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
 * U6 — pin DefaultSlotConflictChecker.check against the REAL
 * PgAppointmentRepository (closes the CLAUDE.md mocked-pool gap: the checker
 * had only ever been exercised with a mocked Pool, so a column-name drift
 * would have shipped silently).
 *
 * Seeds overlapping rows for one customer's window: an ACTIVE scheduled
 * appointment, a CANCELED one, and an EXPIRED hold. Asserts the active row
 * blocks (customer_busy) while the canceled row and the expired hold do NOT.
 * Pins the real columns the checker reads: `scheduled_start` / `scheduled_end`
 * (overlap), `status` (active filter), and `hold_pending_approval` /
 * `hold_expiry_at` (expired-hold release).
 */
describe('Postgres integration — slot-conflict-checker (U6)', () => {
  let pool: Pool;
  let appointmentRepo: PgAppointmentRepository;
  let checker: DefaultSlotConflictChecker;
  let tenant: { tenantId: string; userId: string };
  let customerId: string;
  let jobId: string;

  // The proposed window we test against every seeded row.
  const windowStart = new Date('2026-06-15T10:00:00Z');
  const windowEnd = new Date('2026-06-15T11:00:00Z');
  // An overlapping appointment window (10:30-11:30 overlaps 10:00-11:00).
  const apptStart = new Date('2026-06-15T10:30:00Z');
  const apptEnd = new Date('2026-06-15T11:30:00Z');

  beforeAll(async () => {
    pool = await getSharedTestDb();
    appointmentRepo = new PgAppointmentRepository(pool);
    const assignmentRepo = new PgAssignmentRepository(pool);
    const jobRepo = new PgJobRepository(pool);
    const customerRepo = new PgCustomerRepository(pool);
    const locationRepo = new PgLocationRepository(pool);
    tenant = await createTestTenant(pool);

    checker = new DefaultSlotConflictChecker({ appointmentRepo, assignmentRepo, jobRepo });

    customerId = crypto.randomUUID();
    await customerRepo.create({
      id: customerId,
      tenantId: tenant.tenantId,
      firstName: 'Conflict',
      lastName: 'Customer',
      displayName: 'Conflict Customer',
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
      street1: '123 Main St',
      city: 'Austin',
      state: 'TX',
      postalCode: '78701',
      country: 'USA',
      isPrimary: true,
      isArchived: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    jobId = crypto.randomUUID();
    await jobRepo.create({
      id: jobId,
      tenantId: tenant.tenantId,
      customerId,
      locationId,
      jobNumber: 'JOB-CONFLICT-1',
      summary: 'Conflict test job',
      status: 'scheduled',
      priority: 'normal',
      createdBy: tenant.userId,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  });

  afterAll(async () => {
    await closeSharedTestDb();
  });

  it('an ACTIVE overlapping appointment blocks the slot (customer_busy)', async () => {
    await appointmentRepo.create({
      id: crypto.randomUUID(),
      tenantId: tenant.tenantId,
      jobId,
      scheduledStart: apptStart,
      scheduledEnd: apptEnd,
      timezone: 'America/Chicago',
      status: 'scheduled',
      holdPendingApproval: false,
      createdBy: tenant.userId,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const result = await checker.check({
      tenantId: tenant.tenantId,
      windowStart,
      windowEnd,
      customerId,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.conflict).toBe('customer_busy');
    }
  });

  it('a CANCELED overlapping appointment does NOT block (no active occupant)', async () => {
    const cancelTenant = await createTestTenant(pool);
    const ctx = await seedCustomerJob(cancelTenant);

    await appointmentRepo.create({
      id: crypto.randomUUID(),
      tenantId: cancelTenant.tenantId,
      jobId: ctx.jobId,
      scheduledStart: apptStart,
      scheduledEnd: apptEnd,
      timezone: 'America/Chicago',
      status: 'canceled',
      holdPendingApproval: false,
      createdBy: cancelTenant.userId,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const result = await checker.check({
      tenantId: cancelTenant.tenantId,
      windowStart,
      windowEnd,
      customerId: ctx.customerId,
    });

    expect(result.ok).toBe(true);
  });

  it('an EXPIRED hold overlapping the window does NOT block (slot released)', async () => {
    const holdTenant = await createTestTenant(pool);
    const ctx = await seedCustomerJob(holdTenant);

    await appointmentRepo.create({
      id: crypto.randomUUID(),
      tenantId: holdTenant.tenantId,
      jobId: ctx.jobId,
      scheduledStart: apptStart,
      scheduledEnd: apptEnd,
      timezone: 'America/Chicago',
      status: 'scheduled',
      holdPendingApproval: true,
      // Expiry well in the past relative to Date.now() (the checker uses the
      // real clock for isExpiredHold) so the hold is treated as released.
      holdExpiryAt: new Date('2000-01-01T00:00:00Z'),
      createdBy: holdTenant.userId,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const result = await checker.check({
      tenantId: holdTenant.tenantId,
      windowStart,
      windowEnd,
      customerId: ctx.customerId,
    });

    expect(result.ok).toBe(true);
  });

  // Seed an isolated customer + location + job in a fresh tenant so each
  // negative case has no cross-talk with the active-blocking row above.
  async function seedCustomerJob(
    t: { tenantId: string; userId: string },
  ): Promise<{ customerId: string; jobId: string }> {
    const customerRepo = new PgCustomerRepository(pool);
    const locationRepo = new PgLocationRepository(pool);
    const jobRepo = new PgJobRepository(pool);

    const cId = crypto.randomUUID();
    await customerRepo.create({
      id: cId,
      tenantId: t.tenantId,
      firstName: 'Seed',
      lastName: 'Customer',
      displayName: 'Seed Customer',
      preferredChannel: 'phone',
      smsConsent: false,
      isArchived: false,
      createdBy: t.userId,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const lId = crypto.randomUUID();
    await locationRepo.create({
      id: lId,
      tenantId: t.tenantId,
      customerId: cId,
      street1: '123 Main St',
      city: 'Austin',
      state: 'TX',
      postalCode: '78701',
      country: 'USA',
      isPrimary: true,
      isArchived: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const jId = crypto.randomUUID();
    await jobRepo.create({
      id: jId,
      tenantId: t.tenantId,
      customerId: cId,
      locationId: lId,
      jobNumber: `JOB-${jId.slice(0, 8)}`,
      summary: 'Seed job',
      status: 'scheduled',
      priority: 'normal',
      createdBy: t.userId,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    return { customerId: cId, jobId: jId };
  }
});
