import type { LLMProvider, LLMRequest, LLMResponse } from './gateway';
import { DEFAULT_AI_ROUTING_CONFIG, type ModelTier } from '../../config/ai-routing';

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

export function resolveFallbackTierModelsFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): FallbackTierModels {
  const lightweight =
    env.AI_FALLBACK_LIGHTWEIGHT_MODEL?.trim() || DEFAULT_FALLBACK_TIER_MODELS.lightweight;
  return {
    lightweight,
    standard: env.AI_FALLBACK_STANDARD_MODEL?.trim() || lightweight,
    complex: env.AI_FALLBACK_COMPLEX_MODEL?.trim() || lightweight,
  };
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
    return this.inner.complete({ ...request, model });
  }

  async isAvailable(): Promise<boolean> {
    return this.inner.isAvailable();
  }
}
