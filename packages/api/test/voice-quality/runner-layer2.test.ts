/**
 * VQ2-013 — Layer 2 voting runner tests.
 *
 * The Layer 2 runner is a thin wrapper around Layer 1's `runScript`. It
 * runs each script three times sequentially, applies all graders to each
 * run's observation, packs the verdicts into a `PerRunResult`, and folds
 * the three `PerRunResult`s through the VQ2-012 `aggregate` function.
 *
 * Tests stub `runScript` and the four graders via `vi.mock` so they
 * don't actually drive a session — we're testing the wrapper's
 * orchestration semantics:
 *   - sequential 3-run loop
 *   - layer2Eligible gating
 *   - aggregation pass-through to majority-vote
 *   - per-run cost accumulation
 *   - per-script + per-suite cost-cap enforcement
 *   - failed-run fallback (one runScript throw shouldn't abort the script)
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { VoiceQualityScript } from '../../src/ai/voice-quality/schema';
import type { Observation } from '../../src/ai/voice-quality/observation';

// ─── Hoisted mocks ────────────────────────────────────────────────────────────
//
// vi.mock is hoisted above imports, so the call-counting + return-value shaping
// below has to live in a closure we can mutate from the test bodies. We expose
// a small `harness` object that the mocked modules read at call time.
const harness: {
  runScriptCalls: number;
  runScriptCostsCents: number[]; // cents to add per call (one per run)
  runScriptShouldThrowOnRun: number | null; // 1-indexed
  graderCalls: { floor: number; dispStruct: number; dispLlm: number; callerExp: number; reprompt: number; perceived: number };
  // Per-run grader returns (in order); falls back to the unfailing default
  floorReturn?: { passed: boolean; failedCriteria: number[] };
  dispStructReturn?: { passed: boolean; failedCriteria: number[]; perTurnDetail: Array<{ actualSlots?: Record<string, unknown> }> };
  dispLlmReturn?: { failedCriteria: number[] };
  callerExpReturn?: { ttfaP95Ms: number; lookupP95Ms: number; totalDurationMs: number };
  repromptReturn?: { repromptRatio: number; recoveryTurns: number };
  perceivedReturn?: { verdict: { perceivedSatisfaction: 'good' | 'acceptable' | 'poor'; abandonmentRisk: 0 | 1 | 2 } };
} = {
  runScriptCalls: 0,
  runScriptCostsCents: [],
  runScriptShouldThrowOnRun: null,
  graderCalls: { floor: 0, dispStruct: 0, dispLlm: 0, callerExp: 0, reprompt: 0, perceived: 0 },
};

vi.mock('../../src/ai/voice-quality/runner', async (orig) => {
  const actual = await (orig as () => Promise<Record<string, unknown>>)();
  return {
    ...actual,
    runScript: vi.fn(async (_script: VoiceQualityScript, ctx: { costTracker?: { addCents: (n: number) => void } }) => {
      harness.runScriptCalls++;
      const idx = harness.runScriptCalls;
      const costToAdd = harness.runScriptCostsCents[idx - 1] ?? 0;
      ctx.costTracker?.addCents(costToAdd);
      if (harness.runScriptShouldThrowOnRun === idx) {
        throw new Error(`stubbed runScript failure on run ${idx}`);
      }
      const observation: Observation = {
        callId: `stub-call-${idx}`,
        scriptId: 'stub-script',
        tenantId: 'stub-tenant',
        events: [],
        proposals: [],
        customerCountDelta: 0,
        appointmentCountDelta: 0,
        audit: [],
        totalCostCents: 0,
        totalDurationMs: 0,
        perTurnLatencyMs: [],
        sessionEndedAs: 'completed',
        hangupOccurred: false,
        errors: [],
      };
      return { observation, passed: false, errors: [], durationMs: 1 };
    }),
  };
});

vi.mock('../../src/ai/voice-quality/graders/floor', () => ({
  gradeFloor: vi.fn(() => {
    harness.graderCalls.floor++;
    return harness.floorReturn ?? { passed: true, failedCriteria: [], reasons: {} };
  }),
}));

vi.mock('../../src/ai/voice-quality/graders/disposition-structured', () => ({
  gradeDispositionStructured: vi.fn(() => {
    harness.graderCalls.dispStruct++;
    return (
      harness.dispStructReturn ?? {
        passed: true,
        failedCriteria: [],
        reasons: {},
        perTurnDetail: [{ turnIndex: 0, actualSlots: { customerId: 'cust-1' }, hardSlotMismatches: [] }],
      }
    );
  }),
}));

vi.mock('../../src/ai/voice-quality/graders/disposition-llm', () => ({
  gradeDispositionLlm: vi.fn(async () => {
    harness.graderCalls.dispLlm++;
    return harness.dispLlmReturn ?? { passed: true, failedCriteria: [], reasons: {}, perTurnDetail: [] };
  }),
}));

vi.mock('../../src/ai/voice-quality/graders/caller-experience', () => ({
  gradeCallerExperience: vi.fn(() => {
    harness.graderCalls.callerExp++;
    return (
      harness.callerExpReturn ?? {
        ttfaP95Ms: 100,
        lookupP95Ms: 500,
        totalDurationMs: 30_000,
        passes: { ttfa: true, lookupSpeak: true, duration: true },
        failedMetrics: [],
      }
    );
  }),
  gradeRepromptAndRecovery: vi.fn(async () => {
    harness.graderCalls.reprompt++;
    return (
      harness.repromptReturn ?? {
        totalTurns: 1,
        repromptCount: 0,
        repromptRatio: 0,
        recoveryTurns: 0,
        perTurnReprompts: [false],
        passes: { repromptRatio: true, recovery: true },
      }
    );
  }),
}));

vi.mock('../../src/ai/voice-quality/graders/perceived-completion', () => ({
  gradePerceivedCompletion: vi.fn(async () => {
    harness.graderCalls.perceived++;
    return (
      harness.perceivedReturn ?? {
        passed: true,
        verdict: { perceivedSatisfaction: 'good', rationale: 'ok', abandonmentRisk: 0 },
      }
    );
  }),
}));

// Imports must come AFTER vi.mock declarations.
import {
  runScriptLayer2,
  CostCapExceededError,
  type RunScriptLayer2Context,
} from '../../src/ai/voice-quality/runner-layer2';

// ─── Helpers ────────────────────────────────────────────────────────────────

function eligibleScript(overrides: Partial<VoiceQualityScript> = {}): VoiceQualityScript {
  return {
    id: 'vq2-013-stub',
    bucket: '01-happy-lookups',
    fixtures: { tenant: { id: 't-1' }, customers: [] },
    callerId: '+15555550001',
    callerIdBlocked: false,
    turns: [
      { caller: 'hello', expected: { intent: 'lookup_customer' }, hangupAfter: false },
    ],
    grading: { appliesFloor: [1, 2, 3, 4, 5, 6, 7, 8], appliesDisposition: [9, 10, 11, 12] },
    layer2Eligible: true,
    ...overrides,
  };
}

function makeCtx(overrides: Partial<RunScriptLayer2Context> = {}): RunScriptLayer2Context {
  return {
    driverFactory: () => {
      throw new Error('driverFactory should not be invoked when runScript is mocked');
    },
    repoMode: 'memory',
    // The mocked graders ignore the gateway, but the type requires it.
    gateway: {} as never,
    ...overrides,
  };
}

beforeEach(() => {
  harness.runScriptCalls = 0;
  harness.runScriptCostsCents = [];
  harness.runScriptShouldThrowOnRun = null;
  harness.graderCalls = { floor: 0, dispStruct: 0, dispLlm: 0, callerExp: 0, reprompt: 0, perceived: 0 };
  harness.floorReturn = undefined;
  harness.dispStructReturn = undefined;
  harness.dispLlmReturn = undefined;
  harness.callerExpReturn = undefined;
  harness.repromptReturn = undefined;
  harness.perceivedReturn = undefined;
});

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('VQ2-013 — Layer 2 voting runner', () => {
  it('VQ2-013 — runs the script exactly 3 times sequentially', async () => {
    const script = eligibleScript();
    await runScriptLayer2(script, makeCtx());
    expect(harness.runScriptCalls).toBe(3);
    // Every grader is invoked once per run.
    expect(harness.graderCalls.floor).toBe(3);
    expect(harness.graderCalls.dispStruct).toBe(3);
    expect(harness.graderCalls.dispLlm).toBe(3);
    expect(harness.graderCalls.callerExp).toBe(3);
    expect(harness.graderCalls.reprompt).toBe(3);
    expect(harness.graderCalls.perceived).toBe(3);
  });

  it('VQ2-013 — throws when script is not layer2Eligible', async () => {
    const script = eligibleScript({ layer2Eligible: false });
    await expect(runScriptLayer2(script, makeCtx())).rejects.toThrow(/not layer2-eligible/);
    expect(harness.runScriptCalls).toBe(0);
  });

  it('VQ2-013 — aggregates 3 PerRunResults via majority-vote (passing case)', async () => {
    const script = eligibleScript();
    const result = await runScriptLayer2(script, makeCtx());
    expect(result.scriptId).toBe(script.id);
    expect(result.aggregated.floor.passed).toBe(true);
    expect(result.aggregated.disposition.passed).toBe(true);
    expect(result.aggregated.disposition.slotsAgree).toBe(true);
    expect(result.aggregated.perceivedCompletion.passed).toBe(true);
    expect(result.aggregated.flakeIndicator).toBe(false);
    expect(result.perRunResults).toHaveLength(3);
  });

  it('VQ2-013 — accumulates per-run cost; total = sum of run costs', async () => {
    harness.runScriptCostsCents = [50, 70, 30];
    const script = eligibleScript();
    const result = await runScriptLayer2(script, makeCtx({ perRunCostCapCents: 1_000 }));
    expect(result.totalCostCents).toBe(150);
    expect(result.costCapped).toBe(false);
  });

  it('VQ2-013 — throws CostCapExceededError when per-script cap exceeded mid-run', async () => {
    // 200 + 200 = 400 > 300. Cap should trip after run 2.
    harness.runScriptCostsCents = [200, 200, 200];
    const script = eligibleScript();
    await expect(
      runScriptLayer2(script, makeCtx({ perRunCostCapCents: 300 })),
    ).rejects.toBeInstanceOf(CostCapExceededError);
    // Only 2 runs should have completed.
    expect(harness.runScriptCalls).toBe(2);
  });

  it('VQ2-013 — CostCapExceededError carries scope, cap, observed, scriptId, atRun', async () => {
    harness.runScriptCostsCents = [200, 200, 200];
    const script = eligibleScript();
    try {
      await runScriptLayer2(script, makeCtx({ perRunCostCapCents: 300 }));
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(CostCapExceededError);
      const e = err as CostCapExceededError;
      expect(e.scope).toBe('per-script');
      expect(e.capCents).toBe(300);
      expect(e.observedCents).toBe(400);
      expect(e.scriptId).toBe(script.id);
      expect(e.atRun).toBe(2);
    }
  });

  it('VQ2-013 — throws CostCapExceededError when per-suite cap exceeded', async () => {
    harness.runScriptCostsCents = [50, 50, 50];
    const script = eligibleScript();
    let suiteTotal = 0;
    const suiteTracker = {
      addCents(n: number) {
        suiteTotal += n;
      },
      totalCents() {
        return suiteTotal;
      },
    };
    await expect(
      runScriptLayer2(
        script,
        makeCtx({
          perRunCostCapCents: 1_000,
          suiteCostTracker: suiteTracker,
          suiteCostCapCents: 75,
        }),
      ),
    ).rejects.toBeInstanceOf(CostCapExceededError);
    // Suite cap trips after run 2 (50 + 50 = 100 > 75).
    expect(harness.runScriptCalls).toBe(2);
  });

  it('VQ2-013 — failed run (runScript throws) is recorded as fail-everything PerRunResult; aggregation continues', async () => {
    harness.runScriptShouldThrowOnRun = 2;
    const script = eligibleScript();
    const result = await runScriptLayer2(script, makeCtx());
    // All 3 runs attempted (the failure does not abort the script).
    expect(harness.runScriptCalls).toBe(3);
    expect(result.perRunResults).toHaveLength(3);
    // The failed run is encoded as fail-everything.
    const failed = result.perRunResults[1];
    expect(failed.floor.passed).toBe(false);
    expect(failed.disposition.passed).toBe(false);
    expect(failed.perceivedCompletion.satisfaction).toBe('poor');
    expect(failed.perceivedCompletion.abandonmentRisk).toBe(2);
    // Aggregation reflects the regression: 2-of-3 floor passed but
    // floor requires unanimous, so floor.passed is false.
    expect(result.aggregated.floor.passed).toBe(false);
  });

  it('VQ2-013 — non-cost grader errors per-run also yield fail-result; do not abort the script', async () => {
    // Force the LLM grader to throw on every run; the script still
    // completes 3 runs (with 3 fail-everything results).
    const { gradeDispositionLlm } = await import('../../src/ai/voice-quality/graders/disposition-llm');
    (gradeDispositionLlm as ReturnType<typeof vi.fn>).mockImplementationOnce(() => {
      throw new Error('boom');
    });
    const script = eligibleScript();
    const result = await runScriptLayer2(script, makeCtx());
    expect(harness.runScriptCalls).toBe(3);
    expect(result.perRunResults).toHaveLength(3);
    // First run was the bad one — it's marked as fail-everything.
    expect(result.perRunResults[0].floor.passed).toBe(false);
    // Runs 2 and 3 used the default mocked verdicts.
    expect(result.perRunResults[1].floor.passed).toBe(true);
    expect(result.perRunResults[2].floor.passed).toBe(true);
  });

  it('VQ2-013 — extracts slot values from dispStruct.perTurnDetail into PerRunResult', async () => {
    harness.dispStructReturn = {
      passed: true,
      failedCriteria: [],
      perTurnDetail: [
        { actualSlots: { customerId: 'cust-A' } },
        { actualSlots: { appointmentTimeIso: '2026-05-10T14:00:00Z' } },
      ],
    } as never;
    const result = await runScriptLayer2(eligibleScript(), makeCtx());
    // Each run's slotValues is the merged record across all per-turn detail.
    expect(result.perRunResults[0].disposition.slotValues).toEqual({
      customerId: 'cust-A',
      appointmentTimeIso: '2026-05-10T14:00:00Z',
    });
  });

  it('VQ2-013 — durationMs is non-negative', async () => {
    const result = await runScriptLayer2(eligibleScript(), makeCtx());
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  // ─── Codex P1 fix — grader cost tracker propagation ───────────────────────
  //
  // Before the fix, `runScriptLayer2` created a per-run `runCostTracker`,
  // passed it to `runScript`'s context, but did not propagate it through
  // to the LLM-judge graders. Graders used `ctx.gateway` directly, whose
  // own cost tracker was set at construction time (suite-level), so the
  // runner's `runCents` stayed near zero even when graders burned money.
  //
  // The fix wraps the base gateway with `wrapWithCostTracking({
  //   bus: runBus, costTracker: runCostTracker })` inside `gradeOneRun`.
  // The decorator reads `tokenUsage` off the response and accumulates
  // cents into the per-run tracker. These tests verify (a) cents emitted
  // by grader gateway calls land in the per-run tracker, and (b) those
  // cents contribute to the per-script cost cap.

  it('VQ2-fix — gradeOneRun gateway calls increment the per-run cost tracker', async () => {
    // Wire a fake "real" gateway whose `complete()` returns a token-usage
    // shape that the wrapper translates to a positive cents delta. The
    // wrapper computes:
    //   inputCents  = ceil(input  /1M * 300)
    //   outputCents = ceil(output /1M * 1500)
    // For input=100_000 + output=10_000 → 30 + 15 = 45 cents per call.
    //
    // The wrapper executes for every gateway.complete() call from the
    // mocked graders. We force just gradeDispositionLlm to call
    // gateway.complete() so we can assert a deterministic cents delta.
    const fakeGateway = {
      complete: vi.fn(async () => ({
        content: 'noop',
        model: 'haiku',
        provider: 'fake',
        latencyMs: 1,
        tokenUsage: { input: 100_000, output: 10_000, total: 110_000 },
      })),
    } as never;

    const { gradeDispositionLlm } = await import(
      '../../src/ai/voice-quality/graders/disposition-llm'
    );
    const llmMock = gradeDispositionLlm as ReturnType<typeof vi.fn>;
    // Mock impl receives the per-run-wrapped gateway and calls
    // .complete() on it. The wrapper accumulates 45¢ per call into the
    // per-run cost tracker.
    llmMock.mockImplementation(
      async ({ gateway }: { gateway: { complete: (req: unknown) => Promise<unknown> } }) => {
        await gateway.complete({ messages: [], model: 'haiku' });
        return { passed: true, failedCriteria: [], reasons: {}, perTurnDetail: [] };
      },
    );

    const script = eligibleScript();
    const result = await runScriptLayer2(
      script,
      makeCtx({ gateway: fakeGateway, perRunCostCapCents: 10_000 }),
    );

    // 3 runs × 1 call/run × 45¢ = 135¢. The cost tracker spend is
    // attributed to the runs' totals via the propagation fix.
    expect(result.totalCostCents).toBe(135);
    expect(result.costCapped).toBe(false);
  });

  it('VQ2-fix — accumulated grader cost contributes to per-script cost cap', async () => {
    // Spend 200¢ per gateway.complete() call: input=400_000 (120¢) +
    // output=53_334 (≈80¢, rounded up by ceil) = 200¢ delta. With a
    // per-script cap of 100¢, the cap should fire after run 1.
    const fakeGateway = {
      complete: vi.fn(async () => ({
        content: 'noop',
        model: 'haiku',
        provider: 'fake',
        latencyMs: 1,
        tokenUsage: { input: 400_000, output: 53_334, total: 453_334 },
      })),
    } as never;

    const { gradeDispositionLlm } = await import(
      '../../src/ai/voice-quality/graders/disposition-llm'
    );
    const llmMock = gradeDispositionLlm as ReturnType<typeof vi.fn>;
    llmMock.mockImplementation(
      async ({ gateway }: { gateway: { complete: (req: unknown) => Promise<unknown> } }) => {
        await gateway.complete({ messages: [], model: 'haiku' });
        return { passed: true, failedCriteria: [], reasons: {}, perTurnDetail: [] };
      },
    );

    const script = eligibleScript();
    await expect(
      runScriptLayer2(
        script,
        makeCtx({ gateway: fakeGateway, perRunCostCapCents: 100 }),
      ),
    ).rejects.toBeInstanceOf(CostCapExceededError);

    // After run 1, runCents = 200, which exceeds the 100¢ cap. The cap
    // check happens AFTER the run completes (post per-script accumulator
    // update), so run 1 will have finished before the throw.
    expect(harness.runScriptCalls).toBe(1);
  });
});
