/**
 * live-support.ts — plumbing for the credential-gated `--live` eval paths.
 *
 * Everything here is deliberately split out of the runner scripts so it can be
 * unit-tested OFFLINE with a mocked gateway (no real tokens spent): API-key
 * resolution + fail-fast, deterministic sampling, cost projection + hard cap,
 * threshold gating, and the two run loops (which take an injected gateway).
 *
 * The only production imports are the *pure* production entry points the live
 * eval must measure — `classifyIntent` (the real classifier, fast-path + LLM
 * fallback together) and `extractLaunchSlots` (the production projection of
 * classifier entities onto the launch-slot shape). Neither touches the DB, so
 * importing them here is safe in the offline sandbox. The real network gateway
 * is built by buildLiveGateway (the production createLLMGateway factory, or the
 * Anthropic harness fallback) in the runner scripts and injected into the run
 * loops, so those loops — and their tests — never open a socket.
 */
import type { LLMGateway } from '../api/src/ai/gateway/gateway';
import type { ClassifyContext } from '../api/src/ai/orchestration/intent-classifier';
import type { PathSmokeProviderSelection } from '../api/src/ai/voice-quality/path-smoke/provider';
import { stableHash } from './metrics';

// The production entry points are imported DYNAMICALLY inside the run loops
// (below), not at module top level. Two reasons: (1) the offline eval path and
// the offline unit tests must load this module without pulling in the api
// `src` value modules — a static named import of `classifyIntent` fails to
// resolve across the package boundary under the `tsx` ESM loader; (2) it keeps
// the offline path zero-dependency. Type-only imports above are erased, so they
// are safe to keep static.

// The classifier never touches the DB or RLS, so a synthetic tenant is safe.
// We use the shared system tenant id ('system') — the same tenant the
// real-LLM path smoke uses (PATH_SMOKE_TENANT_ID) — which both the production
// gateway (createLLMGateway stores AI_DEFAULT_MODEL under the system tenant's
// override; per-tier AI_*_MODEL vars win when all three are set) and the Anthropic
// harness fallback (its tenant override pinning the Claude model) route
// explicitly.
export const SYNTHETIC_TENANT_ID = 'system';

export const LIVE_INTENT_TARGET = 0.92;
export const LIVE_SLOT_TARGET = 0.88;

/**
 * Slots evaluated in LIVE mode. `service_type` is intentionally NOT here: the
 * production classifier does not emit it — `extractLaunchSlots` sources
 * service_type from `input.serviceType` (resolved from the tenant vertical
 * pack), and phone from caller-ID. Only these four are LLM-derived, so only
 * these four are a fair measure of the live model's extraction. service_type is
 * reported separately as "not classifier-sourced". See run-slot-eval.ts.
 */
export const LIVE_SLOTS = ['name', 'address', 'time_window', 'problem_description'] as const;

// --- Cost model -------------------------------------------------------------
// Per-model rates are NOT duplicated here: the projection prices through the
// path-smoke rate table (packages/api/src/ai/voice-quality/path-smoke/
// provider.ts — gpt-4o-mini $0.15/$0.60, gpt-4o $2.50/$10, claude-haiku-4-5 at
// the pinned $3/$15 harness rate), loaded dynamically so the offline path
// never pulls in api src value modules.

