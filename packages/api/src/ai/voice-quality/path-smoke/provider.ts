/**
 * Real-LLM path smoke — which provider/model the smoke exercises.
 *
 * The smoke exists to prove the PRODUCTION classifier works against the
 * PRODUCTION model. Production (Railway prod + dev) runs the OpenAI-compatible
 * gateway built by `createLLMGateway` from AI_PROVIDER_API_KEY /
 * AI_PROVIDER_BASE_URL / AI_*_MODEL — not Anthropic. So the production config
 * is preferred; ANTHROPIC_API_KEY (the older Layer-2 harness gateway, Haiku via
 * Anthropic's OpenAI-compat endpoint) is only an explicit fallback for local
 * runs that have no production-shaped key.
 */
import {
  DEFAULT_AI_ROUTING_CONFIG,
  resolveModelForTaskType,
  type AIRoutingConfig,
} from '../../../config/ai-routing';
import { DEFAULT_AI_PROVIDER_BASE_URL } from '../../gateway/factory';
import { LLMGateway, type LLMRequest, type LLMResponse } from '../../gateway/gateway';
import {
  ANTHROPIC_OPENAI_COMPAT_BASE_URL,
  DEFAULT_LAYER_TWO_MODEL,
} from '../../gateway/layer-two-models';

/** Env subset the selector reads (plain record so tests need no process.env). */
export type PathSmokeEnv = Record<string, string | undefined>;

export type PathSmokeProviderSelection =
  | {
      kind: 'production';
      keySource: 'AI_PROVIDER_API_KEY';
      apiKey: string;
      baseUrl: string;
      /** Model the production gateway routes `classify_intent` to. */
      model: string;
    }
  | {
      /** NOT what production runs — local-dev fallback only. */
      kind: 'anthropic-fallback';
      keySource: 'ANTHROPIC_API_KEY';
      apiKey: string;
      baseUrl: string;
      model: string;
    };

/** AppConfig's AI_DEFAULT_MODEL default (shared/config.ts). */
const PRODUCTION_DEFAULT_MODEL = 'gpt-4o-mini';

function nonBlank(v: string | undefined): string | undefined {
  const t = v?.trim();
  return t ? t : undefined;
}

/**
 * Mirrors createLLMGateway's model precedence (factory.ts buildGatewayConfig):
 * when all three per-tier vars are set they win and classify_intent routes by
 * the production task→tier mapping; otherwise AI_DEFAULT_MODEL applies to
 * every tier.
 */
function resolveProductionClassifyModel(env: PathSmokeEnv): string {
  const lightweight = nonBlank(env.AI_LIGHTWEIGHT_MODEL);
  const standard = nonBlank(env.AI_STANDARD_MODEL);
  const complex = nonBlank(env.AI_COMPLEX_MODEL);
  if (lightweight && standard && complex) {
    const routing: AIRoutingConfig = {
      tiers: {
        lightweight: { ...DEFAULT_AI_ROUTING_CONFIG.tiers.lightweight, model: lightweight },
        standard: { ...DEFAULT_AI_ROUTING_CONFIG.tiers.standard, model: standard },
        complex: { ...DEFAULT_AI_ROUTING_CONFIG.tiers.complex, model: complex },
      },
      taskTierMapping: DEFAULT_AI_ROUTING_CONFIG.taskTierMapping,
    };
    return resolveModelForTaskType(routing, 'classify_intent');
  }
  return nonBlank(env.AI_DEFAULT_MODEL) ?? PRODUCTION_DEFAULT_MODEL;
}

