export type ModelTier = 'lightweight' | 'standard' | 'complex';

export interface TierConfig {
  model: string;
  /**
   * Currently unused — provider selection comes from `LLMGatewayConfig.taskRouting`.
   * Reserved for future use (P2-029 failover/provider routing will wire this).
   */
  provider: string;
  maxTokens?: number;
  temperature?: number;
}

export interface AIRoutingConfig {
  tiers: Record<ModelTier, TierConfig>;
  taskTierMapping: Record<string, ModelTier>;
}

// Model identifiers are read from environment variables so they can be
// updated without a code deploy. Defaults use Anthropic Claude models.
const lightweightModel = process.env.AI_LIGHTWEIGHT_MODEL || 'claude-haiku-4-5-20251001';
const standardModel = process.env.AI_STANDARD_MODEL || 'claude-sonnet-4-6';
const complexModel = process.env.AI_COMPLEX_MODEL || 'claude-sonnet-4-6';

export const DEFAULT_AI_ROUTING_CONFIG: AIRoutingConfig = {
  tiers: {
    lightweight: { model: lightweightModel, provider: 'default', maxTokens: 1024, temperature: 0 },
    standard: { model: standardModel, provider: 'default', maxTokens: 4096, temperature: 0.3 },
    complex: { model: complexModel, provider: 'default', maxTokens: 8192, temperature: 0.5 },
  },
  taskTierMapping: {
    // Lightweight
    'intent_classification': 'lightweight',
    'entity_extraction': 'lightweight',
    'transcript_normalization': 'lightweight',
    // Standard
    'create_customer': 'standard',
    'update_customer': 'standard',
    'create_job': 'standard',
    'create_appointment': 'standard',
    'clarification': 'standard',
    // Complex
    'draft_estimate': 'complex',
    'update_estimate': 'complex',
    'multi_entity_proposal': 'complex',
    // Vision (MMS-to-quote): MUST stay on a vision-capable tier. Unmapped it
    // falls through to `standard`, which only works while that tier's model is
    // vision-capable — an AI_STANDARD_MODEL override to a text model would trip
    // the gateway's vision failfast. Pinning to complex removes that footgun.
    'mms_estimate': 'complex',
  },
};

/**
 * Models known to accept image content parts. Env-overridable so ops can
 * update the set without a deploy: AI_VISION_CAPABLE_MODELS is a
 * comma-separated list merged with these defaults. Matching is
 * case-insensitive and also matches a provider-namespaced id (e.g.
 * "openai/gpt-4o" or "openrouter/openai/gpt-4o" → "gpt-4o").
 */
const DEFAULT_VISION_CAPABLE_MODELS: readonly string[] = [
  'claude-sonnet-4-6',
  'claude-haiku-4-5-20251001',
  'gpt-4o',
  'gpt-4o-mini',
];

function visionCapableModelSet(): string[] {
  const fromEnv = (process.env.AI_VISION_CAPABLE_MODELS ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  return [...DEFAULT_VISION_CAPABLE_MODELS.map((m) => m.toLowerCase()), ...fromEnv];
}

/**
 * Whether the resolved model can accept image inputs. Compares on the last
 * path segment so a provider namespace is ignored ("openai/gpt-4o" → "gpt-4o"),
 * and treats a dated/versioned snapshot as the base family
 * ("gpt-4o-2024-08-06", "gpt-4o-mini-2024-07-18" → capable). Matching a base
 * family (e.g. "gpt-4o") therefore also covers its dated variants.
 */
export function isVisionCapableModel(model: string): boolean {
  if (!model) return false;
  const lastSegment = (id: string): string => id.toLowerCase().split('/').pop() ?? '';
  const m = lastSegment(model);
  return visionCapableModelSet().some((cap) => {
    const c = lastSegment(cap);
    return m === c || m.startsWith(`${c}-`);
  });
}
