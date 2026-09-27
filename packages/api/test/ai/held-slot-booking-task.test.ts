import { describe, it, expect, beforeEach } from 'vitest';
import { CreateAppointmentAITaskHandler } from '../../src/ai/tasks/create-appointment-task';
import { InMemoryAppointmentRepository } from '../../src/appointments/in-memory-appointment';
import type { LLMGateway } from '../../src/ai/gateway/gateway';
import type { TaskContext } from '../../src/ai/tasks/task-handlers';
import type { JobRepository } from '../../src/jobs/job';
import { InMemoryAssignmentRepository } from '../../src/appointments/assignment';
import { InMemoryWorkingHoursRepository } from '../../src/availability/working-hours';
import { InMemoryUnavailableBlockRepository } from '../../src/availability/unavailable-block';
import { StubSkillMatcher } from '../../src/scheduling/skill-matcher';
import type { FeasibilityDependencies } from '../../src/scheduling/feasibility-types';

const tenantA = '00000000-0000-4000-8000-00000000000a';
// Round 4b — must be a genuine hex uuid: create-appointment-task.ts now
// verify-or-gates payload.jobId before the held-slot branch even runs (a
// non-uuid value, however uuid-SHAPED, is dropped and gated rather than
// ridden through — the sweep row A33 fix). This fixture used to be
// deliberately non-hex (a trailing "j1"); that was never load-bearing to
// what this suite proves (held-slot booking happens when a repo is wired),
// so it is now a plain valid id like every other fixture in this file.
const jobId = '00000000-0000-4000-8000-0000000000f1';

/** Minimal fake gateway that returns a fixed JSON booking. */
function fakeGateway(json: Record<string, unknown>): LLMGateway {
  return {
    complete: async () => ({ content: JSON.stringify(json) }),
  } as unknown as LLMGateway;
}

/**
 * The tenant timezone is REQUIRED input for this handler — there is no
 * default zone any more (see create-appointment-task.ts's "NO DEFAULT
 * TIMEZONE" note). A context without one gates into a clarification, so
 * these held-slot fixtures thread the same zone every other scheduling
 * fixture does.
 */
const TZ = 'America/New_York';

function context(): TaskContext {
  return {
    tenantId: tenantA,
    userId: 'agent-1',
    message: 'Book the Johnson AC repair next Tuesday at 2pm',
    timezone: TZ,
  } as TaskContext;
}

const completeBooking = {
  jobId,
  scheduledStart: '2026-06-02T21:00:00Z',
  scheduledEnd: '2026-06-02T22:00:00Z',
  summary: 'AC repair',
  confidence_score: 0.9,
};

describe('CreateAppointmentAITaskHandler — held-slot booking', () => {
  let appointmentRepo: InMemoryAppointmentRepository;

  beforeEach(() => {
    appointmentRepo = new InMemoryAppointmentRepository();
  });

  it('creates a held appointment and a create_booking proposal when wired with an appointmentRepo', async () => {
    const handler = new CreateAppointmentAITaskHandler(
      fakeGateway(completeBooking),
      undefined,
      undefined,
      appointmentRepo,
    );

    const result = await handler.handle(context());

    expect(result.taskType).toBe('create_booking');
    expect(result.proposal.proposalType).toBe('create_booking');

    const appointmentId = result.proposal.payload.appointmentId as string;
    expect(typeof appointmentId).toBe('string');

    const held = await appointmentRepo.findById(tenantA, appointmentId);
    expect(held).not.toBeNull();
    expect(held?.holdPendingApproval).toBe(true);
    expect(held?.holdExpiryAt).toBeInstanceOf(Date);
    expect(held?.jobId).toBe(jobId);
  });

  it('falls back to a create_appointment proposal when no appointmentRepo is wired', async () => {
    const handler = new CreateAppointmentAITaskHandler(fakeGateway(completeBooking));
    const result = await handler.handle(context());
    expect(result.taskType).toBe('create_appointment');
    expect(result.proposal.proposalType).toBe('create_appointment');
  });

  it('falls back to create_appointment when the LLM did not produce a jobId', async () => {
    const handler = new CreateAppointmentAITaskHandler(
      fakeGateway({ ...completeBooking, jobId: undefined }),
      undefined,
      undefined,
      appointmentRepo,
    );
    const result = await handler.handle(context());
    expect(result.proposal.proposalType).toBe('create_appointment');
  });

  it('falls back to create_appointment when the appointment repo create() throws', async () => {
    const throwingRepo = new InMemoryAppointmentRepository();
    throwingRepo.create = async () => { throw new Error('db unavailable'); };
    const handler = new CreateAppointmentAITaskHandler(
      fakeGateway(completeBooking),
      undefined,
      undefined,
      throwingRepo,
    );
    const result = await handler.handle(context());
    expect(result.taskType).toBe('create_appointment');
    expect(result.proposal.proposalType).toBe('create_appointment');
  });
});

