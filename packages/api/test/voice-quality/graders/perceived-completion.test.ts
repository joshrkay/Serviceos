/**
 * VQ2-010 — Perceived-completion (LLM-judged) grader tests.
 *
 * Validates the single-call-per-script LLM-as-judge that grades criterion 12
 * (caller-perceived completion) by reading the full transcript. Driven
 * against `createMockLLMGateway` so tests are deterministic and offline.
 */
import { describe, it, expect } from 'vitest';
import { createMockLLMGateway } from '../../../src/ai/gateway/factory';
import {
  gradePerceivedCompletion,
  type PerceivedCompletionVerdict,
} from '../../../src/ai/voice-quality/graders/perceived-completion';
import type { Observation } from '../../../src/ai/voice-quality/observation';
import type { VoiceQualityScript } from '../../../src/ai/voice-quality/schema';
import type { Proposal } from '../../../src/proposals/proposal';
import type { VoiceSessionEvent } from '../../../src/ai/agents/customer-calling/voice-session-store';
import type { LLMRequest, LLMResponse, LLMProvider } from '../../../src/ai/gateway/gateway';
import { LLMGateway as LLMGatewayClass } from '../../../src/ai/gateway/gateway';

function makeScript(overrides: Partial<VoiceQualityScript> = {}): VoiceQualityScript {
  return {
    id: 'vq2-010-fixture',
    bucket: '01-happy-lookups',
    fixtures: { tenant: {}, customers: [] },
    callerId: '+15551234567',
    callerIdBlocked: false,
    turns: [
      {
        caller: 'When is my next appointment?',
        expected: {
          intent: 'lookup_appointments',
          spokenAnswerMatches: 'Your next appointment is Tuesday at 10am.',
        },
        hangupAfter: false,
      },
    ],
    grading: { appliesFloor: [], appliesDisposition: [12] },
    layer2Eligible: true,
    ...overrides,
  };
}

function makeObservation(overrides: Partial<Observation> = {}): Observation {
  return {
    callId: 'call-vq2-010',
    scriptId: 'vq2-010-fixture',
    tenantId: 't-vq2-010',
    events: [],
    proposals: [] as Proposal[],
    customerCountDelta: 0,
    appointmentCountDelta: 0,
    audit: [],
    totalCostCents: 0,
    totalDurationMs: 1_000,
    perTurnLatencyMs: [800],
    sessionEndedAs: 'completed',
    hangupOccurred: false,
    errors: [],
    ...overrides,
  };
}

function verdict(
  satisfaction: 'good' | 'acceptable' | 'poor',
  abandonmentRisk: 0 | 1 | 2,
  rationale = 'looks good',
): string {
  return JSON.stringify({
    perceivedSatisfaction: satisfaction,
    rationale,
    abandonmentRisk,
  });
}

