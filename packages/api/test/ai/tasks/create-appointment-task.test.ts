/**
 * CreateAppointmentAITaskHandler unit tests.
 *
 * Covers the Phase-1 appointment flow: natural-language ("next Tuesday
 * at 2pm") → ISO datetime. Unlike the minimal CreateAppointmentTaskHandler,
 * this one runs an LLM to resolve the date and extract entities.
 */
import { describe, it, expect, vi } from 'vitest';
import { CreateAppointmentAITaskHandler } from '../../../src/ai/tasks/create-appointment-task';
import { LLMGateway, LLMResponse } from '../../../src/ai/gateway/gateway';

function mockGateway(jsonContent: string): LLMGateway {
  return {
    complete: vi.fn(async () => ({
      content: jsonContent,
      model: 'mock-model',
      provider: 'mock',
      tokenUsage: { input: 120, output: 80, total: 200 },
      latencyMs: 55,
    } satisfies LLMResponse)),
  } as unknown as LLMGateway;
}

describe('CreateAppointmentAITaskHandler', () => {
  const tenantId = 'tenant-1';
  const userId = 'user-1';

  it('produces a create_appointment proposal with LLM-parsed scheduledStart', async () => {
    const gateway = mockGateway(
      JSON.stringify({
        customerName: 'Mrs Lee',
        scheduledStart: '2026-04-21T21:00:00Z',
        scheduledEnd: '2026-04-21T22:00:00Z',
        summary: 'Follow-up visit',
        confidence_score: 0.88,
      })
    );
    const handler = new CreateAppointmentAITaskHandler(gateway);

    const result = await handler.handle({
      tenantId,
      userId,
      message: 'Schedule a follow-up with Mrs Lee next Tuesday at 2pm',
    });

    expect(result.taskType).toBe('create_appointment');
    expect(result.proposal.proposalType).toBe('create_appointment');
    expect(result.proposal.tenantId).toBe(tenantId);
    expect(result.proposal.createdBy).toBe(userId);

    const payload = result.proposal.payload as Record<string, unknown>;
    expect(payload.scheduledStart).toBe('2026-04-21T21:00:00Z');
    expect(payload.scheduledEnd).toBe('2026-04-21T22:00:00Z');
    expect(payload.customerName).toBe('Mrs Lee');
  });

  it('falls back to empty payload when LLM returns unparseable JSON', async () => {
    const gateway = mockGateway('not json');
    const handler = new CreateAppointmentAITaskHandler(gateway);

    const result = await handler.handle({
      tenantId,
      userId,
      message: 'Schedule something for tomorrow',
    });

    expect(result.proposal.proposalType).toBe('create_appointment');
    const payload = result.proposal.payload as Record<string, unknown>;
    expect(payload.scheduledStart).toBeUndefined();
    // Confidence should be low — assessConfidence sees zero fields.
    expect(result.proposal.confidenceScore ?? 1).toBeLessThan(0.9);
  });

  it('threads conversationId into sourceContext when provided', async () => {
    const gateway = mockGateway(
      JSON.stringify({
        scheduledStart: '2026-04-21T21:00:00Z',
        scheduledEnd: '2026-04-21T22:00:00Z',
        confidence_score: 0.9,
      })
    );
    const handler = new CreateAppointmentAITaskHandler(gateway);
    const result = await handler.handle({
      tenantId,
      userId,
      message: 'schedule it',
      conversationId: 'conv-99',
    });
    expect(result.proposal.sourceContext).toEqual({ conversationId: 'conv-99' });
  });

  it('ignores non-ISO date strings defensively', async () => {
    const gateway = mockGateway(
      JSON.stringify({
        scheduledStart: 'next Tuesday',
        scheduledEnd: 'after that',
        confidence_score: 0.8,
      })
    );
    const handler = new CreateAppointmentAITaskHandler(gateway);
    const result = await handler.handle({
      tenantId,
      userId,
      message: 'schedule something',
    });
    const payload = result.proposal.payload as Record<string, unknown>;
    // Refusing garbage dates is better than persisting them as-is —
    // the downstream CreateAppointmentExecutionHandler validates dates
    // and a bad string would blow up on execute.
    expect(payload.scheduledStart).toBeUndefined();
    expect(payload.scheduledEnd).toBeUndefined();
  });

  it('sends the classifier transcript as the user message to the LLM', async () => {
    const gateway = mockGateway(
      JSON.stringify({
        scheduledStart: '2026-04-21T21:00:00Z',
        scheduledEnd: '2026-04-21T22:00:00Z',
        confidence_score: 0.9,
      })
    );
    const handler = new CreateAppointmentAITaskHandler(gateway);
    await handler.handle({
      tenantId,
      userId,
      message: 'schedule a follow-up with Mrs Lee next Tuesday at 2pm',
    });
    const call = (gateway.complete as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.taskType).toBe('create_appointment');
    expect(call.responseFormat).toBe('json');
    expect(call.messages[1].content).toContain('Mrs Lee');
  });
});
