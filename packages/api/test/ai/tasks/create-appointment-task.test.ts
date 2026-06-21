/**
 * CreateAppointmentAITaskHandler unit tests.
 *
 * Covers the hybrid appointment flow: the LLM extracts the verbatim
 * date/time phrase, and `resolveDateTime` translates it deterministically
 * against the TENANT timezone + current instant (both threaded on the
 * context). Ambiguous/invalid phrases become a voice_clarification.
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

// Monday 2026-06-01 noon UTC = 08:00 EDT. June keeps NY on EDT (UTC-4).
const NOW = new Date('2026-06-01T12:00:00.000Z');
const TZ = 'America/New_York';

describe('CreateAppointmentAITaskHandler', () => {
  const tenantId = 'tenant-1';
  const userId = 'user-1';

  it('resolves the spoken phrase to the tenant-timezone UTC instant', async () => {
    const gateway = mockGateway(
      JSON.stringify({
        dateTimePhrase: 'tomorrow at 2pm',
        customerName: 'Mrs Lee',
        summary: 'Follow-up visit',
        confidence_score: 0.88,
      })
    );
    const handler = new CreateAppointmentAITaskHandler(gateway);

    const result = await handler.handle({
      tenantId,
      userId,
      message: 'Schedule a follow-up with Mrs Lee tomorrow at 2pm',
      timezone: TZ,
      now: NOW,
    });

    expect(result.taskType).toBe('create_appointment');
    expect(result.proposal.proposalType).toBe('create_appointment');

    const payload = result.proposal.payload as Record<string, unknown>;
    // 2pm EDT on Tue Jun 2 == 18:00Z (NOT 21:00Z, which the old hardcoded
    // America/Los_Angeles prompt would have produced).
    expect(payload.scheduledStart).toBe('2026-06-02T18:00:00.000Z');
    expect(payload.scheduledEnd).toBe('2026-06-02T19:00:00.000Z');
    expect(payload.timezone).toBe(TZ);
    expect(payload.customerName).toBe('Mrs Lee');
    // The summary the dispatcher sees / TTS reads back is the RESOLVED time.
    expect(result.proposal.summary).toContain('2:00');
  });

  it('carries a valid appointmentType from the model onto the proposal payload', async () => {
    const gateway = mockGateway(
      JSON.stringify({
        dateTimePhrase: 'tomorrow at 2pm',
        summary: 'Furnace not igniting',
        appointmentType: 'repair',
        confidence_score: 0.9,
      })
    );
    const handler = new CreateAppointmentAITaskHandler(gateway);

    const result = await handler.handle({
      tenantId,
      userId,
      message: 'Book a repair for the furnace tomorrow at 2pm',
      timezone: TZ,
      now: NOW,
    });

    const payload = result.proposal.payload as Record<string, unknown>;
    expect(payload.appointmentType).toBe('repair');
  });

  it('drops an out-of-enum appointmentType the model hallucinates', async () => {
    const gateway = mockGateway(
      JSON.stringify({
        dateTimePhrase: 'tomorrow at 2pm',
        summary: 'No heat',
        // urgency is not a type — must not ride onto the payload
        appointmentType: 'emergency',
        confidence_score: 0.9,
      })
    );
    const handler = new CreateAppointmentAITaskHandler(gateway);

    const result = await handler.handle({
      tenantId,
      userId,
      message: 'No heat, come tomorrow at 2pm',
      timezone: TZ,
      now: NOW,
    });

    const payload = result.proposal.payload as Record<string, unknown>;
    expect(payload.appointmentType).toBeUndefined();
  });

  it('carries an arrival window for a daypart phrase', async () => {
    const gateway = mockGateway(
      JSON.stringify({ dateTimePhrase: 'tomorrow morning', summary: 'AC tune-up', confidence_score: 0.8 })
    );
    const handler = new CreateAppointmentAITaskHandler(gateway);
    const result = await handler.handle({
      tenantId,
      userId,
      message: 'Can someone come tomorrow morning',
      timezone: TZ,
      now: NOW,
    });
    const payload = result.proposal.payload as Record<string, unknown>;
    expect(payload.arrivalWindowStart).toBe('2026-06-02T12:00:00.000Z'); // 8am EDT
    expect(payload.arrivalWindowEnd).toBe('2026-06-02T16:00:00.000Z'); // 12pm EDT
  });

  it('emits a voice_clarification when the time cannot be resolved', async () => {
    const gateway = mockGateway('not json');
    const handler = new CreateAppointmentAITaskHandler(gateway);

    const result = await handler.handle({
      tenantId,
      userId,
      message: 'Schedule something soon',
      timezone: TZ,
      now: NOW,
    });

    expect(result.proposal.proposalType).toBe('voice_clarification');
    const payload = result.proposal.payload as Record<string, unknown>;
    expect(payload.scheduledStart).toBeUndefined();
  });

  it('emits a voice_clarification for a date with no time of day', async () => {
    const gateway = mockGateway(
      JSON.stringify({ dateTimePhrase: 'next Tuesday', confidence_score: 0.8 })
    );
    const handler = new CreateAppointmentAITaskHandler(gateway);
    const result = await handler.handle({
      tenantId,
      userId,
      message: 'book me next Tuesday',
      timezone: TZ,
      now: NOW,
    });
    expect(result.proposal.proposalType).toBe('voice_clarification');
  });

  it('threads conversationId into sourceContext on a resolved proposal', async () => {
    const gateway = mockGateway(
      JSON.stringify({ dateTimePhrase: 'tomorrow at 2pm', confidence_score: 0.9 })
    );
    const handler = new CreateAppointmentAITaskHandler(gateway);
    const result = await handler.handle({
      tenantId,
      userId,
      message: 'schedule it tomorrow at 2pm',
      conversationId: 'conv-99',
      timezone: TZ,
      now: NOW,
    });
    expect(result.proposal.proposalType).toBe('create_appointment');
    expect(result.proposal.sourceContext).toEqual({ conversationId: 'conv-99' });
  });

  it('sends the classifier transcript as the user message to the LLM', async () => {
    const gateway = mockGateway(
      JSON.stringify({ dateTimePhrase: 'tomorrow at 2pm', customerName: 'Mrs Lee', confidence_score: 0.9 })
    );
    const handler = new CreateAppointmentAITaskHandler(gateway);
    await handler.handle({
      tenantId,
      userId,
      message: 'schedule a follow-up with Mrs Lee tomorrow at 2pm',
      timezone: TZ,
      now: NOW,
    });
    const call = (gateway.complete as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.taskType).toBe('create_appointment');
    expect(call.responseFormat).toBe('json');
    expect(call.messages[1].content).toContain('Mrs Lee');
  });

  it('falls back to the product-default timezone when the context omits one', async () => {
    const gateway = mockGateway(
      JSON.stringify({ dateTimePhrase: 'tomorrow at 2pm', confidence_score: 0.9 })
    );
    const handler = new CreateAppointmentAITaskHandler(gateway);
    const result = await handler.handle({
      tenantId,
      userId,
      message: 'schedule it tomorrow at 2pm',
      now: NOW,
      // no timezone — must default to America/New_York, never a hardcoded zone
    });
    const payload = result.proposal.payload as Record<string, unknown>;
    expect(payload.timezone).toBe('America/New_York');
    expect(payload.scheduledStart).toBe('2026-06-02T18:00:00.000Z');
  });
});

// ─── RV-007 (F-4): Confidence Marker `_meta` ─────────────────────────────
describe('RV-007 — CreateAppointmentAITaskHandler populates payload._meta', () => {
  const tenantId = 'tenant-1';
  const userId = 'user-1';

  it('sets overallConfidence mapped from the task confidence score (overall-only — no per-field signal)', async () => {
    const gateway = mockGateway(
      JSON.stringify({
        dateTimePhrase: 'tomorrow at 2pm',
        summary: 'Follow-up visit',
        confidence_score: 0.88,
      }),
    );
    const handler = new CreateAppointmentAITaskHandler(gateway);

    const result = await handler.handle({
      tenantId,
      userId,
      message: 'Schedule a follow-up tomorrow at 2pm',
      timezone: TZ,
      now: NOW,
    });

    expect(result.proposal.proposalType).toBe('create_appointment');
    const meta = (result.proposal.payload as Record<string, unknown>)._meta as Record<
      string,
      unknown
    >;
    expect(meta).toBeDefined();
    expect(meta.overallConfidence).toBe('high'); // 0.88 ≥ 0.8
    expect(meta.fieldConfidence).toBeUndefined();
    expect(meta.markers).toBeUndefined();
  });

  it('maps a mid score to medium', async () => {
    const gateway = mockGateway(
      JSON.stringify({
        dateTimePhrase: 'tomorrow at 2pm',
        summary: 'AC tune-up',
        confidence_score: 0.6,
      }),
    );
    const handler = new CreateAppointmentAITaskHandler(gateway);

    const result = await handler.handle({
      tenantId,
      userId,
      message: 'come tomorrow at 2pm',
      timezone: TZ,
      now: NOW,
    });

    const meta = (result.proposal.payload as Record<string, unknown>)._meta as Record<
      string,
      unknown
    >;
    expect(meta.overallConfidence).toBe('medium');
  });
});
