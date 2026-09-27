/**
 * Postgres integration — 3.12 "As M, I want to be warned when back-to-back
 * jobs aren't drivable, so I stop promising times Carlos can't make."
 *
 * G1 entry audit (#1007) finding: the production hold-creation path,
 * `placeAppointmentHold` (ai/scheduling/place-hold.ts:111,
 * `createAppointment(..., deps.appointmentRepo)`), NEVER calls
 * `checkFeasibility` — the only place the `travel_time` warning this story
 * describes is computed (src/scheduling/feasibility.ts). `checkFeasibility`
 * IS called from `scheduling/routes.ts` (POST /check-feasibility) and from
 * the reschedule/reassignment/crew proposal-execution handlers — but never
 * from the voice/AI hold-placement path that actually creates the
 * back-to-back appointments the story is about.
 *
 * #1045 (option a) closed the gap: `placeAppointmentHold` now takes the
 * shared `FeasibilityDependencies` and runs `checkFeasibility` against every
 * technician whose calendar neighbours the held slot, surfacing the
 * warning-severity issues (travel_time included) on
 * `PlaceHoldResult.feasibility`. The CONTROL still proves the mechanism at
 * real Postgres; the former `it.fails` STORY-NOT-MET pin is now a passing
 * assertion.
 */
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
import { assignTechnician } from '../../src/appointments/assignment';
import { checkFeasibility } from '../../src/scheduling/feasibility';
import { FeasibilityDependencies } from '../../src/scheduling/feasibility-types';
import { StubSkillMatcher } from '../../src/scheduling/skill-matcher';
import { TravelTimeProvider } from '../../src/scheduling/travel-time/provider';
import { placeAppointmentHold } from '../../src/ai/scheduling/place-hold';

// San Francisco vs. Oakland — a real ~20 minute drive apart.
const SF = { latitude: 37.7749, longitude: -122.4194 };
const OAK = { latitude: 37.8044, longitude: -122.2712 };

