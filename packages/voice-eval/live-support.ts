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
 * is constructed in the runner scripts (createRealLayerTwoGateway) and injected,
 * so these functions — and their tests — never open a socket.
 */
import type { LLMGateway } from '../api/src/ai/gateway/gateway';
import type { ClassifyContext } from '../api/src/ai/orchestration/intent-classifier';
import { stableHash } from './metrics';

// The production entry points are imported DYNAMICALLY inside the run loops
// (below), not at module top level. Two reasons: (1) the offline eval path and
// the offline unit tests must load this module without pulling in the api
// `src` value modules — a static named import of `classifyIntent` fails to
// resolve across the package boundary under the `tsx` ESM loader; (2) it keeps
// the offline path zero-dependency. Type-only imports above are erased, so they
// are safe to keep static.

// The classifier never touches the DB or RLS, so a synthetic tenant is safe.
// We use the shared system tenant id ('system') so the Layer-2 gateway's
// tenant override (which pins every tier to the configured Claude model)
// applies — otherwise an unknown tenant would resolve to a default model name
// that the Anthropic OpenAI-compat endpoint would reject. See
// packages/api/src/ai/gateway/real-layer-two-factory.ts.
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
// Mirrors the Haiku pricing in packages/api/src/ai/gateway/real-layer-two-factory.ts
// (HAIKU_*_CENTS_PER_MTOKEN). Duplicated as plain constants so this module (and
// its offline tests) never has to import the `openai`-bearing factory.
export const HAIKU_INPUT_CENTS_PER_MTOKEN = 300;
export const HAIKU_OUTPUT_CENTS_PER_MTOKEN = 1500;

// Conservative per-call token estimate for the pre-flight cost projection. The
// classifier system prompt is large (~500 lines of intent taxonomy); we assume
// NO prompt-cache discount so the projection over-estimates rather than
// under-estimates spend (a cost cap must fail safe). Per-utterance input tokens
// are added on top from the utterance length.
//
// This constant MUST stay an overestimate of the real classifier system
// prompt (SYSTEM_PROMPT in packages/api/src/ai/orchestration/intent-classifier.ts,
// exported for exactly this reason). Measured 2026-07-17: 35,309 chars ≈ 8,828
// tokens by this file's own chars/4 heuristic (estimateTokens) — the live eval
// path (SYNTHETIC_TENANT_ID, no vertical/plan/owner/extended context) sends
// only that base prompt, nothing more. This constant carries ~25% headroom
// over that measurement so future taxonomy growth doesn't silently make the
// preflight understate cost. It is pinned by a test
// (packages/api/test/voice-quality/voice-eval-live.test.ts) that imports the
// real SYSTEM_PROMPT and fails the moment this constant stops being a safe
// overestimate — if that test fails, bump this constant (don't just raise the
// test's margin) and re-verify the cost cap semantics still abort before
// spending.
export const EST_SYSTEM_PROMPT_TOKENS = 11000;
export const EST_OUTPUT_TOKENS_PER_CALL = 250;
export const DEFAULT_COST_CAP_CENTS = 500; // $5

const CHARS_PER_TOKEN = 4;

/** Rough token count for a piece of text (chars/4), floored at 1. */
export function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / CHARS_PER_TOKEN));
}

/** Conservative cents for a single classify call over `utteranceChars`. */
export function projectCallCents(utteranceChars: number): number {
  const inputTokens = EST_SYSTEM_PROMPT_TOKENS + Math.ceil(utteranceChars / CHARS_PER_TOKEN);
  const inputCents = (inputTokens / 1_000_000) * HAIKU_INPUT_CENTS_PER_MTOKEN;
  const outputCents = (EST_OUTPUT_TOKENS_PER_CALL / 1_000_000) * HAIKU_OUTPUT_CENTS_PER_MTOKEN;
  return inputCents + outputCents;
}

/** Conservative projected cents for a whole run over the given utterances. */
export function projectRunCents(utterances: string[]): number {
  let cents = 0;
  for (const u of utterances) cents += projectCallCents(u.length);
  return cents;
}

export interface CostCapResult {
  projectedCents: number;
  capCents: number;
  withinCap: boolean;
}

/** Pure cost-cap check. Does not throw — the caller decides how to abort. */
export function checkCostCap(utterances: string[], capCents: number): CostCapResult {
  const projectedCents = projectRunCents(utterances);
  return { projectedCents, capCents, withinCap: projectedCents <= capCents };
}

/** Resolve the cost cap (cents) from the environment, defaulting conservatively. */
export function resolveCostCapCents(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.VOICE_EVAL_COST_CAP_CENTS;
  if (raw === undefined || raw.trim() === '') return DEFAULT_COST_CAP_CENTS;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_COST_CAP_CENTS;
}

// --- Credential resolution --------------------------------------------------
export interface ResolvedKey {
  key: string;
  source: string;
}

/**
 * Resolve the live LLM API key from the environment. The live gateway is the
 * Layer-2 real gateway (Anthropic via the OpenAI-compat endpoint), so
 * ANTHROPIC_API_KEY is preferred; AI_PROVIDER_API_KEY (the production factory's
 * variable) is accepted as a fallback so a deploy-configured environment works
 * unchanged. Returns null when no usable key is present — the caller fails fast.
 */
export function resolveLiveApiKey(env: NodeJS.ProcessEnv = process.env): ResolvedKey | null {
  const candidates: Array<[string, string | undefined]> = [
    ['ANTHROPIC_API_KEY', env.ANTHROPIC_API_KEY],
    ['AI_PROVIDER_API_KEY', env.AI_PROVIDER_API_KEY],
  ];
  for (const [source, key] of candidates) {
    if (key && key.trim() !== '') return { key: key.trim(), source };
  }
  return null;
}

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
  }
  return { examples: out, fastPathHits, llmCalls };
}