// Conservative per-call token estimate for the pre-flight cost projection. The
// classifier system prompt is large (~500 lines of intent taxonomy); we assume
// NO prompt-cache discount so the projection over-estimates rather than
// under-estimates spend (a cost cap must fail safe). Per-utterance input tokens
// are added on top from the utterance length.
//
// This constant MUST stay an overestimate of the real classifier system
// prompt (SYSTEM_PROMPT in packages/api/src/ai/orchestration/intent-classifier.ts,
// exported for exactly this reason). Re-measured 2026-08-09 after Task 10
// of the Tradesperson plan (2026-08-07) — the final task in that plan wave,
// adding lookup_crew_schedule / lookup_timesheets / lookup_my_day (taxonomy
// 1.14.0) plus a "Distinctions that matter" disambiguation note
// (lookup_appointments vs lookup_my_day): 55,992 chars ≈ 13,998 tokens by
// this file's own chars/4 heuristic (estimateTokens) — up from ~47,400
// chars ≈ 11,850 tokens (2026-08-07, taxonomy 1.6.0). Bumped from 16,000 to
// 20,000: the prior constant had fallen BELOW the 1.15x safety margin
// entirely (packages/api/test/voice-quality/voice-eval-live.test.ts failed:
// 16,000 < 16,098 required), and this plan wave is now complete, so there
// is no known further taxonomy growth to project forward — 20,000 gives
// ~43% headroom over the current measurement (~24% over the strict 1.15x
// minimum) for incidental doc/comment growth in the prompt text, not a
// specific future taxonomy size. (Previously 2026-07-26, VOX-07
// create_invoice field guidance: 37,899 chars ≈ 9,475 tokens. Before that,
// 2026-07-17: 35,309 chars ≈ 8,828 tokens.) The live eval path
// (SYNTHETIC_TENANT_ID, no vertical/plan/owner/extended context) sends only
// that base prompt, nothing more. A larger EST_SYSTEM_PROMPT_TOKENS shrinks
// the utterances-per-cost-cap in checkCostCap below — that's
// the SAFE direction for a preflight cost cap (it fails closed sooner, never
// later). This constant is pinned by a test
// (packages/api/test/voice-quality/voice-eval-live.test.ts) that imports the
// real SYSTEM_PROMPT and fails the moment this constant stops being a safe
// overestimate — if that test fails, bump this constant (don't just raise
// the test's margin) and re-verify the cost cap semantics still abort
// before spending.
//
// 2026-08-28 (#886/#887): the classifier prompt is now SURFACE-CONDITIONAL
// (buildClassifierSystemPrompt in
// packages/api/src/ai/orchestration/classifier-profile.ts). The live eval
// path passes no `classifierProfile`, so it sends the full 'operator'
// taxonomy — byte-identical to SYSTEM_PROMPT — and this constant stays
// sized against that worst-case prompt. The trimmed telephony profiles
// ('caller' ~4.1k tokens first turn) are strictly smaller, so this remains
// a safe overestimate for every surface the eval could exercise.
export const EST_SYSTEM_PROMPT_TOKENS = 20000;
export const EST_OUTPUT_TOKENS_PER_CALL = 250;
export const DEFAULT_COST_CAP_CENTS = 500; // $5

const CHARS_PER_TOKEN = 4;

/** Rough token count for a piece of text (chars/4), floored at 1. */
export function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / CHARS_PER_TOKEN));
}

export interface CostCapResult {
  /** Null when `model` has no known price — the cap cannot be enforced. */
  projectedCents: number | null;
  capCents: number;
  withinCap: boolean;
}

export class ActualCostCapExceededError extends Error {
  constructor(
    readonly capCents: number,
    readonly spentCents: number,
  ) {
    super(`live voice eval actual cost ${spentCents.toFixed(2)}c exceeded cap ${capCents.toFixed(2)}c`);
    this.name = 'ActualCostCapExceededError';
  }
}

export function assertActualCostWithinCap(spentCents: number, capCents: number): void {
  if (spentCents > capCents) throw new ActualCostCapExceededError(capCents, spentCents);
}

/**
 * Conservative (no prompt-cache) pre-flight projection for classifying every
 * utterance with `model`, checked against `capCents`. Does not throw — the
 * caller decides how to abort. An unpriced model is never within cap: the run
 * refuses rather than enforce the cap against a guessed rate.
 */
export async function checkCostCap(
  utterances: readonly string[],
  capCents: number,
  model: string,
): Promise<CostCapResult> {
  const { projectPathSmokeCents } = await import('../api/src/ai/voice-quality/path-smoke/provider');
  const projectedCents = projectPathSmokeCents({
    model,
    utterances,
    systemPromptTokens: EST_SYSTEM_PROMPT_TOKENS,
    outputTokensPerCall: EST_OUTPUT_TOKENS_PER_CALL,
  });
  return { projectedCents, capCents, withinCap: projectedCents !== null && projectedCents <= capCents };
}

