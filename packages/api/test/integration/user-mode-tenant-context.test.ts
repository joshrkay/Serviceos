/**
 * Postgres integration — the UserModeService behind requireTenant's mode
 * loader, GET /api/me and POST /api/me/mode runs under the RLS runtime role
 * (raw-pg audit 2026-10-23 §4 P2.1).
 *
 * Its four statements (getUser, getTenantSettings,
 * getTenantIntegrationStatuses, setMode) ran `WHERE tenant_id = $1` on the
 * raw pool as the privileged principal, each on a pooled connection of its
 * own — on an /api request, a second connection held next to the request's.
 * With RLS_RUNTIME_ROLE on, this suite proves:
 *
 *   1. every statement reports `rls_app_runtime` with the caller's tenant
 *      GUC, against the real columns;
 *   2. with the tenant pin widened to both seeded tenants, RLS alone keeps
 *      the other tenant's users / tenant_settings / tenant_integrations rows
 *      out of the reads and its same-subject users row out of the UPDATE;
 *   3. control: the same widened statements as the connection principal DO
 *      reach the other tenant;
 *   4. the role keeps what they need after migration 219;
 *   5. where requireTenant runs: behind the /api withTenantTransaction
 *      middleware the mode read rides the request client (no checkout, one
 *      statement, never two connections); on a route the middleware skips it
 *      is one tenant session;
 *   6. setMode still commits on its own (the behaviour P2.1 leaves to the
 *      owner): visible to another connection before the request ends, it
 *      survives the request's ROLLBACK — also through POST /api/me/mode when
 *      the audit write after it fails — and the request client never runs it.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import express from 'express';
import request from 'supertest';
import type { Pool } from 'pg';
import { closeSharedTestDb, createTestTenant, getSharedTestDb, TENANT_CONTEXT_WITH_ROLE_SQL } from './shared';
import { probeStatementRoles } from './statement-role-probe';
import { countPoolTraffic, runtimeRoleGrantsMissingAfter219, widenTenantPredicates } from './tenant-predicate-probe';
import { createPgUserModeService, createUserModeLoader } from '../../src/users/pg-user-mode-service';
import { createMeRouter } from '../../src/routes/me';
import { PgAuditRepository } from '../../src/audit/pg-audit';
import type { AuditRepository } from '../../src/audit/audit';
import { applyTenantContext } from '../../src/db/rls-runtime-role';
import { tenantContextStore, withTenantTransaction } from '../../src/middleware/tenant-context';
import { clearUserModeCacheForTests, requireTenant, setUserModeLoader } from '../../src/middleware/auth';
import type { AuthenticatedRequest } from '../../src/auth/clerk';

const ORIGINAL_FLAG = process.env.RLS_RUNTIME_ROLE;
const MODE_TABLES = /FROM users|UPDATE users|tenant_settings|tenant_integrations/;
const USERS_READ = /FROM users\s+WHERE tenant_id = \$1 AND clerk_user_id = \$2/;
const REQUEST_TIMEOUTS = /set_config\('statement_timeout'/;

let pool: Pool;
const tenantIds: string[] = [];

interface Seeded {
  tenantId: string;
  clerk: string;
}

/** A tenant whose member `clerk` is a field-capable dispatcher in 'tech' mode. */
async function seedTenant(opts: { member?: boolean; clerk?: string } = {}): Promise<Seeded> {
  const { tenantId } = await createTestTenant(pool);
  tenantIds.push(tenantId);
  const clerk = opts.clerk ?? `user_mode_${crypto.randomUUID()}`;
  if (opts.member !== false) {
    await pool.query(
      `INSERT INTO users (id, tenant_id, clerk_user_id, email, role, can_field_serve, current_mode)
       VALUES ($1, $2, $3, $4, 'dispatcher', true, 'tech')`,
      [crypto.randomUUID(), tenantId, clerk, `${clerk}@example.com`],
    );
  }
  return { tenantId, clerk };
}

async function seedSettingsAndIntegration(tenantId: string, timezone: string): Promise<void> {
  await pool.query(
    `INSERT INTO tenant_settings (tenant_id, business_name, timezone, unsupervised_proposal_routing)
     VALUES ($1, 'Mode Plumbing', $2, 'queue_only')`,
    [tenantId, timezone],
  );
  await pool.query(
    `INSERT INTO tenant_integrations (tenant_id, provider, status, provider_data)
     VALUES ($1, 'twilio', 'full_readiness', '{}'::jsonb)`,
    [tenantId],
  );
}

