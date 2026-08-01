/**
 * Per-call LLM cost accounting in the production gateway (gateway.ts +
 * model-pricing.ts): response.costMicroCents, the persisted
 * ai_runs.cost_micro_cents value, and the Prometheus
 * gateway_request_cost_micro_cents_total counter.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { LLMGateway } from '../../../src/ai/gateway/gateway';
import type { LLMProvider, LLMRequest, LLMGatewayConfig } from '../../../src/ai/gateway/gateway';
import { StubProvider } from '../../../src/ai/gateway/providers';
import { InMemoryAiRunRepository } from '../../../src/ai/ai-run';
import { metricsRegistry, gatewayRequestCostMicroCentsTotal } from '../../../src/monitoring/metrics';

function makeRequest(overrides: Partial<LLMRequest> = {}): LLMRequest {
  return {
    taskType: 'summarize_conversation',
    messages: [{ role: 'user', content: 'Hello' }],
    tenantId: 'tenant-1',
    ...overrides,
  };
}

function makeGateway(
  providers: Map<string, LLMProvider>,
  config: Partial<LLMGatewayConfig> = {},
  aiRunRepo?: InMemoryAiRunRepository
): LLMGateway {
  const fullConfig: LLMGatewayConfig = {
    defaultProvider: 'stub',
    ...config,
  };
  return new LLMGateway(fullConfig, providers, undefined, aiRunRepo);
}

describe('gateway.complete() — per-call cost accounting', () => {
  afterEach(() => {
    metricsRegistry.resetMetrics();
  });

  it('computes costMicroCents on the response for a known-priced model', async () => {
    const stub = new StubProvider('stub');
    stub.setResponse({ content: 'ok', tokenUsage: { input: 500, output: 200, total: 700 } });
    const providers = new Map<string, LLMProvider>([['stub', stub]]);
    const gateway = makeGateway(providers);

    const response = await gateway.complete(
      makeRequest({ model: 'claude-sonnet-4-6', tenantId: 'tenant-1' })
    );

    // claude-sonnet-4-6: 300 cents/M input, 1500 cents/M output.
    // 500 * 300 + 200 * 1500 = 150,000 + 300,000 = 450,000 micro-cents.
    expect(response.costMicroCents).toBe(450_000);
  });

  it('persists costMicroCents on the completed ai_runs row', async () => {
    const aiRunRepo = new InMemoryAiRunRepository();
    const stub = new StubProvider('stub');
    stub.setResponse({ content: 'ok', tokenUsage: { input: 500, output: 200, total: 700 } });
    const providers = new Map<string, LLMProvider>([['stub', stub]]);
    const gateway = makeGateway(providers, {}, aiRunRepo);

    await gateway.complete(
      makeRequest({ model: 'claude-sonnet-4-6', tenantId: 'tenant-1', taskType: 'summarize_conversation' })
    );

    const runs = await aiRunRepo.findByTaskType('tenant-1', 'summarize_conversation');
    expect(runs).toHaveLength(1);
    expect(runs[0].status).toBe('completed');
    expect(runs[0].costMicroCents).toBe(450_000);
    // Non-failover run: model on the row stays the resolved/requested model.
    expect(runs[0].model).toBe('claude-sonnet-4-6');
  });

  it('increments gateway_request_cost_micro_cents_total with the documented labels', async () => {
    const stub = new StubProvider('stub');
    stub.setResponse({ content: 'ok', tokenUsage: { input: 1000, output: 0, total: 1000 } });
    const providers = new Map<string, LLMProvider>([['stub', stub]]);
    const gateway = makeGateway(providers);

    await gateway.complete(
      makeRequest({
        model: 'claude-sonnet-4-6',
        tenantId: 'tenant-1',
        tenantTier: 'premium',
        taskType: 'summarize_conversation',
      })
    );

    // 1000 input tokens * 300 cents/M = 300,000 micro-cents; 0 output.
    const value = await gatewayRequestCostMicroCentsTotal.get();
    const sample = value.values.find(
      (v) =>
        v.labels.tenant_tier === 'premium' &&
        v.labels.task_type === 'summarize_conversation' &&
        v.labels.model === 'claude-sonnet-4-6' &&
        v.labels.provider === 'stub'
    );
    expect(sample).toBeDefined();
    expect(sample?.value).toBe(300_000);
  });

  it('accumulates across multiple calls for the same label set (never rounds per-call)', async () => {
    const stub = new StubProvider('stub');
    // 1 input token = 100 micro-cents on Haiku 4.5 (100 cents/M) — a
    // sub-cent amount that would round to 0 if accumulated as whole cents.
    stub.setResponse({ content: 'ok', tokenUsage: { input: 1, output: 0, total: 1 } });
    const providers = new Map<string, LLMProvider>([['stub', stub]]);
    const gateway = makeGateway(providers);

    for (let i = 0; i < 5; i++) {
      await gateway.complete(
        makeRequest({ model: 'claude-haiku-4-5-20251001', tenantId: 'tenant-1', taskType: 'classify_intent' })
      );
    }

    const value = await gatewayRequestCostMicroCentsTotal.get();
    const sample = value.values.find(
      (v) => v.labels.task_type === 'classify_intent' && v.labels.model === 'claude-haiku-4-5-20251001'
    );
    expect(sample?.value).toBe(500); // 5 calls * 100 micro-cents, exact
  });

  it('does not fabricate a cost for an unpriced model — null on response, no counter increment, null on ai_runs', async () => {
    const aiRunRepo = new InMemoryAiRunRepository();
    const stub = new StubProvider('stub');
    stub.setResponse({ content: 'ok', tokenUsage: { input: 500, output: 200, total: 700 } });
    const providers = new Map<string, LLMProvider>([['stub', stub]]);
    const gateway = makeGateway(providers, {}, aiRunRepo);

    const response = await gateway.complete(
      makeRequest({ model: 'gpt-4o-mini', tenantId: 'tenant-1', taskType: 'summarize_conversation' })
    );

    expect(response.costMicroCents).toBeNull();

    const runs = await aiRunRepo.findByTaskType('tenant-1', 'summarize_conversation');
    expect(runs[0].costMicroCents).toBeNull();

    const value = await gatewayRequestCostMicroCentsTotal.get();
    const sample = value.values.find((v) => v.labels.model === 'gpt-4o-mini');
    expect(sample).toBeUndefined();
  });

  it('does not record cost on the error path (no tokenUsage to price)', async () => {
    const aiRunRepo = new InMemoryAiRunRepository();
    const failingProvider: LLMProvider = {
      name: 'failing',
      async complete() {
        throw new Error('boom');
      },
      async isAvailable() {
        return true;
      },
    };
    const providers = new Map<string, LLMProvider>([['failing', failingProvider]]);
    const gateway = makeGateway(providers, { defaultProvider: 'failing' }, aiRunRepo);

    await expect(
      gateway.complete(
        makeRequest({ model: 'claude-sonnet-4-6', tenantId: 'tenant-1', taskType: 'summarize_conversation' })
      )
    ).rejects.toThrow();

    const runs = await aiRunRepo.findByTaskType('tenant-1', 'summarize_conversation');
    expect(runs[0].status).toBe('failed');
    expect(runs[0].costMicroCents).toBeUndefined();

    const value = await gatewayRequestCostMicroCentsTotal.get();
    expect(value.values.find((v) => v.labels.model === 'claude-sonnet-4-6')).toBeUndefined();
  });

  // A provider whose response reports a DIFFERENT model/provider than the
  // request resolved to — the shape the resilience layer produces after a
  // cheaper-model or fallback-provider failover.
  function failoverProvider(actualModel: string, actualProvider = 'fallback'): LLMProvider {
    return {
      name: 'primary',
      async complete(req: LLMRequest) {
        return {
          content: 'ok',
          model: actualModel,
          provider: actualProvider,
          tokenUsage: { input: 500, output: 200, total: 700 },
          latencyMs: 1,
        };
      },
      async isAvailable() {
        return true;
      },
    };
  }

  it('prices a failover by the model that actually ran, not the resolved route', async () => {
    // Route resolves to Sonnet (300/1500 c/M) but the call fails over to
    // Haiku (100/500 c/M): cost must be Haiku's, not Sonnet's.
    const providers = new Map<string, LLMProvider>([
      ['primary', failoverProvider('claude-haiku-4-5-20251001', 'openai-compat')],
    ]);
    const gateway = makeGateway(providers, { defaultProvider: 'primary' });

    const response = await gateway.complete(
      makeRequest({ model: 'claude-sonnet-4-6', tenantId: 'tenant-1' })
    );

    // Haiku: 500 * 100 + 200 * 500 = 50,000 + 100,000 = 150,000 micro-cents
    // (NOT the Sonnet figure of 450,000).
    expect(response.costMicroCents).toBe(150_000);
    const value = await gatewayRequestCostMicroCentsTotal.get();
    const haikuRow = value.values.find(
      (v) => v.labels.model === 'claude-haiku-4-5-20251001'
    );
    expect(haikuRow?.value).toBe(150_000);
    // Never attributed to the un-served Sonnet route.
    expect(value.values.find((v) => v.labels.model === 'claude-sonnet-4-6')).toBeUndefined();
  });

  it('persists the post-failover serving model on the ai_runs row, not the resolved route', async () => {
    // ai_runs.model is written as 'claude-sonnet-4-6' at create() time (the
    // resolved route), before the primary call fails over to Haiku. The
    // completion update must overwrite it with the model costMicroCents was
    // actually priced at — otherwise per-model spend aggregations over
    // ai_runs misattribute failover traffic to Sonnet's rate.
    const aiRunRepo = new InMemoryAiRunRepository();
    const providers = new Map<string, LLMProvider>([
      ['primary', failoverProvider('claude-haiku-4-5-20251001', 'openai-compat')],
    ]);
    const gateway = makeGateway(providers, { defaultProvider: 'primary' }, aiRunRepo);

    await gateway.complete(
      makeRequest({
        model: 'claude-sonnet-4-6',
        tenantId: 'tenant-1',
        taskType: 'summarize_conversation',
      })
    );

    const runs = await aiRunRepo.findByTaskType('tenant-1', 'summarize_conversation');
    expect(runs).toHaveLength(1);
    expect(runs[0].costMicroCents).toBe(150_000);
    expect(runs[0].model).toBe('claude-haiku-4-5-20251001');
  });

  it('records cost when an unpriced route fails over to a priced model', async () => {
    // Resolved route is an unpriced model; the failover lands on a priced
    // one, so cost is non-null (was recorded as null before the fix).
    const providers = new Map<string, LLMProvider>([
      ['primary', failoverProvider('claude-haiku-4-5-20251001')],
    ]);
    const gateway = makeGateway(providers, { defaultProvider: 'primary' });

    const response = await gateway.complete(
      makeRequest({ model: 'some-unpriced-model', tenantId: 'tenant-1' })
    );

    expect(response.costMicroCents).toBe(150_000);
  });
});
