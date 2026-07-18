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

  it('records the caller-resolved model at creation (P2-028 routing)', async () => {
    const aiRunRepo = new InMemoryAiRunRepository();
    const stub = new StubProvider('stub');
    stub.setResponse({ content: 'ok' });
    const providers = new Map<string, LLMProvider>();
    providers.set('stub', stub);
    const gateway = makeGateway(providers, {}, aiRunRepo);

    await gateway.complete(
      makeRequest({ taskType: 'summarize', tenantId: 'tenant-4', model: 'caller-resolved-model' })
    );

    const runs = await aiRunRepo.findByTaskType('tenant-4', 'summarize');
    expect(runs).toHaveLength(1);
    // With P2-028, caller-supplied request.model wins over tier routing at
    // create() time; the provider here doesn't echo a different model, so
    // the completion update leaves it as the resolved route.
    expect(runs[0].model).toBe('caller-resolved-model');
  });

  it('overwrites the AiRun model with the provider-echoed serving model on completion', async () => {
    // Bug fix: ai_runs rows were created with model: resolvedModel and never
    // updated, while costMicroCents is computed from the ACTUAL serving
    // model (response.model, which the resilience layer rewrites on a
    // cheaper-model or fallback-provider failover). That let a Sonnet ->
    // Haiku failover persist model='sonnet' with Haiku-priced cost,
    // misattributing spend in per-model aggregations over ai_runs. The
    // completion update must now record the same model the cost was priced
    // at — response.model when the provider supplies one.
    //
    // NB: StubProvider deliberately echoes back `request.model` when the
    // caller supplies one (see providers.ts), so it can't exercise a
    // provider that serves a genuinely different model than requested —
    // exactly the failover shape this test needs. Use a bare LLMProvider
    // instead, mirroring cost-accounting.test.ts's `failoverProvider`.
    const aiRunRepo = new InMemoryAiRunRepository();
    const failoverLikeProvider: LLMProvider = {
      name: 'primary',
      async complete() {
        return {
          content: 'ok',
          model: 'provider-echoed-model',
          provider: 'fallback',
          latencyMs: 1,
        };
      },
      async isAvailable() {
        return true;
      },
    };
    const providers = new Map<string, LLMProvider>();
    providers.set('primary', failoverLikeProvider);
    const gateway = makeGateway(providers, { defaultProvider: 'primary' }, aiRunRepo);

    await gateway.complete(
      makeRequest({ taskType: 'summarize', tenantId: 'tenant-4b', model: 'caller-resolved-model' })
    );

    const runs = await aiRunRepo.findByTaskType('tenant-4b', 'summarize');
    expect(runs).toHaveLength(1);
    // Row was created with 'caller-resolved-model' but the completion
    // update must overwrite it with the model that actually served (and
    // priced) the request.
    expect(runs[0].model).toBe('provider-echoed-model');
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

  it('propagates provider error even when repo updateStatus also throws', async () => {
    const aiRunRepo = new InMemoryAiRunRepository();
    // Make updateStatus throw to simulate a DB failure during error handling
    (aiRunRepo as any).updateStatus = async () => {
      throw new Error('DB down');
    };

    const failingProvider: LLMProvider = {
      name: 'failing',
      async complete() {
        throw new Error('upstream 503');
      },
      async isAvailable() {
        return true;
      },
    };

    const providers = new Map<string, LLMProvider>();
    providers.set('failing', failingProvider);
    const gateway = makeGateway(providers, { defaultProvider: 'failing' }, aiRunRepo);

    // The LLM provider error must propagate; the repo's DB error must not mask it
    await expect(
      gateway.complete(makeRequest({ taskType: 'summarize', tenantId: 'tenant-6' }))
    ).rejects.toThrow(/upstream 503/);
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

  it('Story 3.12 — logs the correlationId on a provider failure', async () => {
    const errorLog = vi.fn();
    const logger = { info: vi.fn(), error: errorLog };
    const failingProvider: LLMProvider = {
      name: 'failing',
      async complete() {
        throw new Error('boom');
      },
      async isAvailable() {
        return true;
      },
    };
    const providers = new Map<string, LLMProvider>();
    providers.set('failing', failingProvider);
    const config: LLMGatewayConfig = { defaultProvider: 'failing', defaultModel: 'test-model' };
    const gateway = new LLMGateway(config, providers, logger);

    await expect(
      gateway.complete(makeRequest({ metadata: { correlationId: 'corr-xyz' } })),
    ).rejects.toThrow();

    const failLog = errorLog.mock.calls.find(([msg]) => msg === 'LLM completion failed');
    expect(failLog).toBeTruthy();
    expect(failLog![1]).toMatchObject({ correlationId: 'corr-xyz' });
  });
});