describe('VQ2-010 — gradePerceivedCompletion', () => {
  it('VQ2-010 — passes when judge returns satisfaction=good, abandonmentRisk=0', async () => {
    const { gateway, provider } = createMockLLMGateway(verdict('good', 0));
    const script = makeScript();
    const observation = makeObservation();

    const result = await gradePerceivedCompletion({ observation, script, gateway });

    expect(result.passed).toBe(true);
    expect(result.verdict.perceivedSatisfaction).toBe('good');
    expect(result.verdict.abandonmentRisk).toBe(0);
    expect(provider.getCalls()).toHaveLength(1);
  });

  it('VQ2-010 — passes when judge returns satisfaction=acceptable, abandonmentRisk=1', async () => {
    const { gateway } = createMockLLMGateway(verdict('acceptable', 1, 'one reprompt but resolved'));
    const result = await gradePerceivedCompletion({
      observation: makeObservation(),
      script: makeScript(),
      gateway,
    });

    expect(result.passed).toBe(true);
    expect(result.verdict.perceivedSatisfaction).toBe('acceptable');
    expect(result.verdict.abandonmentRisk).toBe(1);
  });

  it('VQ2-010 — fails when judge returns satisfaction=poor', async () => {
    const { gateway } = createMockLLMGateway(verdict('poor', 1, 'agent gave wrong info'));
    const result = await gradePerceivedCompletion({
      observation: makeObservation(),
      script: makeScript(),
      gateway,
    });

    expect(result.passed).toBe(false);
    expect(result.verdict.perceivedSatisfaction).toBe('poor');
  });

  it('VQ2-010 — fails when judge returns abandonmentRisk=2 regardless of satisfaction', async () => {
    const { gateway } = createMockLLMGateway(verdict('acceptable', 2, 'caller hung up frustrated'));
    const result = await gradePerceivedCompletion({
      observation: makeObservation(),
      script: makeScript(),
      gateway,
    });

    expect(result.passed).toBe(false);
    expect(result.verdict.abandonmentRisk).toBe(2);
  });

  it('VQ2-010 — caches by transcript hash: same input twice → only one judge call', async () => {
    const { gateway, provider } = createMockLLMGateway(verdict('good', 0));
    const cache = new Map<string, PerceivedCompletionVerdict>();
    const script = makeScript();
    const observation = makeObservation();

    await gradePerceivedCompletion({ observation, script, gateway, cache });
    await gradePerceivedCompletion({ observation, script, gateway, cache });

    expect(provider.getCalls()).toHaveLength(1);
    expect(cache.size).toBe(1);
  });

  it('VQ2-010 — different observation events → different cache key, both call judge', async () => {
    const { gateway, provider } = createMockLLMGateway(verdict('good', 0));
    const cache = new Map<string, PerceivedCompletionVerdict>();
    const script = makeScript();

    const eventA: VoiceSessionEvent = {
      type: 'intent_classified',
      ts: 1000,
      callId: 'c1',
      intent: 'lookup_appointments',
      confidence: 0.95,
    } as VoiceSessionEvent;
    const eventB: VoiceSessionEvent = {
      type: 'intent_classified',
      ts: 2000,
      callId: 'c1',
      intent: 'book_appointment',
      confidence: 0.9,
    } as VoiceSessionEvent;

    const obsA = makeObservation({ events: [eventA] });
    const obsB = makeObservation({ events: [eventB] });

    await gradePerceivedCompletion({ observation: obsA, script, gateway, cache });
    await gradePerceivedCompletion({ observation: obsB, script, gateway, cache });

    expect(provider.getCalls()).toHaveLength(2);
    expect(cache.size).toBe(2);
  });

  it('VQ2-fix — same events with different `ts` values → identical cache key (only one judge call)', async () => {
    // Regression for PR #334 review (Codex P2 / Gemini #4): without the cache
    // key omitting `ts` from event JSON, two voting runs that produce
    // structurally identical events with per-millisecond clock skew would
    // each pay for a separate judge call, defeating the runner-layer2
    // perceived-completion cache.
    const { gateway, provider } = createMockLLMGateway(verdict('good', 0));
    const cache = new Map<string, PerceivedCompletionVerdict>();
    const script = makeScript();

    const baseEvent = {
      type: 'intent_classified' as const,
      callId: 'c1',
      intent: 'lookup_appointments',
      confidence: 0.95,
    };
    const eventAtT1: VoiceSessionEvent = { ...baseEvent, ts: 1000 } as VoiceSessionEvent;
    const eventAtT2: VoiceSessionEvent = { ...baseEvent, ts: 1234 } as VoiceSessionEvent;

    const obsRun1 = makeObservation({ events: [eventAtT1] });
    const obsRun2 = makeObservation({ events: [eventAtT2] });

    await gradePerceivedCompletion({ observation: obsRun1, script, gateway, cache });
    await gradePerceivedCompletion({ observation: obsRun2, script, gateway, cache });

    expect(provider.getCalls()).toHaveLength(1);
    expect(cache.size).toBe(1);
  });

  it('VQ2-010 — invalid JSON from gateway throws clear error', async () => {
    const { gateway } = createMockLLMGateway('not json {{{');
    await expect(
      gradePerceivedCompletion({
        observation: makeObservation(),
        script: makeScript(),
        gateway,
      }),
    ).rejects.toThrow(/perceived-completion|judge.*JSON|invalid.*JSON/i);
  });

  it('VQ2-followup — buildTranscriptSummary uses speech_outbound transcripts when available', async () => {
    // Capture the user prompt the gateway sees so we can assert what
    // transcript the judge was actually given.
    let observedUserPrompt = '';
    const verdictBody = verdict('good', 0);
    const provider: LLMProvider = {
      name: 'mock',
      async complete(req: LLMRequest): Promise<LLMResponse> {
        const userMsg = req.messages.find((m) => m.role === 'user');
        observedUserPrompt = userMsg?.content ?? '';
        return {
          content: verdictBody,
          model: 'mock-model',
          provider: 'mock',
          latencyMs: 1,
          tokenUsage: { input: 10, output: 10, total: 20 },
        };
      },
      async isAvailable() {
        return true;
      },
    };
    const providers = new Map<string, LLMProvider>([['mock', provider]]);
    const gateway = new LLMGatewayClass({ defaultProvider: 'mock' }, providers);

    const script = makeScript({
      turns: [
        {
          caller: 'first caller line',
          expected: { intent: 'lookup_appointments', spokenAnswerMatches: 'expected answer 1' },
          hangupAfter: false,
        },
        {
          caller: 'second caller line',
          expected: { intent: 'lookup_appointments', spokenAnswerMatches: 'expected answer 2' },
          hangupAfter: false,
        },
      ],
    });
    const observation = makeObservation({
      events: [
        {
          type: 'speech_outbound',
          transcript: 'agent recovered turn 0',
          turnIndex: 0,
          ts: 1000,
        } as VoiceSessionEvent,
        {
          type: 'speech_outbound',
          transcript: 'agent recovered turn 1',
          turnIndex: 1,
          ts: 2000,
        } as VoiceSessionEvent,
      ],
    });

    await gradePerceivedCompletion({ observation, script, gateway });

    // The judge should see the recovered transcripts on the Agent: lines,
    // not the placeholder.
    expect(observedUserPrompt).toContain('Caller: first caller line');
    expect(observedUserPrompt).toContain('Agent: agent recovered turn 0');
    expect(observedUserPrompt).toContain('Caller: second caller line');
    expect(observedUserPrompt).toContain('Agent: agent recovered turn 1');
    expect(observedUserPrompt).not.toContain('<response captured in events>');
    expect(observedUserPrompt).not.toContain('<response not captured>');
  });

  it('VQ2-followup — buildTranscriptSummary falls back to "<response not captured>" when no speech_outbound for a turn', async () => {
    let observedUserPrompt = '';
    const verdictBody = verdict('good', 0);
    const provider: LLMProvider = {
      name: 'mock',
      async complete(req: LLMRequest): Promise<LLMResponse> {
        const userMsg = req.messages.find((m) => m.role === 'user');
        observedUserPrompt = userMsg?.content ?? '';
        return {
          content: verdictBody,
          model: 'mock-model',
          provider: 'mock',
          latencyMs: 1,
          tokenUsage: { input: 10, output: 10, total: 20 },
        };
      },
      async isAvailable() {
        return true;
      },
    };
    const providers = new Map<string, LLMProvider>([['mock', provider]]);
    const gateway = new LLMGatewayClass({ defaultProvider: 'mock' }, providers);

    const script = makeScript({
      turns: [
        {
          caller: 'turn 0 caller',
          expected: { intent: 'lookup_appointments', spokenAnswerMatches: 'turn 0 expected' },
          hangupAfter: false,
        },
        {
          caller: 'turn 1 caller',
          expected: { intent: 'lookup_appointments', spokenAnswerMatches: 'turn 1 expected' },
          hangupAfter: false,
        },
      ],
    });
    // Only turn 0 has a speech_outbound event; turn 1 falls back.
    const observation = makeObservation({
      events: [
        {
          type: 'speech_outbound',
          transcript: 'turn 0 actual',
          turnIndex: 0,
          ts: 1000,
        } as VoiceSessionEvent,
      ],
    });

    await gradePerceivedCompletion({ observation, script, gateway });

    expect(observedUserPrompt).toContain('Agent: turn 0 actual');
    expect(observedUserPrompt).toContain('Agent: <response not captured>');
  });

  // #1331 — the judge must grade against the product's contract, not an
  // imagined one where the agent executes changes mid-call. On the phone a
  // write is read back ("Just to confirm — … Is that right?") and, on the
  // caller's yes, DRAFTED for human approval (proposals never auto-execute);
  // the owner hears "it's in your approvals". Without that context the judge
  // has no way to tell an honest drafted-for-review close from a failure.
  it('#1331 — tells the judge the read-back-then-draft-for-approval contract and who is calling', async () => {
    const { gateway, provider } = createMockLLMGateway(verdict('good', 0));
    await gradePerceivedCompletion({
      observation: makeObservation(),
      script: makeScript({ callerIsOwner: true }),
      gateway,
    });

    const [call] = provider.getCalls();
    const system = call.messages.find((m) => m.role === 'system')!.content;
    const user = call.messages.find((m) => m.role === 'user')!.content;
    expect(system).toMatch(/never carries out a change during the call/i);
    expect(system).toMatch(/drafted for human approval/i);
    expect(user).toContain('Caller: the business owner, calling their own business line');

    const { gateway: g2, provider: p2 } = createMockLLMGateway(verdict('good', 0));
    await gradePerceivedCompletion({ observation: makeObservation(), script: makeScript(), gateway: g2 });
    const user2 = p2.getCalls()[0].messages.find((m) => m.role === 'user')!.content;
    expect(user2).toContain('Caller: a customer of the business');
  });

  // #1331 (run 36925905917) — lookup-appointments-next: the agent said
  // "Friday, June 12th at 9 a.m." (right: the corpus world is Friday
  // 2026-05-01 and June 12, 2026 is a Friday) and this judge called it "the
  // wrong date" — with no call date it guessed the year. The criterion-12
  // judge already gets the corpus call date; this one must too.
  it('#1331 — tells the judge the corpus call date, so spoken dates are judged against that calendar', async () => {
    const { gateway, provider } = createMockLLMGateway(verdict('good', 0));
    await gradePerceivedCompletion({ observation: makeObservation(), script: makeScript(), gateway });

    const user = provider.getCalls()[0].messages.find((m) => m.role === 'user')!.content;
    expect(user).toContain('Call date: Friday, May 1, 2026');
  });

  it('#1331 — returns the per-turn agent lines the judge read, so the report can show them', async () => {
    const { gateway } = createMockLLMGateway(verdict('good', 0));
    const script = makeScript({
      turns: [
        { caller: 'Add three boxes of PEX.', expected: {}, hangupAfter: false },
        { caller: "Yes, that's right.", expected: {}, hangupAfter: false },
      ],
    });
    const result = await gradePerceivedCompletion({
      observation: makeObservation({
        events: [
          { type: 'speech_outbound', transcript: 'Just to confirm — add material. Is that right?', turnIndex: 0, ts: 1 },
        ],
      }),
      script,
      gateway,
    });
    expect(result.agentTurns).toEqual([
      'Just to confirm — add material. Is that right?',
      '<response not captured>',
    ]);
  });

  it('VQ2-010 — verdict shape validated by Zod (rejects malformed responses)', async () => {
    // Valid JSON, but wrong shape — abandonmentRisk out of range, satisfaction not in enum.
    const { gateway } = createMockLLMGateway(
      JSON.stringify({
        perceivedSatisfaction: 'mediocre', // not in enum
        rationale: 'whatever',
        abandonmentRisk: 5, // out of range
      }),
    );
    await expect(
      gradePerceivedCompletion({
        observation: makeObservation(),
        script: makeScript(),
        gateway,
      }),
    ).rejects.toThrow(/perceived-completion|schema|invalid/i);
  });
});

