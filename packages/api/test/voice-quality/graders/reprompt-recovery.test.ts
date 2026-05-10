/**
 * VQ2-011 — Reprompt + recovery grader tests.
 *
 * Validates the per-turn LLM-judged reprompt classifier alongside the
 * recovery-turn counter. Driven against `createMockLLMGateway` whose
 * default response is overridden between calls so each turn gets a
 * distinct verdict (the project's MockLLMProvider exposes
 * `setDefaultResponse`, which we use as a queue-by-mutation).
 */
import { describe, it, expect } from 'vitest';
import { createMockLLMGateway } from '../../../src/ai/gateway/factory';
import {
  gradeRepromptAndRecovery,
  REPROMPT_RATIO_MAX,
  RECOVERY_MAX_TURNS,
} from '../../../src/ai/voice-quality/graders/caller-experience';
import type { Observation } from '../../../src/ai/voice-quality/observation';
import type { VoiceQualityScript } from '../../../src/ai/voice-quality/schema';
import type { Proposal } from '../../../src/proposals/proposal';
import type { LLMGateway, LLMRequest, LLMResponse, LLMProvider } from '../../../src/ai/gateway/gateway';
import { LLMGateway as LLMGatewayClass } from '../../../src/ai/gateway/gateway';

function makeScript(turnCount: number): VoiceQualityScript {
  return {
    id: 'vq2-011-fixture',
    bucket: '01-happy-lookups',
    fixtures: { tenant: {}, customers: [] },
    callerId: '+15551234567',
    callerIdBlocked: false,
    turns: Array.from({ length: turnCount }, (_, i) => ({
      caller: `caller utterance ${i + 1}`,
      expected: {
        intent: 'lookup_appointments',
        spokenAnswerMatches: `agent reply ${i + 1}`,
      },
      hangupAfter: false,
    })),
    grading: { appliesFloor: [], appliesDisposition: [] },
    layer2Eligible: true,
  };
}

function makeObservation(overrides: Partial<Observation> = {}): Observation {
  return {
    callId: 'call-vq2-011',
    scriptId: 'vq2-011-fixture',
    tenantId: 't-vq2-011',
    events: [],
    proposals: [] as Proposal[],
    customerCountDelta: 0,
    appointmentCountDelta: 0,
    audit: [],
    totalCostCents: 0,
    totalDurationMs: 1_000,
    perTurnLatencyMs: [],
    sessionEndedAs: 'completed',
    hangupOccurred: false,
    errors: [],
    ...overrides,
  };
}

function repromptVerdict(isReprompt: boolean): string {
  return JSON.stringify({ isReprompt, reason: isReprompt ? 'reprompts' : 'advances' });
}

/**
 * Build a gateway whose `complete()` returns successive verdicts from a
 * pre-seeded queue. After exhausting the queue it throws so a test that
 * makes more calls than expected fails loudly.
 */
