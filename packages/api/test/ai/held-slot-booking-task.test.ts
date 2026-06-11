import { describe, it, expect, beforeEach } from 'vitest';
import { CreateAppointmentAITaskHandler } from '../../src/ai/tasks/create-appointment-task';
import { InMemoryAppointmentRepository } from '../../src/appointments/in-memory-appointment';
import type { LLMGateway } from '../../src/ai/gateway/gateway';
import type { TaskContext } from '../../src/ai/tasks/task-handlers';
import type { JobRepository } from '../../src/jobs/job';

const tenantA = '00000000-0000-4000-8000-00000000000a';
const jobId = '00000000-0000-4000-8000-0000000000j1';

/** Minimal fake gateway that returns a fixed JSON booking. */
function fakeGateway(json: Record<string, unknown>): LLMGateway {
  return {
    complete: async () => ({ content: JSON.stringify(json) }),
  } as unknown as LLMGateway;
}

function context(): TaskContext {
  return {
    tenantId: tenantA,
    userId: 'agent-1',
    message: 'Book the Johnson AC repair next Tuesday at 2pm',
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

// A valid-hex UUID (the shared `jobId` fixture above is intentionally non-hex).
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
