import { describe, it, expect, afterEach } from 'vitest';
import { LLMGateway, validateLLMRequest, MissingTenantIdError } from '../../src/ai/gateway/gateway';
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
// P0 scaling bug guard: LLMGateway.complete() escalates when a tenant-scoped
// taskType is missing a top-level tenantId. Without this, the resilience
// wrappers (ProviderTenantQuotaWrapper / CachingGatewayWrapper) silently fall
// back to the shared "system" bucket, collapsing every tenant's quota onto
// one process-global limit.
//
// Escalation is env-driven (AI_GATEWAY_STRICT_TENANT_ID, see gateway.ts):
//   - strict mode (default in test/dev/CI, i.e. whenever this suite runs
//     without an explicit override) THROWS MissingTenantIdError, so a
//     newly-introduced call site that omits tenantId fails the test/CI run
//     immediately instead of shipping a silent shared-bucket bug.
//   - warn-only mode (default in production; explicit opt-in elsewhere) logs
//     and continues — a throw in production would 500 a real request rather
//     than degrade to the shared bucket.
// The tests below force each mode explicitly via the env var so the suite
// doesn't depend on incidental NODE_ENV state.
// ---------------------------------------------------------------------------
describe('LLMGateway.complete() — missing top-level tenantId guard', () => {
  const ENV_KEY = 'AI_GATEWAY_STRICT_TENANT_ID';
  const originalValue = process.env[ENV_KEY];

  afterEach(() => {
    if (originalValue === undefined) delete process.env[ENV_KEY];
    else process.env[ENV_KEY] = originalValue;
  });

  describe('strict mode (AI_GATEWAY_STRICT_TENANT_ID=true — also the default in test/dev)', () => {
    it('throws MissingTenantIdError for a known tenant-scoped taskType with no top-level tenantId', async () => {
      process.env[ENV_KEY] = 'true';
      const stub = new StubProvider('stub');
      stub.setResponse({ content: 'ok', tokenUsage: { input: 1, output: 1, total: 2 } });
      const providers = new Map<string, LLMProvider>([['stub', stub]]);
      const gateway = makeGateway(providers);

      // 'classify_intent' is in the canonical TASK_TYPES list (config/ai-routing.ts)
      // — a real, tenant-scoped call site — and no top-level tenantId is set here.
      const request = makeRequest({
        taskType: 'classify_intent',
        metadata: { tenantId: 'tenant-xyz' },
      });
      await expect(gateway.complete(request)).rejects.toThrow(MissingTenantIdError);
      await expect(gateway.complete(request)).rejects.toThrow(/tenantId/i);
    });

    it('throws before dispatching to the provider (fails fast, no wasted call)', async () => {
      process.env[ENV_KEY] = 'true';
      let providerCalled = false;
      const provider: LLMProvider = {
        name: 'spy',
        async complete() {
          providerCalled = true;
          return {
            content: 'ok',
            model: 'spy-model',
            provider: 'spy',
            tokenUsage: { input: 1, output: 1, total: 2 },
            latencyMs: 0,
          };
        },
        async isAvailable() {
          return true;
        },
      };
      const providers = new Map<string, LLMProvider>([['spy', provider]]);
      const gateway = makeGateway(providers, { defaultProvider: 'spy' });

      await expect(
        gateway.complete(makeRequest({ taskType: 'classify_intent' }))
      ).rejects.toThrow(MissingTenantIdError);
      expect(providerCalled).toBe(false);
    });

    it('does not throw when the request carries a top-level tenantId', async () => {
      process.env[ENV_KEY] = 'true';
      const stub = new StubProvider('stub');
      stub.setResponse({ content: 'ok', tokenUsage: { input: 1, output: 1, total: 2 } });
      const providers = new Map<string, LLMProvider>([['stub', stub]]);
      const gateway = makeGateway(providers);

      await expect(
        gateway.complete(makeRequest({ taskType: 'classify_intent', tenantId: 'tenant-xyz' }))
      ).resolves.toBeDefined();
    });

    it('does not throw for a taskType outside the known tenant-scoped set (avoids false positives)', async () => {
      process.env[ENV_KEY] = 'true';
      const stub = new StubProvider('stub');
      stub.setResponse({ content: 'ok', tokenUsage: { input: 1, output: 1, total: 2 } });
      const providers = new Map<string, LLMProvider>([['stub', stub]]);
      const gateway = makeGateway(providers);

      // 'summarize' (the default makeRequest taskType) is not in the canonical
      // TASK_TYPES list, so it must not trip the guard.
      await expect(gateway.complete(makeRequest())).resolves.toBeDefined();
    });

    it('is the default with no env var set (matches test/dev/CI expectations)', async () => {
      delete process.env[ENV_KEY];
      const stub = new StubProvider('stub');
      const providers = new Map<string, LLMProvider>([['stub', stub]]);
      const gateway = makeGateway(providers);

      await expect(
        gateway.complete(makeRequest({ taskType: 'classify_intent' }))
      ).rejects.toThrow(MissingTenantIdError);
    });
  });

  describe('warn-only mode (AI_GATEWAY_STRICT_TENANT_ID=false — also the default in production)', () => {
    it('warns (does not throw) when a known tenant-scoped taskType has no top-level tenantId', async () => {
      process.env[ENV_KEY] = 'false';
      const stub = new StubProvider('stub');
      stub.setResponse({ content: 'ok', tokenUsage: { input: 1, output: 1, total: 2 } });
      const providers = new Map<string, LLMProvider>([['stub', stub]]);
      const { logger, entries } = makeCapturingLogger();
      const gateway = makeGateway(providers, {}, logger);

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
      process.env[ENV_KEY] = 'false';
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

    it('is the default in a production-like environment with no explicit override', async () => {
      delete process.env[ENV_KEY];
      const originalNodeEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = 'production';
      try {
        const stub = new StubProvider('stub');
        stub.setResponse({ content: 'ok', tokenUsage: { input: 1, output: 1, total: 2 } });
        const providers = new Map<string, LLMProvider>([['stub', stub]]);
        const { logger, entries } = makeCapturingLogger();
        const gateway = makeGateway(providers, {}, logger);

        await expect(
          gateway.complete(makeRequest({ taskType: 'classify_intent' }))
        ).resolves.toBeDefined();
        const warning = entries.find((e) => e.meta?.level === 'warn' && /tenantId/i.test(e.message));
        expect(warning).toBeDefined();
      } finally {
        if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
        else process.env.NODE_ENV = originalNodeEnv;
      }
    });
  });
});

// ---------------------------------------------------------------------------
// Sweep pin: the tenant-ID sweep (see the guard tests above) fixed a known
// set of gateway.complete() call sites that used to put tenantId only in
// `metadata`. This is a lightweight source-text guard (not an AST scanner —
// see test/app/invoice-delivery-boot-guard.test.ts for the established
// precedent of this pattern in this repo) pinning that each fixed call site
// still passes a top-level `tenantId` field. It's intentionally narrow
// (checks for the literal token near the taskType), not exhaustive — its
// job is to catch an accidental revert, not to police every call site in
// the codebase.
// ---------------------------------------------------------------------------
describe('tenantId sweep — fixed call sites keep a top-level tenantId (source pin)', () => {
  const fixedCallSites: Array<{ file: string; taskType: string; tenantIdPattern: RegExp }> = [
    {
      file: '../../src/routes/assistant.ts',
      taskType: 'taskType',
      tenantIdPattern: /taskType,\s*\n\s*\/\/[^\n]*\n(?:\s*\/\/[^\n]*\n)*\s*tenantId,/,
    },
    {
      file: '../../src/workers/transcription.ts',
      taskType: "'transcription_correction'",
      tenantIdPattern: /taskType: 'transcription_correction',\s*\n(?:\s*\/\/[^\n]*\n)*\s*tenantId,/,
    },
    {
      file: '../../src/ai/skills/confirm-intent.ts',
      taskType: "'classify_intent'",
      tenantIdPattern: /taskType: 'classify_intent',\s*\n(?:\s*\/\/[^\n]*\n)*\s*tenantId,/,
    },
    {
      file: '../../src/ai/skills/summarize-session.ts',
      taskType: "'summarize_conversation'",
      tenantIdPattern: /taskType: 'summarize_conversation',\s*\n(?:\s*\/\/[^\n]*\n)*\s*tenantId,/,
    },
    {
      file: '../../src/ai/orchestration/transcript-decomposer.ts',
      taskType: "'decompose_transcript'",
      tenantIdPattern: /taskType: 'decompose_transcript',\s*\n(?:\s*\/\/[^\n]*\n)*\s*tenantId: context\.tenantId,/,
    },
  ];

  for (const { file, tenantIdPattern } of fixedCallSites) {
    it(`${file} passes a top-level tenantId on its gateway.complete() call`, async () => {
      const { readFileSync } = await import('fs');
      const { resolve } = await import('path');
      const src = readFileSync(resolve(__dirname, file), 'utf8');
      expect(src).toMatch(tenantIdPattern);
    });
  }
});
