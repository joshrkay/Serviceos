import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { getSharedTestDb, createTestTenant, closeSharedTestDb } from './shared';
import { PgAppointmentRepository } from '../../src/appointments/pg-appointment';
import { PgAssignmentRepository } from '../../src/appointments/pg-assignment';
import { PgJobRepository } from '../../src/jobs/pg-job';
import { PgCustomerRepository } from '../../src/customers/pg-customer';
import { PgLocationRepository } from '../../src/locations/pg-location';
import { PgSettingsRepository } from '../../src/settings/pg-settings';
import { ensureTenantSettings } from '../../src/settings/settings';
import { listAppointmentsWithMeta } from '../../src/appointments/appointment';
import { getDayBoundaries } from '../../src/dispatch/board-query';

/**
 * U8 — the technician day-window (GET /api/dispatch/technician/:id/appointments)
 * must bucket the day in the TENANT timezone, not hardcoded UTC.
 *
 * Repro: a NEGATIVE-offset tenant (America/Los_Angeles, UTC-8 in winter) books
 * an appointment at 23:00 local on 2026-01-15. That instant is 2026-01-16T07:00Z
 * — the NEXT UTC day. The old window `[2026-01-15T00:00Z, 2026-01-15T23:59:59Z]`
 * dropped it entirely; the tenant-tz window `getDayBoundaries('2026-01-15', tz)`
 * includes it. This test pins the real `scheduled_start` column against both
 * windows (a mocked pool would not prove the query buckets correctly).
 */
describe('Postgres integration — technician day window (tenant tz)', () => {
  let pool: Pool;
  let appointmentRepo: PgAppointmentRepository;
  let assignmentRepo: PgAssignmentRepository;
  let settingsRepo: PgSettingsRepository;
  let tenant: { tenantId: string; userId: string };
  const dateStr = '2026-01-15';
  const timezone = 'America/Los_Angeles';
  // 23:00 America/Los_Angeles on 2026-01-15 (PST, UTC-8) = 2026-01-16T07:00:00Z.
  const lateLocalInstant = new Date('2026-01-16T07:00:00.000Z');
  let appointmentId: string;

  beforeAll(async () => {
    pool = await getSharedTestDb();
    appointmentRepo = new PgAppointmentRepository(pool);
    assignmentRepo = new PgAssignmentRepository(pool);
    settingsRepo = new PgSettingsRepository(pool);
    const jobRepo = new PgJobRepository(pool);
    const customerRepo = new PgCustomerRepository(pool);
    const locationRepo = new PgLocationRepository(pool);
    tenant = await createTestTenant(pool);

    // Seed the tenant timezone the way the route resolves it (settings repo).
    await ensureTenantSettings(tenant.tenantId, settingsRepo);
    await settingsRepo.update(tenant.tenantId, { timezone });

    const customerId = crypto.randomUUID();
    await customerRepo.create({
      id: customerId,
      tenantId: tenant.tenantId,
      firstName: 'Late',
      lastName: 'Booker',
      displayName: 'Late Booker',
      preferredChannel: 'phone',
      smsConsent: false,
      isArchived: false,
      createdBy: tenant.userId,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const locationId = crypto.randomUUID();
    await locationRepo.create({
      id: locationId,
      tenantId: tenant.tenantId,
      customerId,
      street1: '1 Sunset Blvd',
      city: 'Los Angeles',
      state: 'CA',
      postalCode: '90001',
      country: 'USA',
      isPrimary: true,
      isArchived: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const jobId = crypto.randomUUID();
    await jobRepo.create({
      id: jobId,
      tenantId: tenant.tenantId,
      customerId,
      locationId,
      jobNumber: 'JOB-LATE',
      summary: 'Late-night HVAC call',
      status: 'scheduled',
      priority: 'normal',
      createdBy: tenant.userId,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    appointmentId = crypto.randomUUID();
    await appointmentRepo.create({
      id: appointmentId,
      tenantId: tenant.tenantId,
      jobId,
      scheduledStart: lateLocalInstant,
      scheduledEnd: new Date(lateLocalInstant.getTime() + 60 * 60 * 1000),
      timezone,
      status: 'scheduled',
      createdBy: tenant.userId,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    // Assign the tenant's user as the technician for this appointment so the
    // day-window query's technicianId EXISTS filter matches.
    await assignmentRepo.create({
      id: crypto.randomUUID(),
      tenantId: tenant.tenantId,
      appointmentId,
      technicianId: tenant.userId,
      isPrimary: true,
      assignedBy: tenant.userId,
      assignedAt: new Date(),
    });
  });

  afterAll(async () => {
    await closeSharedTestDb();
  });

  it('resolves the tenant timezone from settings', async () => {
    const settings = await settingsRepo.findByTenant(tenant.tenantId);
    expect(settings?.timezone).toBe(timezone);
  });

  it('includes a 23:00-local appointment on the tenant date (not the next UTC day)', async () => {
    const settings = await settingsRepo.findByTenant(tenant.tenantId);
    const { start, end } = getDayBoundaries(dateStr, settings?.timezone);

    const result = await listAppointmentsWithMeta(tenant.tenantId, appointmentRepo, {
      technicianId: tenant.userId,
      fromDate: start,
      toDate: end,
      sort: 'asc',
      limit: 50,
    });

    expect(result.data.map((a) => a.id)).toContain(appointmentId);
  });

  it('the OLD naive-UTC window would have dropped it (proves the fix matters)', async () => {
    // Pre-fix behavior: `${dateStr}T00:00:00.000Z`..`${dateStr}T23:59:59.999Z`.
    const naiveFrom = new Date(`${dateStr}T00:00:00.000Z`);
    const naiveTo = new Date(`${dateStr}T23:59:59.999Z`);

    const result = await listAppointmentsWithMeta(tenant.tenantId, appointmentRepo, {
      technicianId: tenant.userId,
      fromDate: naiveFrom,
      toDate: naiveTo,
      sort: 'asc',
      limit: 50,
    });

    expect(result.data.map((a) => a.id)).not.toContain(appointmentId);
  });
});
