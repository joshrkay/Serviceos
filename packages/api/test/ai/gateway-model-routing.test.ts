/**
 * P2-028 — Task-complexity-based model routing (gateway integration)
 *
 * Tests that LLMGateway.complete() uses the tier routing system to resolve
 * models, supports tenant overrides, emits structured routing decision logs,
 * and warns once on unmapped taskTypes.
 */

import { LLMGateway } from '../../src/ai/gateway/gateway';
import type {
  LLMProvider,
  LLMRequest,
  LLMResponse,
  LLMGatewayConfig,
  LLMGatewayLogger,
} from '../../src/ai/gateway/gateway';
import { StubProvider } from '../../src/ai/gateway/providers';
import { InMemoryAiRunRepository } from '../../src/ai/ai-run';
import { clearUnmappedTaskTypeWarnings } from '../../src/ai/gateway/router';
import { isVisionCapableModel } from '../../src/config/ai-routing';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRequest(overrides: Partial<LLMRequest> = {}): LLMRequest {
  return {
    taskType: 'intent_classification',
    messages: [{ role: 'user', content: 'Hello' }],
    tenantId: 'tenant-1',
    ...overrides,
  };
}

function makeGateway(
  providers: Map<string, LLMProvider>,
  config: Partial<LLMGatewayConfig> = {},
  logger?: LLMGatewayLogger,
  aiRunRepo?: InMemoryAiRunRepository
): LLMGateway {
  const fullConfig: LLMGatewayConfig = {
    defaultProvider: 'stub',
    ...config,
  };
  return new LLMGateway(fullConfig, providers, logger, aiRunRepo);
}

function makeStubProviders(name = 'stub'): Map<string, LLMProvider> {
  const stub = new StubProvider(name);
  stub.setResponse({ content: 'ok', tokenUsage: { input: 1, output: 1, total: 2 } });
  return new Map([[name, stub]]);
}

interface LogEntry {
  message: string;
  meta?: Record<string, unknown>;
}

