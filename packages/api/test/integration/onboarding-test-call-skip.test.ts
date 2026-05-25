import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import express, { Request, Response, NextFunction } from 'express';
import request from 'supertest';
import { Pool } from 'pg';
import { getSharedTestDb, createTestTenant, closeSharedTestDb } from './shared';
import { createOnboardingRouter } from '../../src/routes/onboarding';
import { PgSettingsRepository } from '../../src/settings/pg-settings';
import { PgPackActivationRepository } from '../../src/settings/pg-pack-activation';
import { PgAuditRepository } from '../../src/audit/pg-audit';
import type { AuthenticatedRequest } from '../../src/auth/clerk';

describe('POST /api/onboarding/test-call/skip', () => {
  let pool: Pool;
  let app: express.Express;
  let currentTenant: { tenantId: string; userId: string };

  beforeAll(async () => {
    pool = await getSharedTestDb();
    const settingsRepo = new PgSettingsRepository(pool);
    const packActivationRepo = new PgPackActivationRepository(pool);
    const auditRepo = new PgAuditRepository(pool);

    app = express();
    app.use(express.json());
    app.use((req: Request, _res: Response, next: NextFunction) => {
      (req as AuthenticatedRequest).auth = {
        userId: currentTenant.userId,
        sessionId: 'sess-test',
        tenantId: currentTenant.tenantId,
        role: 'owner',
      };
      next();
    });
    app.use('/api/onboarding', createOnboardingRouter({ settingsRepo, packActivationRepo, auditRepo, pool }));
  });

  beforeEach(async () => {
    currentTenant = await createTestTenant(pool);
  });

  afterAll(async () => {
    await closeSharedTestDb();
  });

  it('sets onboarding_test_call_skipped_at and returns status with test_call skipped', async () => {
    const res = await request(app).post('/api/onboarding/test-call/skip').send({});
    expect(res.status).toBe(200);
    expect(res.body.steps).toBeDefined();
    expect(res.body.steps.length).toBe(7);
    const testCallStep = res.body.steps.find((s: { id: string }) => s.id === 'test_call');
    expect(testCallStep.id).toBe('test_call');
    expect(testCallStep.status).toBe('skipped');

    // Verify DB column is set
    const dbRow = await pool.query(
      'SELECT onboarding_test_call_skipped_at FROM tenant_settings WHERE tenant_id=$1',
      [currentTenant.tenantId]
    );
    expect(dbRow.rows[0].onboarding_test_call_skipped_at).not.toBeNull();
  });

  it('emits a tenant.test_call_skipped audit event', async () => {
    await request(app).post('/api/onboarding/test-call/skip').send({});
    const ev = await pool.query(
      "SELECT * FROM audit_events WHERE tenant_id=$1 AND event_type='tenant.test_call_skipped'",
      [currentTenant.tenantId]
    );
    expect(ev.rows.length).toBe(1);
    expect(ev.rows[0].entity_type).toBe('tenant_settings');
  });
});
