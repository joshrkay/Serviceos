/**
 * Per-model LLM pricing table + cost computation for the production gateway.
 *
 * Companion to the offline eval-only pricing in `real-layer-two-factory.ts`
 * (see that file's header for why it keeps its own constants instead of
 * consuming this module). This module is the source of truth for
 * `gateway.ts`'s per-call cost accounting (Prometheus + `ai_runs.cost_micro_cents`).
 *
 * ## Precision / rounding design
 *
 * Anthropic (and most providers) quote prices as an integer number of cents
 * per 1,000,000 tokens (e.g. $3.00/1M tokens = 300 cents/1M tokens). A naive
 * `Math.round((tokens / 1_000_000) * centsPerMillion)` computed per call
 * rounds every sub-cent call (the overwhelming majority of `classify_intent`
 * / lightweight-tier calls) down to 0 cents — the exact "sub-cent calls round
 * to zero" failure mode this module exists to avoid.
 *
 * Instead, cost is computed and accumulated in **micro-cents**, where
 * `1 cent = 1,000,000 micro-cents`. Given an integer rate R (cents per
 * 1,000,000 tokens) and token count T:
 *
 *   cost_in_cents        = T * R / 1,000,000
 *   cost_in_micro_cents  = cost_in_cents * 1,000,000
 *                        = T * R
 *
 * So `costMicroCents = tokens * centsPerMillionTokens` — a plain integer
 * multiplication, always exact, never rounded, and never zero for a nonzero
 * token count at any realistic rate. Totals accumulate by integer addition
 * (`inputMicroCents + outputMicroCents`) with zero compounding error.
 *
 * Rounding happens exactly ONCE, only when a caller needs a whole-cent
 * figure (e.g. a legacy display or coarse report): `microCentsToCents()`
 * divides by 1,000,000 and rounds half-up via `Math.round`. The persisted
 * `ai_runs.cost_micro_cents` column and the Prometheus counter both store
 * the unrounded micro-cent value — aggregation (SQL `SUM`, Prometheus
 * `sum()`) over exact integers stays exact; only a human-facing dollar
 * figure derived from an aggregate should round, and only once.
 */

export interface ModelPriceRates {
  /** Integer cents per 1,000,000 input tokens. */
  inputCentsPerMillionTokens: number;
  /** Integer cents per 1,000,000 output tokens. */
  outputCentsPerMillionTokens: number;
}

export interface TokenUsageLike {
  input?: number;
  output?: number;
  total?: number;
}

/**
 * Default pricing table, keyed by canonical (lowercase, undated, unprefixed)
 * model family — resolution below matches a dated/provider-namespaced id
 * (e.g. "claude-haiku-4-5-20251001", "anthropic/claude-opus-4-8") against
 * these family keys the same way `isVisionCapableModel` does in
 * `config/ai-routing.ts`.
 *
 * ONLY models with a verified current price are listed. Deliberately
 * excluded: OpenAI models (gpt-4o, gpt-4o-mini — reachable via
 * AI_DEFAULT_MODEL / AI_PROVIDER_BASE_URL for system-tenant calls) and
 * legacy/deprecated Claude models (opus-4-5, opus-4-1, sonnet-4-5, sonnet-4-0,
 * opus-4-0, haiku-3). Per the "never a guess" rule for AI-emitted money
 * figures (see CLAUDE.md catalog-resolver pattern — the same discipline
 * applies to cost accounting), an unpriced model resolves to a null cost
 * rather than a fabricated number. Ops can add any of these via
 * AI_MODEL_PRICING_JSON without a deploy — see `loadPricingOverrides` below.
 *
 * Prices as of 2026-06-24 (Anthropic published pricing, USD, per 1,000,000
 * tokens): Haiku 4.5 $1.00/$5.00, Sonnet 4.6 $3.00/$15.00, Sonnet 5
 * $3.00/$15.00 standard (introductory $2.00/$10.00 through 2026-08-31 —
 * intentionally NOT baked into this permanent default table; set
 * AI_MODEL_PRICING_JSON during the introductory window if routing real
 * traffic to claude-sonnet-5), Opus 4.6/4.7/4.8 $5.00/$25.00, Fable 5 /
 * Mythos 5 $10.00/$50.00.
 *
 * OpenRouter open-model floor prices as of 2026-07-20 (USD per 1,000,000
 * tokens; aggregator floors — actual billed rate may be higher depending on
 * the routed provider). Override via AI_MODEL_PRICING_JSON if your routed
 * provider differs: Llama 3.1 8B $0.02/$0.03, Llama 3.3 70B $0.10/$0.32,
 * Qwen 2.5 72B $0.36/$0.40, Qwen 2.5 VL 72B $0.80/$0.80.
 */
