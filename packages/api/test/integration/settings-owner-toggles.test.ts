/**
 * #1011 (wayfinder map #995) — the five owner-toggle settings at REAL Postgres.
 *
 * `test/routes/settings.strip.test.ts` proves the route echoes the keys back
 * against an in-memory repo. That is not the claim that matters: the silent-200
 * was only visible as a COLUMN that never moved. So every assertion here reads
 * the raw column back out of `tenant_settings`, and the audit event is read
 * back through the real `PgAuditRepository` (not an in-memory audit double) —
 * a settings write whose audit row never lands is the D2-1c failure mode.
 *
 * Tenant grades proven here (PRD §11.0e):
 *  - **T1** — a second tenant's PUT leaves the first tenant's column untouched,
 *    cross-checked through the UNPRIVILEGED `rls_app_runtime` role (the test
 *    pool is superuser and would otherwise bypass RLS entirely).
 *  - **T3** — two tenants carrying OPPOSITE values in ONE run, each read back
 *    through the production resolver `isWeeklyFeedbackEnabledForTenant`, which
 *    is what the weekly-feedback sweep actually calls.
 *
 * Docker-gated. Run with the colima recipe:
 *   DOCKER_HOST=unix:///Users/joshuakay/.colima/default/docker.sock \
 *   TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE=/var/run/docker.sock \
 *   RLS_RUNTIME_ROLE=true \
 *   npx vitest run --config vitest.integration.config.ts \
 *     test/integration/settings-owner-toggles.test.ts
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import express, { Request, Response, NextFunction } from 'express';
import request from 'supertest';
import { Pool, PoolClient } from 'pg';
import { getSharedTestDb, createTestTenant, closeSharedTestDb } from './shared';
import { createSettingsRouter } from '../../src/routes/settings';
import { PgSettingsRepository } from '../../src/settings/pg-settings';
import { PgAuditRepository } from '../../src/audit/pg-audit';
import { ensureTenantSettings } from '../../src/settings/settings';
import { isWeeklyFeedbackEnabledForTenant } from '../../src/digest/weekly-feedback-config';
import type { AuthenticatedRequest } from '../../src/auth/clerk';

const APP_ROLE = 'rls_app_runtime';

/**
 * Run `fn` on a connection that behaves like production: the unprivileged
 * NOBYPASSRLS role with `app.current_tenant_id` set for the transaction.
 * Mirrors tenant-isolation.leak.test.ts:80. Always rolls back.
 */
