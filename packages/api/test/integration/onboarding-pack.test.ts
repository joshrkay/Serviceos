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

describe('POST /api/onboarding/pack', () => {
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

  it('rejects unknown packId with 400 VALIDATION_ERROR', async () => {
    const res = await request(app).post('/api/onboarding/pack').send({
      packId: 'electrical',
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('VALIDATION_ERROR');
  });

  it('activates hvac pack and step 3 becomes done', async () => {
    const res = await request(app).post('/api/onboarding/pack').send({
      packId: 'hvac',
    });
    expect(res.status).toBe(200);
    expect(res.body.packId).toBe('hvac');

    // Verify pack status in GET /status
    const status = await request(app).get('/api/onboarding/status');
    expect(status.body.steps.find((s: any) => s.id === 'pack').status).toBe('done');

    // Verify activeVerticalPacks in DB
    const dbRow = await pool.query(
      'SELECT terminology_preferences FROM tenant_settings WHERE tenant_id=$1',
      [currentTenant.tenantId]
    );
    expect(dbRow.rows[0].terminology_preferences._activeVerticalPacks).toEqual(['hvac']);
  });

  it('is idempotent: activating hvac twice results in single entry', async () => {
    // First activation
    await request(app).post('/api/onboarding/pack').send({ packId: 'hvac' });
    // Second activation
    await request(app).post('/api/onboarding/pack').send({ packId: 'hvac' });

    const dbRow = await pool.query(
      'SELECT terminology_preferences FROM tenant_settings WHERE tenant_id=$1',
      [currentTenant.tenantId]
    );
    expect(dbRow.rows[0].terminology_preferences._activeVerticalPacks).toEqual(['hvac']);
    expect(dbRow.rows[0].terminology_preferences._activeVerticalPacks.length).toBe(1);
  });
});