/** Resolve the cost cap (cents) from the environment, defaulting conservatively. */
export function resolveCostCapCents(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.VOICE_EVAL_COST_CAP_CENTS;
  if (raw === undefined || raw.trim() === '') return DEFAULT_COST_CAP_CENTS;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_COST_CAP_CENTS;
}

// --- Provider selection -----------------------------------------------------
/**
 * Which provider/model the live eval exercises. Reuses the path-smoke selector
 * (#1426) so both real-LLM gates share ONE definition of "the production
 * provider": AI_PROVIDER_API_KEY + AI_PROVIDER_BASE_URL + AI_*_MODEL, the
 * config Railway prod/dev run (api.openai.com, gpt-4o-mini for classify) and
 * that `createLLMGateway` consumes. ANTHROPIC_API_KEY (the Layer-2 harness,
 * Haiku via Anthropic's OpenAI-compat endpoint) is an explicit local fallback
 * only. Returns null when neither key is set — the caller fails fast (exit 2).
 */
export type LiveProviderSelection = PathSmokeProviderSelection;

export async function selectLiveProvider(
  env: Record<string, string | undefined> = process.env,
): Promise<LiveProviderSelection | null> {
  const { selectPathSmokeProvider } = await import('../api/src/ai/voice-quality/path-smoke/provider');
  return selectPathSmokeProvider(env);
}

export const LIVE_FALLBACK_WARNING =
  '⚠️  ANTHROPIC_API_KEY fallback — this does NOT exercise the provider production runs.\n' +
  '   Set AI_PROVIDER_API_KEY (+ AI_PROVIDER_BASE_URL / AI_*_MODEL) to measure production.';

/** One-line, key-free description of the provider a live run exercises. */
export async function describeLiveProvider(selection: LiveProviderSelection): Promise<string> {
  const { describePathSmokeProvider } = await import('../api/src/ai/voice-quality/path-smoke/provider');
  return describePathSmokeProvider(selection);
}

/**
 * Build the classifier's gateway for the selected provider, recording each
 * call's actual spend via `addCents`. The production selection goes through
 * `createLLMGateway(loadConfig(env))` — the exact factory app.ts uses
 * (resilience stack, tier routing, provider/model mismatch check) — wrapped in
 * the path-smoke spend tracker (per-model pricing of the served model id).
 * The Anthropic fallback uses the Layer-2 harness gateway. Loaded lazily so
 * offline runs never import the `openai`-bearing factories.
 */
export async function buildLiveGateway(
  selection: LiveProviderSelection,
  addCents: (cents: number) => void,
  env: NodeJS.ProcessEnv = process.env,
): Promise<LLMGateway> {
  if (selection.kind === 'production') {
    const { createLLMGateway } = await import('../api/src/ai/gateway/factory');
    const { loadConfig } = await import('../api/src/shared/config');
    const { withPathSmokeSpendTracking } = await import('../api/src/ai/voice-quality/path-smoke/provider');
    return withPathSmokeSpendTracking(createLLMGateway(loadConfig(env)), {
      fallbackModel: selection.model,
      addCents,
    });
  }
  const { createRealLayerTwoGateway } = await import('../api/src/ai/gateway/real-layer-two-factory');
  const { AgentEventBus } = await import('../api/src/ai/voice-quality/event-bus');
  let harnessCents = 0;
  return createRealLayerTwoGateway({
    apiKey: selection.apiKey,
    bus: new AgentEventBus(),
    costTracker: {
      addCents: (n) => {
        harnessCents += n;
        addCents(n);
      },
      totalCents: () => harnessCents,
    },
  });
}

/**
 * How the owner records each live baseline locally — the same provider env,
 * per-step cost cap and sample size as .github/workflows/voice-eval-live.yml
 * (pinned together by ci-workflow-voice-eval-live.test.ts). The placeholder
 * baselines carry this string, and writeBaseline keeps it on record.
 */
