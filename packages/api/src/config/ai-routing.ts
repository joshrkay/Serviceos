export type ModelTier = 'lightweight' | 'standard' | 'complex';

export interface TierConfig {
  model: string;
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
  },
};
