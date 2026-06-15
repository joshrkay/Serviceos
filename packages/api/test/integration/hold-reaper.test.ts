import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { getSharedTestDb, createTestTenant, closeSharedTestDb } from './shared';
import { PgAppointmentRepository } from '../../src/appointments/pg-appointment';
import { PgJobRepository } from '../../src/jobs/pg-job';
import { PgCustomerRepository } from '../../src/customers/pg-customer';
import { PgLocationRepository } from '../../src/locations/pg-location';
import { InMemoryAuditRepository } from '../../src/audit/audit';
import { runHoldReaperSweep } from '../../src/workers/hold-reaper-worker';
import { createLogger } from '../../src/logging/logger';

/**
 * U6 — Held-slot reaper against REAL Postgres (PgAppointmentRepository).
 *
 * Seeds three rows for one tenant — an EXPIRED hold, a LIVE hold (future
 * expiry), and a normal confirmed appointment — runs the reaper sweep, and
 * asserts ONLY the expired hold is durably canceled. Pins the real hold
 * columns (`hold_pending_approval`, `hold_expiry_at`) round-tripping through
 * the migration-094 partial-index predicate that `findExpiredHolds` queries.
 */
describe('Postgres integration — hold-reaper sweep (U6)', () => {
  let pool: Pool;
  let appointmentRepo: PgAppointmentRepository;
  let tenant: { tenantId: string; userId: string };
  let jobId: string;

  const NOW = new Date('2026-06-15T12:00:00Z');

  beforeAll(async () => {
    pool = await getSharedTestDb();
    appointmentRepo = new PgAppointmentRepository(pool);
    const jobRepo = new PgJobRepository(pool);
    const customerRepo = new PgCustomerRepository(pool);
    const locationRepo = new PgLocationRepository(pool);
    tenant = await createTestTenant(pool);

    const customerId = crypto.randomUUID();
    await customerRepo.create({
      id: customerId,
      tenantId: tenant.tenantId,
      firstName: 'Reaper',
      lastName: 'Customer',
      displayName: 'Reaper Customer',
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
      jobNumber: 'JOB-REAP-1',
      summary: 'Reaper test job',
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

  it('cancels ONLY the expired hold; leaves a live hold and a confirmed appt untouched', async () => {
    const start = new Date('2026-06-15T09:00:00Z');
    const end = new Date(start.getTime() + 60 * 60 * 1000);

    const expiredHold = await appointmentRepo.create({
      id: crypto.randomUUID(),
      tenantId: tenant.tenantId,
      jobId,
      scheduledStart: start,
      scheduledEnd: end,
      timezone: 'America/Chicago',
      status: 'scheduled',
      holdPendingApproval: true,
      holdExpiryAt: new Date(NOW.getTime() - 60 * 1000), // 1 min past NOW
      createdBy: tenant.userId,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const liveHold = await appointmentRepo.create({
      id: crypto.randomUUID(),
      tenantId: tenant.tenantId,
      jobId,
      scheduledStart: start,
      scheduledEnd: end,
      timezone: 'America/Chicago',
      status: 'scheduled',
      holdPendingApproval: true,
      holdExpiryAt: new Date(NOW.getTime() + 60 * 60 * 1000), // future
      createdBy: tenant.userId,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const confirmed = await appointmentRepo.create({
      id: crypto.randomUUID(),
      tenantId: tenant.tenantId,
      jobId,
      scheduledStart: start,
      scheduledEnd: end,
      timezone: 'America/Chicago',
      status: 'confirmed',
      holdPendingApproval: false,
      createdBy: tenant.userId,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const audit = new InMemoryAuditRepository();
    const result = await runHoldReaperSweep({
      appointmentRepo,
      auditRepo: audit,
      listTenantIds: async () => [tenant.tenantId],
      logger: createLogger({ service: 'test', environment: 'test', level: 'error' }),
      now: () => NOW,
    });

    expect(result.reaped).toBe(1);
    expect(result.failed).toBe(0);

    // Expired hold — durably canceled, hold flags cleared.
    const reaped = await appointmentRepo.findById(tenant.tenantId, expiredHold.id);
    expect(reaped!.status).toBe('canceled');
    expect(reaped!.holdPendingApproval).toBe(false);
    expect(reaped!.holdExpiryAt).toBeUndefined();

    // Live hold — untouched.
    const liveAfter = await appointmentRepo.findById(tenant.tenantId, liveHold.id);
    expect(liveAfter!.status).toBe('scheduled');
    expect(liveAfter!.holdPendingApproval).toBe(true);
    expect(liveAfter!.holdExpiryAt).toBeInstanceOf(Date);

    // Confirmed appointment — untouched.
    const confirmedAfter = await appointmentRepo.findById(tenant.tenantId, confirmed.id);
    expect(confirmedAfter!.status).toBe('confirmed');
    expect(confirmedAfter!.holdPendingApproval).toBe(false);

    // Exactly one hold_expired audit event, scoped to the tenant + the reaped row.
    const events = await audit.findByEntity(tenant.tenantId, 'appointment', expiredHold.id);
    expect(events).toHaveLength(1);
    expect(events[0].eventType).toBe('appointment.hold_expired');
    expect(events[0].tenantId).toBe(tenant.tenantId);

    // Idempotency against the real index predicate — a second sweep reaps nothing.
    const second = await runHoldReaperSweep({
      appointmentRepo,
      auditRepo: audit,
      listTenantIds: async () => [tenant.tenantId],
      logger: createLogger({ service: 'test', environment: 'test', level: 'error' }),
      now: () => NOW,
    });
    expect(second.reaped).toBe(0);
  });
});
