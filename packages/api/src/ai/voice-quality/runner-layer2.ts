/**
 * VQ2-013 — Layer 2 voting runner.
 *
 * Thin wrapper around Layer 1's `runScript`. For each Layer-2-eligible
 * script we:
 *   1. Run the script three times sequentially (the plan §"Voting
 *      strategy" pins sequential — parallelizing would interleave
 *      callSids on the shared media-streams server and confuse session
 *      resolution).
 *   2. Apply all five graders (floor + dispStruct + dispLlm + caller
 *      experience + reprompt + perceived) to each run's observation.
 *   3. Pack every run's verdicts into a `PerRunResult`.
 *   4. Fold the three runs through VQ2-012's `aggregate` for the
 *      majority-vote verdict.
 *
 * # Cost-cap enforcement
 *
 * Two distinct caps:
 *   - `perRunCostCapCents` (per-script): cumulative cost across the 3
 *     runs of a single script. When tripped mid-loop we throw
 *     `CostCapExceededError(scope='per-script')`. The outer harness
 *     catches this and records the script as `cost-capped` (a non-pass
 *     for the launch gate, but distinguishable in the report).
 *   - `suiteCostCapCents` (per-suite, optional): only consulted when the
 *     caller passes a `suiteCostTracker`. When tripped, the whole suite
 *     fail-fasts via `CostCapExceededError(scope='per-suite')`.
 *
 * # Failed-run handling
 *
 * If `runScript` (or any grader) throws inside one of the three runs we
 * synthesize a "fail everything" `PerRunResult` and continue to the next
 * run. Reasoning: partial signal is more useful than no signal — if 2
 * of 3 runs reveal a regression, the harness should report it; aborting
 * the script on a single transient runtime error would mask the data.
 * The exception is `CostCapExceededError` itself: that propagates so
 * the outer caller sees the cap event.
 *
 * # Gateway plumbing
 *
 * Three of the graders (`gradeDispositionLlm`,
 * `gradeRepromptAndRecovery`, `gradePerceivedCompletion`) need an
 * `LLMGateway`. The Layer 1 `RunScriptContext` exposes a
 * `gatewayFactory` (used to build a per-run cassette) but not a direct
 * `gateway` instance. The Layer 2 ctx therefore takes an explicit
 * `gateway` field; if absent and `gatewayFactory` is available, we
 * synthesize one via the factory keyed on the script id (matching the
 * Layer 1 convention). Production call-sites pass `gateway` directly
 * because the audio path uses the same gateway across all 3 runs.
 */
import type { VoiceQualityScript } from './schema';
import { runScript } from './runner';
import type { RunScriptContext, CostTracker } from './runner';
import { gradeFloor } from './graders/floor';
import { gradeDispositionStructured } from './graders/disposition-structured';
import { gradeDispositionLlm } from './graders/disposition-llm';
import { gradeCallerExperience, gradeRepromptAndRecovery } from './graders/caller-experience';
import { gradePerceivedCompletion } from './graders/perceived-completion';
import { aggregate } from './voting/majority-vote';
import type { AggregatedResult, PerRunResult } from './voting/majority-vote';
import type { LLMGateway } from '../gateway/gateway';
import { wrapWithCostTracking } from './audio/real-llm-gateway-factory';
import { AgentEventBus } from './event-bus';

/**
 * ~$3.50 per script across 3 runs (i.e. the script's worst-case ceiling).
 * Calibrated against Haiku judge cost (~1¢/turn) + provider headroom.
 */
export const PER_RUN_COST_CAP_CENTS_DEFAULT = 350;

/** ~$10/suite — the whole-run fail-fast threshold from spec §6.2. */
export const SUITE_COST_CAP_CENTS_DEFAULT = 1000;

/**
 * Thrown when a cost cap (per-script or per-suite) is breached. The
 * outer harness catches and records the scope so the launch-gate report
 * can distinguish "ran and failed" from "cost-capped before completing".
 */