const LIVE_PROVIDER_ENV =
  'AI_PROVIDER_API_KEY=... AI_PROVIDER_BASE_URL=https://api.openai.com/v1 AI_DEFAULT_MODEL=gpt-4o-mini ' +
  'AI_LIGHTWEIGHT_MODEL=gpt-4o-mini AI_STANDARD_MODEL=gpt-4o-mini AI_COMPLEX_MODEL=gpt-4o ' +
  'AI_CLASSIFY_INTENT_DEADLINE_MS=12000';

export const LIVE_RECORD_COMMANDS = {
  intent:
    `${LIVE_PROVIDER_ENV} VOICE_EVAL_COST_CAP_CENTS=150 npx tsx packages/voice-eval/run-intent-eval.ts ` +
    '--live --max-utterances 200 --record-baseline packages/voice-eval/baselines/intent-live.json',
  slot:
    `${LIVE_PROVIDER_ENV} VOICE_EVAL_COST_CAP_CENTS=80 npx tsx packages/voice-eval/run-slot-eval.ts ` +
    '--live --max-utterances 100 --record-baseline packages/voice-eval/baselines/slot-live.json',
} as const;

// --- Deterministic sampling -------------------------------------------------
/** Parse `--max-utterances N` / `--max-utterances=N` from argv. */
export function parseMaxUtterances(argv: string[]): number | undefined {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--max-utterances') {
      const v = Number(argv[i + 1]);
      return Number.isFinite(v) && v > 0 ? Math.floor(v) : undefined;
    }
    const m = /^--max-utterances=(.+)$/.exec(a);
    if (m) {
      const v = Number(m[1]);
      return Number.isFinite(v) && v > 0 ? Math.floor(v) : undefined;
    }
  }
  return undefined;
}

/**
 * Deterministically take the first `max` rows by stable hash of a per-row key,
 * so a capped run is a stable, comparable sub-sample of the held-out split
 * (same rows every run, independent of file order). `max` undefined/≥length
 * returns all rows (still hash-sorted for determinism). Ties broken by key.
 */
