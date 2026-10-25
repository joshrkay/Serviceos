/**
 * Postgres integration — the onboarding AI self-check worker runs its
 * tenant_settings reads and writes under the RLS runtime role (raw-pg audit
 * 2026-10-23 §4 P1.9).
 *
 * `createVerifyAiWorker().handle` read and updated tenant_settings
 * `WHERE tenant_id = $1` with the payload tenant (Stripe-resolved, or the
 * owner's retry) on the raw pool, as the privileged principal. It now runs
 * one tenant session per stage: the read and the 'running' mark before the
 * gateway call, the outcome after it — never a session open across the LLM
 * call. With RLS_RUNTIME_ROLE on, this suite proves:
 *
 *   1. every tenant_settings statement on each path (pass, fail, no model,
 *      already passed) reports `rls_app_runtime` with the payload tenant's GUC;
 *   2. with the tenant pin widened to both seeded tenants, RLS alone keeps
 *      the other tenant's settings row out of the read and the writes;
 *   3. control: the same widened statements as the connection principal read
 *      and stamp the other tenant;
 *   4. the role keeps SELECT and UPDATE on tenant_settings after migration 219;
 *   5. the real LLM gateway (its in-transaction guard on) is called with no
 *      connection of the worker's held and stage 1 committed;
 *   6. the cost per path, against base.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { closeSharedTestDb, createTestTenant, getSharedTestDb } from './shared';
import { probeStatementRoles } from './statement-role-probe';
import { countPoolTraffic, runtimeRoleGrantsMissingAfter219, widenTenantPredicates } from './tenant-predicate-probe';
import { createVerifyAiWorker, VERIFY_AI_JOB_TYPE } from '../../src/workers/verify-ai';
import { createMockLLMGateway, type LLMGateway, type LLMResponse } from '../../src/ai/gateway';
import { PgAuditRepository } from '../../src/audit/pg-audit';
import { createLogger } from '../../src/logging/logger';
import type { QueueMessage } from '../../src/queues/queue';
import { currentTenantContext } from '../../src/middleware/tenant-context';

const ORIGINAL_FLAG = process.env.RLS_RUNTIME_ROLE;
const SETTINGS = /tenant_settings/;
const logger = createLogger({ service: 'test', environment: 'test', level: 'error' });
const oneLine = (sql: string) => sql.replace(/\s+/g, ' ').trim();

let pool: Pool;
const tenantIds: string[] = [];

function message(tenantId: string): QueueMessage<{ tenantId: string }> {
  return {
    id: `msg-${tenantId}`,
    type: VERIFY_AI_JOB_TYPE,
    payload: { tenantId },
    attempts: 1,
    maxAttempts: 3,
    idempotencyKey: `verify-ai-${tenantId}`,
    createdAt: new Date().toISOString(),
  };
}

/** A tenant, with a tenant_settings row unless `settings` is false. */
async function seedTenant(settings: { aiModel: string | null; status?: string | null } | false): Promise<string> {
  const { tenantId } = await createTestTenant(pool);
  tenantIds.push(tenantId);
  if (settings) {
    await pool.query(
      `INSERT INTO tenant_settings (tenant_id, business_name, ai_model, ai_verification_status)
       VALUES ($1, 'Verify Shop', $2, $3)`,
      [tenantId, settings.aiModel, settings.status ?? null],
    );
  }
  return tenantId;
}

async function verificationOf(tenantId: string): Promise<{ status: string | null; error: string | null } | null> {
  const { rows } = await pool.query<{ status: string | null; error: string | null }>(
    `SELECT ai_verification_status AS status, ai_verification_error AS error FROM tenant_settings WHERE tenant_id = $1`,
    [tenantId],
  );
  return rows[0] ?? null;
}

function passingGateway(): LLMGateway {
  return createMockLLMGateway('pong').gateway;
}

function failingGateway(): LLMGateway {
  return {
    complete: async (): Promise<LLMResponse> => {
      throw new Error('provider down');
    },
  } as unknown as LLMGateway;
}

/** What each tenant_settings statement was, in order: its verb and the status it writes. */
function shapes(sqls: string[]): string[] {
  return sqls.map((sql) => {
    const status = sql.match(/ai_verification_status\s*=\s*'([a-z]+)'/i)?.[1];
    const verb = sql.trim().split(/\s+/)[0]!;
    return status ? `${verb} ${status}` : verb;
  });
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
    for (const table of ['audit_events', 'tenant_settings', 'users']) {
      await pool.query(`DELETE FROM ${table} WHERE tenant_id = $1`, [id]).catch(() => undefined);
    }
    await pool.query('DELETE FROM tenants WHERE id = $1', [id]).catch(() => undefined);
  }
  await closeSharedTestDb();
});

