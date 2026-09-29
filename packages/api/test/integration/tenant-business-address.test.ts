/**
 * #1402 §13 — the tenant business address at real Postgres
 * (`tenant_settings.business_address`, migration 299).
 *
 * Seam: PUT/GET /api/settings over PgSettingsRepository.
 */
import express, { Request, Response, NextFunction } from 'express';
import request from 'supertest';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { randomUUID } from 'crypto';

import { getSharedTestDb, createTestTenant, closeSharedTestDb, type TestTenant } from './shared';
import { PgSettingsRepository } from '../../src/settings/pg-settings';
import { createSettingsRouter } from '../../src/routes/settings';
import type { AuthenticatedRequest } from '../../src/auth/clerk';

describe('Postgres integration — #1402 tenant business address', () => {
  let pool: Pool;
  let settingsRepo: PgSettingsRepository;

  async function seedSettings(t: TestTenant) {
    const now = new Date();
    await settingsRepo.create({
      id: randomUUID(),
      tenantId: t.tenantId,
      businessName: 'Address Co',
      timezone: 'America/Phoenix',
      estimatePrefix: 'EST-',
      invoicePrefix: 'INV-',
      nextEstimateNumber: 1,
      nextInvoiceNumber: 1,
      defaultPaymentTermDays: 30,
      createdAt: now,
      updatedAt: now,
    });
  }

  function appFor(t: TestTenant) {
    const app = express();
    app.use(express.json());
    app.use((req: Request, _res: Response, next: NextFunction) => {
      (req as AuthenticatedRequest).auth = {
        userId: 'owner-1402',
        sessionId: 's',
        tenantId: t.tenantId,
        role: 'owner',
      };
      next();
    });
    app.use('/api/settings', createSettingsRouter(settingsRepo));
    return app;
  }

  beforeAll(async () => {
    pool = await getSharedTestDb();
    settingsRepo = new PgSettingsRepository(pool);
  }, 120_000);

  afterAll(async () => {
    await closeSharedTestDb();
  });

  it('round-trips, clears with null, and never leaks to a neighbour tenant', async () => {
    const acting = await createTestTenant(pool);
    const neighbour = await createTestTenant(pool);
    await seedSettings(acting);
    await seedSettings(neighbour);
    const app = appFor(acting);

    await request(app)
      .put('/api/settings')
      .send({ businessAddress: '1200 W Main St\nMesa, AZ 85201' })
      .expect(200);
    expect((await request(app).get('/api/settings')).body.businessAddress).toBe(
      '1200 W Main St\nMesa, AZ 85201',
    );
    expect((await request(appFor(neighbour)).get('/api/settings')).body.businessAddress)
      .toBeUndefined();

    await request(app).put('/api/settings').send({ businessAddress: null }).expect(200);
    expect((await request(app).get('/api/settings')).body.businessAddress).toBeUndefined();
  });
});