/** The member's stored mode, read on its own connection as the principal. */
async function modeOf(tenantId: string, clerk: string): Promise<string | null> {
  const { rows } = await pool.query<{ current_mode: string }>(
    `SELECT current_mode FROM users WHERE tenant_id = $1 AND clerk_user_id = $2`,
    [tenantId, clerk],
  );
  return rows[0]?.current_mode ?? null;
}

beforeAll(async () => {
  pool = await getSharedTestDb();
});

beforeEach(() => {
  process.env.RLS_RUNTIME_ROLE = 'true';
  clearUserModeCacheForTests();
});

afterEach(() => {
  setUserModeLoader(null);
  clearUserModeCacheForTests();
  if (ORIGINAL_FLAG === undefined) delete process.env.RLS_RUNTIME_ROLE;
  else process.env.RLS_RUNTIME_ROLE = ORIGINAL_FLAG;
});

afterAll(async () => {
  for (const id of tenantIds) {
    for (const table of ['tenant_integrations', 'tenant_settings', 'audit_events', 'users']) {
      await pool.query(`DELETE FROM ${table} WHERE tenant_id = $1`, [id]).catch(() => undefined);
    }
    await pool.query('DELETE FROM tenants WHERE id = $1', [id]).catch(() => undefined);
  }
  await closeSharedTestDb();
});

describe('UserModeService — every statement under the RLS runtime role (real Postgres)', () => {
  it('getUser, getTenantSettings, getTenantIntegrationStatuses and setMode run as rls_app_runtime for the caller, on the real columns', async () => {
    const t = await seedTenant();
    await seedSettingsAndIntegration(t.tenantId, 'America/Phoenix');
    const probe = probeStatementRoles(pool, MODE_TABLES);
    const service = createPgUserModeService(probe.pool);

    const user = await service.getUser(t.tenantId, t.clerk);
    const settings = await service.getTenantSettings(t.tenantId);
    const statuses = await service.getTenantIntegrationStatuses(t.tenantId);
    const { modeChangedAt } = await service.setMode(t.tenantId, t.clerk, 'both');

    expect(user).toMatchObject({ user_id: t.clerk, tenant_id: t.tenantId, role: 'dispatcher', can_field_serve: true, current_mode: 'tech' });
    expect(settings).toEqual({ backup_supervisor_user_id: null, unsupervised_proposal_routing: 'queue_only', timezone: 'America/Phoenix' });
    expect(statuses).toEqual([{ provider: 'twilio', status: 'full_readiness', updated_at: expect.any(Date) }]);
    expect(await modeOf(t.tenantId, t.clerk)).toBe('both');
    expect((await service.getUser(t.tenantId, t.clerk))?.mode_changed_at?.getTime()).toBe(modeChangedAt.getTime());
    expect(probe.seen.map((s) => s.sql.trim().split(/\s+/)[0])).toEqual(['SELECT', 'SELECT', 'SELECT', 'UPDATE', 'SELECT']);
    for (const s of probe.seen) expect(s).toMatchObject({ role: 'rls_app_runtime', tenantGuc: t.tenantId });
  });
});

describe("UserModeService — RLS alone keeps the other tenant's rows out (real Postgres)", () => {
  /**
   * The caller has no users / tenant_settings / tenant_integrations rows of
   * its own for the reads; the other tenant has all three, and the same
   * Clerk subject is a member of both for the UPDATE.
   */
  async function runWidened(asPrincipal: boolean) {
    const shared = `user_mode_${crypto.randomUUID()}`;
    const caller = await seedTenant({ member: false });
    const other = await seedTenant({ clerk: shared });
    await seedSettingsAndIntegration(other.tenantId, 'Pacific/Honolulu');
    const widened = widenTenantPredicates(pool, { target: MODE_TABLES, tenants: [caller.tenantId, other.tenantId], asPrincipal });
    const service = createPgUserModeService(widened.pool);

    const user = await service.getUser(caller.tenantId, shared);
    const settings = await service.getTenantSettings(caller.tenantId);
    const statuses = await service.getTenantIntegrationStatuses(caller.tenantId);

    // The UPDATE: the same subject a member of `writer` and of `other`.
    const writer = await seedTenant({ clerk: shared });
    const widenedWrite = widenTenantPredicates(pool, { target: MODE_TABLES, tenants: [writer.tenantId, other.tenantId], asPrincipal });
    await createPgUserModeService(widenedWrite.pool).setMode(writer.tenantId, shared, 'supervisor');

    expect(widened.rewritten).toHaveLength(3);
    expect(widenedWrite.rewritten).toHaveLength(1);
    expect(await modeOf(writer.tenantId, shared)).toBe('supervisor');
    return {
      userTenant: user?.tenant_id ?? null,
      timezone: settings.timezone,
      providers: statuses.map((s) => s.provider),
      otherMode: await modeOf(other.tenantId, shared),
    };
  }

  it('with the tenant pin widened to both tenants, the reads see nothing of the other tenant and the UPDATE leaves its row alone', async () => {
    expect(await runWidened(false)).toEqual({ userTenant: null, timezone: 'America/New_York', providers: [], otherMode: 'tech' });
  });

  it("control: the same widened statements run as the connection principal read the other tenant's rows and switch its mode", async () => {
    const result = await runWidened(true);
    expect(result).toMatchObject({ timezone: 'Pacific/Honolulu', providers: ['twilio'], otherMode: 'supervisor' });
    expect(result.userTenant).not.toBeNull();
  });
});