describe('verify-ai worker — tenant_settings under the RLS runtime role (real Postgres)', () => {
  const run = async (tenantId: string, gateway: LLMGateway, p: Pool) =>
    createVerifyAiWorker({ pool: p, gateway, auditRepo: new PgAuditRepository(pool) }).handle(message(tenantId), logger);

  it('a pass: the read, the running mark and the passed write all run as rls_app_runtime for the payload tenant', async () => {
    const tenantId = await seedTenant({ aiModel: 'gpt-4o-mini' });
    const probe = probeStatementRoles(pool, SETTINGS);

    await run(tenantId, passingGateway(), probe.pool);

    expect(await verificationOf(tenantId)).toEqual({ status: 'passed', error: null });
    expect(shapes(probe.seen.map((s) => s.sql))).toEqual(['SELECT', 'UPDATE running', 'UPDATE passed']);
    for (const s of probe.seen) expect(s).toMatchObject({ role: 'rls_app_runtime', tenantGuc: tenantId });
  });

  it('a gateway failure, a missing model and an earlier pass: every statement as rls_app_runtime for the payload tenant', async () => {
    const failing = await seedTenant({ aiModel: 'gpt-4o-mini' });
    const noModel = await seedTenant({ aiModel: null });
    const passed = await seedTenant({ aiModel: 'gpt-4o-mini', status: 'passed' });

    const p1 = probeStatementRoles(pool, SETTINGS);
    await expect(run(failing, failingGateway(), p1.pool)).rejects.toThrow('provider down');
    const p2 = probeStatementRoles(pool, SETTINGS);
    await run(noModel, passingGateway(), p2.pool);
    const p3 = probeStatementRoles(pool, SETTINGS);
    await run(passed, passingGateway(), p3.pool);

    expect(await verificationOf(failing)).toEqual({ status: 'failed', error: 'provider down' });
    expect(await verificationOf(noModel)).toEqual({ status: 'failed', error: 'ai_config_missing' });
    expect(await verificationOf(passed)).toEqual({ status: 'passed', error: null });
    expect(shapes(p1.seen.map((s) => s.sql))).toEqual(['SELECT', 'UPDATE running', 'UPDATE failed']);
    expect(shapes(p2.seen.map((s) => s.sql))).toEqual(['SELECT', 'UPDATE failed']);
    expect(shapes(p3.seen.map((s) => s.sql))).toEqual(['SELECT']);
    for (const [probe, tenantId] of [[p1, failing], [p2, noModel], [p3, passed]] as const) {
      for (const s of probe.seen) expect(s).toMatchObject({ role: 'rls_app_runtime', tenantGuc: tenantId });
    }
  });

  /** Both scenarios, the tenant pin widened to caller + other; reports the other tenant's row and whether the gateway ran. */
  async function runWidened(asPrincipal: boolean) {
    // Both configured: the writes must not reach the other row.
    const caller = await seedTenant({ aiModel: 'gpt-4o-mini' });
    const other = await seedTenant({ aiModel: 'gpt-4o-mini' });
    const w1 = widenTenantPredicates(pool, { target: SETTINGS, tenants: [caller, other], asPrincipal });
    await run(caller, passingGateway(), w1.pool);

    // The caller has no settings row, the other tenant does: the read must not find it.
    const unconfigured = await seedTenant(false);
    const configured = await seedTenant({ aiModel: 'gpt-4o-mini' });
    let gatewayCalls = 0;
    const counting = passingGateway();
    const complete = counting.complete.bind(counting);
    counting.complete = async (req) => {
      gatewayCalls += 1;
      return complete(req);
    };
    const w2 = widenTenantPredicates(pool, { target: SETTINGS, tenants: [unconfigured, configured], asPrincipal });
    await run(unconfigured, counting, w2.pool);

    expect(w1.rewritten).toHaveLength(3);
    expect(w2.rewritten.length).toBeGreaterThan(0);
    expect(await verificationOf(caller)).toEqual({ status: 'passed', error: null });
    return {
      other: await verificationOf(other),
      configured: await verificationOf(configured),
      gatewayCalls,
    };
  }

  it("with the tenant pin widened to both tenants, RLS alone keeps the other tenant's settings out of the read and the writes", async () => {
    expect(await runWidened(false)).toEqual({
      other: { status: null, error: null },
      configured: { status: null, error: null },
      gatewayCalls: 0,
    });
  });

  it("control: the same widened statements run as the connection principal stamp the other tenant and read its model", async () => {
    expect(await runWidened(true)).toEqual({
      other: { status: 'passed', error: null },
      configured: { status: 'passed', error: null },
      gatewayCalls: 1,
    });
  });
});

