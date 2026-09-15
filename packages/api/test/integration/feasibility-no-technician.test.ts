import { describe, it, expect, beforeAll, afterAll } from 'vitest';
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
import { FeasibilityDependencies } from '../../src/scheduling/feasibility-types';
import { StubSkillMatcher } from '../../src/scheduling/skill-matcher';
import { HaversineFallbackProvider } from '../../src/scheduling/travel-time/haversine-fallback';

/**
 * A11 (2026-08-31 live sweep) — `checkFeasibility` against REAL Postgres.
 *
 * Live evidence: `RescheduleAppointmentExecutionHandler`'s execution
 * retried forever on `invalid input syntax for type uuid: ""`. Root cause
 * traced statically (packages/api/test/scheduling/feasibility-overlap.test.ts
 * pins the mocked-deps half): when an appointment has never had a
 * technician assigned, `proposedTechnicianId` fell back to `''`, and EVERY
 * one of `checkFeasibility`'s four sub-checks binds it straight into a
 * `uuid`-typed repo query with no guard — `assignmentRepo.findByTechnician`,
 * `workingHoursRepo.findByTechnician`,
 * `unavailableBlockRepo.findByTechnicianAndDateRange`,
 * `skillMatcher.skillsForTechnician` (gated on required skills only).
 * `create-scheduling.ts`'s own draft-time call already independently
 * reached the same guard ("Passing an empty string to checkFeasibility
 * would hit the assignment query with an invalid UUID (Postgres 22P02)")
 * — this pins the execution-time gap and the fix (uuid-or-absent:
 * `proposedTechnicianId: string | undefined`, never `''`) against the
 * REAL Postgres error the mocked unit suite cannot reproduce (a mocked
 * repo happily accepts any string; a real `uuid` column does not).
 */
describe('Postgres integration — checkFeasibility with no assigned technician (A11)', () => {
  let pool: Pool;
  let appointmentRepo: PgAppointmentRepository;
  let assignmentRepo: PgAssignmentRepository;
  let jobRepo: PgJobRepository;
  let customerRepo: PgCustomerRepository;
  let locationRepo: PgLocationRepository;
  let workingHoursRepo: PgWorkingHoursRepository;
  let unavailableBlockRepo: PgUnavailableBlockRepository;
  let deps: FeasibilityDependencies;

  beforeAll(async () => {
    pool = await getSharedTestDb();
    appointmentRepo = new PgAppointmentRepository(pool);
    assignmentRepo = new PgAssignmentRepository(pool);
    jobRepo = new PgJobRepository(pool);
    customerRepo = new PgCustomerRepository(pool);
    locationRepo = new PgLocationRepository(pool);
    workingHoursRepo = new PgWorkingHoursRepository(pool);
    unavailableBlockRepo = new PgUnavailableBlockRepository(pool);
    deps = {
      assignmentRepo,
      appointmentRepo,
      jobRepo,
      locationRepo,
      workingHoursRepo,
      unavailableBlockRepo,
      travelTimeProvider: new HaversineFallbackProvider(),
      skillMatcher: new StubSkillMatcher(),
    };
  });

  afterAll(async () => {
    await closeSharedTestDb();
  });

  async function seedUnassignedAppointment(): Promise<{
    tenantId: string;
    userId: string;
    appointmentId: string;
  }> {
    const tenant = await createTestTenant(pool);
    const customerId = crypto.randomUUID();
    await customerRepo.create({
      id: customerId,
      tenantId: tenant.tenantId,
      firstName: 'No',
      lastName: 'Technician',
      displayName: 'No Technician',
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
      street1: '1 Unassigned Ave',
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
      jobNumber: `JOB-UNASSIGNED-${jobId.slice(0, 8)}`,
      summary: 'Unassigned reschedule fixture',
      status: 'scheduled',
      priority: 'normal',
      createdBy: tenant.userId,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const appointmentId = crypto.randomUUID();
    await appointmentRepo.create({
      id: appointmentId,
      tenantId: tenant.tenantId,
      jobId,
      scheduledStart: new Date('2026-09-01T18:00:00.000Z'),
      scheduledEnd: new Date('2026-09-01T19:00:00.000Z'),
      timezone: 'UTC',
      status: 'scheduled',
      holdPendingApproval: false,
      createdBy: tenant.userId,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    // Deliberately NO assignTechnician call — this appointment has never
    // had a technician assigned, mirroring the live A11 shape.
    return { tenantId: tenant.tenantId, userId: tenant.userId, appointmentId };
  }

  it('the danger is real: an empty-string technician id against the REAL assignment repo throws the exact Postgres uuid error', async () => {
    // Below checkFeasibility, not through it — this is what "" reaching
    // `assignmentRepo.findByTechnician` inside `loadTechnicianAppointmentsInWindow`
    // actually does against a genuine `uuid`-typed column, which is the raw
    // failure `checkFeasibility`'s guard now exists specifically to prevent.
    // Same query shape `workingHoursRepo.findByTechnician` /
    // `unavailableBlockRepo.findByTechnicianAndDateRange` /
    // `skillMatcher.skillsForTechnician` would each independently hit.
    const { tenantId } = await seedUnassignedAppointment();
    await expect(assignmentRepo.findByTechnician(tenantId, '')).rejects.toThrow(
      /invalid input syntax for type uuid/,
    );
  });

  it('the fix: checkFeasibility never reaches that query for EITHER falsy sentinel ("" or undefined) — feasible, no blocking issues, against the SAME real repos', async () => {
    const { tenantId, appointmentId } = await seedUnassignedAppointment();
    const appointment = await appointmentRepo.findById(tenantId, appointmentId);
    expect(appointment).not.toBeNull();

    for (const proposedTechnicianId of [undefined, ''] as const) {
      const result = await checkFeasibility(
        {
          tenantId,
          appointment: appointment!,
          proposedTechnicianId,
          proposedScheduledStart: appointment!.scheduledStart,
          proposedScheduledEnd: appointment!.scheduledEnd,
        },
        deps,
      );

      expect(result.feasible, `proposedTechnicianId=${JSON.stringify(proposedTechnicianId)}`).toBe(
        true,
      );
      expect(result.blocking).toHaveLength(0);
      expect(result.travelTime).toBeNull();
    }
  });
});
