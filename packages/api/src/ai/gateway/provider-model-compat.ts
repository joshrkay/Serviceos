/**
 * Detect when AI_PROVIDER_BASE_URL and tier model IDs cannot work together.
 *
 * Live incident 2026-07-20: Railway pointed at api.openai.com while tier
 * defaults were Claude (`claude-haiku-4-5-20251001` / `claude-sonnet-4-6`).
 * `/api/health/ai` stayed green (breaker closed) while every completion
 * errored — proven via `gateway_requests_total{provider="api.openai.com",
 * model="claude-…",outcome="error"}`.
 *
 * This is a static config check (no network). It does not prove the key
 * works; pair with `probeAiCompletion` for that.
 */

export type ProviderHostFamily = 'openai' | 'openrouter' | 'anthropic' | 'unknown';

export type ModelIdFamily =
  | 'openai'
  | 'anthropic'
  | 'meta_llama'
  | 'qwen'
  | 'other';

export interface ProviderModelMismatch {
  providerHost: string;
  providerFamily: ProviderHostFamily;
  model: string;
  modelFamily: ModelIdFamily;
  reason: string;
}

function hostFromBaseUrl(baseUrl: string): string {
  try {
    return new URL(baseUrl).hostname.toLowerCase();
  } catch {
    return baseUrl.toLowerCase();
  }
}

export function classifyProviderHost(baseUrl: string): ProviderHostFamily {
  const host = hostFromBaseUrl(baseUrl);
  if (host.includes('openrouter.ai')) return 'openrouter';
  if (host.includes('anthropic.com')) return 'anthropic';
  if (host.includes('openai.com')) return 'openai';
  return 'unknown';
}

export function classifyModelId(model: string): ModelIdFamily {
  const id = model.trim().toLowerCase();
  const leaf = id.includes('/') ? id.slice(id.lastIndexOf('/') + 1) : id;
  if (leaf.startsWith('claude') || id.startsWith('anthropic/')) return 'anthropic';
  if (leaf.startsWith('gpt-') || leaf.startsWith('o1') || leaf.startsWith('o3') || id.startsWith('openai/')) {
    return 'openai';
  }
  if (leaf.startsWith('llama') || id.includes('meta-llama/')) return 'meta_llama';
  if (leaf.startsWith('qwen') || id.includes('qwen/')) return 'qwen';
  return 'other';
}

/**
 * Returns a mismatch when the model family is known to be unusable on the
 * configured host. OpenRouter accepts namespaced ids from many families, so
 * it never mismatches here. Unknown hosts are skipped (custom proxies).
 */
export function findProviderModelMismatch(
  baseUrl: string,
  models: readonly string[],
): ProviderModelMismatch | null {
  const providerFamily = classifyProviderHost(baseUrl);
  if (providerFamily === 'unknown' || providerFamily === 'openrouter') {
    return null;
  }

  for (const model of models) {
    if (!model || !model.trim()) continue;
    const modelFamily = classifyModelId(model);
    if (providerFamily === 'openai' && modelFamily !== 'openai' && modelFamily !== 'other') {
      return {
        providerHost: hostFromBaseUrl(baseUrl),
        providerFamily,
        model,
        modelFamily,
        reason:
          `Model "${model}" (${modelFamily}) is not served by ${hostFromBaseUrl(baseUrl)}. ` +
          'Set AI_*_MODEL to OpenAI ids (e.g. gpt-4o-mini) or point AI_PROVIDER_BASE_URL at ' +
          'OpenRouter/Anthropic. See docs/runbooks/live-ai-restore.md.',
      };
    }
    if (providerFamily === 'anthropic' && modelFamily !== 'anthropic' && modelFamily !== 'other') {
      return {
        providerHost: hostFromBaseUrl(baseUrl),
        providerFamily,
        model,
        modelFamily,
        reason:
          `Model "${model}" (${modelFamily}) is not served by ${hostFromBaseUrl(baseUrl)}. ` +
          'Use Claude model ids or change AI_PROVIDER_BASE_URL.',
      };
    }
  }
  return null;
}
