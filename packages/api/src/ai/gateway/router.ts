import { AIRoutingConfig, ModelTier, TierConfig, DEFAULT_AI_ROUTING_CONFIG } from '../../config/ai-routing';
import { LLMRequest } from './gateway';

export function resolveModelForTask(taskType: string, config?: AIRoutingConfig): TierConfig {
  const routingConfig = config || DEFAULT_AI_ROUTING_CONFIG;
  const tier = routingConfig.taskTierMapping[taskType] || 'standard'; // default to standard
  return routingConfig.tiers[tier];
}

export function getTaskTier(taskType: string, config?: AIRoutingConfig): ModelTier {
  const routingConfig = config || DEFAULT_AI_ROUTING_CONFIG;
  return routingConfig.taskTierMapping[taskType] || 'standard';
}

export function enrichRequestWithRouting(request: LLMRequest, config?: AIRoutingConfig): LLMRequest {
  const tierConfig = resolveModelForTask(request.taskType, config);
  return {
    ...request,
    model: request.model || tierConfig.model,
    maxTokens: request.maxTokens ?? tierConfig.maxTokens,
    temperature: request.temperature ?? tierConfig.temperature,
  };
}