// #1613 — Layer 2 run 37323734649: known-customer-no-signup was "poor" on all
// three runs ("incorrectly stated there's nothing to sign up for, failing to
// address the caller's intent"). The judge HAD the script's expected answer,
// rendered as "Turn 1: intent=create_customer, …, answer matches "…"", and
// read the classification label as the outcome owed to the caller. The
// expectation now names the classification as a label and the expected reply
// as the right outcome, and the system prompt says the spec is what to grade
// against. The year rule the criterion-12 judge gets is stated here too.
describe('#1613 — the judge grades against the scripted outcome, not the literal request', () => {
  it('describes the expectation as classified intent + the right reply, and says the spec is the outcome', async () => {
    const { gateway, provider } = createMockLLMGateway(verdict('good', 0));
    const script = makeScript({
      turns: [
        {
          caller: 'Hi, can I sign up?',
          expected: {
            intent: 'create_customer',
            alsoAcceptedIntents: ['lookup_account_summary'],
            escalates: false,
            spokenAnswerMatches: "I've got you in our system already, so there's nothing to sign up for.",
          },
          hangupAfter: false,
        },
      ],
    });

    await gradePerceivedCompletion({ observation: makeObservation(), script, gateway });

    const [call] = provider.getCalls();
    const system = call.messages.find((m) => m.role === 'system')!.content;
    const user = call.messages.find((m) => m.role === 'user')!.content;
    expect(user).toContain(
      "Expected outcome (the product's specification for this call; a reply matching it is the caller getting what they came for):",
    );
    expect(user).toContain(
      'Turn 1: the request is classified as create_customer (also accepted: lookup_account_summary); escalates: false; the right reply matches: "I\'ve got you in our system already, so there\'s nothing to sign up for."',
    );
    expect(system).toMatch(/specification of the right outcome/i);
    expect(system).toMatch(/says a year only when a date falls outside the call's year/i);
  });
});