export const DEFAULT_MODEL_PRICING: Readonly<Record<string, ModelPriceRates>> = {
  'claude-haiku-4-5': { inputCentsPerMillionTokens: 100, outputCentsPerMillionTokens: 500 },
  'claude-sonnet-4-6': { inputCentsPerMillionTokens: 300, outputCentsPerMillionTokens: 1500 },
  'claude-sonnet-5': { inputCentsPerMillionTokens: 300, outputCentsPerMillionTokens: 1500 },
  'claude-opus-4-6': { inputCentsPerMillionTokens: 500, outputCentsPerMillionTokens: 2500 },
  'claude-opus-4-7': { inputCentsPerMillionTokens: 500, outputCentsPerMillionTokens: 2500 },
  'claude-opus-4-8': { inputCentsPerMillionTokens: 500, outputCentsPerMillionTokens: 2500 },
  'claude-fable-5': { inputCentsPerMillionTokens: 1000, outputCentsPerMillionTokens: 5000 },
  'claude-mythos-5': { inputCentsPerMillionTokens: 1000, outputCentsPerMillionTokens: 5000 },
  // OpenRouter Option A defaults (keys = lastSegment of the OpenRouter id).
  'llama-3.1-8b-instruct': { inputCentsPerMillionTokens: 2, outputCentsPerMillionTokens: 3 },
  'llama-3.3-70b-instruct': { inputCentsPerMillionTokens: 10, outputCentsPerMillionTokens: 32 },
  'qwen-2.5-72b-instruct': { inputCentsPerMillionTokens: 36, outputCentsPerMillionTokens: 40 },
  'qwen2.5-vl-72b-instruct': { inputCentsPerMillionTokens: 80, outputCentsPerMillionTokens: 80 },
};

function isFiniteNonNegativeInteger(n: unknown): n is number {
  return typeof n === 'number' && Number.isInteger(n) && n >= 0 && Number.isFinite(n);
}

function isValidRates(v: unknown): v is ModelPriceRates {
  if (!v || typeof v !== 'object') return false;
  const r = v as Record<string, unknown>;
  return (
    isFiniteNonNegativeInteger(r.inputCentsPerMillionTokens) &&
    isFiniteNonNegativeInteger(r.outputCentsPerMillionTokens)
  );
}

/** Lowercase the model id and drop a provider namespace prefix ("openai/gpt-4o" -> "gpt-4o"). */
function lastSegment(id: string): string {
  return id.toLowerCase().split('/').pop() ?? '';
}

/**
 * Env-overridable pricing, mirroring the model-id override pattern in
 * `config/ai-routing.ts` (AI_LIGHTWEIGHT_MODEL etc.) and
 * `AI_VISION_CAPABLE_MODELS` — price changes never need a deploy.
 *
 * AI_MODEL_PRICING_JSON is a JSON object of `{ "<model-family-id>": {
 * "inputCentsPerMillionTokens": N, "outputCentsPerMillionTokens": N } }`
 * entries merged OVER the defaults above (each key fully replaces its
 * default entry; unknown keys are added as new models). Malformed JSON or
 * an invalid per-model entry is dropped with a stderr warning rather than
 * crashing boot or poisoning pricing with NaN — pricing errors must fail
 * safe to "unknown cost", never to a wrong cost.
 *
 * Override keys are normalized with the SAME `lastSegment()` function used
 * to normalize the runtime model id at lookup time (lowercased, provider
 * namespace stripped). Without this, an override keyed
 * `"openai/gpt-4o-mini"` (the natural shape when AI_DEFAULT_MODEL is an
 * OpenRouter-style namespaced id) would be stored verbatim and never match
 * the bare `"gpt-4o-mini"` produced by `resolveModelPricing()`, silently
 * resolving to a null cost despite ops having provided a rate. Namespaced
 * and bare override keys for the same model both resolve to the same
 * normalized key; if both are present, whichever is encountered last in
 * `Object.entries()` iteration order wins — the same "last one wins"
 * collision rule as any other object-key merge in this module.
 */
