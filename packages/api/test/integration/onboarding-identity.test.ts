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

describe('PUT /api/onboarding/identity', () => {
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

  it('rejects payload missing businessName with 400', async () => {
    const res = await request(app).put('/api/onboarding/identity').send({
      businessHours: {}, jobBufferMinutes: 30, hourlyRateCents: 10000,
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('VALIDATION_ERROR');
  });

  it('upserts on valid payload (no prior row) and step 2 becomes done', async () => {
    const payload = {
      businessName: 'Acme HVAC',
      serviceAreaText: 'Austin, TX',
      serviceAreaRadius: 25,
      businessHours: { mon: { open: '08:00', close: '17:00' }, sat: null, sun: null },
      jobBufferMinutes: 45,
      hourlyRateCents: 15000,
      // The real client always sends this (IdentityStep pre-fills
      // `detectBrowserTimezone()`), and `isIdentityDone`
      // (onboarding/derive-status.ts) now requires it: a tenant with no
      // chosen zone cannot book at all — CreateAppointmentTaskHandler turns
      // every spoken booking into a timezone clarification rather than guess
      // one (Phoenix mis-booking postmortem, migration 263). Omitting it here
      // made the fixture assert a "done" identity step for a tenant the
      // product cannot actually serve.
      timezone: 'America/Chicago',
    };
    const res = await request(app).put('/api/onboarding/identity').send(payload);
    expect(res.status).toBe(200);

    const status = await request(app).get('/api/onboarding/status');
    expect(status.body.steps.find((s: any) => s.id === 'identity').status).toBe('done');

    const dbRow = await pool.query('SELECT * FROM tenant_settings WHERE tenant_id=$1', [currentTenant.tenantId]);
    expect(dbRow.rows[0].business_name).toBe('Acme HVAC');
    expect(dbRow.rows[0].hourly_rate_cents).toBe(15000);
    expect(dbRow.rows[0].job_buffer_minutes).toBe(45);
    expect(dbRow.rows[0].service_area_text).toBe('Austin, TX');
  });

  it('updates an existing tenant_settings row in place (idempotent)', async () => {
    // First PUT
    await request(app).put('/api/onboarding/identity').send({
      businessName: 'V1', businessHours: { mon: null }, jobBufferMinutes: 30, hourlyRateCents: 10000,
    });
    // Second PUT updates
    const res = await request(app).put('/api/onboarding/identity').send({
      businessName: 'V2', businessHours: { mon: null }, jobBufferMinutes: 60, hourlyRateCents: 20000,
    });
    expect(res.status).toBe(200);
    const dbRow = await pool.query('SELECT business_name, job_buffer_minutes, hourly_rate_cents FROM tenant_settings WHERE tenant_id=$1', [currentTenant.tenantId]);
    expect(dbRow.rows[0].business_name).toBe('V2');
    expect(dbRow.rows[0].job_buffer_minutes).toBe(60);
    expect(dbRow.rows[0].hourly_rate_cents).toBe(20000);
  });

  // #874 — service_area_radius is tri-state against the REAL upsert SQL
  // (the CASE/COALESCE split lives in pg-settings.ts, so only Postgres can
  // prove it): omitted keeps the stored radius, explicit null clears it.
  it('serviceAreaRadius: omitted keeps the stored value, null clears it (#874)', async () => {
    const base = {
      businessName: 'Radius Co',
      businessHours: { mon: null },
      jobBufferMinutes: 30,
      hourlyRateCents: 10000,
    };
    await request(app).put('/api/onboarding/identity').send({ ...base, serviceAreaRadius: 30 });

    // Omitted → kept.
    await request(app).put('/api/onboarding/identity').send(base);
    let row = await pool.query(
      'SELECT service_area_radius FROM tenant_settings WHERE tenant_id=$1',
      [currentTenant.tenantId],
    );
    expect(row.rows[0].service_area_radius).toBe(30);

    // Explicit null → cleared.
    const res = await request(app)
      .put('/api/onboarding/identity')
      .send({ ...base, serviceAreaRadius: null });
    expect(res.status).toBe(200);
    row = await pool.query(
      'SELECT service_area_radius FROM tenant_settings WHERE tenant_id=$1',
      [currentTenant.tenantId],
    );
    expect(row.rows[0].service_area_radius).toBeNull();
  });

  it('emits a tenant.identity_set audit event', async () => {
    await request(app).put('/api/onboarding/identity').send({
      businessName: 'A', businessHours: { mon: null }, jobBufferMinutes: 30, hourlyRateCents: 10000,
    });
    const ev = await pool.query(
      "SELECT * FROM audit_events WHERE tenant_id=$1 AND event_type='tenant.identity_set'",
      [currentTenant.tenantId]
    );
    expect(ev.rows.length).toBe(1);
  });
});