describe('grants: rls_app_runtime keeps what the worker needs after migration 219', () => {
  it('tenant_settings stays readable and updatable', async () => {
    expect(await runtimeRoleGrantsMissingAfter219(pool, [['tenant_settings', 'SELECT'], ['tenant_settings', 'UPDATE']])).toEqual([]);
  });
});

describe('verify-ai worker — no tenant session across the LLM call (real Postgres)', () => {
  it('the real gateway (its in-transaction guard on) is called with stage 1 committed and no connection of the worker held', async () => {
    const tenantId = await seedTenant({ aiModel: 'gpt-4o-mini' });
    const traffic = countPoolTraffic(pool);
    const gateway = passingGateway();
    const complete = gateway.complete.bind(gateway);
    let atCall: { held: number; last: string | undefined; checkouts: number; context: unknown } | undefined;
    gateway.complete = async (req) => {
      atCall = {
        held: pool.totalCount - pool.idleCount,
        last: traffic.statements().at(-1),
        checkouts: traffic.checkouts(),
        context: currentTenantContext(),
      };
      return complete(req);
    };

    await createVerifyAiWorker({ pool: traffic.pool, gateway, auditRepo: new PgAuditRepository(traffic.pool) }).handle(
      message(tenantId),
      logger,
    );

    expect(atCall).toEqual({ held: 0, last: 'COMMIT', checkouts: 1, context: undefined });
    expect(await verificationOf(tenantId)).toEqual({ status: 'passed', error: null });
  });
});

describe('verify-ai worker — cost per path (real Postgres)', () => {
  const measure = async (tenantId: string, gateway: LLMGateway) => {
    const traffic = countPoolTraffic(pool);
    await createVerifyAiWorker({ pool: traffic.pool, gateway, auditRepo: new PgAuditRepository(traffic.pool) })
      .handle(message(tenantId), logger)
      .catch(() => undefined);
    const settings = traffic.statements().filter((s) => SETTINGS.test(s));
    return {
      checkouts: traffic.checkouts(),
      statements: traffic.statements().length,
      maxOpen: traffic.maxOpen(),
      settings: shapes(settings.map(oneLine)),
    };
  };

  it('one tenant session per stage, the audit write unchanged, never two connections at once', async () => {
    // Base (raw pool reads/writes; the audit row its own repository transaction):
    // pass 4 checkouts / 9 statements, gateway failure 4 / 9, no model 2 / 2, already passed 1 / 1.
    // Stage 1 (read + running mark): BEGIN, GUC+role, SELECT, UPDATE, COMMIT. Stage 3 (passed): BEGIN, GUC+role, UPDATE, COMMIT.
    // The audit row: BEGIN, GUC+role, INSERT, COMMIT, RESET ROLE, RESET GUC (PgAuditRepository, as on base).
    expect(await measure(await seedTenant({ aiModel: 'gpt-4o-mini' }), passingGateway())).toEqual({
      checkouts: 3,
      statements: 15,
      maxOpen: 1,
      settings: ['SELECT', 'UPDATE running', 'UPDATE passed'],
    });
    expect(await measure(await seedTenant({ aiModel: 'gpt-4o-mini' }), failingGateway())).toEqual({
      checkouts: 3,
      statements: 15,
      maxOpen: 1,
      settings: ['SELECT', 'UPDATE running', 'UPDATE failed'],
    });
    expect(await measure(await seedTenant({ aiModel: null }), passingGateway())).toEqual({
      checkouts: 1,
      statements: 5,
      maxOpen: 1,
      settings: ['SELECT', 'UPDATE failed'],
    });
    expect(await measure(await seedTenant({ aiModel: 'gpt-4o-mini', status: 'passed' }), passingGateway())).toEqual({
      checkouts: 1,
      statements: 4,
      maxOpen: 1,
      settings: ['SELECT'],
    });
  });
});
