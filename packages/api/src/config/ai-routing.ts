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

export const DEFAULT_AI_ROUTING_CONFIG: AIRoutingConfig = {
  tiers: {
    lightweight: { model: 'claude-haiku-4-5-20251001', provider: 'default', maxTokens: 1024, temperature: 0 },
    standard: { model: 'claude-sonnet-4-6', provider: 'default', maxTokens: 4096, temperature: 0.3 },
    complex: { model: 'claude-sonnet-4-6', provider: 'default', maxTokens: 8192, temperature: 0.5 },
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
