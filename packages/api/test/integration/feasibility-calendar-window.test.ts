import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { Pool } from 'pg';
import { getSharedTestDb, createTestTenant, closeSharedTestDb } from './shared';
import { PgAppointmentRepository } from '../../src/appointments/pg-appointment';
import { PgAssignmentRepository } from '../../src/appointments/pg-assignment';
import { PgJobRepository } from '../../src/jobs/pg-job';
import { PgCustomerRepository } from '../../src/customers/pg-customer';
import { PgLocationRepository } from '../../src/locations/pg-location';
import { PgWorkingHoursRepository } from '../../src/availability/pg-working-hours';
import { PgUnavailableBlockRepository } from '../../src/availability/pg-unavailable-block';
import { checkFeasibility } from '../../src/scheduling/feasibility';
import { noSkillConstraints } from '../helpers/no-skill-constraints';
import { HaversineFallbackProvider } from '../../src/scheduling/travel-time/haversine-fallback';

/**
 * Dispatch FR-2 phase 3 — the suggested-tech fan-out runs checkFeasibility
 * per technician, so the calendar read skips assignments whose denormalised
 * window (appointment_assignments.scheduled_start/end, migration 131) lies
 * outside the proposal. Pins against REAL Postgres that (a) those columns
 * come back on findByTechnician, (b) a reschedule propagates into them via
 * the trigger, so a visit MOVED into the window is still caught, and (c) old
 * visits are never loaded one by one.
 */
describe('Postgres integration — feasibility calendar read is window-filtered', () => {
  let pool: Pool;
  let appointmentRepo: PgAppointmentRepository;
  let assignmentRepo: PgAssignmentRepository;
  let jobRepo: PgJobRepository;
  let customerRepo: PgCustomerRepository;
  let locationRepo: PgLocationRepository;

  beforeAll(async () => {
    pool = await getSharedTestDb();
    appointmentRepo = new PgAppointmentRepository(pool);
    assignmentRepo = new PgAssignmentRepository(pool);
    jobRepo = new PgJobRepository(pool);
    customerRepo = new PgCustomerRepository(pool);
    locationRepo = new PgLocationRepository(pool);
  });

  afterAll(async () => {
    await closeSharedTestDb();
  });

  it('loads only in-window visits, and still sees a visit rescheduled into the window', async () => {
    const tenant = await createTestTenant(pool);
    const techId = crypto.randomUUID();
    await pool.query(
      `INSERT INTO users (id, tenant_id, clerk_user_id, email, role) VALUES ($1, $2, $3, $4, 'technician')`,
      [techId, tenant.tenantId, techId, `tech-${techId.slice(0, 8)}@example.com`],
    );
    const customerId = crypto.randomUUID();
    await customerRepo.create({
      id: customerId, tenantId: tenant.tenantId, firstName: 'Win', lastName: 'Dow', displayName: 'Win Dow',
      preferredChannel: 'phone', smsConsent: false, isArchived: false, createdBy: tenant.userId,
      createdAt: new Date(), updatedAt: new Date(),
    });
    const locationId = crypto.randomUUID();
    await locationRepo.create({
      id: locationId, tenantId: tenant.tenantId, customerId, street1: '1 Window St', city: 'Austin', state: 'TX',
      postalCode: '78701', country: 'USA', isPrimary: true, addressType: 'service', isArchived: false,
      createdAt: new Date(), updatedAt: new Date(),
    });
    const jobId = crypto.randomUUID();
    await jobRepo.create({
      id: jobId, tenantId: tenant.tenantId, customerId, locationId, jobNumber: `JOB-WIN-${jobId.slice(0, 8)}`,
      summary: 'Window fixture', status: 'scheduled', priority: 'normal', createdBy: tenant.userId,
      createdAt: new Date(), updatedAt: new Date(),
    });
    const mkAppt = async (start: string, end: string) => {
      const id = crypto.randomUUID();
      await appointmentRepo.create({
        id, tenantId: tenant.tenantId, jobId, scheduledStart: new Date(start), scheduledEnd: new Date(end),
        timezone: 'UTC', status: 'scheduled', holdPendingApproval: false, createdBy: tenant.userId,
        createdAt: new Date(), updatedAt: new Date(),
      });
      return id;
    };
    const assign = (appointmentId: string) => assignmentRepo.create({
      id: crypto.randomUUID(), tenantId: tenant.tenantId, appointmentId, technicianId: techId,
      isPrimary: true, assignedBy: tenant.userId, assignedAt: new Date(),
    });

    const oldVisit = await mkAppt('2025-01-10T15:00:00Z', '2025-01-10T16:00:00Z');
    const movedVisit = await mkAppt('2025-02-10T15:00:00Z', '2025-02-10T16:00:00Z');
    await assign(oldVisit);
    await assign(movedVisit);
    // Rescheduled INTO the target window after assignment — the trigger must carry it.
    await appointmentRepo.update(tenant.tenantId, movedVisit, {
      scheduledStart: new Date('2026-09-01T18:30:00Z'), scheduledEnd: new Date('2026-09-01T19:30:00Z'),
    });
    const targetId = await mkAppt('2026-09-01T18:00:00Z', '2026-09-01T19:00:00Z');
    const target = (await appointmentRepo.findById(tenant.tenantId, targetId))!;

    const rows = await assignmentRepo.findByTechnician(tenant.tenantId, techId);
    expect(rows.every((r) => r.scheduledStart instanceof Date && r.scheduledEnd instanceof Date)).toBe(true);

    const findById = vi.spyOn(appointmentRepo, 'findById');
    const result = await checkFeasibility(
      { tenantId: tenant.tenantId, appointment: target, proposedTechnicianId: techId,
        proposedScheduledStart: target.scheduledStart, proposedScheduledEnd: target.scheduledEnd },
      {
        assignmentRepo, appointmentRepo, jobRepo, locationRepo,
        workingHoursRepo: new PgWorkingHoursRepository(pool),
        unavailableBlockRepo: new PgUnavailableBlockRepository(pool),
        travelTimeProvider: new HaversineFallbackProvider(),
        skillMatcher: noSkillConstraints(),
      },
    );

    expect(result.blocking.some((i) => i.check === 'overlap' && i.conflictingEntityId === movedVisit)).toBe(true);
    expect(findById.mock.calls.some(([, id]) => id === oldVisit)).toBe(false);
  });
});
