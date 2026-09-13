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

  // This test used to assert the OPPOSITE: that a context with no timezone
  // "falls back to the product default" of America/New_York. That default is
  // exactly the defect — an operator in America/Phoenix had every spoken
  // booking stored three hours early and auto-executed at confidence 1,
  // because a US-East timestamp is indistinguishable from a correct one.
  // There is no default zone any more; an unresolvable tenant timezone gates.
  it('gates instead of booking at a guessed zone when the context omits a timezone', async () => {
    const gateway = mockGateway(
      JSON.stringify({ dateTimePhrase: 'tomorrow at 2pm', confidence_score: 0.9 })
    );
    const handler = new CreateAppointmentAITaskHandler(gateway);
    const result = await handler.handle({
      tenantId,
      userId,
      message: 'schedule it tomorrow at 2pm',
      now: NOW,
      // no timezone — must NOT book at a guessed zone
    });

    expect(result.taskType).toBe('voice_clarification');
    expect(result.proposal.proposalType).toBe('voice_clarification');
    expect(result.proposal.sourceContext?.reason).toBe('tenant_timezone_unconfigured');
    // Nothing is booked, and nothing spoken is lost.
    const payload = result.proposal.payload as Record<string, unknown>;
    expect(payload.scheduledStart).toBeUndefined();
    expect(payload.transcript).toBe('schedule it tomorrow at 2pm');
    // A clarification carries no trust tier, so it can never auto-approve.
    expect(result.proposal.status).toBe('draft');
  });

  it('gates on a timezone the runtime does not recognize', async () => {
    const gateway = mockGateway(
      JSON.stringify({ dateTimePhrase: 'tomorrow at 2pm', confidence_score: 0.9 })
    );
    const handler = new CreateAppointmentAITaskHandler(gateway);
    const result = await handler.handle({
      tenantId,
      userId,
      message: 'schedule it tomorrow at 2pm',
      now: NOW,
      timezone: 'Foo/Bar',
    });
    expect(result.proposal.proposalType).toBe('voice_clarification');
    expect(result.proposal.sourceContext?.reason).toBe('tenant_timezone_unconfigured');
  });
});

// ─── Round 4b (sweep row A33) — jobId verify-or-gate ─────────────────────
//
// A33's live defect: the drafting LLM echoed the SPOKEN JOB NAME verbatim
// into `jobId` ("QA Sweep Furnace Inspection" — a title, not a uuid). The
// payload validated fine (nothing checked its shape), auto-approved at
// confidence 0.9, and died at execution with Postgres's `invalid input
// syntax for type uuid`. These tests pin the fix: an unresolvable jobId
// never rides the payload — it becomes a `missingFields: ['jobId']` gate
// with the raw text preserved on `jobReference`, and a router-resolved id
// (context.existingEntities.jobId) always wins over the model's own guess.
describe('Round 4b — jobId verify-or-gate (sweep row A33)', () => {
  const tenantId = 'tenant-1';
  const userId = 'user-1';

  it('gates instead of persisting a job TITLE the LLM echoed into jobId', async () => {
    const gateway = mockGateway(
      JSON.stringify({
        dateTimePhrase: 'Thursday morning',
        jobId: 'QA Sweep Furnace Inspection',
        summary: 'Rough-in inspection',
        confidence_score: 0.9,
      }),
    );
    const handler = new CreateAppointmentAITaskHandler(gateway);

    const result = await handler.handle({
      tenantId,
      userId,
      message: 'Schedule a rough-in inspection for the QA Sweep Furnace Inspection job Thursday morning',
      timezone: TZ,
      now: NOW,
    });

    const payload = result.proposal.payload as Record<string, unknown>;
    // Never a malformed id on the payload...
    expect(payload.jobId).toBeUndefined();
    // ...the raw text is preserved for the entity resolver instead...
    expect(payload.jobReference).toBe('QA Sweep Furnace Inspection');
    // ...and the proposal is gated, not silently approvable.
    expect(result.proposal.sourceContext?.missingFields).toEqual(['jobId']);
    // Confidence hygiene: missingFields forces 'draft' regardless of the
    // model's own high confidence score and the autonomous trust tier.
    expect(result.proposal.status).toBe('draft');
  });

  it('prefers the router-resolved jobId over the LLM-echoed value', async () => {
    const resolvedJobId = '11111111-2222-3333-4444-555555555555';
    const gateway = mockGateway(
      JSON.stringify({
        dateTimePhrase: 'Thursday morning',
        jobId: 'QA Sweep Furnace Inspection',
        confidence_score: 0.9,
      }),
    );
    const handler = new CreateAppointmentAITaskHandler(gateway);

    const result = await handler.handle({
      tenantId,
      userId,
      message: 'Schedule a rough-in inspection for the QA Sweep Furnace Inspection job Thursday morning',
      timezone: TZ,
      now: NOW,
      existingEntities: { jobId: resolvedJobId },
    });

    const payload = result.proposal.payload as Record<string, unknown>;
    expect(payload.jobId).toBe(resolvedJobId);
    expect(result.proposal.sourceContext?.missingFields).toBeUndefined();
    // The B4 allowlist stamp so routes/assistant.ts's dropUnverifiedIds
    // never scrubs this DB-verified id back out.
    expect(result.proposal.sourceContext?.verifiedIds).toEqual({ jobId: resolvedJobId });
  });

  it('trusts a well-formed uuid the LLM produced on its own (unchanged behavior)', async () => {
    const llmJobId = '99999999-8888-7777-6666-555555555555';
    const gateway = mockGateway(
      JSON.stringify({
        dateTimePhrase: 'tomorrow at 2pm',
        jobId: llmJobId,
        confidence_score: 0.9,
      }),
    );
    const handler = new CreateAppointmentAITaskHandler(gateway);

    const result = await handler.handle({
      tenantId,
      userId,
      message: 'book it tomorrow at 2pm',
      timezone: TZ,
      now: NOW,
    });

    const payload = result.proposal.payload as Record<string, unknown>;
    expect(payload.jobId).toBe(llmJobId);
    expect(result.proposal.sourceContext?.missingFields).toBeUndefined();
  });

  it('leaves jobId absent (no gate) when the transcript never named a job — SCH-02 auto-open stays untouched', async () => {
    const gateway = mockGateway(
      JSON.stringify({
        dateTimePhrase: 'tomorrow at 2pm',
        customerName: 'Mrs Lee',
        confidence_score: 0.9,
      }),
    );
    const handler = new CreateAppointmentAITaskHandler(gateway);

    const result = await handler.handle({
      tenantId,
      userId,
      message: 'book a follow-up with Mrs Lee tomorrow at 2pm',
      timezone: TZ,
      now: NOW,
      customerId: 'cust-123',
    });

    const payload = result.proposal.payload as Record<string, unknown>;
    expect(payload.jobId).toBeUndefined();
    expect(payload.jobReference).toBeUndefined();
    expect(result.proposal.sourceContext?.missingFields).toBeUndefined();
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