describe('Postgres integration — back-to-back travel warning vs. the production hold path (3.12)', () => {
  let pool: Pool;
  let tenant: { tenantId: string; userId: string };
  let appointmentRepo: PgAppointmentRepository;
  let assignmentRepo: PgAssignmentRepository;
  let jobRepo: PgJobRepository;
  let locationRepo: PgLocationRepository;
  let technicianId: string;
  let jobPrevId: string;
  let jobNewId: string;
  let prevApptId: string;

  const travelTimeProvider: TravelTimeProvider = {
    // A real ~20-minute SF<->Oakland drive; the test seeds only a 5-minute gap.
    estimateDriveTime: async () => ({ seconds: 1200, source: 'haversine', degraded: false }),
  };

  beforeAll(async () => {
    pool = await getSharedTestDb();
    appointmentRepo = new PgAppointmentRepository(pool);
    assignmentRepo = new PgAssignmentRepository(pool);
    jobRepo = new PgJobRepository(pool);
    locationRepo = new PgLocationRepository(pool);
    tenant = await createTestTenant(pool);

    technicianId = crypto.randomUUID();
    await pool.query(
      `INSERT INTO users (id, tenant_id, clerk_user_id, email, role) VALUES ($1, $2, $3, $4, 'technician')`,
      [technicianId, tenant.tenantId, `clerk_${technicianId}`, `tech_${technicianId}@example.com`],
    );

    const customerRepo = new PgCustomerRepository(pool);
    const customerId = crypto.randomUUID();
    await customerRepo.create({
      id: customerId,
      tenantId: tenant.tenantId,
      firstName: 'Carlos',
      lastName: 'Route',
      displayName: 'Carlos Route',
      preferredChannel: 'phone',
      smsConsent: false,
      isArchived: false,
      createdBy: tenant.userId,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const locationSfId = crypto.randomUUID();
    await locationRepo.create({
      id: locationSfId,
      tenantId: tenant.tenantId,
      customerId,
      street1: '1 SF St',
      city: 'San Francisco',
      state: 'CA',
      postalCode: '94103',
      country: 'USA',
      isPrimary: true,
      isArchived: false,
      latitude: SF.latitude,
      longitude: SF.longitude,
      createdAt: new Date(),
      updatedAt: new Date(),
    } as never);
    const locationOakId = crypto.randomUUID();
    await locationRepo.create({
      id: locationOakId,
      tenantId: tenant.tenantId,
      customerId,
      street1: '1 Oakland Ave',
      city: 'Oakland',
      state: 'CA',
      postalCode: '94601',
      country: 'USA',
      isPrimary: false,
      isArchived: false,
      latitude: OAK.latitude,
      longitude: OAK.longitude,
      createdAt: new Date(),
      updatedAt: new Date(),
    } as never);

    jobPrevId = crypto.randomUUID();
    await jobRepo.create({
      id: jobPrevId,
      tenantId: tenant.tenantId,
      customerId,
      locationId: locationOakId,
      jobNumber: 'JOB-PREV',
      summary: 'Earlier job, Oakland',
      status: 'scheduled',
      priority: 'normal',
      createdBy: tenant.userId,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    jobNewId = crypto.randomUUID();
    await jobRepo.create({
      id: jobNewId,
      tenantId: tenant.tenantId,
      customerId,
      locationId: locationSfId,
      jobNumber: 'JOB-NEW',
      summary: 'New hold, San Francisco',
      status: 'scheduled',
      priority: 'normal',
      createdBy: tenant.userId,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    // The PRIOR appointment: Carlos is booked in Oakland, ending at 09:55.
    prevApptId = crypto.randomUUID();
    await appointmentRepo.create({
      id: prevApptId,
      tenantId: tenant.tenantId,
      jobId: jobPrevId,
      scheduledStart: new Date('2099-08-10T09:00:00Z'),
      scheduledEnd: new Date('2099-08-10T09:55:00Z'),
      timezone: 'UTC',
      status: 'scheduled',
      holdPendingApproval: false,
      createdBy: tenant.userId,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await assignTechnician(
      { tenantId: tenant.tenantId, appointmentId: prevApptId, technicianId, technicianRole: 'technician', assignedBy: tenant.userId },
      assignmentRepo,
      { appointmentRepo },
    );
  });

  afterAll(async () => {
    await closeSharedTestDb();
  });

  function feasibilityDeps(): FeasibilityDependencies {
    return {
      assignmentRepo,
      appointmentRepo,
      jobRepo,
      locationRepo,
      workingHoursRepo: new PgWorkingHoursRepository(pool),
      unavailableBlockRepo: new PgUnavailableBlockRepository(pool),
      travelTimeProvider,
      skillMatcher: new StubSkillMatcher(),
    };
  }

  it('CONTROL: checkFeasibility genuinely flags this back-to-back pair as a travel_time warning at real Postgres', async () => {
    // A candidate SF appointment starting only 5 minutes after the Oakland
    // job ends — a ~20-minute drive does not fit in a 5-minute gap.
    const candidate = {
      id: crypto.randomUUID(),
      tenantId: tenant.tenantId,
      jobId: jobNewId,
      scheduledStart: new Date('2099-08-10T10:00:00Z'),
      scheduledEnd: new Date('2099-08-10T11:00:00Z'),
      timezone: 'UTC',
      status: 'scheduled' as const,
      holdPendingApproval: false,
      createdBy: tenant.userId,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const result = await checkFeasibility(
      {
        tenantId: tenant.tenantId,
        appointment: candidate,
        proposedTechnicianId: technicianId,
        proposedScheduledStart: candidate.scheduledStart,
        proposedScheduledEnd: candidate.scheduledEnd,
      },
      feasibilityDeps(),
    );
    expect(result.warnings.some((w) => w.check === 'travel_time')).toBe(true);
    expect(result.travelTime?.fromPrevSeconds).toBe(1200);
  });

  it('3.12 (#1045): placeAppointmentHold runs checkFeasibility and surfaces the SAME travel_time warning on the hold result', async () => {
    // No jobRepo wired — ownership verification is orthogonal to this story.
    // No technicianId either: a voice hold is placed before anyone is
    // dispatched, so the hold path checks every technician whose calendar
    // neighbours the slot (here: Carlos, booked in Oakland until 09:55).
    const result = await placeAppointmentHold(
      { appointmentRepo, feasibility: feasibilityDeps() },
      {
        tenantId: tenant.tenantId,
        jobId: jobNewId,
        scheduledStart: new Date('2099-08-10T10:00:00Z'),
        scheduledEnd: new Date('2099-08-10T11:00:00Z'),
        timezone: 'UTC',
        createdBy: tenant.userId,
      },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.feasibility.checked).toBe(true);
    expect(result.feasibility.warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          check: 'travel_time',
          conflictingEntityId: prevApptId,
          metadata: expect.objectContaining({ technicianId, travelSeconds: 1200 }),
        }),
      ]),
    );
    // A warning, never a block: the hold row was still written.
    const row = await appointmentRepo.findById(tenant.tenantId, result.appointmentId);
    expect(row?.holdPendingApproval).toBe(true);
  });

  it('3.12 (#1045): a drivable slot carries no travel warning', async () => {
    const result = await placeAppointmentHold(
      { appointmentRepo, feasibility: feasibilityDeps() },
      {
        tenantId: tenant.tenantId,
        jobId: jobNewId,
        scheduledStart: new Date('2099-08-10T12:00:00Z'),
        scheduledEnd: new Date('2099-08-10T13:00:00Z'),
        timezone: 'UTC',
        createdBy: tenant.userId,
      },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.feasibility.checked).toBe(true);
    expect(result.feasibility.warnings.filter((w) => w.check === 'travel_time')).toEqual([]);
  });

  it('3.12 (#1045): no feasibility deps wired → the result says the check did not run (never a silent all-clear)', async () => {
    const result = await placeAppointmentHold(
      { appointmentRepo },
      {
        tenantId: tenant.tenantId,
        jobId: jobNewId,
        scheduledStart: new Date('2099-08-11T10:00:00Z'),
        scheduledEnd: new Date('2099-08-11T11:00:00Z'),
        timezone: 'UTC',
        createdBy: tenant.userId,
      },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.feasibility).toEqual({ checked: false, warnings: [] });
  });
});
