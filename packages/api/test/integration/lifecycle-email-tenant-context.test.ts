/**
 * Postgres integration — the lifecycle_emails claim ledger runs under the RLS
 * runtime role (raw-pg audit 2026-10-23 §4 P2.4).
 *
 * claimLifecycleEmail (INSERT … ON CONFLICT DO NOTHING) and its transport-
 * failure release (DELETE … WHERE tenant_id = $1 AND kind = $2) ran straight
 * on the pool as the privileged principal: the VALUES stamp and the WHERE pin
 * were the only tenant boundary, and the policy's WITH CHECK never applied.
 * With RLS_RUNTIME_ROLE on, this suite proves:
 *
 *   1. the claim and the release — direct and through sendLifecycleEmail —
 *      report `rls_app_runtime` with the claiming tenant's GUC;
 *   2. with the release's tenant pin widened to both tenants, RLS alone leaves
 *      the other tenant's same-kind row in place; a claim re-stamped with the
 *      other tenant is refused by WITH CHECK;
 *   3. control: the same widened / re-stamped statements as the connection
 *      principal delete / land the other tenant's row;
 *   4. the role keeps what the ledger needs once migration 219 is applied;
 *   5. the claim still commits on its own (the send-claim-ledger contract,
 *      #1825): inside a caller's tenant transaction the claim is visible to
 *      another connection while the provider is called and survives that
 *      transaction's ROLLBACK, a release is committed before the error
 *      returns, and the ambient client runs none of the ledger statements;
 *   6. the cost: one tenant session per ledger step, never two at once.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Pool, PoolClient, QueryResult } from 'pg';
import { closeSharedTestDb, createTestTenant, getSharedTestDb, TENANT_CONTEXT_WITH_ROLE_SQL } from './shared';
import { probeStatementRoles } from './statement-role-probe';
import { countPoolTraffic, runtimeRoleGrantsMissingAfter219, widenTenantPredicates } from './tenant-predicate-probe';
import { claimLifecycleEmail, sendLifecycleEmail, type LifecycleEmailKind } from '../../src/notifications/lifecycle-email';
import type { MessageDeliveryProvider } from '../../src/notifications/delivery-provider';
import { applyTenantContext } from '../../src/db/rls-runtime-role';
import { tenantContextStore } from '../../src/middleware/tenant-context';
import { PgAuditRepository } from '../../src/audit/pg-audit';
import { createLogger } from '../../src/logging/logger';

const ORIGINAL_FLAG = process.env.RLS_RUNTIME_ROLE;
const LEDGER = /lifecycle_emails/;
const logger = createLogger({ service: 'test', environment: 'test', level: 'error' });
const rendered = { subject: 'Welcome', text: 'hi', html: '<p>hi</p>' };

let pool: Pool;
const tenantIds: string[] = [];

async function seedTenant(): Promise<string> {
  const { tenantId } = await createTestTenant(pool);
  tenantIds.push(tenantId);
  return tenantId;
}

async function seedRow(tenantId: string, kind: LifecycleEmailKind): Promise<void> {
  await pool.query(`INSERT INTO lifecycle_emails (tenant_id, kind) VALUES ($1, $2)`, [tenantId, kind]);
}

/** Whether the (tenant, kind) row exists, read on its own connection as the principal. */
async function hasRow(tenantId: string, kind: LifecycleEmailKind): Promise<boolean> {
  const { rows } = await pool.query(`SELECT 1 FROM lifecycle_emails WHERE tenant_id = $1 AND kind = $2`, [tenantId, kind]);
  return rows.length > 0;
}

function provider(onSend: () => void | Promise<void>): MessageDeliveryProvider {
  return { sendEmail: async () => onSend() } as unknown as MessageDeliveryProvider;
}

const failing = () =>
  provider(() => {
    throw new Error('smtp down');
  });

type QueryFn = (text: unknown, values?: unknown) => Promise<QueryResult>;

/**
 * The INSERT analogue of widening a WHERE pin: the claim's row is stamped with
 * `other` instead of the caller (`$1` still referenced). Under the tenant role
 * WITH CHECK refuses it; `asPrincipal` (RESET ROLE first) is the control.
 */