// A second, distinct valid uuid — kept separate from the shared `jobId`
// fixture above purely so the two describe blocks below never collide.
const validJobId = '00000000-0000-4000-8000-000000000abc';

/** Minimal jobRepo whose findById returns the seeded job only for its own id. */
function fakeJobRepo(job: { id: string; customerId: string } | null): JobRepository {
  return {
    findById: async (_tenantId: string, id: string) =>
      job && job.id === id ? job : null,
  } as unknown as JobRepository;
}

function contextFor(customerId?: string): TaskContext {
  return {
    tenantId: tenantA,
    userId: 'agent-1',
    message: 'Book the Johnson AC repair next Tuesday at 2pm',
    timezone: TZ,
    // supervisorPresent + the fixture's 0.9 confidence are auto-approve
    // favorable, so a degraded fallback that (wrongly) kept the autonomous
    // trust tier would land in 'approved' — the regression these tests guard.
    supervisorPresent: true,
    ...(customerId ? { customerId } : {}),
  } as TaskContext;
}

describe('CreateAppointmentAITaskHandler — held-slot ownership (jobRepo wired)', () => {
  let appointmentRepo: InMemoryAppointmentRepository;

  beforeEach(() => {
    appointmentRepo = new InMemoryAppointmentRepository();
  });

  it('holds the slot when the verified caller owns the job', async () => {
    const handler = new CreateAppointmentAITaskHandler(
      fakeGateway({ ...completeBooking, jobId: validJobId }),
      undefined,
      undefined,
      appointmentRepo,
      fakeJobRepo({ id: validJobId, customerId: 'cust-1' }),
    );

    const result = await handler.handle(contextFor('cust-1'));

    expect(result.taskType).toBe('create_booking');
    const held = await appointmentRepo.findById(
      tenantA,
      result.proposal.payload.appointmentId as string,
    );
    expect(held?.holdPendingApproval).toBe(true);
    expect(held?.jobId).toBe(validJobId);
  });

  it('degrades to create_appointment when the job belongs to another customer', async () => {
    const handler = new CreateAppointmentAITaskHandler(
      fakeGateway({ ...completeBooking, jobId: validJobId }),
      undefined,
      undefined,
      appointmentRepo,
      fakeJobRepo({ id: validJobId, customerId: 'someone-else' }),
    );

    const result = await handler.handle(contextFor('cust-1'));

    // No hold is written against a job the caller does not own, and the
    // fallback is review-gated ('draft') — never auto-approved against the
    // unverified job.
    expect(result.proposal.proposalType).toBe('create_appointment');
    expect(result.proposal.status).toBe('draft');
  });

  it('degrades to a review-gated create_appointment for an unidentified caller (no customerId)', async () => {
    const handler = new CreateAppointmentAITaskHandler(
      fakeGateway({ ...completeBooking, jobId: validJobId }),
      undefined,
      undefined,
      appointmentRepo,
      fakeJobRepo({ id: validJobId, customerId: 'cust-1' }),
    );

    const result = await handler.handle(contextFor(undefined));

    expect(result.proposal.proposalType).toBe('create_appointment');
    expect(result.proposal.status).toBe('draft');
  });

  it('degrades to a review-gated create_appointment when the LLM jobId is not a valid UUID', async () => {
    const handler = new CreateAppointmentAITaskHandler(
      fakeGateway({ ...completeBooking, jobId: 'not-a-uuid' }),
      undefined,
      undefined,
      appointmentRepo,
      fakeJobRepo({ id: validJobId, customerId: 'cust-1' }),
    );

    const result = await handler.handle(contextFor('cust-1'));

    expect(result.proposal.proposalType).toBe('create_appointment');
    expect(result.proposal.status).toBe('draft');
  });
});

