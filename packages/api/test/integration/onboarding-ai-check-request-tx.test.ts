/**
 * Postgres integration — POST /api/onboarding/ai-check/retry and /skip write
 * tenant_settings inside the request transaction, under the RLS runtime role.
 *
 * Both handlers used a private `tenantWrite` helper that checked out a SECOND
 * pooled connection and ran `set_config('app.current_tenant_id', $1, true)`
 * outside any BEGIN. That GUC is transaction-local, so it died with its own
 * implicit transaction: the UPDATE ran as the privileged connection principal
 * with no tenant GUC and no role, and it committed on its own. A request whose
 * audit write then failed answered 500 but kept the settings change, with no
 * audit row for it.
 *
 * The suite mounts the real `withTenantTransaction` middleware, forces
 * RLS_RUNTIME_ROLE on, and asks Postgres (statement-role-probe) which role and
 * tenant each UPDATE ran under.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import express, { NextFunction, Request, Response } from 'express';
import request from 'supertest';
import type { Pool } from 'pg';
import { closeSharedTestDb, createTestTenant, getSharedTestDb, type TestTenant } from './shared';
import { probeStatementRoles, type StatementRoleProbe } from './statement-role-probe';
import { Tier2FailingAuditRepository } from './tier2-failing-audit';
import { createOnboardingRouter } from '../../src/routes/onboarding';
import { withTenantTransaction } from '../../src/middleware/tenant-context';
import { PgSettingsRepository } from '../../src/settings/pg-settings';
import { PgPackActivationRepository } from '../../src/settings/pg-pack-activation';
import { PgAuditRepository } from '../../src/audit/pg-audit';
import { InMemoryQueue } from '../../src/queues/queue';
import type { AuditRepository } from '../../src/audit/audit';
import type { AuthenticatedRequest } from '../../src/auth/clerk';

const ORIGINAL_FLAG = process.env.RLS_RUNTIME_ROLE;

let pool: Pool;
let probe: StatementRoleProbe;
let a: TestTenant;
let b: TestTenant;

async function seedSettings(tenantId: string): Promise<void> {
  // Superuser fixture write (bypasses RLS), so both tenants start identical.
  await pool.query(
    `INSERT INTO tenant_settings (id, tenant_id, business_name, timezone, estimate_prefix, invoice_prefix,
                                  next_estimate_number, next_invoice_number, default_payment_term_days,
                                  ai_verification_status, ai_verification_error)
     VALUES (gen_random_uuid(), $1, 'Acme', 'America/New_York', 'EST', 'INV', 1, 1, 30, 'failed', 'boom')`,
    [tenantId],
  );
}

async function readSettings(tenantId: string) {
  const { rows } = await pool.query<{
    ai_verification_status: string | null;
    ai_verification_error: string | null;
    ai_verification_skipped_at: Date | null;
  }>(
    `SELECT ai_verification_status, ai_verification_error, ai_verification_skipped_at
       FROM tenant_settings WHERE tenant_id = $1`,
    [tenantId],
  );
  return rows[0];
}

function buildApp(auditRepo: AuditRepository, actingTenant: TestTenant) {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as AuthenticatedRequest).auth = {
      userId: actingTenant.userId,
      sessionId: 'sess-test',
      tenantId: actingTenant.tenantId,
      role: 'owner',
    };
    next();
  });
  app.use('/api', withTenantTransaction(probe.pool));
  app.use(
    '/api/onboarding',
    createOnboardingRouter({
      settingsRepo: new PgSettingsRepository(probe.pool),
      packActivationRepo: new PgPackActivationRepository(probe.pool),
      auditRepo,
      pool: probe.pool,
      queue: new InMemoryQueue(),
    }),
  );
  return app;
}

beforeAll(async () => {
  pool = await getSharedTestDb();
});

beforeEach(async () => {
  process.env.RLS_RUNTIME_ROLE = 'true';
  probe = probeStatementRoles(pool, /UPDATE tenant_settings/);
  a = await createTestTenant(pool);
  b = await createTestTenant(pool);
  await seedSettings(a.tenantId);
  await seedSettings(b.tenantId);
});

afterEach(() => {
  if (ORIGINAL_FLAG === undefined) delete process.env.RLS_RUNTIME_ROLE;
  else process.env.RLS_RUNTIME_ROLE = ORIGINAL_FLAG;
});

afterAll(async () => {
  await closeSharedTestDb();
});

describe('POST /api/onboarding/ai-check/skip (real Postgres, request transaction)', () => {
  it('records the skip for its own tenant only, under rls_app_runtime, with its audit row', async () => {
    const auditRepo = new PgAuditRepository(probe.pool);
    const res = await request(buildApp(auditRepo, a)).post('/api/onboarding/ai-check/skip').send({});

    expect(res.status).toBe(200);
    expect((await readSettings(a.tenantId)).ai_verification_skipped_at).toBeInstanceOf(Date);
    expect((await readSettings(b.tenantId)).ai_verification_skipped_at).toBeNull();

    expect(probe.seen).toHaveLength(1);
    expect(probe.seen[0]).toMatchObject({ role: 'rls_app_runtime', tenantGuc: a.tenantId });

    const audit = await new PgAuditRepository(pool).findByEntity(a.tenantId, 'tenant_settings', a.tenantId);
    expect(audit.filter((e) => e.eventType === 'tenant.ai_verification_skipped')).toHaveLength(1);
  });

  it('rolls the skip back when its audit write fails (one transaction, not two)', async () => {
    const auditRepo = new Tier2FailingAuditRepository(
      new PgAuditRepository(probe.pool),
      'tenant.ai_verification_skipped',
    );
    const res = await request(buildApp(auditRepo, a)).post('/api/onboarding/ai-check/skip').send({});

    expect(res.status).toBe(500);
    expect(auditRepo.attemptedTier2).toBe(1);
    expect((await readSettings(a.tenantId)).ai_verification_skipped_at).toBeNull();
  });
});

describe('POST /api/onboarding/ai-check/retry (real Postgres, request transaction)', () => {
  it('resets its own tenant to pending only, under rls_app_runtime, with its audit row', async () => {
    const auditRepo = new PgAuditRepository(probe.pool);
    const res = await request(buildApp(auditRepo, a)).post('/api/onboarding/ai-check/retry').send({});

    expect(res.status).toBe(200);
    expect(await readSettings(a.tenantId)).toMatchObject({
      ai_verification_status: 'pending',
      ai_verification_error: null,
    });
    expect(await readSettings(b.tenantId)).toMatchObject({
      ai_verification_status: 'failed',
      ai_verification_error: 'boom',
    });

    expect(probe.seen).toHaveLength(1);
    expect(probe.seen[0]).toMatchObject({ role: 'rls_app_runtime', tenantGuc: a.tenantId });

    const audit = await new PgAuditRepository(pool).findByEntity(a.tenantId, 'tenant_settings', a.tenantId);
    expect(audit.filter((e) => e.eventType === 'tenant.ai_verification_retry')).toHaveLength(1);
  });

  it('rolls the reset back when its audit write fails', async () => {
    const auditRepo = new Tier2FailingAuditRepository(
      new PgAuditRepository(probe.pool),
      'tenant.ai_verification_retry',
    );
    const res = await request(buildApp(auditRepo, a)).post('/api/onboarding/ai-check/retry').send({});

    expect(res.status).toBe(500);
    expect(auditRepo.attemptedTier2).toBe(1);
    expect(await readSettings(a.tenantId)).toMatchObject({
      ai_verification_status: 'failed',
      ai_verification_error: 'boom',
    });
  });
});
