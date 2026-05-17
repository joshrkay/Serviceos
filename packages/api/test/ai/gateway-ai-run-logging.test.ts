/**
 * P2-027 Gap 1 — AI-run logging in LLMGateway.complete()
 *
 * Tests that every gateway.complete() call writes an ai_runs row through
 * AiRunRepository: pending → running → completed/failed with correct fields.
 */

import { LLMGateway } from '../../src/ai/gateway/gateway';
import type { LLMProvider, LLMRequest, LLMResponse, LLMGatewayConfig } from '../../src/ai/gateway/gateway';
import { StubProvider } from '../../src/ai/gateway/providers';
import { InMemoryAiRunRepository } from '../../src/ai/ai-run';

function makeRequest(overrides: Partial<LLMRequest> = {}): LLMRequest {
  return {
    taskType: 'summarize',
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
    defaultModel: 'test-model',
    ...config,
  };
  return new LLMGateway(fullConfig, providers, undefined, aiRunRepo);
}

describe('P2-027 Gap 1 — gateway AI-run logging', () => {
  it('writes a pending then completed AiRun on success', async () => {
    const aiRunRepo = new InMemoryAiRunRepository();
    const stub = new StubProvider('stub');
    stub.setResponse({
      content: 'result',
      tokenUsage: { input: 10, output: 5, total: 15 },
    });

    const providers = new Map<string, LLMProvider>();
    providers.set('stub', stub);
    const gateway = makeGateway(providers, {}, aiRunRepo);

    await gateway.complete(makeRequest({ taskType: 'summarize', tenantId: 'tenant-1' }));

    const runs = await aiRunRepo.findByTaskType('tenant-1', 'summarize');
    expect(runs).toHaveLength(1);
    expect(runs[0].status).toBe('completed');
    expect(runs[0].taskType).toBe('summarize');
    expect(runs[0].tokenUsage?.total).toBe(15);
    expect(runs[0].durationMs).toBeGreaterThanOrEqual(0);
  });

  it('writes a failed AiRun with errorMessage on provider error', async () => {
    const aiRunRepo = new InMemoryAiRunRepository();
    const failingProvider: LLMProvider = {
      name: 'failing',
      async complete() {
        throw new Error('Connection timeout');
      },
      async isAvailable() {
        return true;
      },
    };

    const providers = new Map<string, LLMProvider>();
    providers.set('failing', failingProvider);
    const gateway = makeGateway(providers, { defaultProvider: 'failing' }, aiRunRepo);

    await expect(
      gateway.complete(makeRequest({ taskType: 'summarize', tenantId: 'tenant-2' }))
    ).rejects.toThrow();

    const runs = await aiRunRepo.findByTaskType('tenant-2', 'summarize');
    expect(runs).toHaveLength(1);
    expect(runs[0].status).toBe('failed');
    expect(runs[0].errorMessage).toContain('Connection timeout');
  });

  it('propagates correlationId from request to AiRun row', async () => {
    const aiRunRepo = new InMemoryAiRunRepository();
    const stub = new StubProvider('stub');
    const providers = new Map<string, LLMProvider>();
    providers.set('stub', stub);
    const gateway = makeGateway(providers, {}, aiRunRepo);

    const correlationId = 'corr-id-abc-123';
    await gateway.complete(
      makeRequest({ taskType: 'summarize', tenantId: 'tenant-3', metadata: { correlationId } })
    );

    const runs = await aiRunRepo.findByTaskType('tenant-3', 'summarize');
    expect(runs).toHaveLength(1);
    expect(runs[0].correlationId).toBe(correlationId);
  });

  it('records the resolved model (not request override placeholder) on AiRun', async () => {
    const aiRunRepo = new InMemoryAiRunRepository();
    const stub = new StubProvider('stub');
    stub.setResponse({ content: 'ok', model: 'resolved-model' });
    const providers = new Map<string, LLMProvider>();
    providers.set('stub', stub);
    const gateway = makeGateway(
      providers,
      { defaultModel: 'resolved-model' },
      aiRunRepo
    );

    await gateway.complete(makeRequest({ taskType: 'summarize', tenantId: 'tenant-4' }));

    const runs = await aiRunRepo.findByTaskType('tenant-4', 'summarize');
    expect(runs).toHaveLength(1);
    // Should record the resolved model (defaultModel when no override), not undefined
    expect(runs[0].model).toBe('resolved-model');
  });

  it('does not fail the LLM call if AiRun repository write fails', async () => {
    // Repo that always throws on create
    const brokenRepo = new InMemoryAiRunRepository();
    (brokenRepo as any).create = async () => {
      throw new Error('DB connection lost');
    };

    const stub = new StubProvider('stub');
    stub.setResponse({ content: 'still works', tokenUsage: { input: 1, output: 1, total: 2 } });
    const providers = new Map<string, LLMProvider>();
    providers.set('stub', stub);
    const gateway = makeGateway(providers, {}, brokenRepo);

    // Should NOT throw despite the repo being broken
    const response = await gateway.complete(makeRequest({ tenantId: 'tenant-5' }));
    expect(response.content).toBe('still works');
  });

  it('works without an aiRunRepo (backward compat — no 4th arg)', async () => {
    const stub = new StubProvider('stub');
    stub.setResponse({ content: 'no repo', tokenUsage: { input: 1, output: 1, total: 2 } });
    const providers = new Map<string, LLMProvider>();
    providers.set('stub', stub);

    const config: LLMGatewayConfig = { defaultProvider: 'stub', defaultModel: 'test-model' };
    const gateway = new LLMGateway(config, providers);

    const response = await gateway.complete(makeRequest());
    expect(response.content).toBe('no repo');
  });
});