function loadPricingOverrides(): Record<string, ModelPriceRates> {
  const raw = process.env.AI_MODEL_PRICING_JSON;
  if (!raw || raw.trim() === '') return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    process.stderr.write(
      '[WARN] AI_MODEL_PRICING_JSON is not valid JSON — ignoring, falling back to default pricing\n',
    );
    return {};
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    process.stderr.write(
      '[WARN] AI_MODEL_PRICING_JSON must be a JSON object — ignoring, falling back to default pricing\n',
    );
    return {};
  }
  const overrides: Record<string, ModelPriceRates> = {};
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (!isValidRates(value)) {
      process.stderr.write(
        `[WARN] AI_MODEL_PRICING_JSON entry "${key}" is missing/invalid rate fields — skipping\n`,
      );
      continue;
    }
    overrides[lastSegment(key)] = value;
  }
  return overrides;
}

/**
 * Effective pricing table: defaults merged with the env override, computed
 * once at module load (same lazy-once pattern as the rest of the gateway's
 * env-derived config). Re-import the module (or restart the process) to
 * pick up a changed AI_MODEL_PRICING_JSON.
 */
export const MODEL_PRICING: Readonly<Record<string, ModelPriceRates>> = {
  ...DEFAULT_MODEL_PRICING,
  ...loadPricingOverrides(),
};

/**
 * Resolve pricing for a model id. Matches the exact normalized id first,
 * then falls back to a dated/versioned-snapshot match against a known
 * family (e.g. "claude-haiku-4-5-20251001" -> "claude-haiku-4-5"), mirroring
 * `isVisionCapableModel` in `config/ai-routing.ts`. Returns `null` for any
 * model not in `MODEL_PRICING` — deliberately never a guessed price.
 */
export function resolveModelPricing(model: string | undefined): ModelPriceRates | null {
  if (!model) return null;
  const normalized = lastSegment(model);
  if (!normalized) return null;
  if (MODEL_PRICING[normalized]) return MODEL_PRICING[normalized];
  for (const [family, rates] of Object.entries(MODEL_PRICING)) {
    if (normalized === family || normalized.startsWith(`${family}-`)) {
      return rates;
    }
  }
  return null;
}

/**
 * Compute the exact cost of a completion in micro-cents (1 cent =
 * 1,000,000 micro-cents — see file header for the derivation). Returns
 * `null` when the model has no known price (never a guessed cost) or when
 * tokenUsage is absent.
 *
 * Negative/non-finite token counts (never expected from a real provider
 * response, but defensively handled) are floored to 0 rather than allowed
 * to produce a negative or NaN cost.
 */
export function computeCostMicroCents(
  model: string | undefined,
  tokenUsage: TokenUsageLike | undefined,
): number | null {
  const rates = resolveModelPricing(model);
  if (!rates) return null;
  if (!tokenUsage) return null;

  const inputTokens = sanitizeTokenCount(tokenUsage.input);
  const outputTokens = sanitizeTokenCount(tokenUsage.output);

  return (
    inputTokens * rates.inputCentsPerMillionTokens +
    outputTokens * rates.outputCentsPerMillionTokens
  );
}

function sanitizeTokenCount(n: number | undefined): number {
  if (typeof n !== 'number' || !Number.isFinite(n) || n <= 0) return 0;
  return Math.trunc(n);
}

/**
 * The ONE place cost rounds to whole cents — for callers that genuinely need
 * a coarse cents figure (e.g. a legacy integer-cents display). Rounds
 * half-up. Prefer carrying `costMicroCents` end-to-end (storage, metrics,
 * aggregation) and only calling this at the final display boundary.
 */
export function microCentsToCents(costMicroCents: number): number {
  return Math.round(costMicroCents / 1_000_000);
}
