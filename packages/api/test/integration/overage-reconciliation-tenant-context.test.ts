/**
 * Postgres integration — the overage reconciliation's gap backfill reads each
 * gap tenant's rows under the RLS runtime role (raw-pg audit 2026-10-23 §4
 * P2.7).
 *
 * For each subscribed tenant (listGapTenants, a global tenants read that stays
 * as it is), the sweep asks whether a call_usage_settlements row already
 * covers the last closed period. That read ran `WHERE tenant_id = $1` on the
 * raw pool, as the privileged principal, so the predicate was the only tenant
 * boundary: a covering row of another tenant would have made the sweep skip a
 * period that was never billed. With RLS_RUNTIME_ROLE on, this suite proves:
 *
 *   1. the covering read — and the metered usage and overage cap reads that
 *      now share its session — report `rls_app_runtime` with the gap
 *      tenant's GUC;
 *   2. with the tenant pin widened to both seeded tenants, RLS alone keeps
 *      the other tenant's settlement from counting as cover: the caller's
 *      unbilled period is still backfilled;
 *   3. control: the same widened read as the connection principal finds the
 *      other tenant's settlement and skips the caller's period;
 *   4. the role keeps SELECT on the three tables after migration 219;
 *   5. the semantics, ordering and per-tenant error isolation are kept: the
 *      session is closed before settlePeriod (the Stripe call), a tenant whose
 *      read fails is counted and the next tenant is still reconciled;
 *   6. the cost for one reconciliation tenant: one tenant session, never two
 *      connections.
 *
 * listStaleSettlements and listGapTenants read across every tenant in the
 * shared database, so the pool handed to the sweep keeps only this file's
 * tenants in their results (`scopedToTenants`), and the sweep never touches
 * another file's rows.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import type { Pool, QueryResult } from 'pg';
import { closeSharedTestDb, createTestTenant, getSharedTestDb, TENANT_CONTEXT_WITH_ROLE_SQL } from './shared';
import { probeStatementRoles } from './statement-role-probe';
import { countPoolTraffic, runtimeRoleGrantsMissingAfter219, widenTenantPredicates } from './tenant-predicate-probe';
import { runOverageSettlementReconciliation } from '../../src/workers/overage-settlement-reconciliation';
import { PgCallUsageRepository } from '../../src/billing/call-usage-events';
import { PgOverageCapStore } from '../../src/billing/overage-cap';
import type { CallUsageBillingService } from '../../src/billing/call-usage-billing';
import { createLogger } from '../../src/logging/logger';

const ORIGINAL_FLAG = process.env.RLS_RUNTIME_ROLE;
const COVERING = /FROM call_usage_settlements\s+WHERE tenant_id = \$1\s+AND period_start/;
const GAP_READS = /FROM call_usage_settlements\s+WHERE tenant_id|FROM call_usage_events|ai_overage_cap_cents, ai_overage_uncapped FROM tenant_settings/;
const NOW = new Date('2026-10-15T12:00:00Z');
// Current period Oct 1 -> Nov 1; the last closed one is Aug 31 -> Oct 1.
const PERIOD_START = new Date('2026-10-01T00:00:00Z');
const PERIOD_END = new Date('2026-11-01T00:00:00Z');
const PREV_START = new Date('2026-08-31T00:00:00Z');
const logger = createLogger({ service: 'test', environment: 'test', level: 'error' });

let pool: Pool;
const tenantIds: string[] = [];

/** A subscribed Starter tenant with a mirrored billing period and 90 metered minutes in the closed one. */
async function seedGapTenant(opts: { usageMinutes?: number } = {}): Promise<string> {
  const { tenantId } = await createTestTenant(pool);
  tenantIds.push(tenantId);
  await pool.query(
    `UPDATE tenants SET subscription_status = 'active', plan_id = 'starter', stripe_customer_id = $2,
            current_period_start = $3, current_period_end = $4
      WHERE id = $1`,
    [tenantId, `cus_${tenantId.slice(0, 8)}`, PERIOD_START, PERIOD_END],
  );
  await pool.query(`INSERT INTO tenant_settings (tenant_id, business_name) VALUES ($1, 'Overage HVAC')`, [tenantId]);
  const minutes = opts.usageMinutes ?? 90;
  if (minutes > 0) {
    await pool.query(
      `INSERT INTO call_usage_events (tenant_id, call_id, started_at, ended_at, duration_seconds, billable)
       VALUES ($1, $2, $3, $4, $5, true)`,
      [tenantId, `call-${crypto.randomUUID()}`, new Date('2026-09-10T15:00:00Z'), new Date('2026-09-10T16:30:00Z'), minutes * 60],
    );
  }
  return tenantId;
}

