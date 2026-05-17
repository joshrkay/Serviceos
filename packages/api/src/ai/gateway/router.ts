import { AIRoutingConfig, ModelTier, TierConfig, DEFAULT_AI_ROUTING_CONFIG } from '../../config/ai-routing';
import { LLMRequest } from './gateway';

/** Tracks which unmapped taskTypes have already logged a warning (warn-once per process). */
const warnedTaskTypes = new Set<string>();

/**
 * Reset the warn-once tracker. Exposed for test isolation — call in beforeEach
 * when testing unmapped-taskType warning behaviour.
 */
export function clearUnmappedTaskTypeWarnings(): void {
  warnedTaskTypes.clear();
}

/**
 * Returns whether a warning should be emitted for this taskType (and records it).
 * Returns true only the first time a given taskType is seen as unmapped.
 */
export function shouldWarnForUnmappedTaskType(taskType: string): boolean {
  if (warnedTaskTypes.has(taskType)) return false;
  warnedTaskTypes.add(taskType);
  return true;
}

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

export interface RoutingDecision {
  resolvedTier: ModelTier;
  resolvedModel: string;
  overrideSource: 'request' | 'tenant' | 'default';
  maxTokens?: number;
  temperature?: number;
}

/**
 * Resolve model and tier from the request, applying tenant overrides when present.
 *
 * Override precedence (highest to lowest):
 * 1. Caller-supplied `request.model` → overrideSource = 'request'
 * 2. Tenant override config         → overrideSource = 'tenant'
 * 3. DEFAULT_AI_ROUTING_CONFIG      → overrideSource = 'default'
 */
export function resolveRouting(
  request: LLMRequest,
  tenantRoutingConfig?: Partial<AIRoutingConfig>
): RoutingDecision {
  const activeConfig = tenantRoutingConfig
    ? mergeTenantRouting(DEFAULT_AI_ROUTING_CONFIG, tenantRoutingConfig)
    : DEFAULT_AI_ROUTING_CONFIG;

  const tier = getTaskTier(request.taskType, activeConfig);
  const tierConfig = activeConfig.tiers[tier];

  // Caller override wins
  if (request.model) {
    return {
      resolvedTier: tier,
      resolvedModel: request.model,
      overrideSource: 'request',
      maxTokens: request.maxTokens ?? tierConfig.maxTokens,
      temperature: request.temperature ?? tierConfig.temperature,
    };
  }

  // Tenant override wins over default
  const source: 'tenant' | 'default' = tenantRoutingConfig ? 'tenant' : 'default';
  return {
    resolvedTier: tier,
    resolvedModel: tierConfig.model,
    overrideSource: source,
    maxTokens: request.maxTokens ?? tierConfig.maxTokens,
    temperature: request.temperature ?? tierConfig.temperature,
  };
}

/**
 * Merge a tenant's partial AIRoutingConfig over the base config.
 *
 * - If the tenant supplies `tiers`, each tier entry in the override completely
 *   replaces the corresponding tier in base (per-tier, not per-field).
 * - If the tenant supplies `taskTierMapping`, individual entries are merged
 *   so tenants only need to specify the mappings they want to change.
 */
export function mergeTenantRouting(
  base: AIRoutingConfig,
  override: Partial<AIRoutingConfig>
): AIRoutingConfig {
  return {
    tiers: override.tiers
      ? { ...base.tiers, ...override.tiers }
      : base.tiers,
    taskTierMapping: override.taskTierMapping
      ? { ...base.taskTierMapping, ...override.taskTierMapping }
      : base.taskTierMapping,
  };
}
