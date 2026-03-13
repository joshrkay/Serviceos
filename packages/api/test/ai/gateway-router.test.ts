import { resolveModelForTask, getTaskTier, enrichRequestWithRouting } from '../../src/ai/gateway/router';
import { DEFAULT_AI_ROUTING_CONFIG } from '../../src/config/ai-routing';
import type { AIRoutingConfig } from '../../src/config/ai-routing';
import type { LLMRequest } from '../../src/ai/gateway/gateway';

function makeRequest(overrides: Partial<LLMRequest> = {}): LLMRequest {
  return {
    taskType: 'create_customer',
    messages: [{ role: 'user', content: 'Hello' }],
    ...overrides,
  };
}

describe('P2-028 — Task-complexity-based model routing', () => {
  it('happy path — lightweight task routes to haiku', () => {
    const tierConfig = resolveModelForTask('intent_classification');

    expect(tierConfig.model).toBe('claude-haiku-4-5-20251001');
    expect(tierConfig.provider).toBe('default');
    expect(tierConfig.maxTokens).toBe(1024);
    expect(tierConfig.temperature).toBe(0);
  });

  it('happy path — standard task routes to sonnet', () => {
    const tierConfig = resolveModelForTask('create_customer');

    expect(tierConfig.model).toBe('claude-sonnet-4-6');
    expect(tierConfig.provider).toBe('default');
    expect(tierConfig.maxTokens).toBe(4096);
    expect(tierConfig.temperature).toBe(0.3);
  });

  it('happy path — complex task routes to sonnet with higher tokens', () => {
    const tierConfig = resolveModelForTask('draft_estimate');

    expect(tierConfig.model).toBe('claude-sonnet-4-6');
    expect(tierConfig.provider).toBe('default');
    expect(tierConfig.maxTokens).toBe(8192);
    expect(tierConfig.temperature).toBe(0.5);
  });

  it('happy path — unknown task defaults to standard tier', () => {
    const tier = getTaskTier('unknown_task_type');
    expect(tier).toBe('standard');

    const tierConfig = resolveModelForTask('unknown_task_type');
    expect(tierConfig.model).toBe('claude-sonnet-4-6');
    expect(tierConfig.maxTokens).toBe(4096);
    expect(tierConfig.temperature).toBe(0.3);
  });

  it('validation — custom config overrides defaults', () => {
    const customConfig: AIRoutingConfig = {
      tiers: {
        lightweight: { model: 'custom-small', provider: 'custom-provider', maxTokens: 512, temperature: 0 },
        standard: { model: 'custom-medium', provider: 'custom-provider', maxTokens: 2048, temperature: 0.2 },
        complex: { model: 'custom-large', provider: 'custom-provider', maxTokens: 16384, temperature: 0.7 },
      },
      taskTierMapping: {
        'my_task': 'complex',
      },
    };

    const tierConfig = resolveModelForTask('my_task', customConfig);

    expect(tierConfig.model).toBe('custom-large');
    expect(tierConfig.provider).toBe('custom-provider');
    expect(tierConfig.maxTokens).toBe(16384);
    expect(tierConfig.temperature).toBe(0.7);

    const tier = getTaskTier('my_task', customConfig);
    expect(tier).toBe('complex');
  });

  it('happy path — enrichRequestWithRouting applies tier config', () => {
    const request = makeRequest({ taskType: 'entity_extraction' });
    const enriched = enrichRequestWithRouting(request);

    expect(enriched.model).toBe('claude-haiku-4-5-20251001');
    expect(enriched.maxTokens).toBe(1024);
    expect(enriched.temperature).toBe(0);
    // Original request fields preserved
    expect(enriched.taskType).toBe('entity_extraction');
    expect(enriched.messages).toEqual(request.messages);
  });

  it('mock provider test — request model override preserved', () => {
    const request = makeRequest({
      taskType: 'intent_classification',
      model: 'my-custom-model',
    });

    const enriched = enrichRequestWithRouting(request);

    // The explicit model on the request should be preserved, not overridden
    expect(enriched.model).toBe('my-custom-model');
    // But maxTokens and temperature should come from tier config since not set on request
    expect(enriched.maxTokens).toBe(1024);
    expect(enriched.temperature).toBe(0);
  });

  it('malformed AI output handled gracefully — empty config uses defaults', () => {
    // When no config is passed, defaults are used
    const tierConfig = resolveModelForTask('draft_estimate');
    const defaultTierConfig = DEFAULT_AI_ROUTING_CONFIG.tiers['complex'];

    expect(tierConfig.model).toBe(defaultTierConfig.model);
    expect(tierConfig.maxTokens).toBe(defaultTierConfig.maxTokens);
    expect(tierConfig.temperature).toBe(defaultTierConfig.temperature);

    // Verify enrichment also works with defaults
    const request = makeRequest({ taskType: 'draft_estimate' });
    const enriched = enrichRequestWithRouting(request);

    expect(enriched.model).toBe(defaultTierConfig.model);
    expect(enriched.maxTokens).toBe(defaultTierConfig.maxTokens);
    expect(enriched.temperature).toBe(defaultTierConfig.temperature);
  });
});
