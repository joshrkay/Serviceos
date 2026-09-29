/**
 * #1402 §3/§15 — at real Postgres, through the real appointment router:
 *   - a start in the past is refused (400 VALIDATION_ERROR) and no row lands;
 *   - outside the tenant's business hours (read from the real
 *     tenant_settings.business_hours JSONB via PgSettingsRepository) the
 *     appointment IS written and the response carries the warning;
 *   - a tenant with no business hours configured gets no warning.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express, { Express, NextFunction, Request, Response } from 'express';
import request from 'supertest';
import { Pool } from 'pg';
import { getSharedTestDb, closeSharedTestDb } from './shared';
import { bootstrapTenant } from '../../src/auth/clerk';
import type { AuthenticatedRequest } from '../../src/auth/clerk';
import { PgTenantRepository } from '../../src/auth/pg-tenant';
import { createAppointmentRouter } from '../../src/routes/appointments';
import { PgAppointmentRepository } from '../../src/appointments/pg-appointment';
import { PgCustomerRepository } from '../../src/customers/pg-customer';
import { PgLocationRepository } from '../../src/locations/pg-location';
import { PgJobRepository } from '../../src/jobs/pg-job';
import { PgSettingsRepository } from '../../src/settings/pg-settings';
import { permissiveTenantOwnership } from '../../src/shared/tenant-ownership';
import type { JobTimelineRepository } from '../../src/jobs/job-lifecycle';

const EVERY_DAY_8_TO_5 = Object.fromEntries(
  ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'].map((d) => [d, { open: '08:00', close: '17:00' }]),
);

/** A UTC instant `days` from today at `hh:00`. */
function futureAt(days: number, hh: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  d.setUTCHours(hh, 0, 0, 0);
  return d.toISOString();
}

describe('Postgres integration — #1402 appointment past-start block + business-hours warning', () => {
  let pool: Pool;
  let settingsRepo: PgSettingsRepository;
  let appointmentRepo: PgAppointmentRepository;

  beforeAll(async () => {
    pool = await getSharedTestDb();
    settingsRepo = new PgSettingsRepository(pool);
    appointmentRepo = new PgAppointmentRepository(pool);
  });

  afterAll(async () => {
    await closeSharedTestDb();
  });

  async function tenantWithJob(label: string) {
    const userId = `user_1402_${label}_${crypto.randomUUID().replace(/-/g, '')}`;
    const boot = await bootstrapTenant(userId, `${label}-${Date.now()}@example.com`, new PgTenantRepository(pool), {
      settingsRepository: settingsRepo,
    });
    const tenantId = boot.tenantId;
    const customerId = crypto.randomUUID();
    await new PgCustomerRepository(pool).create({
      id: customerId, tenantId, firstName: 'Hours', lastName: 'Check', displayName: 'Hours Check',
      preferredChannel: 'phone', smsConsent: false, isArchived: false, createdBy: userId,
      createdAt: new Date(), updatedAt: new Date(),
    });
    const locationId = crypto.randomUUID();
    await new PgLocationRepository(pool).create({
      id: locationId, tenantId, customerId, street1: '1 Main St', city: 'Austin', state: 'TX',
      postalCode: '78701', country: 'USA', isPrimary: true, isArchived: false,
      createdAt: new Date(), updatedAt: new Date(),
    });
    const jobId = crypto.randomUUID();
    const jobRepo = new PgJobRepository(pool);
    await jobRepo.create({
      id: jobId, tenantId, customerId, locationId, jobNumber: `JOB-1402-${jobId.slice(0, 6)}`,
      summary: 'Hours check visit', status: 'new', priority: 'normal', createdBy: userId,
      createdAt: new Date(), updatedAt: new Date(),
    });

    const app: Express = express();
    app.use(express.json());
    app.use((req: Request, _res: Response, next: NextFunction) => {
      (req as AuthenticatedRequest).auth = { userId, sessionId: 'sess-1402', tenantId, role: 'owner' };
      next();
    });
    app.use(
      '/api/appointments',
      createAppointmentRouter(
        appointmentRepo,
        permissiveTenantOwnership(),
        jobRepo,
        {} as JobTimelineRepository,
        { settingsRepo },
      ),
    );
    return { tenantId, jobId, app };
  }

  it('refuses a start in the past and writes nothing', async () => {
    const { tenantId, jobId, app } = await tenantWithJob('past');
    const res = await request(app).post('/api/appointments').send({
      jobId,
      scheduledStart: new Date(Date.now() - 24 * 3600_000).toISOString(),
      scheduledEnd: new Date(Date.now() - 23 * 3600_000).toISOString(),
      timezone: 'UTC',
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('VALIDATION_ERROR');
    expect(await appointmentRepo.findByJob(tenantId, jobId)).toHaveLength(0);
  });

  it('writes an out-of-hours appointment with the warning; no hours configured → no warning', async () => {
    const withHours = await tenantWithJob('hours');
    await settingsRepo.update(withHours.tenantId, { timezone: 'UTC', businessHours: EVERY_DAY_8_TO_5 });
    const noHours = await tenantWithJob('nohours');

    const late = { scheduledStart: futureAt(7, 22), scheduledEnd: futureAt(7, 23), timezone: 'UTC' };
    const a = await request(withHours.app).post('/api/appointments').send({ jobId: withHours.jobId, ...late });
    const b = await request(noHours.app).post('/api/appointments').send({ jobId: noHours.jobId, ...late });

    expect(a.status).toBe(201);
    expect(a.body.warnings).toEqual(['Appointment is outside business hours']);
    expect(await appointmentRepo.findByJob(withHours.tenantId, withHours.jobId)).toHaveLength(1);
    expect(b.status).toBe(201);
    expect(b.body.warnings).toBeUndefined();
  });
});