export function sampleDeterministic<T>(rows: T[], keyOf: (row: T) => string, max?: number): T[] {
  const sorted = [...rows].sort((a, b) => {
    const ka = keyOf(a);
    const kb = keyOf(b);
    const ha = stableHash(ka);
    const hb = stableHash(kb);
    if (ha !== hb) return ha - hb;
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
  if (max === undefined || max >= sorted.length) return sorted;
  return sorted.slice(0, max);
}

// --- Threshold gating -------------------------------------------------------
export interface GateResult {
  value: number;
  target: number;
  enforced: boolean;
  pass: boolean;
}

/**
 * Evaluate a metric against a target. When `gate` is false it is report-only
 * (`pass` is always true); when true, `pass` reflects value >= target.
 */
export function evaluateGate(value: number, target: number, gate: boolean): GateResult {
  return { value, target, enforced: gate, pass: gate ? value >= target : true };
}

// --- Live run loops (gateway injected) --------------------------------------
export interface IntentRow {
  utterance: string;
  intent: string;
}

export interface LiveIntentResult {
  pairs: { gold: string; pred: string }[];
  /** Count of rows resolved by a deterministic short-circuit (no LLM call). */
  fastPathHits: number;
  llmCalls: number;
}

/**
 * Route each utterance through the PRODUCTION `classifyIntent` with the given
 * gateway. Fast-path hits (empty transcript / deterministic phrase matches that
 * return before the LLM) are detected by the absence of `tokenUsage` on the
 * result — the classifier only populates it when the gateway was actually
 * called. This measures production behavior (fast-path + LLM together) and
 * reports the fast-path hit rate, exactly as the classifier ships.
 */
export async function runLiveIntentEval(
  rows: IntentRow[],
  gateway: LLMGateway,
  ctx: ClassifyContext = { tenantId: SYNTHETIC_TENANT_ID },
  afterRow?: () => void,
): Promise<LiveIntentResult> {
  const { classifyIntent } = await import('../api/src/ai/orchestration/intent-classifier');
  const pairs: { gold: string; pred: string }[] = [];
  let fastPathHits = 0;
  let llmCalls = 0;
  for (const r of rows) {
    const res = await classifyIntent(r.utterance, ctx, gateway);
    pairs.push({ gold: r.intent, pred: res.intentType });
    if (res.tokenUsage) llmCalls++;
    else fastPathHits++;
    afterRow?.();
  }
  return { pairs, fastPathHits, llmCalls };
}

export interface SlotExample {
  transcript: string;
  gold: Record<string, string>;
}

export interface LiveSlotResult {
  examples: { gold: Record<string, string>; pred: Record<string, string> }[];
  fastPathHits: number;
  llmCalls: number;
}

/**
 * Route each transcript through the production classifier and project the
 * resulting entities onto the launch-slot shape via `extractLaunchSlots` (the
 * production projection). Input is left empty — no gold is injected — so the
 * predicted slots reflect only what the LLM produced. service_type is not
 * classifier-derived and is excluded upstream (LIVE_SLOTS).
 */
export async function runLiveSlotEval(
  examples: SlotExample[],
  gateway: LLMGateway,
  ctx: ClassifyContext = { tenantId: SYNTHETIC_TENANT_ID },
  afterRow?: () => void,
): Promise<LiveSlotResult> {
  const { classifyIntent } = await import('../api/src/ai/orchestration/intent-classifier');
  const { extractLaunchSlots } = await import('../api/src/voice/launch-slots');
  const out: { gold: Record<string, string>; pred: Record<string, string> }[] = [];
  let fastPathHits = 0;
  let llmCalls = 0;
  for (const ex of examples) {
    const res = await classifyIntent(ex.transcript, ctx, gateway);
    if (res.tokenUsage) llmCalls++;
    else fastPathHits++;
    const slots = extractLaunchSlots(res.extractedEntities ?? {});
    out.push({
      gold: ex.gold,
      pred: {
        name: slots.caller_name ?? '',
        address: slots.address ?? '',
        time_window: slots.preferred_time_window ?? '',
        problem_description: slots.problem_description ?? '',
      },
    });
    afterRow?.();
  }
  return { examples: out, fastPathHits, llmCalls };
}

// --- CLI entry --------------------------------------------------------------
/** Resolve once everything already queued on `stream` has been flushed. */
function drain(stream: NodeJS.WriteStream): Promise<void> {
  return new Promise((resolve) => {
    try {
      stream.write('', () => resolve());
    } catch {
      resolve();
    }
  });
}

/**
 * Run a runner script's `main` as a one-shot CLI and exit with the code it
 * returns (a thrown error exits 1, or 3 for an actual-spend cap breach).
 *
 * Why this exists: the production gateway's resilience stack sleeps its retry
 * backoff (and arms its deadline) on UNREF'D timers — right for a long-lived
 * server, fatal for a script. When the provider rate-limited a call, that
 * unref'd backoff timer was the only thing left in the event loop, so Node
 * drained the loop and exited 0 with `main` still pending: header printed, no
 * report, no baseline written, green CI step (voice-eval-live.yml baseline
 * run, 2026-09-28). A ref'd keepalive holds the loop open until `main`
 * settles, and as a last line of defence an `exit` hook turns any exit that
 * happens while `main` is still unsettled into a loud non-zero failure.
 * stdout/stderr are drained before the explicit exit (the gateway may still
 * hold timers, so we cannot wait for the loop to empty on its own), so the
 * report is never truncated through a `| tee` pipe.
 */
export function runEvalCli(main: () => Promise<number>): void {
  let settled = false;
  const keepalive = setInterval(() => {}, 60_000);
  process.on('exit', (code) => {
    if (settled) return;
    process.stderr.write(
      `\n❌ voice-eval exited (code ${code}) before the run finished — no report or baseline was produced.\n`,
    );
    if (!code) process.exitCode = 1;
  });
  const finish = async (code: number): Promise<never> => {
    settled = true;
    clearInterval(keepalive);
    await Promise.all([drain(process.stdout), drain(process.stderr)]);
    process.exit(code);
  };
  main().then(
    (code) => finish(code),
    (e: unknown) => {
      console.error(e);
      return finish(e instanceof ActualCostCapExceededError ? 3 : 1);
    },
  );
}
