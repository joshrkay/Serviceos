import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { getSharedTestDb, createTestTenant, closeSharedTestDb } from './shared';
import { PgAppointmentRepository } from '../../src/appointments/pg-appointment';
import { PgAssignmentRepository } from '../../src/appointments/pg-assignment';
import { PgJobRepository } from '../../src/jobs/pg-job';
import { PgCustomerRepository } from '../../src/customers/pg-customer';
import { PgLocationRepository } from '../../src/locations/pg-location';
import { DefaultSlotConflictChecker } from '../../src/ai/tasks/slot-conflict-checker';

/**
 * U6 integration — pins DefaultSlotConflictChecker.check against a REAL
 * PgAppointmentRepository (the mocked-pool gap CLAUDE.md warns about). Proves
 * the real query + JS filter honor the actual columns: status, scheduled_start/
 * end overlap, hold_pending_approval, hold_expiry_at. An active appointment
 * blocks the slot; a canceled one and an EXPIRED hold do not; a LIVE hold does.
 */
describe('Postgres integration — slot conflict checker (U6)', () => {
  let pool: Pool;
  let tenant: { tenantId: string; userId: string };
  let checker: DefaultSlotConflictChecker;
  let customerId: string;
  const now = Date.now();

  // Four non-overlapping 1h windows; the broad findByDateRange lookup is
  // narrowed to one appointment per window by the strict-overlap predicate.
  const W = {
    active: { start: new Date(now + 2 * 3600_000), end: new Date(now + 3 * 3600_000) },
    canceled: { start: new Date(now + 5 * 3600_000), end: new Date(now + 6 * 3600_000) },
    expiredHold: { start: new Date(now + 8 * 3600_000), end: new Date(now + 9 * 3600_000) },
    liveHold: { start: new Date(now + 11 * 3600_000), end: new Date(now + 12 * 3600_000) },
  };

  beforeAll(async () => {
    pool = await getSharedTestDb();
    tenant = await createTestTenant(pool);
    const appointmentRepo = new PgAppointmentRepository(pool);
    const assignmentRepo = new PgAssignmentRepository(pool);
    const jobRepo = new PgJobRepository(pool);
    const customerRepo = new PgCustomerRepository(pool);
    const locationRepo = new PgLocationRepository(pool);
    checker = new DefaultSlotConflictChecker({ appointmentRepo, assignmentRepo, jobRepo });

    customerId = crypto.randomUUID();
    await customerRepo.create({
      id: customerId,
      tenantId: tenant.tenantId,
      firstName: 'Conflict',
      lastName: 'Checker',
      displayName: 'Conflict Checker',
      preferredChannel: 'sms',
      smsConsent: true,
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
      street1: '2 Conflict Ave',
      city: 'Austin',
      state: 'TX',
      postalCode: '78701',
      country: 'USA',
      isPrimary: true,
      addressType: 'service',
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
      jobNumber: 'JOB-CONFLICT',
      summary: 'Conflict job',
      status: 'scheduled',
      priority: 'normal',
      createdBy: tenant.userId,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const mkAppt = async (
      win: { start: Date; end: Date },
      over: Partial<Parameters<PgAppointmentRepository['create']>[0]>,
    ) => {
      await appointmentRepo.create({
        id: crypto.randomUUID(),
        tenantId: tenant.tenantId,
        jobId,
        scheduledStart: win.start,
        scheduledEnd: win.end,
        timezone: 'America/New_York',
        status: 'scheduled',
        holdPendingApproval: false,
        createdBy: tenant.userId,
        createdAt: new Date(),
        updatedAt: new Date(),
        ...over,
      });
    };

    await mkAppt(W.active, { status: 'scheduled' });
    await mkAppt(W.canceled, { status: 'canceled' });
    await mkAppt(W.expiredHold, {
      holdPendingApproval: true,
      holdExpiryAt: new Date(now - 3600_000), // expired an hour ago
    });
    await mkAppt(W.liveHold, {
      holdPendingApproval: true,
      holdExpiryAt: new Date(now + 24 * 3600_000), // still live
    });
  });

  afterAll(async () => {
    await closeSharedTestDb();
  });

  it('an active appointment blocks the overlapping slot (customer_busy)', async () => {
    const res = await checker.check({
      tenantId: tenant.tenantId,
      windowStart: W.active.start,
      windowEnd: W.active.end,
      customerId,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.conflict).toBe('customer_busy');
  });

  it('a canceled appointment does NOT block the slot', async () => {
    const res = await checker.check({
      tenantId: tenant.tenantId,
      windowStart: W.canceled.start,
      windowEnd: W.canceled.end,
      customerId,
    });
    expect(res.ok).toBe(true);
  });

  it('an expired hold does NOT block the slot (released)', async () => {
    const res = await checker.check({
      tenantId: tenant.tenantId,
      windowStart: W.expiredHold.start,
      windowEnd: W.expiredHold.end,
      customerId,
    });
    expect(res.ok).toBe(true);
  });

  it('a live hold DOES block the slot', async () => {
    const res = await checker.check({
      tenantId: tenant.tenantId,
      windowStart: W.liveHold.start,
      windowEnd: W.liveHold.end,
      customerId,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.conflict).toBe('customer_busy');
  });
});