// #1045 / PRD 3.12 — the recorded-voice hold path runs the back-to-back
// drivability check and surfaces the warning on the booking proposal the
// operator reviews. The feasibility composer itself is pinned at real
// Postgres in test/integration/place-hold-feasibility-gap.integration.test.ts;
// this pins that the HANDLER wires it and carries the result to the card.
describe('CreateAppointmentAITaskHandler — held-slot feasibility (#1045)', () => {
  const technicianId = '00000000-0000-4000-8000-0000000000e1';
  const prevJobId = '00000000-0000-4000-8000-0000000000f2';
  const prevApptId = '00000000-0000-4000-8000-0000000000a1';

  async function feasibilityFixture(appointmentRepo: InMemoryAppointmentRepository): Promise<FeasibilityDependencies> {
    const assignmentRepo = new InMemoryAssignmentRepository();
    // Carlos is across town until 17:55Z; the spoken slot ("next Tuesday at 2pm"
    // from a fixed Thursday) resolves to 18:00Z (14:00 America/New_York).
    await appointmentRepo.create({
      id: prevApptId,
      tenantId: tenantA,
      jobId: prevJobId,
      scheduledStart: new Date('2026-06-02T17:00:00Z'),
      scheduledEnd: new Date('2026-06-02T17:55:00Z'),
      timezone: TZ,
      status: 'scheduled',
      holdPendingApproval: false,
      createdBy: 'seed',
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await assignmentRepo.create({
      id: '00000000-0000-4000-8000-0000000000b1',
      tenantId: tenantA,
      appointmentId: prevApptId,
      technicianId,
      isPrimary: true,
      assignedBy: 'seed',
      assignedAt: new Date(),
    });
    return {
      appointmentRepo,
      assignmentRepo,
      jobRepo: {
        findById: async (_t: string, id: string) => ({ id, locationId: `loc-${id}` }),
      } as unknown as JobRepository,
      locationRepo: {
        findById: async () => ({ latitude: 37.77, longitude: -122.41 }),
      } as unknown as FeasibilityDependencies['locationRepo'],
      workingHoursRepo: new InMemoryWorkingHoursRepository(),
      unavailableBlockRepo: new InMemoryUnavailableBlockRepository(),
      travelTimeProvider: {
        estimateDriveTime: async () => ({ seconds: 1200, source: 'haversine', degraded: false }),
      },
      skillMatcher: new StubSkillMatcher(),
    };
  }

  it('stamps the travel_time warning for the neighbouring technician on the create_booking proposal', async () => {
    const appointmentRepo = new InMemoryAppointmentRepository();
    const feasibility = await feasibilityFixture(appointmentRepo);
    const handler = new CreateAppointmentAITaskHandler(
      fakeGateway(completeBooking),
      undefined,
      undefined,
      appointmentRepo,
      undefined,
      undefined,
      feasibility,
    );

    const result = await handler.handle({ ...context(), now: new Date('2026-05-28T12:00:00Z') });

    expect(result.taskType).toBe('create_booking');
    const stamp = result.proposal.sourceContext?.holdFeasibility as
      | { checked: boolean; warnings: Array<Record<string, unknown>> }
      | undefined;
    expect(stamp?.checked).toBe(true);
    expect(stamp?.warnings).toEqual([
      expect.objectContaining({
        check: 'travel_time',
        severity: 'warning',
        conflictingEntityId: prevApptId,
        metadata: expect.objectContaining({ technicianId }),
      }),
    ]);
  });

  it('says the check did not run when no feasibility deps are wired', async () => {
    const appointmentRepo = new InMemoryAppointmentRepository();
    const handler = new CreateAppointmentAITaskHandler(
      fakeGateway(completeBooking),
      undefined,
      undefined,
      appointmentRepo,
    );
    const result = await handler.handle(context());
    expect(result.proposal.sourceContext?.holdFeasibility).toEqual({ checked: false, warnings: [] });
  });
});
