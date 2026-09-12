/**
 * #1011 (wayfinder map #995) — the owner capability write at REAL Postgres.
 *
 * `test/routes/settings-capabilities.route.test.ts` drives the route against an
 * in-memory stand-in, which can prove the contract but not the containment: the
 * thing that keeps one tenant's capability write out of another tenant's row is
 * an RLS policy (migration 159), and a fake Map will always "pass" that.
 *
 * So this file writes through the mounted route against real Postgres and then
 * reads back:
 *  - the `tenant_feature_flags` row, with `updated_by` actually pinned to the
 *    acting user (the parameter has existed since RV-001 and nothing set it);
 *  - the `feature_flag.tenant_updated` audit row through the real
 *    `PgAuditRepository`;
 *  - **T1** — the other tenant's row is untouched, and under the UNPRIVILEGED
 *    `rls_app_runtime` role tenant B sees ZERO of tenant A's rows (with a
 *    negative control so the zero means containment, not a broken query);
 *  - **T3** — two tenants writing OPPOSITE values in ONE run, each resolved
 *    back through the production `isEnabledForTenant` path;
 *  - fail-closed — with no `app.current_tenant_id` GUC set, a SELECT on the
 *    table returns nothing to the unprivileged role rather than everything.
 *
 * Docker-gated. Run with the colima recipe:
 *   DOCKER_HOST=unix:///Users/joshuakay/.colima/default/docker.sock \
 *   TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE=/var/run/docker.sock \
 *   RLS_RUNTIME_ROLE=true \
 *   npx vitest run --config vitest.integration.config.ts \
 *     test/integration/tenant-feature-flag-write.test.ts
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import express, { Request, Response, NextFunction } from 'express';
import request from 'supertest';
import { Pool, PoolClient } from 'pg';
import { getSharedTestDb, createTestTenant, closeSharedTestDb } from './shared';
import { createSettingsRouter } from '../../src/routes/settings';
import { PgSettingsRepository } from '../../src/settings/pg-settings';
import { PgAuditRepository } from '../../src/audit/pg-audit';
import { PgTenantFeatureFlagRepository } from '../../src/flags/pg-tenant-feature-flags';
import { InMemoryFeatureFlagRepository } from '../../src/flags/feature-flags';
import { PgUserRepository } from '../../src/users/pg-user';
import { ensureTenantSettings } from '../../src/settings/settings';
import { DROPPED_CALL_RECOVERY_FLAG } from '../../src/workers/dropped-call-worker';
import { VOICE_VULNERABILITY_TRIAGE_FLAG } from '../../src/ai/agents/customer-calling/vulnerability-triage-hook';
import type { AuthenticatedRequest } from '../../src/auth/clerk';

const APP_ROLE = 'rls_app_runtime';

/** Production-shaped connection: unprivileged role + tenant GUC. Always rolls back. */
async function asTenant<T>(
  pool: Pool,
  tenantId: string | null,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SET LOCAL ROLE ${APP_ROLE}`);
    if (tenantId !== null) {
      await client.query("SELECT set_config('app.current_tenant_id', $1, true)", [tenantId]);
    }
    return await fn(client);
  } finally {
    await client.query('ROLLBACK').catch(() => undefined);
    client.release();
  }
}

describe('#1011 — owner capability write reaches tenant_feature_flags (real Postgres)', () => {
  let pool: Pool;
  let app: express.Express;
  let tenantFlags: PgTenantFeatureFlagRepository;
  let platformFlags: InMemoryFeatureFlagRepository;
  let auditRepo: PgAuditRepository;
  let current: { tenantId: string; userId: string };
  let tenantA: { tenantId: string; userId: string };
  let tenantB: { tenantId: string; userId: string };

  beforeAll(async () => {
    pool = await getSharedTestDb();
    const settingsRepo = new PgSettingsRepository(pool);
    auditRepo = new PgAuditRepository(pool);
    platformFlags = new InMemoryFeatureFlagRepository();
    tenantFlags = new PgTenantFeatureFlagRepository(pool, platformFlags);

    app = express();
    app.use(express.json());
    app.use((req: Request, _res: Response, next: NextFunction) => {
      (req as AuthenticatedRequest).auth = {
        userId: current.userId,
        sessionId: 'sess-caps',
        tenantId: current.tenantId,
        role: 'owner',
      };
      next();
    });
    app.use(
      '/api/settings',
      createSettingsRouter(settingsRepo, undefined, auditRepo, {
        tenantFlags,
        platformFlags,
        userRepo: new PgUserRepository(pool),
      }),
    );
  });

  beforeEach(async () => {
    tenantA = await createTestTenant(pool);
    tenantB = await createTestTenant(pool);
    const settingsRepo = new PgSettingsRepository(pool);
    await ensureTenantSettings(tenantA.tenantId, settingsRepo);
    await ensureTenantSettings(tenantB.tenantId, settingsRepo);
    current = tenantA;
    // Clear the platform flags IN PLACE rather than rebuilding the repo: the
    // router closed over this instance at mount, so a replacement object would
    // be written by the test and never read by the route — which is exactly
    // how the D5 case first passed a 200 it should have refused.
    for (const key of [DROPPED_CALL_RECOVERY_FLAG, VOICE_VULNERABILITY_TRIAGE_FLAG]) {
      await platformFlags.delete(key);
    }
  });

  afterAll(async () => {
    await closeSharedTestDb();
  });

  async function rawFlagRow(tenantId: string, flagKey: string) {
    const { rows } = await pool.query(
      `SELECT enabled, updated_by FROM tenant_feature_flags
        WHERE tenant_id = $1 AND flag_key = $2`,
      [tenantId, flagKey],
    );
    return rows[0] as { enabled: boolean; updated_by: string | null } | undefined;
  }

  it('writes a tenant_feature_flags row with updated_by pinned to the acting user', async () => {
    expect(await rawFlagRow(tenantA.tenantId, DROPPED_CALL_RECOVERY_FLAG)).toBeUndefined();

    const res = await request(app)
      .put(`/api/settings/capabilities/${DROPPED_CALL_RECOVERY_FLAG}`)
      .send({ enabled: true });
    expect(res.status).toBe(200);

    const row = await rawFlagRow(tenantA.tenantId, DROPPED_CALL_RECOVERY_FLAG);
    expect(row).toBeDefined();
    expect(row!.enabled).toBe(true);
    // The `updatedBy` parameter has existed since RV-001 and nothing set it.
    expect(row!.updated_by).toBe(tenantA.userId);
  });

  it('is idempotent: a second write updates the same row rather than erroring', async () => {
    await request(app)
      .put(`/api/settings/capabilities/${DROPPED_CALL_RECOVERY_FLAG}`)
      .send({ enabled: true });
    const off = await request(app)
      .put(`/api/settings/capabilities/${DROPPED_CALL_RECOVERY_FLAG}`)
      .send({ enabled: false });

    expect(off.status).toBe(200);
    expect(off.body.enabled).toBe(false);
    expect((await rawFlagRow(tenantA.tenantId, DROPPED_CALL_RECOVERY_FLAG))!.enabled).toBe(false);
  });

  it('lands a feature_flag.tenant_updated audit row through PgAuditRepository', async () => {
    await request(app)
      .put(`/api/settings/capabilities/${VOICE_VULNERABILITY_TRIAGE_FLAG}`)
      .send({ enabled: true });

    const events = await auditRepo.findRecentByTenant(tenantA.tenantId, { limit: 20 });
    const event = events.find((e) => e.eventType === 'feature_flag.tenant_updated');
    expect(event).toBeDefined();
    expect(event!.actorId).toBe(tenantA.userId);
    expect(event!.entityId).toBe(VOICE_VULNERABILITY_TRIAGE_FLAG);
    expect(event!.metadata).toMatchObject({
      scope: 'tenant',
      flagKey: VOICE_VULNERABILITY_TRIAGE_FLAG,
      value: { enabled: true },
    });
  });

  it('D5: a platform freeze blocks the write and leaves no row behind', async () => {
    await platformFlags.upsert({ name: DROPPED_CALL_RECOVERY_FLAG, enabled: false });

    const res = await request(app)
      .put(`/api/settings/capabilities/${DROPPED_CALL_RECOVERY_FLAG}`)
      .send({ enabled: true });

    expect(res.status).toBe(409);
    expect(await rawFlagRow(tenantA.tenantId, DROPPED_CALL_RECOVERY_FLAG)).toBeUndefined();
  });

  it('CONTAINMENT (D2): an unlisted key writes no row at all', async () => {
    const res = await request(app)
      .put('/api/settings/capabilities/supervisor_agent')
      .send({ enabled: false });

    expect(res.status).toBe(400);
    expect(await rawFlagRow(tenantA.tenantId, 'supervisor_agent')).toBeUndefined();
  });

  // ── T1 — cross-tenant containment ────────────────────────────────────────

  it("T1: tenant B's owner flipping the same key leaves tenant A's row untouched", async () => {
    current = tenantA;
    await request(app)
      .put(`/api/settings/capabilities/${DROPPED_CALL_RECOVERY_FLAG}`)
      .send({ enabled: true });

    current = tenantB;
    const bRes = await request(app)
      .put(`/api/settings/capabilities/${DROPPED_CALL_RECOVERY_FLAG}`)
      .send({ enabled: false });
    expect(bRes.status).toBe(200);

    expect((await rawFlagRow(tenantA.tenantId, DROPPED_CALL_RECOVERY_FLAG))!.enabled).toBe(true);
    expect((await rawFlagRow(tenantB.tenantId, DROPPED_CALL_RECOVERY_FLAG))!.enabled).toBe(false);
    expect((await rawFlagRow(tenantB.tenantId, DROPPED_CALL_RECOVERY_FLAG))!.updated_by).toBe(
      tenantB.userId,
    );
  });

  it('T1: under the unprivileged RLS role, tenant B sees ZERO of tenant A rows', async () => {
    current = tenantA;
    await request(app)
      .put(`/api/settings/capabilities/${DROPPED_CALL_RECOVERY_FLAG}`)
      .send({ enabled: true });

    const seenByB = await asTenant(pool, tenantB.tenantId, async (client) => {
      const { rows } = await client.query(
        'SELECT COUNT(*)::int AS n FROM tenant_feature_flags WHERE tenant_id = $1',
        [tenantA.tenantId],
      );
      return rows[0].n as number;
    });
    expect(seenByB).toBe(0);

    // Negative control — A's own context DOES see the row, so the zero above
    // is RLS containment and not a query that can never return anything.
    const seenByA = await asTenant(pool, tenantA.tenantId, async (client) => {
      const { rows } = await client.query(
        'SELECT COUNT(*)::int AS n FROM tenant_feature_flags WHERE tenant_id = $1',
        [tenantA.tenantId],
      );
      return rows[0].n as number;
    });
    expect(seenByA).toBe(1);
  });

  it("T1: tenant B cannot read tenant A's capability audit rows under the unprivileged role", async () => {
    current = tenantA;
    await request(app)
      .put(`/api/settings/capabilities/${DROPPED_CALL_RECOVERY_FLAG}`)
      .send({ enabled: true });

    const seenByB = await asTenant(pool, tenantB.tenantId, async (client) => {
      const { rows } = await client.query(
        `SELECT COUNT(*)::int AS n FROM audit_events
          WHERE tenant_id = $1 AND event_type = 'feature_flag.tenant_updated'`,
        [tenantA.tenantId],
      );
      return rows[0].n as number;
    });
    expect(seenByB).toBe(0);
  });

  // ── T3 — two tenants, opposite values, one run ───────────────────────────

  it('T3: A=true and B=false written through the route in one run each resolve to their own value', async () => {
    current = tenantA;
    await request(app)
      .put(`/api/settings/capabilities/${DROPPED_CALL_RECOVERY_FLAG}`)
      .send({ enabled: true });

    current = tenantB;
    await request(app)
      .put(`/api/settings/capabilities/${DROPPED_CALL_RECOVERY_FLAG}`)
      .send({ enabled: false });

    // Resolved through the SAME method the dropped-call worker gates on
    // (workers/dropped-call-worker.ts:148), not a hand-rolled SELECT.
    await expect(
      tenantFlags.isEnabledForTenant(tenantA.tenantId, DROPPED_CALL_RECOVERY_FLAG),
    ).resolves.toBe(true);
    await expect(
      tenantFlags.isEnabledForTenant(tenantB.tenantId, DROPPED_CALL_RECOVERY_FLAG),
    ).resolves.toBe(false);
  });

  it('T3: GET reads each tenant its OWN capability state in the same run', async () => {
    current = tenantA;
    await request(app)
      .put(`/api/settings/capabilities/${VOICE_VULNERABILITY_TRIAGE_FLAG}`)
      .send({ enabled: true });

    const aRead = await request(app).get('/api/settings/capabilities');
    current = tenantB;
    const bRead = await request(app).get('/api/settings/capabilities');

    expect(aRead.body[VOICE_VULNERABILITY_TRIAGE_FLAG]).toEqual({
      enabled: true,
      source: 'tenant',
    });
    expect(bRead.body[VOICE_VULNERABILITY_TRIAGE_FLAG]).toEqual({
      enabled: false,
      source: 'default',
    });
  });

  // ── Fail-closed ──────────────────────────────────────────────────────────

  it('fail-closed: with no tenant GUC set, the unprivileged role reads no rows', async () => {
    current = tenantA;
    await request(app)
      .put(`/api/settings/capabilities/${DROPPED_CALL_RECOVERY_FLAG}`)
      .send({ enabled: true });

    // Either the policy's `current_setting(...)::UUID` cast throws, or it
    // matches nothing. Both are fail-closed; what must never happen is rows
    // coming back.
    let rowCount: number | 'threw';
    try {
      rowCount = await asTenant(pool, null, async (client) => {
        const { rows } = await client.query(
          'SELECT COUNT(*)::int AS n FROM tenant_feature_flags',
        );
        return rows[0].n as number;
      });
    } catch {
      rowCount = 'threw';
    }
    expect(rowCount === 'threw' || rowCount === 0).toBe(true);
  });

  // ── The real auth shape ──────────────────────────────────────────────────
  //
  // Everything above feeds `req.auth.userId` a UUID, because `createTestTenant`
  // makes the users row's id and its clerk_user_id the same value. PRODUCTION
  // DOES NOT: `req.auth.userId` is the Clerk SUBJECT (`payload.sub`,
  // auth/clerk.ts:460) — `user_2abc…` in production, `dev_owner` under
  // DEV_AUTH_BYPASS (auth/dev-auth-bypass.ts:207/239/246) — while
  // `tenant_feature_flags.updated_by` is a UUID column (migration 159).
  //
  // So the tests above were passing on a fixture that cannot occur in
  // production, and the route 500s the first time a real owner touches it.
  // These cases pin the real shape.

  /** Point the tenant's users row at a Clerk-shaped subject, as production has it. */
  async function useClerkSubject(
    tenant: { tenantId: string; userId: string },
    subject: string,
  ) {
    await pool.query('UPDATE users SET clerk_user_id = $1 WHERE id = $2', [
      subject,
      tenant.userId,
    ]);
    current = { tenantId: tenant.tenantId, userId: subject };
  }

  it('accepts a Clerk-subject userId and stores the canonical users.id in updated_by', async () => {
    const subject = 'user_2capturetestSubjectAbc123';
    await useClerkSubject(tenantA, subject);

    const res = await request(app)
      .put(`/api/settings/capabilities/${DROPPED_CALL_RECOVERY_FLAG}`)
      .send({ enabled: true });

    expect(res.status).toBe(200);
    const row = await rawFlagRow(tenantA.tenantId, DROPPED_CALL_RECOVERY_FLAG);
    expect(row).toBeDefined();
    expect(row!.enabled).toBe(true);
    // The UUID of the users row, NOT the Clerk subject.
    expect(row!.updated_by).toBe(tenantA.userId);
  });

  it('accepts the DEV_AUTH_BYPASS subject (dev_owner) the same way', async () => {
    await useClerkSubject(tenantA, 'dev_owner');

    const res = await request(app)
      .put(`/api/settings/capabilities/${VOICE_VULNERABILITY_TRIAGE_FLAG}`)
      .send({ enabled: true });

    expect(res.status).toBe(200);
    expect(
      (await rawFlagRow(tenantA.tenantId, VOICE_VULNERABILITY_TRIAGE_FLAG))!.updated_by,
    ).toBe(tenantA.userId);
  });

  it('still audits under the CLERK SUBJECT, which audit_events.actor_id is TEXT for', async () => {
    const subject = 'user_2capturetestSubjectAbc123';
    await useClerkSubject(tenantA, subject);

    await request(app)
      .put(`/api/settings/capabilities/${DROPPED_CALL_RECOVERY_FLAG}`)
      .send({ enabled: true });

    const events = await auditRepo.findRecentByTenant(tenantA.tenantId, { limit: 20 });
    const event = events.find((e) => e.eventType === 'feature_flag.tenant_updated');
    expect(event).toBeDefined();
    // Deliberately NOT the users.id: the audit trail records who acted as the
    // authenticated principal, and every other audit row on this tenant keys
    // the same way.
    expect(event!.actorId).toBe(subject);
  });

  it('writes NULL updated_by rather than failing when the subject has no users row', async () => {
    // A subject with no matching users row must not cost the owner their
    // toggle — the column is nullable, so the attribution degrades, not the write.
    current = { tenantId: tenantA.tenantId, userId: 'user_2neverProvisioned' };

    const res = await request(app)
      .put(`/api/settings/capabilities/${DROPPED_CALL_RECOVERY_FLAG}`)
      .send({ enabled: true });

    expect(res.status).toBe(200);
    const row = await rawFlagRow(tenantA.tenantId, DROPPED_CALL_RECOVERY_FLAG);
    expect(row).toBeDefined();
    expect(row!.enabled).toBe(true);
    expect(row!.updated_by).toBeNull();
  });

  it('resolves a subject to the RIGHT tenant user, not another tenant with the same subject', async () => {
    const subject = 'user_2sharedAcrossTenants';
    await pool.query('UPDATE users SET clerk_user_id = $1 WHERE id = $2', [
      subject,
      tenantB.userId,
    ]);
    await useClerkSubject(tenantA, subject);

    await request(app)
      .put(`/api/settings/capabilities/${DROPPED_CALL_RECOVERY_FLAG}`)
      .send({ enabled: true });

    // Tenant A's row must carry A's users.id, never B's.
    expect((await rawFlagRow(tenantA.tenantId, DROPPED_CALL_RECOVERY_FLAG))!.updated_by).toBe(
      tenantA.userId,
    );
    expect(await rawFlagRow(tenantB.tenantId, DROPPED_CALL_RECOVERY_FLAG)).toBeUndefined();
  });
});
