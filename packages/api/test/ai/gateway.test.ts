import { LLMGateway, validateLLMRequest } from '../../src/ai/gateway/gateway';
import type {
  LLMProvider,
  LLMRequest,
  LLMResponse,
  LLMGatewayConfig,
  LLMGatewayLogger,
} from '../../src/ai/gateway/gateway';
import { StubProvider } from '../../src/ai/gateway/providers';
import { AppError, ValidationError } from '../../src/shared/errors';

function makeRequest(overrides: Partial<LLMRequest> = {}): LLMRequest {
  return {
    taskType: 'summarize',
    messages: [{ role: 'user', content: 'Hello' }],
    ...overrides,
  };
}

function makeGateway(
  providers: Map<string, LLMProvider>,
  config: Partial<LLMGatewayConfig> = {},
  logger?: LLMGatewayLogger
): LLMGateway {
  const fullConfig: LLMGatewayConfig = {
    defaultProvider: 'stub',
    defaultModel: 'test-model',
    ...config,
  };
  return new LLMGateway(fullConfig, providers, logger);
}

interface CapturedLogEntry {
  message: string;
  meta?: Record<string, unknown>;
}

function makeCapturingLogger(): { logger: LLMGatewayLogger; entries: CapturedLogEntry[] } {
  const entries: CapturedLogEntry[] = [];
  const logger: LLMGatewayLogger = {
    info: (message, meta) => entries.push({ message, meta }),
    error: (message, meta) => entries.push({ message, meta }),
  };
  return { logger, entries };
}