function restampClaims(real: Pool, other: string, opts: { asPrincipal?: boolean } = {}): { pool: Pool; rewritten: string[] } {
  const rewritten: string[] = [];
  const connect = async (): Promise<PoolClient> => {
    const client = await real.connect();
    const inner = client.query as unknown as QueryFn;
    (client as unknown as { query: QueryFn }).query = async (text, values) => {
      const sql = typeof text === 'string' ? text : null;
      if (sql === null || !/INSERT INTO lifecycle_emails/.test(sql)) return inner.call(client, text, values);
      const next = sql.replace(/VALUES \(\$1,/, `VALUES ((CASE WHEN $1::uuid IS NOT NULL THEN '${other}'::uuid END),`);
      rewritten.push(next);
      if (opts.asPrincipal) await inner.call(client, 'RESET ROLE');
      return inner.call(client, next, values);
    };
    const innerRelease = client.release;
    client.release = (err?: Error | boolean) => {
      delete (client as unknown as { query?: QueryFn }).query;
      return innerRelease(err);
    };
    return client;
  };
  const query = async (text: unknown, values?: unknown): Promise<QueryResult> => {
    const client = await connect();
    try {
      return await (client.query as unknown as QueryFn)(text, values);
    } finally {
      client.release();
    }
  };
  const proxied = new Proxy(real, {
    get(target, prop) {
      if (prop === 'connect') return connect;
      if (prop === 'query') return query;
      const value = Reflect.get(target, prop, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return { pool: proxied, rewritten };
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
    for (const table of ['lifecycle_emails', 'audit_events', 'users']) {
      await pool.query(`DELETE FROM ${table} WHERE tenant_id = $1`, [id]).catch(() => undefined);
    }
    await pool.query('DELETE FROM tenants WHERE id = $1', [id]).catch(() => undefined);
  }
  await closeSharedTestDb();
});

describe('lifecycle_emails ledger — every statement under the RLS runtime role (real Postgres)', () => {
  it('the claim (direct and through sendLifecycleEmail) and the release run as rls_app_runtime for the claiming tenant', async () => {
    const tenantId = await seedTenant();
    const probe = probeStatementRoles(pool, LEDGER);

    expect(await claimLifecycleEmail(probe.pool, tenantId, 'setup_reminder')).toBe(true);
    expect(await claimLifecycleEmail(probe.pool, tenantId, 'setup_reminder')).toBe(false);
    expect(await sendLifecycleEmail({ pool: probe.pool, delivery: provider(() => undefined), logger }, { tenantId, kind: 'welcome', to: 'o@shop.com', rendered })).toBe('sent');
    await expect(
      sendLifecycleEmail({ pool: probe.pool, delivery: failing(), logger }, { tenantId, kind: 'trial_3d', to: 'o@shop.com', rendered }),
    ).rejects.toThrow('smtp down');

    expect(await hasRow(tenantId, 'setup_reminder')).toBe(true);
    expect(await hasRow(tenantId, 'welcome')).toBe(true);
    expect(await hasRow(tenantId, 'trial_3d')).toBe(false);
    expect(probe.seen.map((s) => s.sql.trim().split(/\s+/)[0])).toEqual(['INSERT', 'INSERT', 'INSERT', 'INSERT', 'DELETE']);
    for (const s of probe.seen) expect(s).toMatchObject({ role: 'rls_app_runtime', tenantGuc: tenantId });
  });
});

describe("lifecycle_emails ledger — RLS alone keeps the other tenant's row out (real Postgres)", () => {
  /** A failed send for `caller`: its claim, then the release with the tenant pin widened to both tenants. */
  async function widenedRelease(asPrincipal: boolean) {
    const caller = await seedTenant();
    const other = await seedTenant();
    await seedRow(other, 'trial_1d');
    const widened = widenTenantPredicates(pool, { target: LEDGER, tenants: [caller, other], asPrincipal });

    await expect(
      sendLifecycleEmail({ pool: widened.pool, delivery: failing(), logger }, { tenantId: caller, kind: 'trial_1d', to: 'o@shop.com', rendered }),
    ).rejects.toThrow('smtp down');

    expect(widened.rewritten).toHaveLength(1);
    expect(widened.rewritten[0]).toMatch(/^DELETE FROM lifecycle_emails/);
    expect(await hasRow(caller, 'trial_1d')).toBe(false);
    return hasRow(other, 'trial_1d');
  }

  it("with the release's tenant pin widened to both tenants, the other tenant's same-kind row stays", async () => {
    expect(await widenedRelease(false)).toBe(true);
  });

  it("control: the same widened release run as the connection principal deletes the other tenant's row", async () => {
    expect(await widenedRelease(true)).toBe(false);
  });

  it("a claim re-stamped with the other tenant is refused by the policy's WITH CHECK", async () => {
    const caller = await seedTenant();
    const other = await seedTenant();
    const restamped = restampClaims(pool, other);

    await expect(claimLifecycleEmail(restamped.pool, caller, 'welcome')).rejects.toThrow(/row-level security/);

    expect(restamped.rewritten).toHaveLength(1);
    expect(await hasRow(other, 'welcome')).toBe(false);
    expect(await hasRow(caller, 'welcome')).toBe(false);
  });

  it('control: the same re-stamped claim run as the connection principal lands in the other tenant', async () => {
    const caller = await seedTenant();
    const other = await seedTenant();
    const restamped = restampClaims(pool, other, { asPrincipal: true });

    expect(await claimLifecycleEmail(restamped.pool, caller, 'welcome')).toBe(true);

    expect(await hasRow(other, 'welcome')).toBe(true);
  });
});

describe('grants: rls_app_runtime keeps what the ledger needs after migration 219', () => {
  it('lifecycle_emails stays readable (RETURNING), insertable and deletable', async () => {
    expect(
      await runtimeRoleGrantsMissingAfter219(pool, [
        ['lifecycle_emails', 'SELECT'],
        ['lifecycle_emails', 'INSERT'],
        ['lifecycle_emails', 'DELETE'],
      ]),
    ).toEqual([]);
  });
});

describe('lifecycle_emails ledger — each step commits on its own, never with a caller (P2.4 behaviour preserved)', () => {
  /** A tenant transaction for `tenantId` published the way the /api middleware publishes one, recording what it runs. */
  async function openAmbient(tenantId: string) {
    const client = await pool.connect();
    const ran: string[] = [];
    const inner = client.query.bind(client) as unknown as QueryFn;
    (client as unknown as { query: QueryFn }).query = (text, values) => {
      ran.push(typeof text === 'string' ? text : String((text as { text?: string })?.text ?? ''));
      return inner(text, values);
    };
    await client.query('BEGIN');
    await applyTenantContext(client, tenantId, { transactional: true });
    return {
      ran,
      run: <T>(fn: () => Promise<T>) => tenantContextStore.run({ client, tenantId }, fn),
      rollback: async () => {
        await client.query('ROLLBACK');
        delete (client as unknown as { query?: QueryFn }).query;
        client.release();
      },
    };
  }

  it('inside a tenant transaction, the claim is committed before the provider is called and survives that transaction\'s ROLLBACK', async () => {
    const tenantId = await seedTenant();
    const ambient = await openAmbient(tenantId);
    const traffic = countPoolTraffic(pool);
    let atProvider: { committed: boolean; lastStatement: string | undefined } | null = null;

    const outcome = await ambient.run(() =>
      sendLifecycleEmail(
        {
          pool: traffic.pool,
          delivery: provider(async () => {
            atProvider = { committed: await hasRow(tenantId, 'welcome'), lastStatement: traffic.statements().at(-1) };
          }),
          logger,
        },
        { tenantId, kind: 'welcome', to: 'o@shop.com', rendered },
      ),
    );
    await ambient.rollback();

    expect(outcome).toBe('sent');
    // Another connection sees the claim while the provider runs; the claim's session has ended.
    expect(atProvider).toEqual({ committed: true, lastStatement: 'COMMIT' });
    expect(await hasRow(tenantId, 'welcome')).toBe(true);
    expect(traffic.checkouts()).toBe(1);
    expect(ambient.ran.filter((sql) => LEDGER.test(sql))).toEqual([]);
  });

  it('a release inside a tenant transaction is committed at once: the key is free to another connection before that transaction ends', async () => {
    const tenantId = await seedTenant();
    const ambient = await openAmbient(tenantId);

    await expect(
      ambient.run(() => sendLifecycleEmail({ pool, delivery: failing(), logger }, { tenantId, kind: 'dunning_0d', to: 'o@shop.com', rendered })),
    ).rejects.toThrow('smtp down');
    const claimedElsewhere = await claimLifecycleEmail(pool, tenantId, 'dunning_0d');
    await ambient.rollback();

    expect(claimedElsewhere).toBe(true);
    expect(await hasRow(tenantId, 'dunning_0d')).toBe(true);
    expect(ambient.ran.filter((sql) => LEDGER.test(sql))).toEqual([]);
  });
});

describe('lifecycle_emails ledger — cost: one tenant session per ledger step (real Postgres)', () => {
  const cost = (traffic: ReturnType<typeof countPoolTraffic>) => ({
    checkouts: traffic.checkouts(),
    statements: traffic.statements().length,
    maxOpen: traffic.maxOpen(),
  });

  it('a claim is BEGIN, the GUC + role, the INSERT, COMMIT (base: 1 checkout / 1 statement)', async () => {
    const tenantId = await seedTenant();
    const traffic = countPoolTraffic(pool);

    expect(await claimLifecycleEmail(traffic.pool, tenantId, 'setup_reminder')).toBe(true);

    expect(cost(traffic)).toEqual({ checkouts: 1, statements: 4, maxOpen: 1 });
    expect(traffic.statements()[0]).toBe('BEGIN');
    expect(traffic.statements()[1]).toBe(TENANT_CONTEXT_WITH_ROLE_SQL);
    expect(traffic.statements()[3]).toBe('COMMIT');
  });

  it('sendLifecycleEmail: a send with its audit row, a duplicate and a failed send', async () => {
    const tenantId = await seedTenant();
    const measure = async (kind: LifecycleEmailKind, delivery: MessageDeliveryProvider) => {
      const traffic = countPoolTraffic(pool);
      await sendLifecycleEmail(
        { pool: traffic.pool, delivery, auditRepo: new PgAuditRepository(traffic.pool), logger },
        { tenantId, kind, to: 'o@shop.com', rendered },
      ).catch(() => undefined);
      return cost(traffic);
    };

    // Base: 2 / 7 (the claim's pool.query + the audit repository's session).
    expect(await measure('welcome', provider(() => undefined))).toEqual({ checkouts: 2, statements: 10, maxOpen: 1 });
    // Base: 1 / 1.
    expect(await measure('welcome', provider(() => undefined))).toEqual({ checkouts: 1, statements: 4, maxOpen: 1 });
    // Base: 2 / 2 (claim, release).
    expect(await measure('trial_0d', failing())).toEqual({ checkouts: 2, statements: 8, maxOpen: 1 });
  });
});