export class CostCapExceededError extends Error {
  constructor(
    public readonly scope: 'per-script' | 'per-suite',
    public readonly capCents: number,
    public readonly observedCents: number,
    public readonly scriptId?: string,
    public readonly atRun?: number,
  ) {
    super(
      `voice-quality layer2 cost cap exceeded: scope=${scope}, cap=${capCents}¢, observed=${observedCents}¢` +
        (scriptId ? `, scriptId=${scriptId}` : '') +
        (atRun !== undefined ? `, atRun=${atRun}` : ''),
    );
    this.name = 'CostCapExceededError';
  }
}

/**
 * Suite-level cost tracker shape. Mirrors `CostTracker` but is used at
 * a different scope: the per-run tracker is reset between runs so cost
 * caps fire per-script; the suite tracker is shared across every script
 * so it can fire suite-wide.
 */
export interface SuiteCostTracker {
  addCents(n: number): void;
  totalCents(): number;
}

export interface RunScriptLayer2Context extends Omit<RunScriptContext, 'costTracker'> {
  /**
   * Cap on cumulative cost across this script's 3 runs. Default
   * `PER_RUN_COST_CAP_CENTS_DEFAULT`. Tripping throws
   * `CostCapExceededError(scope='per-script')` and aborts the script.
   */
  perRunCostCapCents?: number;
  /**
   * Optional suite-level cost tracker. When supplied, each run's cost
   * is also added here; when `suiteCostCapCents` is also supplied, a
   * `CostCapExceededError(scope='per-suite')` is thrown the moment the
   * suite total exceeds it.
   */
  suiteCostTracker?: SuiteCostTracker;
  /** Cap on cumulative suite cost. Only consulted with `suiteCostTracker`. */
  suiteCostCapCents?: number;
  /**
   * LLM gateway shared across the three runs. Used by the LLM-judge
   * graders. If absent and `gatewayFactory` is set, one is synthesized
   * per run via the factory.
   */
  gateway?: LLMGateway;
}

export interface RunScriptLayer2Result {
  scriptId: string;
  /** Folded majority-vote verdict over the three runs. */
  aggregated: AggregatedResult;
  /** Per-run grader verdicts, in run order (always length 3). */
  perRunResults: ReadonlyArray<PerRunResult>;
  /** Sum of per-run costs (cents). */
  totalCostCents: number;
  /** True iff a cost cap was hit (always paired with a thrown error today). */
  costCapped: boolean;
  durationMs: number;
}

/**
 * Build a "fail-everything" PerRunResult so a transient error in one
 * run doesn't silently lift the aggregated verdict. Voting still
 * produces a meaningful answer when 2-of-3 succeed.
 */
function failEverythingRun(): PerRunResult {
  return {
    floor: { passed: false, failedCriteria: [] },
    disposition: { passed: false, failedCriteria: [], slotValues: {} },
    callerExperience: {
      ttfaMs: 0,
      lookupMs: 0,
      durationMs: 0,
      repromptRatio: 0,
      recoveryTurns: 0,
    },
    perceivedCompletion: { satisfaction: 'poor', abandonmentRisk: 2 },
  };
}

/**
 * Walk `dispStruct.perTurnDetail` and merge each turn's `actualSlots`
 * into a single record. Voting compares slot key-value pairs across
 * runs; collapsing per-turn detail to one map per run is what VQ2-012
 * expects on `disposition.slotValues`.
 *
 * Later turns overwrite earlier ones on the same key (rare but
 * defensible — proposals later in the call are more authoritative).
 */
function mergeSlotValues(
  perTurnDetail: ReadonlyArray<{ actualSlots?: Record<string, unknown> }>,
): Record<string, unknown> {
  const merged: Record<string, unknown> = {};
  for (const turn of perTurnDetail) {
    if (turn.actualSlots) {
      for (const [k, v] of Object.entries(turn.actualSlots)) {
        merged[k] = v;
      }
    }
  }
  return merged;
}

