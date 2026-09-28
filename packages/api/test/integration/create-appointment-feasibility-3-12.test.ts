/**
 * Postgres integration — PRD row 3.12, the NON-held half. "As M, I want to be
 * warned when back-to-back jobs aren't drivable, so I stop promising times
 * Carlos can't make."
 *
 * #1045 made the HELD path (`create_booking`, `placeAppointmentHold`) run
 * `checkFeasibility` against every technician whose calendar neighbours the
 * slot. The other creation path — a `create_appointment` proposal drafted by
 * `CreateAppointmentAITaskHandler` when no job is named yet (the executor
 * auto-opens one at the customer's service location on approval) — was
 * still drafted blind. This file pins that path at its public seam,
 * `CreateAppointmentAITaskHandler.handle()`, with every repository real.
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
import { FeasibilityDependencies } from '../../src/scheduling/feasibility-types';
import { StubSkillMatcher } from '../../src/scheduling/skill-matcher';
import { TravelTimeProvider } from '../../src/scheduling/travel-time/provider';
import { CreateAppointmentAITaskHandler } from '../../src/ai/tasks/create-appointment-task';
import type { LLMGateway } from '../../src/ai/gateway/gateway';
import type { TaskContext } from '../../src/ai/tasks/task-handlers';

// San Francisco vs. Oakland — a real ~20 minute drive apart.
const SF = { latitude: 37.7749, longitude: -122.4194 };
const OAK = { latitude: 37.8044, longitude: -122.2712 };
// "Now" is the day before the booking; the caller asks for tomorrow at 10am
// (UTC tenant), five minutes after Carlos leaves his Oakland job at 09:55.
const NOW = new Date('2099-08-09T12:00:00Z');

interface SeededTenant {
  tenantId: string;
  userId: string;
  customerId: string;
  technicianId: string;
  prevApptId: string;
}

describe('Postgres integration — the non-held create_appointment draft is feasibility-checked (3.12)', () => {
  let pool: Pool;
  let appointmentRepo: PgAppointmentRepository;
  let assignmentRepo: PgAssignmentRepository;
  let jobRepo: PgJobRepository;
  let locationRepo: PgLocationRepository;
  let customerRepo: PgCustomerRepository;
  let tenantA: SeededTenant;
  let tenantB: SeededTenant;

  const travelTimeProvider: TravelTimeProvider = {
    // A ~20-minute SF<->Oakland drive against a 5-minute gap. Great-circle
    // source, so the warning carries the "unverified" provenance with it.
    estimateDriveTime: async () => ({ seconds: 1200, source: 'haversine', degraded: false }),
  };

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

  async function addLocation(tenantId: string, customerId: string, at: typeof SF, isPrimary: boolean) {
    const id = crypto.randomUUID();
    await locationRepo.create({
      id,
      tenantId,
      customerId,
      street1: isPrimary ? '1 SF St' : '1 Oakland Ave',
      city: isPrimary ? 'San Francisco' : 'Oakland',
      state: 'CA',
      postalCode: isPrimary ? '94103' : '94601',
      country: 'USA',
      isPrimary,
      isArchived: false,
      latitude: at.latitude,
      longitude: at.longitude,
      createdAt: new Date(),
      updatedAt: new Date(),
    } as never);
    return id;
  }

  /**
   * One tenant: a customer whose primary (service) address is in SF, and
   * technician Carlos booked on an Oakland job until 09:55 on the day asked.
   */
  async function seedTenant(opts: { withNeighbour: boolean }): Promise<SeededTenant> {
    const tenant = await createTestTenant(pool);
    const technicianId = crypto.randomUUID();
    await pool.query(
      `INSERT INTO users (id, tenant_id, clerk_user_id, email, role) VALUES ($1, $2, $3, $4, 'technician')`,
      [technicianId, tenant.tenantId, `clerk_${technicianId}`, `tech_${technicianId}@example.com`],
    );
    const customerId = crypto.randomUUID();
    await customerRepo.create({
      id: customerId,
      tenantId: tenant.tenantId,
      firstName: 'Dana',
      lastName: 'Caller',
      displayName: 'Dana Caller',
      preferredChannel: 'phone',
      smsConsent: false,
      isArchived: false,
      createdBy: tenant.userId,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await addLocation(tenant.tenantId, customerId, SF, true);
    const oakId = await addLocation(tenant.tenantId, customerId, OAK, false);

    let prevApptId = '';
    if (opts.withNeighbour) {
      const jobPrevId = crypto.randomUUID();
      await jobRepo.create({
        id: jobPrevId,
        tenantId: tenant.tenantId,
        customerId,
        locationId: oakId,
        jobNumber: `JOB-PREV-${jobPrevId.slice(0, 4)}`,
        summary: 'Earlier job, Oakland',
        status: 'scheduled',
        priority: 'normal',
        createdBy: tenant.userId,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
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
    }
    return { tenantId: tenant.tenantId, userId: tenant.userId, customerId, technicianId, prevApptId };
  }

  /** The drafting model names the caller and a time, but no job. */
  function gateway(): LLMGateway {
    return {
      complete: async () => ({
        content: JSON.stringify({ dateTimePhrase: 'tomorrow at 10am', summary: 'Leak check', confidence_score: 0.9 }),
      }),
    } as unknown as LLMGateway;
  }

  function context(t: SeededTenant): TaskContext {
    return {
      tenantId: t.tenantId,
      userId: t.userId,
      customerId: t.customerId,
      message: 'Can someone come out tomorrow at 10am to check a leak?',
      timezone: 'UTC',
      now: NOW,
    } as TaskContext;
  }

  function handler(deps?: FeasibilityDependencies) {
    return new CreateAppointmentAITaskHandler(
      gateway(),
      undefined,
      undefined,
      appointmentRepo,
      jobRepo,
      undefined,
      deps,
    );
  }

  beforeAll(async () => {
    pool = await getSharedTestDb();
    appointmentRepo = new PgAppointmentRepository(pool);
    assignmentRepo = new PgAssignmentRepository(pool);
    jobRepo = new PgJobRepository(pool);
    locationRepo = new PgLocationRepository(pool);
    customerRepo = new PgCustomerRepository(pool);
    tenantA = await seedTenant({ withNeighbour: true });
    tenantB = await seedTenant({ withNeighbour: false });
  });

  afterAll(async () => {
    await closeSharedTestDb();
  });

  it('a jobless booking five minutes after Carlos leaves Oakland drafts a create_appointment that carries the travel_time warning', async () => {
    const result = await handler(feasibilityDeps()).handle(context(tenantA));

    expect(result.proposal.proposalType).toBe('create_appointment');
    expect(result.proposal.payload.scheduledStart).toBe('2099-08-10T10:00:00.000Z');
    const feasibility = (result.proposal.sourceContext as Record<string, unknown> | undefined)?.slotFeasibility;
    expect(feasibility).toEqual({
      checked: true,
      warnings: [
        expect.objectContaining({
          check: 'travel_time',
          severity: 'warning',
          conflictingEntityId: tenantA.prevApptId,
          metadata: expect.objectContaining({
            technicianId: tenantA.technicianId,
            travelSeconds: 1200,
            // Great-circle fallback — the provenance the card flags as unverified.
            source: 'haversine',
          }),
        }),
      ],
    });
    // A warning, never a block and never a write: nothing is booked at draft time.
    const booked = await appointmentRepo.findByDateRange(
      tenantA.tenantId,
      new Date('2099-08-10T10:00:00Z'),
      new Date('2099-08-10T11:00:00Z'),
    );
    expect(booked.filter((a) => a.id !== tenantA.prevApptId)).toEqual([]);
  });

  it("T1: the same slot on a neighbour tenant is checked and clear — tenant A's Carlos is not on tenant B's calendar", async () => {
    const result = await handler(feasibilityDeps()).handle(context(tenantB));

    expect(result.proposal.proposalType).toBe('create_appointment');
    const feasibility = (result.proposal.sourceContext as Record<string, unknown> | undefined)?.slotFeasibility;
    expect(feasibility).toEqual({ checked: true, warnings: [] });
  });

  it('no feasibility deps wired → the draft says the check did not run (never a silent all-clear)', async () => {
    const result = await handler(undefined).handle(context(tenantA));

    const feasibility = (result.proposal.sourceContext as Record<string, unknown> | undefined)?.slotFeasibility;
    expect(feasibility).toEqual({ checked: false, warnings: [] });
  });
});
