import { describe, it, expect, beforeEach } from 'vitest';
import { CreateAppointmentAITaskHandler } from '../../src/ai/tasks/create-appointment-task';
import { InMemoryAppointmentRepository } from '../../src/appointments/in-memory-appointment';
import type { LLMGateway } from '../../src/ai/gateway/gateway';
import type { TaskContext } from '../../src/ai/tasks/task-handlers';

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