/**
 * Resolve the LLM gateway used by the LLM-judge graders. Preference:
 *   1. Explicit `ctx.gateway` (production audio path)
 *   2. `ctx.gatewayFactory(scriptId)` (Layer-1-style cassette wiring)
 *   3. Throw — the LLM-judge graders cannot run without one.
 */
function resolveGateway(ctx: RunScriptLayer2Context, scriptId: string): LLMGateway {
  if (ctx.gateway) return ctx.gateway;
  if (ctx.gatewayFactory) return ctx.gatewayFactory(scriptId);
  throw new Error(
    `runScriptLayer2: no LLM gateway available. Provide ctx.gateway or ctx.gatewayFactory.`,
  );
}

/**
 * Apply all graders to one run's observation and pack into PerRunResult.
 *
 * `perceivedCompletionCache` is shared across the 3 voting runs of the
 * same script so identical transcripts (e.g., when the LLM is run at
 * temp=0 with prompt caching, or replayed via the Layer 2 audio fixture
 * cache) reuse a single judge call instead of triple-invoking. The
 * grader's cache key includes the observation events hash, so genuinely
 * different runs still each pay for a judge call.
 *
 * Throws if any grader throws — the caller wraps this in try/catch and
 * substitutes a fail-everything run so the script can continue.
 */
async function gradeOneRun(
  observation: import('./observation').Observation,
  script: VoiceQualityScript,
  baseGateway: LLMGateway,
  perceivedCompletionCache: Map<string, import('./graders/perceived-completion').PerceivedCompletionVerdict>,
  runCostTracker: CostTracker,
  bus: AgentEventBus,
): Promise<PerRunResult> {
  // Codex P1 fix — propagate the per-run cost tracker through the
  // grader gateway calls. The graders (`gradeDispositionLlm`,
  // `gradeRepromptAndRecovery`, `gradePerceivedCompletion`) call
  // `gateway.complete()`. The base gateway already carries the
  // suite-level cost tracker (set at construction time by
  // `createRealLayerTwoGateway`), but the runner's per-run `runCents`
  // would stay near zero even when judges burn money. Layering a per-
  // run cost-tracking wrapper here makes `runCents` (and thus the
  // per-script cap) actually reflect grader spend in production. For
  // mock gateways with no `tokenUsage` on responses, the wrapper is a
  // no-op — which is the correct behavior in tests.
  const gateway = wrapWithCostTracking(baseGateway, {
    bus,
    costTracker: runCostTracker,
  });
  const floor = gradeFloor(observation, script);
  const dispStruct = gradeDispositionStructured(observation, script);
  const dispLlm = await gradeDispositionLlm({ observation, script, gateway });
  const callerExp = gradeCallerExperience(observation, script);
  const reprompt = await gradeRepromptAndRecovery({ observation, script, gateway });
  const perceived = await gradePerceivedCompletion({
    observation,
    script,
    gateway,
    cache: perceivedCompletionCache,
  });

  return {
    floor: { passed: floor.passed, failedCriteria: floor.failedCriteria },
    disposition: {
      // Hard-disposition pass requires BOTH the structured grader's
      // verdict AND the LLM grader's verdict (criterion 12 + soft slot
      // 10). Either failure flips this run to disposition-fail.
      passed: dispStruct.passed && dispLlm.failedCriteria.length === 0,
      failedCriteria: [...dispStruct.failedCriteria, ...dispLlm.failedCriteria],
      slotValues: mergeSlotValues(dispStruct.perTurnDetail),
    },
    callerExperience: {
      ttfaMs: callerExp.ttfaP95Ms,
      lookupMs: callerExp.lookupP95Ms,
      durationMs: callerExp.totalDurationMs,
      repromptRatio: reprompt.repromptRatio,
      recoveryTurns: reprompt.recoveryTurns,
    },
    perceivedCompletion: {
      satisfaction: perceived.verdict.perceivedSatisfaction,
      abandonmentRisk: perceived.verdict.abandonmentRisk,
    },
  };
}