export function selectPathSmokeProvider(
  env: PathSmokeEnv,
): PathSmokeProviderSelection | null {
  const prodKey = nonBlank(env.AI_PROVIDER_API_KEY);
  if (prodKey) {
    return {
      kind: 'production',
      keySource: 'AI_PROVIDER_API_KEY',
      apiKey: prodKey,
      baseUrl: nonBlank(env.AI_PROVIDER_BASE_URL) ?? DEFAULT_AI_PROVIDER_BASE_URL,
      model: resolveProductionClassifyModel(env),
    };
  }
  const anthropicKey = nonBlank(env.ANTHROPIC_API_KEY);
  if (anthropicKey) {
    return {
      kind: 'anthropic-fallback',
      keySource: 'ANTHROPIC_API_KEY',
      apiKey: anthropicKey,
      baseUrl: ANTHROPIC_OPENAI_COMPAT_BASE_URL,
      model: DEFAULT_LAYER_TWO_MODEL,
    };
  }
  return null;
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/** One-line, key-free description of what the smoke is about to exercise. */
export function describePathSmokeProvider(sel: PathSmokeProviderSelection): string {
  const where = `${hostOf(sel.baseUrl)} model=${sel.model} (key: ${sel.keySource})`;
  return sel.kind === 'production'
    ? `production provider config via createLLMGateway → ${where}`
    : `Anthropic fallback harness gateway → ${where} — NOT the production provider`;
}

interface SmokeRates {
  inputCentsPerMTok: number;
  outputCentsPerMTok: number;
}

/**
 * Smoke-local price table for the cost cap. The production pricing table
 * (gateway/model-pricing.ts) deliberately omits OpenAI models, so this
 * preflight carries its own. Longest family first so a dated snapshot id
 * ("gpt-4o-mini-2024-07-18") never matches the shorter "gpt-4o" prefix.
 *
 *   gpt-4o-mini  $0.15 / $0.60 per 1M  (OpenAI list price)
 *   gpt-4o       $2.50 / $10.00 per 1M (OpenAI list price)
 *   claude-haiku-4-5  $3.00 / $15.00 per 1M — the pinned, conservative
 *     Layer-2 harness rate (real-layer-two-factory.ts), unchanged from the
 *     pre-fix projection for the Anthropic fallback.
 */
const PATH_SMOKE_RATES: ReadonlyArray<readonly [string, SmokeRates]> = [
  ['gpt-4o-mini', { inputCentsPerMTok: 15, outputCentsPerMTok: 60 }],
  ['gpt-4o', { inputCentsPerMTok: 250, outputCentsPerMTok: 1000 }],
  ['claude-haiku-4-5', { inputCentsPerMTok: 300, outputCentsPerMTok: 1500 }],
];

function ratesFor(model: string): SmokeRates | null {
  const id = model.toLowerCase().split('/').pop() ?? '';
  for (const [family, rates] of PATH_SMOKE_RATES) {
    if (id === family || id.startsWith(`${family}-`)) return rates;
  }
  return null;
}

export interface ProjectPathSmokeCentsInput {
  model: string;
  utterances: readonly string[];
  /** Estimated classifier system-prompt tokens sent with every call. */
  systemPromptTokens: number;
  outputTokensPerCall: number;
}

/**
 * Conservative (no-cache) preflight projection in cents for one smoke run.
 * Returns null for a model with no known price — the CLI then refuses to run
 * rather than enforce the cap against a guessed rate.
 */
export function projectPathSmokeCents(input: ProjectPathSmokeCentsInput): number | null {
  const rates = ratesFor(input.model);
  if (!rates) return null;
  let cents = 0;
  for (const u of input.utterances) {
    const inputTokens = input.systemPromptTokens + Math.ceil(u.length / 4);
    cents +=
      (inputTokens / 1_000_000) * rates.inputCentsPerMTok +
      (input.outputTokensPerCall / 1_000_000) * rates.outputCentsPerMTok;
  }
  return cents;
}

/**
 * Actual spend (cents) for one completed call, priced by the model id the
 * provider reports as having served it. Null when that model is unpriced.
 */
export function pathSmokeCallCents(
  model: string,
  usage: { input?: number; output?: number },
): number | null {
  const rates = ratesFor(model);
  if (!rates) return null;
  return (
    ((usage.input ?? 0) / 1_000_000) * rates.inputCentsPerMTok +
    ((usage.output ?? 0) / 1_000_000) * rates.outputCentsPerMTok
  );
}

export interface PathSmokeSpendTrackingDeps {
  /** Selected (preflight-priced) model, used when the served id is unpriced. */
  fallbackModel: string;
  addCents(cents: number): void;
}

/**
 * `LLMGateway` subclass (keeps `instanceof`) that delegates every call to the
 * production gateway untouched and records its actual spend, so the CLI can
 * enforce the cost cap turn by turn.
 */
class PathSmokeSpendTrackingGateway extends LLMGateway {
  constructor(
    private readonly inner: LLMGateway,
    private readonly deps: PathSmokeSpendTrackingDeps,
  ) {
    // Provider machinery is never used — every call delegates to `inner`.
    super({ defaultProvider: 'path-smoke-spend-passthrough' }, new Map());
  }

  override async complete(request: LLMRequest): Promise<LLMResponse> {
    const response = await this.inner.complete(request);
    const usage = response.tokenUsage ?? {};
    const cents =
      pathSmokeCallCents(response.model, usage) ??
      pathSmokeCallCents(this.deps.fallbackModel, usage) ??
      0;
    this.deps.addCents(cents);
    return response;
  }
}

export function withPathSmokeSpendTracking(
  inner: LLMGateway,
  deps: PathSmokeSpendTrackingDeps,
): LLMGateway {
  return new PathSmokeSpendTrackingGateway(inner, deps);
}
