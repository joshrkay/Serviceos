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
import { findBookableSlots, schedulingConfigFromSettings } from '../../src/scheduling/booking-availability';

/**
 * U7 — GET /api/dispatch/availability wraps `findBookableSlots`, which runs a
 * REAL `appointments.scheduled_start` range query (PgAppointmentRepository
 * .findByDateRange) to compute open slots. A mocked pool would not prove the
 * query filters by tenant, buckets by the real column, or that RLS keeps one
 * tenant's calendar out of another's availability. This test pins all three
 * against Postgres:
 *   1. business-hours filtering — no slot before 08:00 / after 17:00 local;
 *   2. a booked appointment removes its (buffered) window from the results;
 *   3. tenant isolation — tenant B's busy window never blocks tenant A.
 *
 * A far-future day keeps every business-hour slot in the future, so the
 * finder's never-in-the-past guard can't make the assertions flaky.
 */
describe('Postgres integration — dispatch availability (findBookableSlots)', () => {
  let pool: Pool;
  let appointmentRepo: PgAppointmentRepository;
  let assignmentRepo: PgAssignmentRepository;
  let settingsRepo: PgSettingsRepository;
  let tenantA: { tenantId: string; userId: string };
  let tenantB: { tenantId: string; userId: string };
  const timezone = 'UTC';
  const day = '2099-06-15';
  // A booked appointment in tenant A's calendar, 10:00–11:00 UTC on `day`.
  const busyStart = new Date(`${day}T10:00:00.000Z`);
  const busyEnd = new Date(`${day}T11:00:00.000Z`);

  async function seedTenant(tenant: { tenantId: string; userId: string }): Promise<void> {
    await ensureTenantSettings(tenant.tenantId, settingsRepo);
    await settingsRepo.update(tenant.tenantId, { timezone });
  }

  async function seedBusyAppointment(tenant: { tenantId: string; userId: string }): Promise<void> {
    const customerId = crypto.randomUUID();
    await new PgCustomerRepository(pool).create({
      id: customerId,
      tenantId: tenant.tenantId,
      firstName: 'Busy',
      lastName: 'Customer',
      displayName: 'Busy Customer',
      preferredChannel: 'phone',
      smsConsent: false,
      isArchived: false,
      createdBy: tenant.userId,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const locationId = crypto.randomUUID();
    await new PgLocationRepository(pool).create({
      id: locationId,
      tenantId: tenant.tenantId,
      customerId,
      street1: '1 Main St',
      city: 'Town',
      state: 'CA',
      postalCode: '90001',
      country: 'USA',
      isPrimary: true,
      isArchived: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const jobId = crypto.randomUUID();
    await new PgJobRepository(pool).create({
      id: jobId,
      tenantId: tenant.tenantId,
      customerId,
      locationId,
      jobNumber: `JOB-${jobId.slice(0, 6)}`,
      summary: 'Booked visit',
      status: 'scheduled',
      priority: 'normal',
      createdBy: tenant.userId,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await appointmentRepo.create({
      id: crypto.randomUUID(),
      tenantId: tenant.tenantId,
      jobId,
      scheduledStart: busyStart,
      scheduledEnd: busyEnd,
      timezone,
      status: 'scheduled',
      createdBy: tenant.userId,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  }

  beforeAll(async () => {
    pool = await getSharedTestDb();
    appointmentRepo = new PgAppointmentRepository(pool);
    assignmentRepo = new PgAssignmentRepository(pool);
    settingsRepo = new PgSettingsRepository(pool);
    tenantA = await createTestTenant(pool);
    tenantB = await createTestTenant(pool);
    await seedTenant(tenantA);
    await seedTenant(tenantB);
    await seedBusyAppointment(tenantA);
  });

  afterAll(async () => {
    await closeSharedTestDb();
  });

  function localHourUTC(iso: string): number {
    return new Date(iso).getUTCHours();
  }

  it('offers only slots inside business hours (08:00–17:00) for an empty calendar', async () => {
    const slots = await findBookableSlots(
      { appointmentRepo, assignmentRepo },
      { tenantId: tenantB.tenantId, fromDate: day, toDate: day, timezone, durationMin: 60, maxSlots: 20 },
    );
    expect(slots.length).toBeGreaterThan(0);
    for (const s of slots) {
      expect(localHourUTC(s.start.toISOString())).toBeGreaterThanOrEqual(8);
      // A 60-min slot must END by 17:00, so its start is at or before 16:00.
      expect(new Date(s.end).getTime()).toBeLessThanOrEqual(new Date(`${day}T17:00:00.000Z`).getTime());
    }
  });

  it('removes the booked (buffered) window from the offered slots', async () => {
    const slots = await findBookableSlots(
      { appointmentRepo, assignmentRepo },
      { tenantId: tenantA.tenantId, fromDate: day, toDate: day, timezone, durationMin: 60, maxSlots: 20 },
    );
    const starts = slots.map((s) => s.start.toISOString());
    // The 10:00 appointment (+30m buffer both sides) blocks any slot that would
    // overlap [09:30, 11:30). A 08:00 slot is still free and must be offered.
    expect(starts).toContain(`${day}T08:00:00.000Z`);
    for (const s of slots) {
      const start = s.start.getTime();
      const end = s.end.getTime();
      const blockedStart = new Date(`${day}T09:30:00.000Z`).getTime();
      const blockedEnd = new Date(`${day}T11:30:00.000Z`).getTime();
      expect(start < blockedEnd && end > blockedStart).toBe(false);
    }
  });

  it('does not let tenant A\'s appointment block tenant B\'s availability (tenant isolation)', async () => {
    const slots = await findBookableSlots(
      { appointmentRepo, assignmentRepo },
      { tenantId: tenantB.tenantId, fromDate: day, toDate: day, timezone, durationMin: 60, maxSlots: 20 },
    );
    const starts = slots.map((s) => s.start.toISOString());
    // Tenant B has an empty calendar; the 10:00 slot that is blocked for tenant A
    // must be offered for tenant B. Proves the range query is tenant-scoped.
    expect(starts).toContain(`${day}T10:00:00.000Z`);
  });

  /**
   * V17 — `booking-availability.test.ts` ("V17 (unit) — tenant business
   * hours propagate into slot generation") already proves this against an
   * in-memory appointment repo and a hand-built `weeklyHours` literal. §1015
   * 3.2's own acceptance criterion is "offered times respect my ACTUAL
   * working day" — the part that unit test can't reach is whether a REAL
   * `tenant_settings.business_hours` column, read back through
   * `schedulingConfigFromSettings` exactly as routes.ts does, still shapes
   * the offered slots. Moved here where the code allows it (a pure date-math
   * function like `isWithinBusinessHours` has no DB seam to move); the T2
   * assertion above is unchanged.
   */
  it('V17 (unit-only half moved to real DB) — a tenant\'s OWN configured business hours and travel buffer, read from a real tenant_settings row, shape the offered slots', async () => {
    const configuredTenant = await createTestTenant(pool);
    await seedTenant(configuredTenant);
    await settingsRepo.update(configuredTenant.tenantId, {
      businessHours: { mon: { open: '10:00', close: '12:00' } },
      jobBufferMinutes: 60,
    });

    const settings = await settingsRepo.findByTenant(configuredTenant.tenantId);
    const config = schedulingConfigFromSettings(settings);
    expect(config.weeklyHours).toEqual({ mon: { open: '10:00', close: '12:00' } });
    expect(config.bufferMinutes).toBe(60);

    const slots = await findBookableSlots(
      { appointmentRepo, assignmentRepo },
      {
        tenantId: configuredTenant.tenantId,
        fromDate: day, // 2099-06-15 is a Monday
        toDate: day,
        timezone,
        durationMin: 60,
        weeklyHours: config.weeklyHours,
        bufferMinutes: config.bufferMinutes,
        maxSlots: 20,
      },
    );

    // The tenant's OWN 10:00-12:00 window — NOT the 08:00-17:00 default the
    // sibling test above proves for tenant B (an unconfigured tenant).
    expect(slots.length).toBeGreaterThan(0);
    for (const s of slots) {
      expect(s.start.toISOString() >= `${day}T10:00:00.000Z`).toBe(true);
      expect(s.end.toISOString() <= `${day}T12:00:00.000Z`).toBe(true);
    }
  });
});
