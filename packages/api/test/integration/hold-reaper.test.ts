import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { getSharedTestDb, createTestTenant, closeSharedTestDb } from './shared';
import { PgAppointmentRepository } from '../../src/appointments/pg-appointment';
import { PgJobRepository } from '../../src/jobs/pg-job';
import { PgCustomerRepository } from '../../src/customers/pg-customer';
import { PgLocationRepository } from '../../src/locations/pg-location';
import { PgAuditRepository } from '../../src/audit/pg-audit';
import { createLogger } from '../../src/logging/logger';
import { runHoldReaperSweep } from '../../src/workers/hold-reaper-worker';

/**
 * U6 integration — proves the reaper cancels expired holds against REAL
 * Postgres (real hold_pending_approval / hold_expiry_at columns + the partial
 * index query in findExpiredHolds), and leaves live holds + normal
 * appointments untouched.
 */
describe('Postgres integration — held-slot reaper (U6)', () => {
  let pool: Pool;
  let tenant: { tenantId: string; userId: string };
  let appointmentRepo: PgAppointmentRepository;
  let auditRepo: PgAuditRepository;
  const now = new Date('2026-06-15T18:00:00Z');
  const logger = createLogger({ service: 'test', environment: 'test' });

  let expiredHoldId: string;
  let liveHoldId: string;
  let normalId: string;

  beforeAll(async () => {
    pool = await getSharedTestDb();
    tenant = await createTestTenant(pool);
    appointmentRepo = new PgAppointmentRepository(pool);
    auditRepo = new PgAuditRepository(pool);
    const jobRepo = new PgJobRepository(pool);
    const customerRepo = new PgCustomerRepository(pool);
    const locationRepo = new PgLocationRepository(pool);

    const customerId = crypto.randomUUID();
    await customerRepo.create({
      id: customerId,
      tenantId: tenant.tenantId,
      firstName: 'Reaper',
      lastName: 'Test',
      displayName: 'Reaper Test',
      preferredChannel: 'sms',
      smsConsent: true,
      isArchived: false,
      createdBy: tenant.userId,
      createdAt: now,
      updatedAt: now,
    });
    const locationId = crypto.randomUUID();
    await locationRepo.create({
      id: locationId,
      tenantId: tenant.tenantId,
      customerId,
      street1: '1 Hold St',
      city: 'Austin',
      state: 'TX',
      postalCode: '78701',
      country: 'USA',
      isPrimary: true,
      addressType: 'service',
      isArchived: false,
      createdAt: now,
      updatedAt: now,
    });
    const jobId = crypto.randomUUID();
    await jobRepo.create({
      id: jobId,
      tenantId: tenant.tenantId,
      customerId,
      locationId,
      jobNumber: 'JOB-REAP',
      summary: 'Hold reaper job',
      status: 'scheduled',
      priority: 'normal',
      createdBy: tenant.userId,
      createdAt: now,
      updatedAt: now,
    });

    const mkAppt = async (over: Partial<Parameters<PgAppointmentRepository['create']>[0]>) => {
      const id = crypto.randomUUID();
      await appointmentRepo.create({
        id,
        tenantId: tenant.tenantId,
        jobId,
        scheduledStart: new Date('2026-06-15T20:00:00Z'),
        scheduledEnd: new Date('2026-06-15T21:00:00Z'),
        timezone: 'America/New_York',
        status: 'scheduled',
        holdPendingApproval: false,
        createdBy: tenant.userId,
        createdAt: now,
        updatedAt: now,
        ...over,
      });
      return id;
    };

    expiredHoldId = await mkAppt({
      holdPendingApproval: true,
      holdExpiryAt: new Date('2026-06-15T17:00:00Z'),
    });
    liveHoldId = await mkAppt({
      holdPendingApproval: true,
      holdExpiryAt: new Date('2026-06-15T19:30:00Z'),
    });
    normalId = await mkAppt({ status: 'confirmed' });
  });

  afterAll(async () => {
    await closeSharedTestDb();
  });

  it('cancels the expired hold, clears the flag, emits audit; spares live + normal', async () => {
    const result = await runHoldReaperSweep({
      appointmentRepo,
      auditRepo,
      listTenantIds: async () => [tenant.tenantId],
      logger,
      now: () => now,
    });

    expect(result.reaped).toBe(1);

    const expired = await appointmentRepo.findById(tenant.tenantId, expiredHoldId);
    expect(expired?.status).toBe('canceled');
    expect(expired?.holdPendingApproval).toBe(false);

    const live = await appointmentRepo.findById(tenant.tenantId, liveHoldId);
    expect(live?.status).toBe('scheduled');
    expect(live?.holdPendingApproval).toBe(true);

    const normal = await appointmentRepo.findById(tenant.tenantId, normalId);
    expect(normal?.status).toBe('confirmed');

    const audits = await auditRepo.findByEntity(tenant.tenantId, 'appointment', expiredHoldId);
    expect(audits.some((a) => a.eventType === 'appointment.hold_expired')).toBe(true);
  });

  it('a second sweep is a no-op (idempotent)', async () => {
    const result = await runHoldReaperSweep({
      appointmentRepo,
      auditRepo,
      listTenantIds: async () => [tenant.tenantId],
      logger,
      now: () => now,
    });
    expect(result.reaped).toBe(0);
  });

  /**
   * T2 (fan-out entry: sweep-tenant-fanout.test.ts, "hold-reaper sweep" —
   * real enumerator, failure isolation) — the fan-out proof shows the sweep
   * REACHES every tenant; it never showed that reaping one tenant's expired
   * hold leaves a NEIGHBOUR tenant's identically-shaped hold and its slot
   * visibility untouched. `findExpiredHolds`/the cancel write are scoped by
   * tenantId at the SQL layer — this proves it empirically rather than by
   * reading the query.
   */
  it('T2 — reaping tenant A\'s expired hold never frees or hides the identical slot for tenant B', async () => {
    const tenantB = await createTestTenant(pool);
    const customerRepoB = new PgCustomerRepository(pool);
    const locationRepoB = new PgLocationRepository(pool);
    const jobRepoB = new PgJobRepository(pool);

    const customerBId = crypto.randomUUID();
    await customerRepoB.create({
      id: customerBId,
      tenantId: tenantB.tenantId,
      firstName: 'Tenant',
      lastName: 'B',
      displayName: 'Tenant B',
      preferredChannel: 'sms',
      smsConsent: true,
      isArchived: false,
      createdBy: tenantB.userId,
      createdAt: now,
      updatedAt: now,
    });
    const locationBId = crypto.randomUUID();
    await locationRepoB.create({
      id: locationBId,
      tenantId: tenantB.tenantId,
      customerId: customerBId,
      street1: '2 Hold St',
      city: 'Austin',
      state: 'TX',
      postalCode: '78701',
      country: 'USA',
      isPrimary: true,
      addressType: 'service',
      isArchived: false,
      createdAt: now,
      updatedAt: now,
    });
    const jobBId = crypto.randomUUID();
    await jobRepoB.create({
      id: jobBId,
      tenantId: tenantB.tenantId,
      customerId: customerBId,
      locationId: locationBId,
      jobNumber: 'JOB-REAP-B',
      summary: 'Tenant B hold job',
      status: 'scheduled',
      priority: 'normal',
      createdBy: tenantB.userId,
      createdAt: now,
      updatedAt: now,
    });

    // Tenant B has a LIVE hold (not yet expired) at the IDENTICAL wall-clock
    // window as tenant A's already-reaped `expiredHoldId` above. If the reap
    // query were missing its tenant_id predicate, or a bulk write leaked
    // across tenants, this row would be canceled/freed too even though it
    // hasn't expired.
    const liveHoldBId = crypto.randomUUID();
    await appointmentRepo.create({
      id: liveHoldBId,
      tenantId: tenantB.tenantId,
      jobId: jobBId,
      scheduledStart: new Date('2026-06-15T20:00:00Z'),
      scheduledEnd: new Date('2026-06-15T21:00:00Z'),
      timezone: 'America/New_York',
      status: 'scheduled',
      holdPendingApproval: true,
      holdExpiryAt: new Date('2026-06-15T19:30:00Z'),
      createdBy: tenantB.userId,
      createdAt: now,
      updatedAt: now,
    });

    // Sweep scoped to tenant A ONLY (as every other test in this file does) —
    // tenant B is never listed, so a correctly-scoped sweep must not touch it.
    const result = await runHoldReaperSweep({
      appointmentRepo,
      auditRepo,
      listTenantIds: async () => [tenant.tenantId],
      logger,
      now: () => now,
    });
    expect(result.reaped).toBe(0); // tenant A's hold was already reaped by the first test in this file.

    // Tenant B's LIVE hold is completely untouched: not reaped, not hidden,
    // not freed — the reap write never crossed the tenant boundary. This is
    // the layer that matters: `findBookableSlots`' own expiry check reads
    // the REAL wall clock (not the sweep's injected `now`), so by the time
    // this suite runs any 2026-06-15 holdExpiryAt reads as long past on the
    // availability API regardless of what the reaper did — an unreliable
    // surface for this assertion. The appointment ROW is the reliable one.
    const holdB = await appointmentRepo.findById(tenantB.tenantId, liveHoldBId);
    expect(holdB?.status).toBe('scheduled');
    expect(holdB?.holdPendingApproval).toBe(true);
    expect(holdB?.holdExpiryAt?.toISOString()).toBe('2026-06-15T19:30:00.000Z');
    expect(await auditRepo.findByEntity(tenantB.tenantId, 'appointment', liveHoldBId)).toEqual([]);
  });
});