describe('grants: rls_app_runtime keeps what the UserModeService needs after migration 219', () => {
  it('users stays readable and updatable, tenant_settings and tenant_integrations readable', async () => {
    expect(
      await runtimeRoleGrantsMissingAfter219(pool, [
        ['users', 'SELECT'],
        ['users', 'UPDATE'],
        ['tenant_settings', 'SELECT'],
        ['tenant_integrations', 'SELECT'],
      ]),
    ).toEqual([]);
  });
});

describe('where requireTenant runs: behind the /api request transaction (real Postgres)', () => {
  /**
   * The /api order that matters here, as app.ts mounts it: the verified
   * session (stubbed), the request transaction, then the routers whose routes
   * each carry requireTenant. POST /api/assistant/chat is on the middleware's
   * long-LLM skip list, so it runs with no request transaction.
   */
  function buildApp(traffic: ReturnType<typeof countPoolTraffic>, t: Seeded, auditRepo?: AuditRepository) {
    const service = createPgUserModeService(traffic.pool);
    setUserModeLoader(createUserModeLoader(service));
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as AuthenticatedRequest).auth = { userId: t.clerk, sessionId: 'sess-mode', tenantId: t.tenantId, role: 'dispatcher' };
      next();
    });
    app.use('/api', withTenantTransaction(traffic.pool));
    app.use('/api/me', createMeRouter(service, auditRepo ?? new PgAuditRepository(traffic.pool)));
    const probe = (req: express.Request, res: express.Response) => {
      res.json({ mode: ((req as AuthenticatedRequest).auth as { mode?: string }).mode ?? null });
    };
    app.get('/api/probe', requireTenant, probe);
    app.post('/api/assistant/chat', requireTenant, probe);
    return app;
  }
  const cost = (traffic: ReturnType<typeof countPoolTraffic>) => ({
    checkouts: traffic.checkouts(),
    statements: traffic.statements().length,
    maxOpen: traffic.maxOpen(),
  });

  it('a cache miss reads the mode on the request client: no second checkout, one statement (base: 2 checkouts / 5 statements, 2 open at once)', async () => {
    const t = await seedTenant();
    const traffic = countPoolTraffic(pool);
    const app = buildApp(traffic, t);

    const res = await request(app).get('/api/probe');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ mode: 'tech' });
    expect(cost(traffic)).toEqual({ checkouts: 1, statements: 5, maxOpen: 1 });
    const ran = traffic.statements();
    expect(ran[0]).toBe('BEGIN');
    expect(ran[1]).toBe(TENANT_CONTEXT_WITH_ROLE_SQL);
    expect(ran[2]).toMatch(REQUEST_TIMEOUTS);
    expect(ran[3]).toMatch(USERS_READ);
    expect(ran[4]).toBe('COMMIT');
  });

  it('a cache hit reads nothing: the request floor only', async () => {
    const t = await seedTenant();
    const traffic = countPoolTraffic(pool);
    const app = buildApp(traffic, t);
    await request(app).get('/api/probe');
    const warm = countPoolTraffic(pool);
    const warmApp = buildApp(warm, t);

    const res = await request(warmApp).get('/api/probe');

    expect(res.body).toEqual({ mode: 'tech' });
    expect(cost(warm)).toEqual({ checkouts: 1, statements: 4, maxOpen: 1 });
  });

  it('GET /api/me: the gate read and the three handler reads all ride the request client (base: 5 checkouts / 8 statements, 2 open at once)', async () => {
    const t = await seedTenant();
    await seedSettingsAndIntegration(t.tenantId, 'America/Chicago');
    const traffic = countPoolTraffic(pool);

    const res = await request(buildApp(traffic, t)).get('/api/me');

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ current_mode: 'tech', timezone: 'America/Chicago', unsupervised_proposal_routing: 'queue_only' });
    expect(res.body.integration_statuses).toEqual([{ provider: 'twilio', status: 'full_readiness', updated_at: expect.any(String) }]);
    expect(cost(traffic)).toEqual({ checkouts: 1, statements: 8, maxOpen: 1 });
  });

  it('on a route the middleware skips (long-LLM), a miss is one tenant session of its own (base: 1 checkout / 1 statement)', async () => {
    const t = await seedTenant();
    const traffic = countPoolTraffic(pool);

    const res = await request(buildApp(traffic, t)).post('/api/assistant/chat').send({});

    expect(res.body).toEqual({ mode: 'tech' });
    expect(cost(traffic)).toEqual({ checkouts: 1, statements: 4, maxOpen: 1 });
    expect(traffic.statements()[2]).toMatch(USERS_READ);
  });

  it('POST /api/me/mode: the reads and the audit row ride the request client, the switch takes one session of its own (base: 4 checkouts / 8 statements)', async () => {
    const t = await seedTenant();
    const traffic = countPoolTraffic(pool);

    const res = await request(buildApp(traffic, t)).post('/api/me/mode').send({ mode: 'both' });

    expect(res.status).toBe(204);
    expect(await modeOf(t.tenantId, t.clerk)).toBe('both');
    // Request: BEGIN, context, timeouts, gate read, handler read, audit INSERT, COMMIT;
    // the switch: BEGIN, context, UPDATE, COMMIT, while the request client is held (as on base).
    expect(cost(traffic)).toEqual({ checkouts: 2, statements: 11, maxOpen: 2 });
  });
});

