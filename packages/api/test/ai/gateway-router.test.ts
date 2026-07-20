import { resolveModelForTask, getTaskTier, enrichRequestWithRouting } from '../../src/ai/gateway/router';
import { DEFAULT_AI_ROUTING_CONFIG, TASK_TYPES } from '../../src/config/ai-routing';
import type { AIRoutingConfig } from '../../src/config/ai-routing';
import type { LLMRequest } from '../../src/ai/gateway/gateway';

function makeRequest(overrides: Partial<LLMRequest> = {}): LLMRequest {
  return {
    taskType: 'create_appointment',
    messages: [{ role: 'user', content: 'Hello' }],
    ...overrides,
  };
}

describe('P2-028 — Task-complexity-based model routing', () => {
  it('happy path — lightweight task routes to llama 8b', () => {
    const tierConfig = resolveModelForTask('intent_classification');

    expect(tierConfig.model).toBe('meta-llama/llama-3.1-8b-instruct');
    expect(tierConfig.maxTokens).toBe(1024);
    expect(tierConfig.temperature).toBe(0);
  });

  it('happy path — standard task routes to llama 70b', () => {
    const tierConfig = resolveModelForTask('create_appointment');

    expect(tierConfig.model).toBe('meta-llama/llama-3.3-70b-instruct');
    expect(tierConfig.maxTokens).toBe(4096);
    expect(tierConfig.temperature).toBe(0.3);
  });

  it('happy path — complex task routes to qwen 72b with higher tokens', () => {
    const tierConfig = resolveModelForTask('draft_estimate');

    expect(tierConfig.model).toBe('qwen/qwen-2.5-72b-instruct');
    expect(tierConfig.maxTokens).toBe(8192);
    expect(tierConfig.temperature).toBe(0.5);
  });

  it('happy path — unknown task defaults to standard tier', () => {
    const tier = getTaskTier('unknown_task_type');
    expect(tier).toBe('standard');

    const tierConfig = resolveModelForTask('unknown_task_type');
    expect(tierConfig.model).toBe('meta-llama/llama-3.3-70b-instruct');
    expect(tierConfig.maxTokens).toBe(4096);
    expect(tierConfig.temperature).toBe(0.3);
  });

  it('validation — custom config overrides defaults', () => {
    const customConfig: AIRoutingConfig = {
      tiers: {
        lightweight: { model: 'custom-small', maxTokens: 512, temperature: 0 },
        standard: { model: 'custom-medium', maxTokens: 2048, temperature: 0.2 },
        complex: { model: 'custom-large', maxTokens: 16384, temperature: 0.7 },
      },
      taskTierMapping: {
        'my_task': 'complex',
      },
    };

    const tierConfig = resolveModelForTask('my_task', customConfig);

    expect(tierConfig.model).toBe('custom-large');
    expect(tierConfig.maxTokens).toBe(16384);
    expect(tierConfig.temperature).toBe(0.7);

    const tier = getTaskTier('my_task', customConfig);
    expect(tier).toBe('complex');
  });

  it('happy path — enrichRequestWithRouting applies tier config', () => {
    const request = makeRequest({ taskType: 'classify_intent' });
    const enriched = enrichRequestWithRouting(request);

    expect(enriched.model).toBe('meta-llama/llama-3.1-8b-instruct');
    expect(enriched.maxTokens).toBe(1024);
    expect(enriched.temperature).toBe(0);
    // Original request fields preserved
    expect(enriched.taskType).toBe('classify_intent');
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

describe('P2-028 — taskTierMapping reconciliation (follow-up #2)', () => {
  const mapping = DEFAULT_AI_ROUTING_CONFIG.taskTierMapping;

  it('maps exactly the canonical gateway taskTypes — no dead keys, no gaps', () => {
    // The mapping must cover precisely the taskTypes that reach the gateway,
    // guarding against the historical drift (idealized keys matching no call
    // site) from recurring.
    expect(Object.keys(mapping).sort()).toEqual([...TASK_TYPES].sort());
  });

  it('drops the idealized keys that matched no real call site', () => {
    for (const dead of [
      'entity_extraction',
      'transcript_normalization',
      'clarification',
      'create_customer',
      'update_customer',
      'create_job',
      'multi_entity_proposal',
    ]) {
      expect(mapping).not.toHaveProperty(dead);
    }
  });

  it('routes the hot-path cheap tasks to lightweight (the cost win)', () => {
    for (const t of [
      'classify_intent',
      'decompose_transcript',
      'summarize_conversation',
      'generate_clarification_questions',
      'transcription_correction',
    ]) {
      expect(getTaskTier(t)).toBe('lightweight');
    }
  });

  it('fixes the classify_intent vs intent_classification naming split', () => {
    // The live intent-classifier.ts call site emits `classify_intent`; the old
    // mapping only had `intent_classification` (used solely by the onboarding
    // self-check), so the hot path silently ran on standard.
    expect(mapping).toHaveProperty('classify_intent');
    expect(getTaskTier('classify_intent')).toBe('lightweight');
  });

  it('keeps financial + vision tasks on complex', () => {
    for (const t of ['draft_estimate', 'update_estimate', 'draft_invoice', 'update_invoice', 'mms_estimate']) {
      expect(getTaskTier(t)).toBe('complex');
    }
  });

  it('keeps customer-facing writing on standard', () => {
    for (const t of ['suggest_reply', 'brand_voice_v1', 'review_private_followup', 'review_public_response', 'create_appointment']) {
      expect(getTaskTier(t)).toBe('standard');
    }
  });

  it('lets dynamic assistant.* taskTypes fall through to standard', () => {
    expect(getTaskTier('assistant.chain')).toBe('standard');
    expect(getTaskTier('assistant.query.unpaid_invoices')).toBe('standard');
  });
});