function makeCapturingLogger(): { logger: LLMGatewayLogger; entries: LogEntry[] } {
  const entries: LogEntry[] = [];
  const logger: LLMGatewayLogger = {
    info: (message, meta) => entries.push({ message, meta }),
    error: (message, meta) => entries.push({ message, meta }),
  };
  return { logger, entries };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('P2-028 — gateway model routing integration', () => {
  beforeEach(() => {
    // Reset warn-once tracking between tests so warnings fire fresh each suite run
    clearUnmappedTaskTypeWarnings();
  });

  // -------------------------------------------------------------------------
  // Tier routing: each tier resolves to its configured model
  // -------------------------------------------------------------------------

  it('routes lightweight taskType to lightweight model (no caller model override)', async () => {
    const providers = makeStubProviders();
    const stub = providers.get('stub') as StubProvider;
    const { logger, entries } = makeCapturingLogger();
    const gateway = makeGateway(providers, {}, logger);

    await gateway.complete(makeRequest({ taskType: 'intent_classification' }));

    const lastRequest = stub.getLastRequest();
    expect(lastRequest?.model).toBe(
      process.env.AI_LIGHTWEIGHT_MODEL ?? 'meta-llama/llama-3.1-8b-instruct'
    );

    // Routing decision log should be emitted
    const routingLog = entries.find((e) => e.message === 'model_routing_decision');
    expect(routingLog).toBeDefined();
    expect(routingLog?.meta?.taskType).toBe('intent_classification');
    expect(routingLog?.meta?.resolvedTier).toBe('lightweight');
    expect(routingLog?.meta?.overrideSource).toBe('default');
  });

  it('routes standard taskType to standard model', async () => {
    const providers = makeStubProviders();
    const stub = providers.get('stub') as StubProvider;
    const gateway = makeGateway(providers);

    await gateway.complete(makeRequest({ taskType: 'create_customer' }));

    const lastRequest = stub.getLastRequest();
    expect(lastRequest?.model).toBe(process.env.AI_STANDARD_MODEL ?? 'meta-llama/llama-3.3-70b-instruct');
  });

  it('routes complex taskType to complex model', async () => {
    const providers = makeStubProviders();
    const stub = providers.get('stub') as StubProvider;
    const gateway = makeGateway(providers);

    await gateway.complete(makeRequest({ taskType: 'draft_estimate' }));

    const lastRequest = stub.getLastRequest();
    expect(lastRequest?.model).toBe(process.env.AI_COMPLEX_MODEL ?? 'qwen/qwen-2.5-72b-instruct');
  });

  it('routes mms_estimate to the complex tier (U1)', async () => {
    const providers = makeStubProviders();
    const stub = providers.get('stub') as StubProvider;
    const gateway = makeGateway(providers);

    await gateway.complete(makeRequest({ taskType: 'mms_estimate' }));

    const model = stub.getLastRequest()?.model;
    // Default complex is text Qwen (operator drafting). MMS photo estimates
    // need AI_COMPLEX_MODEL=qwen/qwen2.5-vl-72b-instruct — see next test.
    expect(model).toBe(process.env.AI_COMPLEX_MODEL ?? 'qwen/qwen-2.5-72b-instruct');
  });

  it('mms_estimate resolves vision-capable when complex tier is an open VL model', async () => {
    const providers = makeStubProviders();
    const stub = providers.get('stub') as StubProvider;
    const visionModel = 'qwen/qwen2.5-vl-72b-instruct';
    const gateway = makeGateway(providers, {
      tenantOverrides: {
        'tenant-mms': {
          tiers: {
            lightweight: { model: 'meta-llama/llama-3.1-8b-instruct' },
            standard: { model: 'meta-llama/llama-3.3-70b-instruct' },
            complex: { model: visionModel },
          },
        },
      },
    });

    await gateway.complete(
      makeRequest({ taskType: 'mms_estimate', tenantId: 'tenant-mms' }),
    );

    const model = stub.getLastRequest()?.model;
    expect(model).toBe(visionModel);
    expect(isVisionCapableModel(model ?? '')).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Caller model override wins
  // -------------------------------------------------------------------------

  it('caller-supplied request.model beats tier mapping', async () => {
    const providers = makeStubProviders();
    const stub = providers.get('stub') as StubProvider;
    const { logger, entries } = makeCapturingLogger();
    const gateway = makeGateway(providers, {}, logger);

    await gateway.complete(
      makeRequest({ taskType: 'intent_classification', model: 'caller-custom-model' })
    );

    const lastRequest = stub.getLastRequest();
    expect(lastRequest?.model).toBe('caller-custom-model');

    // Log should reflect 'request' override source
    const routingLog = entries.find((e) => e.message === 'model_routing_decision');
    expect(routingLog?.meta?.overrideSource).toBe('request');
  });

  // -------------------------------------------------------------------------
  // Tenant override beats default config
  // -------------------------------------------------------------------------

  it('tenant override is applied when tenantOverrides[tenantId] exists', async () => {
    const providers = makeStubProviders();
    const stub = providers.get('stub') as StubProvider;
    const { logger, entries } = makeCapturingLogger();
    const gateway = makeGateway(
      providers,
      {
        tenantOverrides: {
          'tenant-premium': {
            tiers: {
              lightweight: { model: 'tenant-haiku-override', maxTokens: 512, temperature: 0 },
              standard: { model: 'tenant-sonnet-override', maxTokens: 2048, temperature: 0.2 },
              complex: { model: 'tenant-opus-override', maxTokens: 16384, temperature: 0.5 },
            },
          },
        },
      },
      logger
    );

    await gateway.complete(
      makeRequest({ taskType: 'intent_classification', tenantId: 'tenant-premium' })
    );

    const lastRequest = stub.getLastRequest();
    expect(lastRequest?.model).toBe('tenant-haiku-override');

    const routingLog = entries.find((e) => e.message === 'model_routing_decision');
    expect(routingLog?.meta?.overrideSource).toBe('tenant');
  });

  it('falls back to default config when no tenant override exists for tenantId', async () => {
    const providers = makeStubProviders();
    const stub = providers.get('stub') as StubProvider;
    const gateway = makeGateway(providers, {
      tenantOverrides: {
        'tenant-other': {
          tiers: {
            lightweight: { model: 'other-tenant-model' },
            standard: { model: 'other-tenant-model' },
            complex: { model: 'other-tenant-model' },
          },
        },
      },
    });

    await gateway.complete(makeRequest({ taskType: 'intent_classification', tenantId: 'tenant-1' }));

    const lastRequest = stub.getLastRequest();
    // Should be default lightweight model, not the other tenant's override
    expect(lastRequest?.model).toBe(
      process.env.AI_LIGHTWEIGHT_MODEL ?? 'meta-llama/llama-3.1-8b-instruct'
    );
  });

  it('tenant tier overrides replace default tier configs at the tier level', async () => {
    const providers = makeStubProviders();
    const stub = providers.get('stub') as StubProvider;
    const gateway = makeGateway(providers, {
      tenantOverrides: {
        'tenant-partial': {
          tiers: {
            // All three tiers required by AIRoutingConfig.tiers type — override complex only
            complex: { model: 'tenant-complex-model', maxTokens: 16384, temperature: 0.7 },
            lightweight: { model: process.env.AI_LIGHTWEIGHT_MODEL ?? 'meta-llama/llama-3.1-8b-instruct' },
            standard: { model: process.env.AI_STANDARD_MODEL ?? 'meta-llama/llama-3.3-70b-instruct' },
          },
        },
      },
    });

    await gateway.complete(makeRequest({ taskType: 'draft_estimate', tenantId: 'tenant-partial' }));

    const lastRequest = stub.getLastRequest();
    expect(lastRequest?.model).toBe('tenant-complex-model');
  });

  it('partial tenant tier override: unoverridden tiers use default models', async () => {
    const providers = makeStubProviders();
    const stub = providers.get('stub') as StubProvider;
    // AIRoutingConfig.tiers is typed Record<ModelTier, TierConfig> (requires all 3 keys).
    // Cast to Partial<AIRoutingConfig> so we can supply only the complex tier,
    // exercising mergeTenantRouting's merge behaviour for the unspecified tiers.
    const gateway = makeGateway(providers, {
      tenantOverrides: {
        'tenant-partial-only-complex': {
          tiers: { complex: { model: 'partial-complex-model' } },
        } as Partial<import('../../src/config/ai-routing').AIRoutingConfig>,
      },
    });

    // draft_estimate → complex tier → should use tenant's overridden complex model
    await gateway.complete(makeRequest({ taskType: 'draft_estimate', tenantId: 'tenant-partial-only-complex' }));
    expect(stub.getLastRequest()?.model).toBe('partial-complex-model');

    // intent_classification → lightweight tier → tenant did NOT override lightweight,
    // so the DEFAULT lightweight model should be used.
    await gateway.complete(makeRequest({ taskType: 'intent_classification', tenantId: 'tenant-partial-only-complex' }));
    expect(stub.getLastRequest()?.model).toBe(
      process.env.AI_LIGHTWEIGHT_MODEL ?? 'meta-llama/llama-3.1-8b-instruct'
    );
  });

  // -------------------------------------------------------------------------
  // Unmapped taskType → standard tier + single warn log
  // -------------------------------------------------------------------------

  it('unmapped taskType resolves to standard tier', async () => {
    const providers = makeStubProviders();
    const stub = providers.get('stub') as StubProvider;
    const gateway = makeGateway(providers);

    await gateway.complete(makeRequest({ taskType: 'totally_unknown_task_xyz' }));

    const lastRequest = stub.getLastRequest();
    expect(lastRequest?.model).toBe(process.env.AI_STANDARD_MODEL ?? 'meta-llama/llama-3.3-70b-instruct');
  });

  it('unmapped taskType emits a warning log exactly once across multiple calls', async () => {
    const providers = makeStubProviders();
    const warnMessages: string[] = [];
    const logger: LLMGatewayLogger = {
      info: () => {},
      error: (msg) => warnMessages.push(msg),
    };
    // Use a logger that captures 'warn' via error channel — we'll check for warn in info too
    const warnInfo: string[] = [];
    const fullLogger: LLMGatewayLogger = {
      info: (msg, meta) => {
        if (meta?.level === 'warn' || msg.includes('unmapped') || msg.includes('unknown')) {
          warnInfo.push(msg);
        }
      },
      error: logger.error,
    };
    const gateway = makeGateway(providers, {}, fullLogger);

    // Call with same unknown taskType multiple times
    await gateway.complete(makeRequest({ taskType: 'unknown_once_task' }));
    await gateway.complete(makeRequest({ taskType: 'unknown_once_task' }));
    await gateway.complete(makeRequest({ taskType: 'unknown_once_task' }));

    // Warning should have been emitted only once for this taskType
    const warningsForTask = warnInfo.filter((m) => m.includes('unknown_once_task'));
    expect(warningsForTask).toHaveLength(1);
  });

  it('warn-once: different unknown taskTypes each emit their own single warning', async () => {
    const providers = makeStubProviders();
    const warnMessages: string[] = [];
    const logger: LLMGatewayLogger = {
      info: (msg) => {
        if (msg.includes('unmapped') || msg.includes('unknown')) warnMessages.push(msg);
      },
      error: () => {},
    };
    const gateway = makeGateway(providers, {}, logger);

    await gateway.complete(makeRequest({ taskType: 'task_alpha_unknown' }));
    await gateway.complete(makeRequest({ taskType: 'task_beta_unknown' }));
    await gateway.complete(makeRequest({ taskType: 'task_alpha_unknown' })); // repeat — no new warn

    const alphaWarnings = warnMessages.filter((m) => m.includes('task_alpha_unknown'));
    const betaWarnings = warnMessages.filter((m) => m.includes('task_beta_unknown'));
    expect(alphaWarnings).toHaveLength(1);
    expect(betaWarnings).toHaveLength(1);
  });

  // -------------------------------------------------------------------------
  // AiRun.model regression: must equal resolved model (P2-027 compat)
  // -------------------------------------------------------------------------

  it('AiRun.model equals the resolved (tier-mapped) model, not provider-echoed model', async () => {
    const aiRunRepo = new InMemoryAiRunRepository();
    const stub = new StubProvider('stub');
    // Provider echoes a DIFFERENT model than what tier routing resolves
    stub.setResponse({ content: 'ok', model: 'provider-echo-different-model' });
    const providers = new Map<string, LLMProvider>([['stub', stub]]);
    const gateway = makeGateway(providers, {}, undefined, aiRunRepo);

    await gateway.complete(makeRequest({ taskType: 'intent_classification', tenantId: 'tenant-run' }));

    const runs = await aiRunRepo.findByTaskType('tenant-run', 'intent_classification');
    expect(runs).toHaveLength(1);
    // Must be the tier-resolved model, NOT the provider-echoed value
    expect(runs[0].model).toBe(process.env.AI_LIGHTWEIGHT_MODEL ?? 'meta-llama/llama-3.1-8b-instruct');
  });

  it('AiRun.model equals caller-supplied model when request.model is set', async () => {
    const aiRunRepo = new InMemoryAiRunRepository();
    const stub = new StubProvider('stub');
    stub.setResponse({ content: 'ok' });
    const providers = new Map<string, LLMProvider>([['stub', stub]]);
    const gateway = makeGateway(providers, {}, undefined, aiRunRepo);

    await gateway.complete(
      makeRequest({ taskType: 'intent_classification', tenantId: 'tenant-run2', model: 'caller-override-model' })
    );

    const runs = await aiRunRepo.findByTaskType('tenant-run2', 'intent_classification');
    expect(runs).toHaveLength(1);
    expect(runs[0].model).toBe('caller-override-model');
  });

  // -------------------------------------------------------------------------
  // Structured model_routing_decision log
  // -------------------------------------------------------------------------

  it('emits model_routing_decision log with correct fields', async () => {
    const providers = makeStubProviders();
    const { logger, entries } = makeCapturingLogger();
    const gateway = makeGateway(providers, {}, logger);

    await gateway.complete(makeRequest({ taskType: 'draft_estimate' }));

    const routingLog = entries.find((e) => e.message === 'model_routing_decision');
    expect(routingLog).toBeDefined();
    expect(routingLog?.meta).toMatchObject({
      taskType: 'draft_estimate',
      resolvedTier: 'complex',
      resolvedModel: expect.any(String),
      overrideSource: 'default',
    });
  });

  it('model_routing_decision log shows overrideSource=request when model set on request', async () => {
    const providers = makeStubProviders();
    const { logger, entries } = makeCapturingLogger();
    const gateway = makeGateway(providers, {}, logger);

    await gateway.complete(
      makeRequest({ taskType: 'draft_estimate', model: 'explicit-model' })
    );

    const routingLog = entries.find((e) => e.message === 'model_routing_decision');
    expect(routingLog?.meta?.overrideSource).toBe('request');
    expect(routingLog?.meta?.resolvedModel).toBe('explicit-model');
  });

  it('model_routing_decision log shows overrideSource=tenant for tenant override', async () => {
    const providers = makeStubProviders();
    const { logger, entries } = makeCapturingLogger();
    const gateway = makeGateway(
      providers,
      {
        tenantOverrides: {
          'tenant-x': {
            tiers: {
              lightweight: { model: 'x-lightweight' },
              standard: { model: 'x-standard' },
              complex: { model: 'x-complex' },
            },
          },
        },
      },
      logger
    );

    await gateway.complete(makeRequest({ taskType: 'intent_classification', tenantId: 'tenant-x' }));

    const routingLog = entries.find((e) => e.message === 'model_routing_decision');
    expect(routingLog?.meta?.overrideSource).toBe('tenant');
    expect(routingLog?.meta?.resolvedModel).toBe('x-lightweight');
  });
});