async function asTenant<T>(
  pool: Pool,
  tenantId: string,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SET LOCAL ROLE ${APP_ROLE}`);
    await client.query("SELECT set_config('app.current_tenant_id', $1, true)", [tenantId]);
    return await fn(client);
  } finally {
    await client.query('ROLLBACK').catch(() => undefined);
    client.release();
  }
}

describe('#1011 — owner-toggle settings reach tenant_settings (real Postgres)', () => {
  let pool: Pool;
  let app: express.Express;
  let settingsRepo: PgSettingsRepository;
  let auditRepo: PgAuditRepository;
  let current: { tenantId: string; userId: string };
  let tenantA: { tenantId: string; userId: string };
  let tenantB: { tenantId: string; userId: string };

  beforeAll(async () => {
    pool = await getSharedTestDb();
    settingsRepo = new PgSettingsRepository(pool);
    auditRepo = new PgAuditRepository(pool);

    app = express();
    app.use(express.json());
    app.use((req: Request, _res: Response, next: NextFunction) => {
      (req as AuthenticatedRequest).auth = {
        userId: current.userId,
        sessionId: 'sess-1011',
        tenantId: current.tenantId,
        role: 'owner',
      };
      next();
    });
    app.use('/api/settings', createSettingsRouter(settingsRepo, undefined, auditRepo));
  });

  beforeEach(async () => {
    tenantA = await createTestTenant(pool);
    tenantB = await createTestTenant(pool);
    await ensureTenantSettings(tenantA.tenantId, settingsRepo);
    await ensureTenantSettings(tenantB.tenantId, settingsRepo);
    current = tenantA;
  });

  afterAll(async () => {
    await closeSharedTestDb();
  });

  async function rawColumn<T>(tenantId: string, column: string): Promise<T> {
    const { rows } = await pool.query(
      `SELECT ${column} AS v FROM tenant_settings WHERE tenant_id = $1`,
      [tenantId],
    );
    return rows[0]?.v as T;
  }

  it('flips send_thank_you_sms off in the column (the silent-200 made visible)', async () => {
    // The column ships NOT NULL DEFAULT TRUE (db/schema.ts:4848).
    expect(await rawColumn<boolean>(tenantA.tenantId, 'send_thank_you_sms')).toBe(true);

    const res = await request(app).put('/api/settings').send({ sendThankYouSms: false });
    expect(res.status).toBe(200);

    expect(await rawColumn<boolean>(tenantA.tenantId, 'send_thank_you_sms')).toBe(false);
  });

  it('flips send_review_request and weekly_feedback_enabled off in their columns', async () => {
    const res = await request(app)
      .put('/api/settings')
      .send({ sendReviewRequest: false, weeklyFeedbackEnabled: false });
    expect(res.status).toBe(200);

    expect(await rawColumn<boolean>(tenantA.tenantId, 'send_review_request')).toBe(false);
    expect(await rawColumn<boolean>(tenantA.tenantId, 'weekly_feedback_enabled')).toBe(false);
  });

  it('writes autonomous_close_enabled + autonomous_close_max_cents, and clears the cap with null', async () => {
    const on = await request(app)
      .put('/api/settings')
      .send({ autonomousCloseEnabled: true, autonomousCloseMaxCents: 75_000 });
    expect(on.status).toBe(200);

    expect(await rawColumn<boolean>(tenantA.tenantId, 'autonomous_close_enabled')).toBe(true);
    // BIGINT comes back as a string from node-pg.
    expect(String(await rawColumn(tenantA.tenantId, 'autonomous_close_max_cents'))).toBe('75000');

    const cleared = await request(app).put('/api/settings').send({ autonomousCloseMaxCents: null });
    expect(cleared.status).toBe(200);
    expect(await rawColumn(tenantA.tenantId, 'autonomous_close_max_cents')).toBeNull();
  });

  it('lands a settings.tenant.updated audit row through PgAuditRepository with the key in changedKeys', async () => {
    const res = await request(app).put('/api/settings').send({ sendThankYouSms: false });
    expect(res.status).toBe(200);

    const events = await auditRepo.findRecentByTenant(tenantA.tenantId, { limit: 20 });
    const settingsEvent = events.find((e) => e.eventType === 'settings.tenant.updated');
    expect(settingsEvent).toBeDefined();
    expect(settingsEvent!.actorId).toBe(tenantA.userId);
    expect(settingsEvent!.metadata?.changedKeys).toContain('sendThankYouSms');
  });

  // ── T1 — cross-tenant containment ────────────────────────────────────────

  it('T1: tenant B turning the toggle off leaves tenant A untouched', async () => {
    current = tenantB;
    const res = await request(app).put('/api/settings').send({ sendThankYouSms: false });
    expect(res.status).toBe(200);

    expect(await rawColumn<boolean>(tenantB.tenantId, 'send_thank_you_sms')).toBe(false);
    // Another tenant's write must not move this tenant's column.
    expect(await rawColumn<boolean>(tenantA.tenantId, 'send_thank_you_sms')).toBe(true);
  });

  it('T1: under the unprivileged RLS role, tenant B sees ZERO of tenant A settings rows', async () => {
    current = tenantA;
    await request(app).put('/api/settings').send({ sendThankYouSms: false });

    const visibleToB = await asTenant(pool, tenantB.tenantId, async (client) => {
      const { rows } = await client.query(
        'SELECT COUNT(*)::int AS n FROM tenant_settings WHERE tenant_id = $1',
        [tenantA.tenantId],
      );
      return rows[0].n as number;
    });
    expect(visibleToB).toBe(0);

    // Negative control: the same query under tenant A's own context DOES see it,
    // so the zero above is RLS containment and not a broken query.
    const visibleToA = await asTenant(pool, tenantA.tenantId, async (client) => {
      const { rows } = await client.query(
        'SELECT COUNT(*)::int AS n FROM tenant_settings WHERE tenant_id = $1',
        [tenantA.tenantId],
      );
      return rows[0].n as number;
    });
    expect(visibleToA).toBe(1);
  });

  it('T1: tenant B cannot read tenant A settings audit rows under the unprivileged role', async () => {
    current = tenantA;
    await request(app).put('/api/settings').send({ weeklyFeedbackEnabled: false });

    const auditVisibleToB = await asTenant(pool, tenantB.tenantId, async (client) => {
      const { rows } = await client.query(
        `SELECT COUNT(*)::int AS n FROM audit_events
          WHERE tenant_id = $1 AND event_type = 'settings.tenant.updated'`,
        [tenantA.tenantId],
      );
      return rows[0].n as number;
    });
    expect(auditVisibleToB).toBe(0);
  });

  // ── T3 — two tenants, opposite values, one run ───────────────────────────

  it('T3: two tenants write OPPOSITE weekly-feedback values in one run and each reads its own back', async () => {
    current = tenantA;
    const aRes = await request(app).put('/api/settings').send({ weeklyFeedbackEnabled: false });
    expect(aRes.status).toBe(200);

    current = tenantB;
    const bRes = await request(app).put('/api/settings').send({ weeklyFeedbackEnabled: true });
    expect(bRes.status).toBe(200);

    // Read back through the PRODUCTION resolver the weekly-feedback sweep calls
    // (digest/weekly-feedback-config.ts:51), not a hand-rolled SELECT.
    await expect(
      isWeeklyFeedbackEnabledForTenant(settingsRepo, tenantA.tenantId),
    ).resolves.toBe(false);
    await expect(
      isWeeklyFeedbackEnabledForTenant(settingsRepo, tenantB.tenantId),
    ).resolves.toBe(true);
  });

  it('T3: two tenants write OPPOSITE thank-you-SMS values in one run', async () => {
    current = tenantA;
    await request(app).put('/api/settings').send({ sendThankYouSms: false });
    current = tenantB;
    await request(app).put('/api/settings').send({ sendThankYouSms: true });

    expect(await rawColumn<boolean>(tenantA.tenantId, 'send_thank_you_sms')).toBe(false);
    expect(await rawColumn<boolean>(tenantB.tenantId, 'send_thank_you_sms')).toBe(true);
  });
});