/** A completed settlement covering the closed period. */
async function seedCoveringSettlement(tenantId: string): Promise<void> {
  await pool.query(
    `INSERT INTO call_usage_settlements (id, tenant_id, period_start, period_end, plan_id, billable_seconds,
       billable_minutes, overage_minutes, customer_charge_cents, status, stripe_invoice_item_id)
     VALUES ($1, $2, $3, $4, 'starter', 5400, 90, 70, 5000, 'completed', 'ii_done')`,
    [crypto.randomUUID(), tenantId, PREV_START, PERIOD_START],
  );
}

type QueryFn = (text: unknown, values?: unknown) => Promise<QueryResult>;

/**
 * The sweep's two cross-tenant reads, kept to `tenants` (the shared database
 * holds other files' subscribed tenants). Everything else passes through.
 */
function scopedToTenants(real: Pool, tenants: readonly string[]): Pool {
  const query: QueryFn = async (text, values) => {
    const res = await (real.query as unknown as QueryFn)(text, values);
    const sql = typeof text === 'string' ? text : '';
    if (!/FROM tenants|JOIN tenants/.test(sql)) return res;
    const rows = res.rows.filter((r: { id?: string; tenant_id?: string }) => tenants.includes(r.tenant_id ?? r.id ?? ''));
    return { ...res, rows, rowCount: rows.length };
  };
  return new Proxy(real, {
    get(target, prop) {
      if (prop === 'query') return query;
      const value = Reflect.get(target, prop, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

interface Run {
  backfilled: string[];
  /** Connections the pool had out when settlePeriod was called. */
  openAtSettle: number[];
}

/** Run the sweep on `p` (scoped to `tenants`) with the worker's real repositories on the same pool. */
async function reconcile(
  p: Pool,
  tenants: readonly string[],
  opts: { open?: () => number; failUsageFor?: string } = {},
): Promise<Run & { result: Awaited<ReturnType<typeof runOverageSettlementReconciliation>> }> {
  const backfilled: string[] = [];
  const openAtSettle: number[] = [];
  const usage = new PgCallUsageRepository(p);
  const result = await runOverageSettlementReconciliation({
    pool: scopedToTenants(p, tenants),
    logger,
    billing: {
      retrySettlement: async () => ({ invoiceItemId: null, alreadyCompleted: true }),
      settlePeriod: async ({ tenantId }: { tenantId: string }) => {
        backfilled.push(tenantId);
        if (opts.open) openAtSettle.push(opts.open());
        return { planId: 'starter', billableMinutes: 90, overageMinutes: 70, customerChargeCents: 5000, invoiceItemId: 'ii_gap' };
      },
    } as unknown as CallUsageBillingService,
    callUsage: {
      sumBillableSeconds: async (tenantId, start, end) => {
        if (tenantId === opts.failUsageFor) throw new Error('usage read failed');
        return usage.sumBillableSeconds(tenantId, start, end);
      },
    },
    overageCaps: new PgOverageCapStore(p),
    priceIdForPlan: (planId) => `price_${planId}`,
    now: () => NOW,
  });
  return { backfilled, openAtSettle, result };
}

beforeAll(async () => {
  pool = await getSharedTestDb();
});

beforeEach(() => {
  process.env.RLS_RUNTIME_ROLE = 'true';
});

afterEach(() => {
  if (ORIGINAL_FLAG === undefined) delete process.env.RLS_RUNTIME_ROLE;
  else process.env.RLS_RUNTIME_ROLE = ORIGINAL_FLAG;
});

afterAll(async () => {
  for (const id of tenantIds) {
    for (const table of ['call_usage_settlements', 'call_usage_events', 'tenant_settings', 'users']) {
      await pool.query(`DELETE FROM ${table} WHERE tenant_id = $1`, [id]).catch(() => undefined);
    }
    await pool.query('DELETE FROM tenants WHERE id = $1', [id]).catch(() => undefined);
  }
  await closeSharedTestDb();
});

describe('overage reconciliation gap backfill — the per-tenant reads under the RLS runtime role (real Postgres)', () => {
  it('the covering-settlement read, the metered usage and the overage cap run as rls_app_runtime for the gap tenant', async () => {
    const tenantId = await seedGapTenant();
    const probe = probeStatementRoles(pool, GAP_READS);

    const run = await reconcile(probe.pool, [tenantId]);

    expect(run.backfilled).toEqual([tenantId]);
    expect(probe.seen.map((s) => s.sql.replace(/\s+/g, ' ').trim().split(' ').slice(0, 4).join(' '))).toEqual([
      'SELECT id, status FROM',
      'SELECT COALESCE(SUM(duration_seconds), 0)::text AS',
      'SELECT ai_overage_cap_cents, ai_overage_uncapped FROM',
    ]);
    for (const s of probe.seen) expect(s).toMatchObject({ role: 'rls_app_runtime', tenantGuc: tenantId });
  });
});

describe('overage reconciliation gap backfill — RLS alone keeps another tenant\'s settlement from counting as cover (real Postgres)', () => {
  /** The caller's closed period was never billed; the other tenant's same period was. */
  async function runWidened(asPrincipal: boolean): Promise<{ caller: string; backfilled: string[] }> {
    const caller = await seedGapTenant();
    const other = await seedGapTenant();
    await seedCoveringSettlement(other);
    const widened = widenTenantPredicates(pool, { target: COVERING, tenants: [caller, other], asPrincipal });

    const run = await reconcile(widened.pool, [caller]);

    expect(widened.rewritten).toHaveLength(1);
    return { caller, backfilled: run.backfilled };
  }

  it('with the tenant pin widened to both tenants, the caller\'s unbilled period is still backfilled', async () => {
    const r = await runWidened(false);
    expect(r.backfilled).toEqual([r.caller]);
  });

  it('control: the same widened read as the connection principal takes the other tenant\'s settlement as cover and skips the caller', async () => {
    expect((await runWidened(true)).backfilled).toEqual([]);
  });
});

describe('grants: rls_app_runtime keeps what the gap backfill reads after migration 219', () => {
  it('call_usage_settlements, call_usage_events and tenant_settings stay readable', async () => {
    expect(
      await runtimeRoleGrantsMissingAfter219(pool, [
        ['call_usage_settlements', 'SELECT'],
        ['call_usage_events', 'SELECT'],
        ['tenant_settings', 'SELECT'],
      ]),
    ).toEqual([]);
  });
});

describe('overage reconciliation — semantics, order and per-tenant isolation kept (real Postgres)', () => {
  it('a covered period is skipped, an unbilled one backfilled, an in-bundle one left alone; no connection is held during settlePeriod', async () => {
    const covered = await seedGapTenant();
    await seedCoveringSettlement(covered);
    const unbilled = await seedGapTenant();
    const inBundle = await seedGapTenant({ usageMinutes: 10 });
    const traffic = countPoolTraffic(pool);

    const run = await reconcile(traffic.pool, [covered, unbilled, inBundle], { open: traffic.open });

    expect(run.backfilled).toEqual([unbilled]);
    expect(run.openAtSettle).toEqual([0]);
    expect(run.result).toMatchObject({ gapsChecked: 3, gapsBackfilled: 1, failed: 0 });
  });

  it('a tenant whose read fails is counted and rolled back; the next tenant is still reconciled, and no connection leaks', async () => {
    const failing = await seedGapTenant();
    const next = await seedGapTenant();
    const traffic = countPoolTraffic(pool);

    const run = await reconcile(traffic.pool, [failing, next], { failUsageFor: failing });

    expect(run.result).toMatchObject({ gapsChecked: 2, gapsBackfilled: 1, failed: 1 });
    expect(run.backfilled).toEqual([next]);
    expect(traffic.statements().filter((s) => s === 'ROLLBACK')).toHaveLength(1);
    expect(traffic.open()).toBe(0);
  });
});

describe('overage reconciliation — cost for one reconciliation tenant (real Postgres, RLS_RUNTIME_ROLE=true)', () => {
  const cost = (traffic: ReturnType<typeof countPoolTraffic>) => ({
    checkouts: traffic.checkouts(),
    statements: traffic.statements().length,
    maxOpen: traffic.maxOpen(),
  });

  it('an unbilled period: the two global reads, then ONE tenant session for the covering read, the usage and the cap (base: 5 checkouts / 15 statements)', async () => {
    const tenantId = await seedGapTenant();
    const traffic = countPoolTraffic(pool);

    const run = await reconcile(traffic.pool, [tenantId]);

    expect(run.backfilled).toEqual([tenantId]);
    expect(cost(traffic)).toEqual({ checkouts: 3, statements: 8, maxOpen: 1 });
    const session = traffic.statements().slice(2);
    expect(session[0]).toBe('BEGIN');
    expect(session[1]).toBe(TENANT_CONTEXT_WITH_ROLE_SQL);
    expect(session[2]).toMatch(COVERING);
    expect(session[3]).toMatch(/FROM call_usage_events/);
    expect(session[4]).toMatch(/FROM tenant_settings/);
    expect(session[5]).toBe('COMMIT');
  });

  it('a covered period: the two global reads, then a session for the covering read only (base: 3 checkouts / 3 statements)', async () => {
    const tenantId = await seedGapTenant();
    await seedCoveringSettlement(tenantId);
    const traffic = countPoolTraffic(pool);

    const run = await reconcile(traffic.pool, [tenantId]);

    expect(run.backfilled).toEqual([]);
    expect(cost(traffic)).toEqual({ checkouts: 3, statements: 6, maxOpen: 1 });
  });
});