describe('P2-027 — Provider-agnostic LLM gateway', () => {
  it('happy path — completes request via stub provider', async () => {
    const stub = new StubProvider('stub');
    stub.setResponse({
      content: 'Summary result',
      tokenUsage: { input: 10, output: 5, total: 15 },
    });

    const providers = new Map<string, LLMProvider>();
    providers.set('stub', stub);
    const gateway = makeGateway(providers);

    const response = await gateway.complete(makeRequest());

    expect(response.content).toBe('Summary result');
    expect(response.provider).toBe('stub');
    expect(response.tokenUsage.total).toBe(15);
    expect(response.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('happy path — routes to correct provider by task type', async () => {
    const stubA = new StubProvider('provider-a');
    stubA.setResponse({ content: 'Response from A' });

    const stubB = new StubProvider('provider-b');
    stubB.setResponse({ content: 'Response from B' });

    const providers = new Map<string, LLMProvider>();
    providers.set('provider-a', stubA);
    providers.set('provider-b', stubB);

    const gateway = makeGateway(providers, {
      defaultProvider: 'provider-a',
      taskRouting: { 'special-task': 'provider-b' },
    });

    const responseA = await gateway.complete(makeRequest({ taskType: 'general' }));
    expect(responseA.content).toBe('Response from A');
    expect(responseA.provider).toBe('provider-a');

    const responseB = await gateway.complete(makeRequest({ taskType: 'special-task' }));
    expect(responseB.content).toBe('Response from B');
    expect(responseB.provider).toBe('provider-b');
  });

  it('validation — rejects empty messages', async () => {
    const stub = new StubProvider('stub');
    const providers = new Map<string, LLMProvider>();
    providers.set('stub', stub);
    const gateway = makeGateway(providers);

    await expect(
      gateway.complete(makeRequest({ messages: [] }))
    ).rejects.toThrow(ValidationError);
  });

  it('validation — rejects missing task type', async () => {
    const errors = validateLLMRequest(makeRequest({ taskType: '' }));
    expect(errors).toContain('taskType is required');

    const stub = new StubProvider('stub');
    const providers = new Map<string, LLMProvider>();
    providers.set('stub', stub);
    const gateway = makeGateway(providers);

    await expect(
      gateway.complete(makeRequest({ taskType: '' }))
    ).rejects.toThrow(ValidationError);
  });

  it('mock provider test — stub provider returns configured response', async () => {
    const stub = new StubProvider('test-stub');
    stub.setResponse({
      content: 'Custom response content',
      model: 'custom-model',
      tokenUsage: { input: 20, output: 30, total: 50 },
    });

    const response = await stub.complete(makeRequest());

    expect(response.content).toBe('Custom response content');
    expect(response.provider).toBe('test-stub');
    expect(response.tokenUsage).toEqual({ input: 20, output: 30, total: 50 });
  });

  it('mock provider test — stub provider records last request', async () => {
    const stub = new StubProvider('test-stub');
    expect(stub.getLastRequest()).toBeUndefined();

    const request = makeRequest({ taskType: 'estimate', model: 'gpt-4' });
    await stub.complete(request);

    const lastRequest = stub.getLastRequest();
    expect(lastRequest).toBeDefined();
    expect(lastRequest!.taskType).toBe('estimate');
    expect(lastRequest!.model).toBe('gpt-4');
  });

  it('malformed AI output handled gracefully — provider throws error', async () => {
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
    const gateway = makeGateway(providers, { defaultProvider: 'failing' });

    await expect(gateway.complete(makeRequest())).rejects.toThrow(AppError);

    try {
      await gateway.complete(makeRequest());
    } catch (err) {
      expect(err).toBeInstanceOf(AppError);
      expect((err as AppError).code).toBe('LLM_PROVIDER_ERROR');
      expect((err as AppError).message).toContain('Connection timeout');
    }
  });

  it('malformed AI output handled gracefully — provider returns invalid response', async () => {
    const badProvider: LLMProvider = {
      name: 'bad',
      async complete() {
        // Return a response missing required fields to simulate malformed output
        return {
          content: '',
          model: '',
          provider: 'bad',
          tokenUsage: { input: 0, output: 0, total: 0 },
          latencyMs: 0,
        };
      },
      async isAvailable() {
        return true;
      },
    };

    const providers = new Map<string, LLMProvider>();
    providers.set('bad', badProvider);
    const gateway = makeGateway(providers, { defaultProvider: 'bad' });

    // Gateway should handle the response without crashing even if content is empty
    const response = await gateway.complete(makeRequest());
    expect(response.content).toBe('');
    expect(response.provider).toBe('bad');
    expect(response.tokenUsage).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// P0 scaling bug guard: LLMGateway.complete() warns (does NOT throw) when a
// tenant-scoped taskType is missing a top-level tenantId. Without this, the
// resilience wrappers (ProviderTenantQuotaWrapper / CachingGatewayWrapper)
// silently fall back to the shared "system" bucket, collapsing every
// tenant's quota onto one process-global limit. This must stay a warning,
// not a hard throw — other call sites still omit the top-level field and are
// being fixed separately; a throw here would break them.
// ---------------------------------------------------------------------------
describe('LLMGateway.complete() — missing top-level tenantId guard', () => {
  it('warns when a known tenant-scoped taskType has no top-level tenantId', async () => {
    const stub = new StubProvider('stub');
    stub.setResponse({ content: 'ok', tokenUsage: { input: 1, output: 1, total: 2 } });
    const providers = new Map<string, LLMProvider>([['stub', stub]]);
    const { logger, entries } = makeCapturingLogger();
    const gateway = makeGateway(providers, {}, logger);

    // 'classify_intent' is in the canonical TASK_TYPES list (config/ai-routing.ts)
    // — a real, tenant-scoped call site — and no top-level tenantId is set here.
    await gateway.complete(
      makeRequest({ taskType: 'classify_intent', metadata: { tenantId: 'tenant-xyz' } })
    );

    const warning = entries.find(
      (e) => e.meta?.level === 'warn' && e.meta?.taskType === 'classify_intent'
    );
    expect(warning).toBeDefined();
    expect(warning?.message).toMatch(/tenantId/i);
    // The (buggy) metadata-only placement should still be visible in the log
    // for triage, even though it doesn't satisfy the guard.
    expect(warning?.meta?.hasMetadataTenantId).toBe(true);
  });

  it('does not warn when the request carries a top-level tenantId', async () => {
    const stub = new StubProvider('stub');
    stub.setResponse({ content: 'ok', tokenUsage: { input: 1, output: 1, total: 2 } });
    const providers = new Map<string, LLMProvider>([['stub', stub]]);
    const { logger, entries } = makeCapturingLogger();
    const gateway = makeGateway(providers, {}, logger);

    await gateway.complete(
      makeRequest({ taskType: 'classify_intent', tenantId: 'tenant-xyz' })
    );

    const warning = entries.find((e) => e.meta?.level === 'warn' && /tenantId/i.test(e.message));
    expect(warning).toBeUndefined();
  });

  it('does not throw for a taskType outside the known tenant-scoped set (avoids false positives)', async () => {
    const stub = new StubProvider('stub');
    stub.setResponse({ content: 'ok', tokenUsage: { input: 1, output: 1, total: 2 } });
    const providers = new Map<string, LLMProvider>([['stub', stub]]);
    const { logger, entries } = makeCapturingLogger();
    const gateway = makeGateway(providers, {}, logger);

    // 'summarize' (the default makeRequest taskType) is not in the canonical
    // TASK_TYPES list, so it must not trip the guard.
    await expect(gateway.complete(makeRequest())).resolves.toBeDefined();
    const warning = entries.find((e) => e.meta?.level === 'warn' && /tenantId/i.test(e.message));
    expect(warning).toBeUndefined();
  });
});