describe('setMode commits on its own, never with the request (P2.1 behaviour preserved)', () => {
  it('inside a request transaction the switch is visible to another connection at once and survives the request\'s ROLLBACK; the request client never runs it', async () => {
    const t = await seedTenant();
    const client = await pool.connect();
    const ran: string[] = [];
    const inner = client.query.bind(client) as (text: unknown, values?: unknown) => Promise<unknown>;
    (client as unknown as { query: typeof inner }).query = (text, values) => {
      ran.push(typeof text === 'string' ? text : String((text as { text?: string })?.text ?? ''));
      return inner(text, values);
    };
    let seenBeforeRequestEnds: string | null = 'unset';
    try {
      await client.query('BEGIN');
      await applyTenantContext(client, t.tenantId, { transactional: true });
      await tenantContextStore.run({ client, tenantId: t.tenantId }, async () => {
        const service = createPgUserModeService(pool);
        expect((await service.getUser(t.tenantId, t.clerk))?.current_mode).toBe('tech');
        await service.setMode(t.tenantId, t.clerk, 'supervisor');
        seenBeforeRequestEnds = await modeOf(t.tenantId, t.clerk);
      });
      await client.query('ROLLBACK');
    } finally {
      delete (client as unknown as { query?: unknown }).query;
      client.release();
    }

    expect(seenBeforeRequestEnds).toBe('supervisor');
    expect(await modeOf(t.tenantId, t.clerk)).toBe('supervisor');
    // The read rode the request client; the UPDATE did not.
    expect(ran.filter((sql) => USERS_READ.test(sql))).toHaveLength(1);
    expect(ran.filter((sql) => /UPDATE users/.test(sql))).toEqual([]);
  });

  it('through POST /api/me/mode: when the audit write after the switch fails, the request answers 500 and rolls back, and the switch still stands', async () => {
    const t = await seedTenant();
    const traffic = countPoolTraffic(pool);
    const service = createPgUserModeService(traffic.pool);
    setUserModeLoader(createUserModeLoader(service));
    const failingAudit = { create: async () => { throw new Error('audit down'); } } as unknown as AuditRepository;
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as AuthenticatedRequest).auth = { userId: t.clerk, sessionId: 'sess-mode', tenantId: t.tenantId, role: 'dispatcher' };
      next();
    });
    app.use('/api', withTenantTransaction(traffic.pool));
    app.use('/api/me', createMeRouter(service, failingAudit));

    const res = await request(app).post('/api/me/mode').send({ mode: 'supervisor' });

    expect(res.status).toBe(500);
    expect(traffic.statements()).toContain('ROLLBACK');
    expect(await modeOf(t.tenantId, t.clerk)).toBe('supervisor');
  });
});
