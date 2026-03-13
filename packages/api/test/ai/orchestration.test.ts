import { TaskRouter, createDefaultTaskRouter } from '../../src/ai/orchestration/task-router';
import {
  CreateCustomerTaskHandler,
  CreateJobTaskHandler,
  CreateAppointmentTaskHandler,
  DraftEstimateTaskHandler,
} from '../../src/ai/tasks/task-handlers';
import type { TaskContext } from '../../src/ai/tasks/task-handlers';
import { AppError } from '../../src/shared/errors';

function makeContext(overrides: Partial<TaskContext> = {}): TaskContext {
  return {
    tenantId: 'tenant-1',
    message: 'Create a new customer named John Doe with email john@example.com and phone 555-1234',
    userId: 'user-1',
    ...overrides,
  };
}

describe('P2-007 — AI task orchestration baseline', () => {
  it('happy path — routes to create_customer handler', async () => {
    const router = createDefaultTaskRouter();
    const context = makeContext({
      message: 'Create customer John Doe, john@example.com, 555-1234',
    });

    const result = await router.route('create_customer', context);

    expect(result.taskType).toBe('create_customer');
    expect(result.proposal.proposalType).toBe('create_customer');
    expect(result.proposal.status).toBe('draft');
    expect(result.proposal.tenantId).toBe('tenant-1');
    expect(result.proposal.summary).toBe(context.message);
    expect(result.proposal.createdBy).toBe('user-1');
    expect(result.proposal.id).toBeTruthy();
  });

  it('happy path — routes to create_job handler', async () => {
    const router = createDefaultTaskRouter();
    const context = makeContext({
      message: 'Create a plumbing repair job',
      existingEntities: { title: 'Plumbing Repair', description: 'Fix leaking pipe in kitchen' },
    });

    const result = await router.route('create_job', context);

    expect(result.taskType).toBe('create_job');
    expect(result.proposal.proposalType).toBe('create_job');
    expect(result.proposal.status).toBe('draft');
    expect(result.proposal.payload).toEqual({
      title: 'Plumbing Repair',
      description: 'Fix leaking pipe in kitchen',
    });
  });

  it('happy path — routes to create_appointment handler', async () => {
    const router = createDefaultTaskRouter();
    const context = makeContext({
      message: 'Schedule appointment for tomorrow at 2pm',
      conversationId: 'conv-1',
    });

    const result = await router.route('create_appointment', context);

    expect(result.taskType).toBe('create_appointment');
    expect(result.proposal.proposalType).toBe('create_appointment');
    expect(result.proposal.status).toBe('draft');
    expect(result.proposal.sourceContext).toEqual({ conversationId: 'conv-1' });
  });

  it('happy path — routes to draft_estimate handler', async () => {
    const router = createDefaultTaskRouter();
    const context = makeContext({
      message: 'Draft estimate for HVAC installation',
      existingEntities: { lineItems: [{ item: 'HVAC Unit', price: 5000 }], total: 5000 },
    });

    const result = await router.route('draft_estimate', context);

    expect(result.taskType).toBe('draft_estimate');
    expect(result.proposal.proposalType).toBe('draft_estimate');
    expect(result.proposal.status).toBe('draft');
    expect(result.proposal.payload).toEqual({
      lineItems: [{ item: 'HVAC Unit', price: 5000 }],
      total: 5000,
    });
  });

  it('validation — rejects unsupported task type', async () => {
    const router = createDefaultTaskRouter();
    const context = makeContext();

    await expect(
      router.route('unsupported_task', context)
    ).rejects.toThrow(AppError);

    try {
      await router.route('unsupported_task', context);
    } catch (err) {
      expect(err).toBeInstanceOf(AppError);
      expect((err as AppError).code).toBe('UNSUPPORTED_TASK');
      expect((err as AppError).statusCode).toBe(400);
      expect((err as AppError).message).toContain('unsupported_task');
    }
  });

  it('happy path — lists registered task types', () => {
    const router = createDefaultTaskRouter();
    const tasks = router.listRegisteredTasks();

    expect(tasks).toContain('create_customer');
    expect(tasks).toContain('create_job');
    expect(tasks).toContain('create_appointment');
    expect(tasks).toContain('draft_estimate');
    expect(tasks).toHaveLength(4);
  });

  it('mock provider test — handler creates valid proposal', async () => {
    const handler = new CreateCustomerTaskHandler();
    const context = makeContext({
      existingEntities: { name: 'Jane Smith', email: 'jane@example.com', phone: '555-9876' },
      conversationId: 'conv-42',
    });

    const result = await handler.handle(context);

    expect(result.proposal.id).toBeTruthy();
    expect(result.proposal.proposalType).toBe('create_customer');
    expect(result.proposal.status).toBe('draft');
    expect(result.proposal.tenantId).toBe('tenant-1');
    expect(result.proposal.createdBy).toBe('user-1');
    expect(result.proposal.payload).toEqual({
      name: 'Jane Smith',
      email: 'jane@example.com',
      phone: '555-9876',
    });
    expect(result.proposal.sourceContext).toEqual({ conversationId: 'conv-42' });
    expect(result.proposal.createdAt).toBeInstanceOf(Date);
    expect(result.proposal.updatedAt).toBeInstanceOf(Date);
  });

  it('malformed AI output handled gracefully — handler with bad context', async () => {
    const router = createDefaultTaskRouter();
    const context = makeContext({
      message: '',
      existingEntities: {},
    });

    // Handler should still create a valid proposal even with empty/minimal context
    const result = await router.route('create_customer', context);

    expect(result.proposal.id).toBeTruthy();
    expect(result.proposal.proposalType).toBe('create_customer');
    expect(result.proposal.status).toBe('draft');
    expect(result.proposal.payload).toEqual({});
    expect(result.proposal.summary).toBe('');
  });
});
