import type { LLMProvider, LLMRequest, LLMResponse } from './gateway';
import { messagesContainImage } from './gateway';
import { AppError } from '../../shared/errors';
import {
  DEFAULT_AI_ROUTING_CONFIG,
  isVisionCapableModel,
  type ModelTier,
} from '../../config/ai-routing';

export interface FallbackTierModels {
  lightweight: string;
  standard: string;
  complex: string;
}

/**
 * Default OpenRouter-oriented tier map used when AI_FALLBACK_* model env vars
 * are unset. Kept in sync with Profile B defaults in
 * docs/runbooks/live-ai-restore.md — failover must not send OpenAI model ids
 * to an OpenRouter host.
 */
export const DEFAULT_FALLBACK_TIER_MODELS: FallbackTierModels = {
  lightweight: 'meta-llama/llama-3.1-8b-instruct',
  standard: 'meta-llama/llama-3.3-70b-instruct',
  complex: 'qwen/qwen2.5-vl-72b-instruct',
};

/**
 * Each tier falls back to its OWN default (GATEWAY-06). It used to cascade
 * standard and complex to the lightweight model, so a runbook setup that set
 * only AI_FALLBACK_LIGHTWEIGHT_MODEL sent photo-to-quote (mms_estimate,
 * complex) to a text-only 8B model and silently downgraded estimate/invoice
 * drafting during exactly the outage the fallback exists for.
 */
export function resolveFallbackTierModelsFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): FallbackTierModels {
  return {
    lightweight:
      env.AI_FALLBACK_LIGHTWEIGHT_MODEL?.trim() || DEFAULT_FALLBACK_TIER_MODELS.lightweight,
    standard: env.AI_FALLBACK_STANDARD_MODEL?.trim() || DEFAULT_FALLBACK_TIER_MODELS.standard,
    complex: env.AI_FALLBACK_COMPLEX_MODEL?.trim() || DEFAULT_FALLBACK_TIER_MODELS.complex,
  };
}

/**
 * Thrown by FallbackModelMapProvider, before any dispatch, when an
 * image-bearing request would go to a fallback model that cannot take images.
 * The fallback-side twin of the gateway's primary vision fail-fast: a 4xx, so
 * it is not retried, not counted as provider health, and not failed over.
 */
export class FallbackModelNotVisionCapableError extends AppError {
  constructor(taskType: string, fallbackModel: string) {
    super(
      'LLM_FALLBACK_NOT_VISION_CAPABLE',
      `Fallback model ${fallbackModel} cannot take image content (task ${taskType}); ` +
        'set AI_FALLBACK_COMPLEX_MODEL (or the matching tier) to a vision-capable model',
      400,
      { taskType, fallbackModel },
    );
    this.name = 'FallbackModelNotVisionCapableError';
  }
}

function tierForTask(taskType: string | undefined): ModelTier {
  if (!taskType) return 'standard';
  return DEFAULT_AI_ROUTING_CONFIG.taskTierMapping[taskType] ?? 'standard';
}

/**
 * Rewrites `request.model` to a fallback-provider-compatible id before
 * forwarding. Primary (e.g. gpt-4o-mini) and fallback (OpenRouter Llama)
 * rarely share model ids — without this, failover would 4xx and not help.
 */
export class FallbackModelMapProvider implements LLMProvider {
  readonly name: string;

  constructor(
    readonly inner: LLMProvider,
    private readonly tiers: FallbackTierModels,
  ) {
    this.name = inner.name;
  }

  async complete(request: LLMRequest): Promise<LLMResponse> {
    const tier = tierForTask(request.taskType);
    const model = this.tiers[tier];
    // GATEWAY-06: the gateway's vision fail-fast only sees the primary's
    // model; the model rewritten here must be checked too.
    if (messagesContainImage(request.messages) && !isVisionCapableModel(model)) {
      throw new FallbackModelNotVisionCapableError(request.taskType, model);
    }
    return this.inner.complete({ ...request, model });
  }

  async isAvailable(): Promise<boolean> {
    return this.inner.isAvailable();
  }
}
