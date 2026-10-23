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
 *
 * The retry's verify-ai job is enqueued on the same request client
 * (`PgQueue.sendOn`, the P0-009 transactional enqueue). `queue.send` committed
 * the job on its own connection before the audit write, so a request that then
 * rolled back still ran the retry, with no audit row for it. The retry tests
 * use a real PgQueue and read `_queue_messages` back.
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
import { InMemoryQueue, type Queue } from '../../src/queues/queue';
import { PgQueue } from '../../src/queues/pg-queue';
import { VERIFY_AI_JOB_TYPE } from '../../src/workers/verify-ai';
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

/** The retry's verify-ai jobs for `tenantId` in the real queue table. */
async function retryJobs(tenantId: string): Promise<Array<{ type: string; payload: unknown }>> {
  const exists = await pool.query<{ t: string | null }>(`SELECT to_regclass('public._queue_messages')::text AS t`);
  if (!exists.rows[0].t) return [];
  const { rows } = await pool.query<{ type: string; payload: unknown }>(
    `SELECT type, payload FROM _queue_messages WHERE idempotency_key = $1`,
    [`verify-ai-retry-${tenantId}`],
  );
  return rows;
}

async function clearRetryJobs(...tenantIds: string[]): Promise<void> {
  const exists = await pool.query<{ t: string | null }>(`SELECT to_regclass('public._queue_messages')::text AS t`);
  if (!exists.rows[0].t) return;
  await pool.query(`DELETE FROM _queue_messages WHERE idempotency_key = ANY($1::text[])`, [
    tenantIds.map((id) => `verify-ai-retry-${id}`),
  ]);
}

function buildApp(auditRepo: AuditRepository, actingTenant: TestTenant, queue: Queue = new InMemoryQueue()) {
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
      queue,
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

afterEach(async () => {
  if (ORIGINAL_FLAG === undefined) delete process.env.RLS_RUNTIME_ROLE;
  else process.env.RLS_RUNTIME_ROLE = ORIGINAL_FLAG;
  await clearRetryJobs(a.tenantId, b.tenantId);
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
  it('resets its own tenant to pending only, under rls_app_runtime, with its audit row and its job', async () => {
    const auditRepo = new PgAuditRepository(probe.pool);
    const res = await request(buildApp(auditRepo, a, new PgQueue(probe.pool)))
      .post('/api/onboarding/ai-check/retry')
      .send({});

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

    expect(await retryJobs(a.tenantId)).toEqual([{ type: VERIFY_AI_JOB_TYPE, payload: { tenantId: a.tenantId } }]);
    expect(await retryJobs(b.tenantId)).toEqual([]);
  });

  it('rolls the reset back and enqueues no job when its audit write fails', async () => {
    const auditRepo = new Tier2FailingAuditRepository(
      new PgAuditRepository(probe.pool),
      'tenant.ai_verification_retry',
    );
    const res = await request(buildApp(auditRepo, a, new PgQueue(probe.pool)))
      .post('/api/onboarding/ai-check/retry')
      .send({});

    expect(res.status).toBe(500);
    expect(auditRepo.attemptedTier2).toBe(1);
    expect(await readSettings(a.tenantId)).toMatchObject({
      ai_verification_status: 'failed',
      ai_verification_error: 'boom',
    });
    expect(await retryJobs(a.tenantId)).toEqual([]);
  });
});