export async function runScriptLayer2(
  script: VoiceQualityScript,
  ctx: RunScriptLayer2Context,
): Promise<RunScriptLayer2Result> {
  if (!script.layer2Eligible) {
    throw new Error(`runScriptLayer2: script ${script.id} is not layer2-eligible`);
  }

  const perRunCostCap = ctx.perRunCostCapCents ?? PER_RUN_COST_CAP_CENTS_DEFAULT;
  const startMs = Date.now();
  const perRunResults: PerRunResult[] = [];
  let scriptCostCents = 0;
  let costCapped = false;

  // Shared perceived-completion cache across the 3 voting runs of this
  // script. The grader caches by (scriptId + observation events hash),
  // so when 2 of 3 runs produce identical event sequences (Layer 2 with
  // temp=0 + prompt caching frequently does), we pay for 1 judge call
  // instead of 3. The cache key in perceived-completion.ts must not
  // include wall-clock fields (e.g., `ts`) for this to be effective —
  // see the grader's cache-key implementation.
  const perceivedCompletionCache = new Map<string, import('./graders/perceived-completion').PerceivedCompletionVerdict>();

  for (let runIdx = 0; runIdx < 3; runIdx++) {
    // Fresh per-run cost tracker so each run's cost is countable in
    // isolation; we accumulate into `scriptCostCents` after the run.
    let runCents = 0;
    const runCostTracker: CostTracker = {
      addCents(n: number) {
        runCents += n;
      },
      totalCents() {
        return runCents;
      },
    };

    const ctxForRun: RunScriptContext = {
      driverFactory: ctx.driverFactory,
      repoMode: ctx.repoMode,
      ...(ctx.cassetteMode !== undefined ? { cassetteMode: ctx.cassetteMode } : {}),
      ...(ctx.gatewayFactory !== undefined ? { gatewayFactory: ctx.gatewayFactory } : {}),
      ...(ctx.bus !== undefined ? { bus: ctx.bus } : {}),
      costTracker: runCostTracker,
    };

    let runResult: PerRunResult;
    try {
      const { observation } = await runScript(script, ctxForRun);
      const gateway = resolveGateway(ctx, script.id);
      // Reuse the ctx bus when present so cost_incurred events emitted
      // by the wrapper land on the same bus the run is observing.
      // Fall back to a throwaway bus when no bus is wired in (unit
      // tests with mock gateways) — the wrapper still needs a bus
      // reference but no consumer is listening.
      const runBus = ctx.bus ?? new AgentEventBus();
      runResult = await gradeOneRun(
        observation,
        script,
        gateway,
        perceivedCompletionCache,
        runCostTracker,
        runBus,
      );
    } catch (err) {
      // Cost-cap errors propagate (suite-cap may bubble through here in
      // edge cases); everything else degrades to a fail-everything run
      // so 2/3 voting can still produce signal.
      if (err instanceof CostCapExceededError) throw err;
      runResult = failEverythingRun();
    }

    perRunResults.push(runResult);
    scriptCostCents += runCents;
    if (ctx.suiteCostTracker) ctx.suiteCostTracker.addCents(runCents);

    // Per-script cap.
    if (scriptCostCents > perRunCostCap) {
      costCapped = true;
      throw new CostCapExceededError(
        'per-script',
        perRunCostCap,
        scriptCostCents,
        script.id,
        runIdx + 1,
      );
    }
    // Per-suite cap. Only consulted when both tracker + cap are wired.
    if (
      ctx.suiteCostTracker &&
      ctx.suiteCostCapCents !== undefined &&
      ctx.suiteCostTracker.totalCents() > ctx.suiteCostCapCents
    ) {
      costCapped = true;
      throw new CostCapExceededError(
        'per-suite',
        ctx.suiteCostCapCents,
        ctx.suiteCostTracker.totalCents(),
        script.id,
        runIdx + 1,
      );
    }
  }

  const aggregated = aggregate(perRunResults as [PerRunResult, PerRunResult, PerRunResult]);

  return {
    scriptId: script.id,
    aggregated,
    perRunResults,
    totalCostCents: scriptCostCents,
    costCapped,
    durationMs: Date.now() - startMs,
  };
}
