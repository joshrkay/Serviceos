/**
 * VQ-022 — Disposition-LLM grader tests.
 *
 * Validates the LLM-as-judge that grades criterion 12 (caller-facing
 * answer matches ground truth) plus the soft slot fields in criterion 10
 * (notes / reason / description text). Driven entirely against
 * `createMockLLMGateway` so tests are deterministic and offline.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { createMockLLMGateway } from '../../../src/ai/gateway/factory';
import {
  gradeDispositionLlm,
  resetJudgeCache,
} from '../../../src/ai/voice-quality/graders/disposition-llm';
import type { Observation } from '../../../src/ai/voice-quality/observation';
import type { VoiceQualityScript } from '../../../src/ai/voice-quality/schema';
import type { Proposal } from '../../../src/proposals/proposal';

function makeScript(overrides: Partial<VoiceQualityScript> = {}): VoiceQualityScript {
  return {
    id: 'vq-022-fixture',
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
    grading: { appliesFloor: [], appliesDisposition: [10, 12] },
    layer2Eligible: false,
    ...overrides,
  };
}

function makeObservation(overrides: Partial<Observation> = {}): Observation {
  return {
    callId: 'call-vq022',
    scriptId: 'vq-022-fixture',
    tenantId: 't-vq022',
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

function makeProposal(payload: Record<string, unknown>): Proposal {
  return {
    id: 'p-1',
    tenantId: 't-vq022',
    proposalType: 'add_note',
    status: 'ready_for_review',
    payload,
    summary: 'Your next appointment is Tuesday at 10am.',
  } as Proposal;
}

const PASS_RESPONSE = JSON.stringify({
  answerMeaningMatches: true,
  softSlotsReasonable: true,
  rationale: 'looks good',
});

describe('VQ-022 — gradeDispositionLlm', () => {
  beforeEach(() => {
    resetJudgeCache();
  });

  it('VQ-022 — passes when judge says answerMeaningMatches: true AND softSlotsReasonable: true for all turns', async () => {
    const { gateway, provider } = createMockLLMGateway(PASS_RESPONSE);
    const script = makeScript();
    const observation = makeObservation({ proposals: [makeProposal({ note: 'next appt tuesday' })] });

    const result = await gradeDispositionLlm({ observation, script, gateway });

    expect(result.passed).toBe(true);
    expect(result.failedCriteria).toEqual([]);
    expect(result.perTurnDetail).toHaveLength(1);
    expect(result.perTurnDetail[0].answerJudgePass).toBe(true);
    expect(result.perTurnDetail[0].softSlotJudgePass).toBe(true);
    expect(provider.getCalls()).toHaveLength(1);
  });

  it('VQ-022 — fails criterion 12 when judge says answerMeaningMatches: false on any turn', async () => {
    const { gateway } = createMockLLMGateway(
      JSON.stringify({
        answerMeaningMatches: false,
        softSlotsReasonable: true,
        rationale: 'agent gave wrong date',
      }),
    );
    const script = makeScript();
    const observation = makeObservation({ proposals: [makeProposal({})] });

    const result = await gradeDispositionLlm({ observation, script, gateway });

    expect(result.passed).toBe(false);
    expect(result.failedCriteria).toContain(12);
    expect(result.failedCriteria).not.toContain(10);
    expect(result.reasons[12]).toMatch(/wrong date/);
  });

  it('VQ-022 — fails criterion 10 (soft slots) when softSlotsReasonable: false on any turn', async () => {
    const { gateway } = createMockLLMGateway(
      JSON.stringify({
        answerMeaningMatches: true,
        softSlotsReasonable: false,
        rationale: 'note text omits caller-stated reason',
      }),
    );
    const script = makeScript();
    const observation = makeObservation({ proposals: [makeProposal({ note: '' })] });

    const result = await gradeDispositionLlm({ observation, script, gateway });

    expect(result.passed).toBe(false);
    expect(result.failedCriteria).toContain(10);
    expect(result.failedCriteria).not.toContain(12);
    expect(result.reasons[10]).toMatch(/omits caller-stated reason/);
  });

  it('VQ-022 — caches by hash: same input twice → only one judge call', async () => {
    const { gateway, provider } = createMockLLMGateway(PASS_RESPONSE);
    const script = makeScript();
    const observation = makeObservation({ proposals: [makeProposal({ note: 'n' })] });

    await gradeDispositionLlm({ observation, script, gateway });
    await gradeDispositionLlm({ observation, script, gateway });

    expect(provider.getCalls()).toHaveLength(1);
  });

  it('VQ-022 — handles missing spoken answer gracefully', async () => {
    const { gateway, provider } = createMockLLMGateway(PASS_RESPONSE);
    const script = makeScript();
    // No proposals → no spoken answer to grade.
    const observation = makeObservation({ proposals: [] });

    const result = await gradeDispositionLlm({ observation, script, gateway });

    expect(result.passed).toBe(true);
    expect(result.perTurnDetail[0].spokenAnswer).toBeNull();
    expect(result.perTurnDetail[0].judgeRationale).toMatch(/no spoken answer captured/);
    // Skipped: no judge call should happen for a missing answer.
    expect(provider.getCalls()).toHaveLength(0);
  });

  it('VQ-022 — handles missing expected answer (judges for reasonableness only)', async () => {
    const { gateway, provider } = createMockLLMGateway(PASS_RESPONSE);
    const script = makeScript({
      turns: [
        {
          caller: 'just confirm something',
          expected: { intent: 'lookup_appointments' }, // no spokenAnswerMatches
          hangupAfter: false,
        },
      ],
    });
    const observation = makeObservation({ proposals: [makeProposal({ note: 'x' })] });

    const result = await gradeDispositionLlm({ observation, script, gateway });

    expect(result.passed).toBe(true);
    expect(provider.getCalls()).toHaveLength(1);
    const userMsg = provider.getCalls()[0].messages.find((m) => m.role === 'user')!.content;
    // When expected is absent, the prompt explicitly tells the judge to grade for reasonableness.
    expect(userMsg).toMatch(/no explicit expectation/);
  });

  it('VQ-022 — calls cost tracker if provided', async () => {
    const { gateway } = createMockLLMGateway(PASS_RESPONSE);
    const script = makeScript();
    const observation = makeObservation({ proposals: [makeProposal({ note: 'n' })] });

    let total = 0;
    const costTracker = { addCents: (n: number) => { total += n; } };

    await gradeDispositionLlm({ observation, script, gateway, costTracker });

    expect(total).toBeGreaterThan(0);
  });

  it('VQ-022 — invalid JSON from gateway throws clear error', async () => {
    const { gateway } = createMockLLMGateway('not json {{{');
    const script = makeScript();
    const observation = makeObservation({ proposals: [makeProposal({ note: 'n' })] });

    await expect(
      gradeDispositionLlm({ observation, script, gateway }),
    ).rejects.toThrow(/judge.*JSON|invalid.*judge|disposition-llm/i);
  });

  it('VQ-022 — concurrency cap: dispatching 10 turns with batch size 5 results in at most 5 in-flight at once', async () => {
    // We hand-instrument the mock provider to record concurrent in-flight count.
    const { gateway, provider } = createMockLLMGateway(PASS_RESPONSE);
    let inFlight = 0;
    let maxInFlight = 0;
    const originalComplete = provider.complete.bind(provider);
    provider.complete = async (req) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      // Yield twice so multiple promises can stack up if concurrency was unbounded.
      await new Promise((r) => setTimeout(r, 5));
      const res = await originalComplete(req);
      inFlight -= 1;
      return res;
    };

    const turns = Array.from({ length: 10 }, (_, i) => ({
      caller: `caller turn ${i}`,
      expected: {
        intent: 'lookup_appointments',
        spokenAnswerMatches: `expected answer ${i}`,
      },
      hangupAfter: false,
    }));
    const script = makeScript({ turns });
    const proposals = turns.map((_, i) => makeProposal({ note: `note ${i}` }));
    const observation = makeObservation({ proposals });

    const result = await gradeDispositionLlm({ observation, script, gateway });

    expect(result.passed).toBe(true);
    expect(provider.getCalls()).toHaveLength(10);
    expect(maxInFlight).toBeLessThanOrEqual(5);
    expect(maxInFlight).toBeGreaterThan(1); // sanity: parallelism IS happening
  });
});