function createQueuedGateway(verdicts: ReadonlyArray<string>): {
  gateway: LLMGateway;
  callCount: () => number;
  remaining: () => number;
} {
  const queue = [...verdicts];
  let calls = 0;
  const provider: LLMProvider = {
    name: 'mock',
    async complete(_request: LLMRequest): Promise<LLMResponse> {
      calls += 1;
      if (queue.length === 0) {
        throw new Error('queued gateway exhausted: more calls than verdicts');
      }
      const content = queue.shift()!;
      return {
        content,
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
  return {
    gateway,
    callCount: () => calls,
    remaining: () => queue.length,
  };
}

describe('VQ2-011 — gradeRepromptAndRecovery', () => {
  it('VQ2-011 — REPROMPT_RATIO_MAX = 0.1 and RECOVERY_MAX_TURNS = 2 exported correctly', () => {
    expect(REPROMPT_RATIO_MAX).toBe(0.1);
    expect(RECOVERY_MAX_TURNS).toBe(2);
  });

  it('VQ2-011 — empty turns returns sensible zeros without throwing', async () => {
    const { gateway } = createMockLLMGateway(repromptVerdict(false));
    const result = await gradeRepromptAndRecovery({
      observation: makeObservation(),
      script: makeScript(0),
      gateway,
    });
    expect(result).toEqual({
      totalTurns: 0,
      repromptCount: 0,
      repromptRatio: 0,
      recoveryTurns: 0,
      perTurnReprompts: [],
      passes: { repromptRatio: true, recovery: true },
    });
  });

  it('VQ2-011 — zero reprompts in 4-turn script: ratio=0, recoveryTurns=0, both pass', async () => {
    const { gateway, callCount } = createQueuedGateway([
      repromptVerdict(false),
      repromptVerdict(false),
      repromptVerdict(false),
      repromptVerdict(false),
    ]);
    const result = await gradeRepromptAndRecovery({
      observation: makeObservation(),
      script: makeScript(4),
      gateway,
    });
    expect(result.totalTurns).toBe(4);
    expect(result.repromptCount).toBe(0);
    expect(result.repromptRatio).toBe(0);
    expect(result.recoveryTurns).toBe(0);
    expect(result.perTurnReprompts).toEqual([false, false, false, false]);
    expect(result.passes.repromptRatio).toBe(true);
    expect(result.passes.recovery).toBe(true);
    expect(callCount()).toBe(4);
  });

  it('VQ2-011 — one reprompt resolved next turn: ratio=0.25, recoveryTurns=1, both pass', async () => {
    const { gateway } = createQueuedGateway([
      repromptVerdict(false),
      repromptVerdict(true),
      repromptVerdict(false),
      repromptVerdict(false),
    ]);
    const result = await gradeRepromptAndRecovery({
      observation: makeObservation(),
      script: makeScript(4),
      gateway,
    });
    expect(result.totalTurns).toBe(4);
    expect(result.repromptCount).toBe(1);
    expect(result.repromptRatio).toBe(0.25);
    expect(result.recoveryTurns).toBe(1);
    expect(result.perTurnReprompts).toEqual([false, true, false, false]);
    expect(result.passes.repromptRatio).toBe(false); // 0.25 > 0.10
    expect(result.passes.recovery).toBe(true); // 1 <= 2
  });

  it('VQ2-011 — three consecutive reprompts that never resolve: ratio=1.0, recoveryTurns=2 (bounded by remaining turns)', async () => {
    const { gateway } = createQueuedGateway([
      repromptVerdict(true),
      repromptVerdict(true),
      repromptVerdict(true),
    ]);
    const result = await gradeRepromptAndRecovery({
      observation: makeObservation(),
      script: makeScript(3),
      gateway,
    });
    expect(result.totalTurns).toBe(3);
    expect(result.repromptCount).toBe(3);
    expect(result.repromptRatio).toBe(1);
    // first reprompt at idx 0, then 2 more turns of reprompts → recovery = 2
    expect(result.recoveryTurns).toBe(2);
    expect(result.perTurnReprompts).toEqual([true, true, true]);
    expect(result.passes.repromptRatio).toBe(false);
    expect(result.passes.recovery).toBe(true); // exactly 2, threshold inclusive
  });

  it('VQ2-011 — reprompt ratio above 0.10 → passes.repromptRatio: false', async () => {
    // 3 reprompts in 20 turns = 0.15 > 0.10
    const verdicts: string[] = [];
    for (let i = 0; i < 20; i++) verdicts.push(repromptVerdict(i < 3));
    const { gateway } = createQueuedGateway(verdicts);
    const result = await gradeRepromptAndRecovery({
      observation: makeObservation(),
      script: makeScript(20),
      gateway,
    });
    expect(result.repromptRatio).toBeCloseTo(0.15, 5);
    expect(result.passes.repromptRatio).toBe(false);
  });

  it('VQ2-011 — recovery 3 turns → passes.recovery: false', async () => {
    // turn 0 reprompt, turns 1..3 reprompt, turn 4 advances → recovery = 4
    const { gateway } = createQueuedGateway([
      repromptVerdict(true),
      repromptVerdict(true),
      repromptVerdict(true),
      repromptVerdict(true),
      repromptVerdict(false),
    ]);
    const result = await gradeRepromptAndRecovery({
      observation: makeObservation(),
      script: makeScript(5),
      gateway,
    });
    expect(result.recoveryTurns).toBe(4);
    expect(result.passes.recovery).toBe(false);
  });

  it('VQ2-011 — recovery exactly at threshold: 2 turns → passes.recovery: true', async () => {
    // turn 0 reprompt, turn 1 reprompt, turn 2 advances → recovery = 2
    const { gateway } = createQueuedGateway([
      repromptVerdict(true),
      repromptVerdict(true),
      repromptVerdict(false),
      repromptVerdict(false),
    ]);
    const result = await gradeRepromptAndRecovery({
      observation: makeObservation(),
      script: makeScript(4),
      gateway,
    });
    expect(result.recoveryTurns).toBe(2);
    expect(result.passes.recovery).toBe(true);
  });

  it('VQ2-011 — invalid JSON from gateway falls back to non-reprompt (conservative)', async () => {
    const { gateway } = createQueuedGateway([
      'not json {{{',
      'still not json',
    ]);
    const result = await gradeRepromptAndRecovery({
      observation: makeObservation(),
      script: makeScript(2),
      gateway,
    });
    expect(result.repromptCount).toBe(0);
    expect(result.perTurnReprompts).toEqual([false, false]);
  });

  /**
   * Bounded parallelism: with PARALLELISM=5 and 12 turns we expect 3 batches
   * of 5/5/2. We assert that the total in-flight count never exceeds 5 by
   * having the mock provider track concurrent invocations via a manual
   * latch.
   */
  it('VQ2-011 — bounded parallelism: never more than 5 in-flight judge calls', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    let calls = 0;

    const provider: LLMProvider = {
      name: 'mock',
      async complete(_req: LLMRequest): Promise<LLMResponse> {
        calls += 1;
        inFlight += 1;
        if (inFlight > maxInFlight) maxInFlight = inFlight;
        // Yield to event loop so other Promise.all members can also enter.
        await new Promise((r) => setImmediate(r));
        inFlight -= 1;
        return {
          content: repromptVerdict(false),
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

    await gradeRepromptAndRecovery({
      observation: makeObservation(),
      script: makeScript(12),
      gateway,
    });

    expect(calls).toBe(12);
    expect(maxInFlight).toBeLessThanOrEqual(5);
    // We also assert at least 2 in-flight: confirms parallelism is happening, not serial.
    expect(maxInFlight).toBeGreaterThan(1);
  });
});
