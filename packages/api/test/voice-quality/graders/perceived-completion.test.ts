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
