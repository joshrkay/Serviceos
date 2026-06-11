/**
 * VQ2-005 — real Anthropic gateway factory tests.
 *
 * Asserts the factory:
 *   - rejects empty/missing API keys early
 *   - wires through to the underlying chat-completions endpoint
 *   - emits exactly one `cost_incurred` event per successful call
 *   - computes cents from `usage.prompt_tokens` / `usage.completion_tokens`
 *     using the hoisted Haiku pricing constants
 *   - charges cached input tokens at the cache-read rate (90% discount)
 *   - does NOT emit cost on error (the SDK doesn't reliably surface
 *     `usage` on failed calls)
 *   - propagates errors unmodified
 *   - defaults to the production agent model when not overridden
 *
 * The Anthropic / OpenAI-compatible SDK is mocked via `vi.mock('openai')` —
 * tests never make real network calls.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

// Hoisted shared mock: vitest hoists vi.mock above all imports, so we
// stash the constructor + create stub on a module-scoped object that
// the mock factory reads.
const openaiMock: {
  createImpl: (req: unknown) => Promise<unknown>;
  ctorArgs: unknown[];
} = {
  createImpl: () => Promise.resolve({}),
  ctorArgs: [],
};

vi.mock('openai', () => {
  class MockOpenAI {
    chat = {
      completions: {
        create: vi.fn((req: unknown) => openaiMock.createImpl(req)),
      },
    };
    constructor(args: unknown) {
      openaiMock.ctorArgs.push(args);
    }
  }
  return { default: MockOpenAI };
});

// Imports must come AFTER the vi.mock declaration so the mock is in
// place when the factory module pulls in the SDK.
import { AgentEventBus } from '../../../src/ai/voice-quality/event-bus';
import {
  createRealLayerTwoGateway,
  HAIKU_INPUT_CENTS_PER_MTOKEN,
  HAIKU_OUTPUT_CENTS_PER_MTOKEN,
  HAIKU_CACHE_READ_CENTS_PER_MTOKEN,
  type LayerTwoCostTracker,
} from '../../../src/ai/gateway/real-layer-two-factory';

class MockCostTracker implements LayerTwoCostTracker {
  private total = 0;
  readonly addCents = vi.fn((n: number) => {
    this.total += n;
  });
  totalCents(): number {
    return this.total;
  }
}

/**
 * Build a synthetic OpenAI-shaped chat completion response with a given
 * usage block. `cached` is split out as its own param so each test can
 * dial just the dimension it cares about without rebuilding the whole
 * response shape.
 */
function fakeCompletion(opts: {
  content?: string;
  promptTokens?: number;
  completionTokens?: number;
  cachedTokens?: number;
  model?: string;
}): unknown {
  const promptTokens = opts.promptTokens ?? 0;
  const completionTokens = opts.completionTokens ?? 0;
  return {
    choices: [{ message: { content: opts.content ?? '{"ok":true}' } }],
    model: opts.model ?? 'claude-haiku-4-5-20251001',
    usage: {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: promptTokens + completionTokens,
      prompt_tokens_details:
        opts.cachedTokens !== undefined
          ? { cached_tokens: opts.cachedTokens }
          : undefined,
    },
  };
}

describe('VQ2-005 — createRealLayerTwoGateway', () => {
  let bus: AgentEventBus;
  let costTracker: MockCostTracker;

  beforeEach(() => {
    bus = new AgentEventBus();
    costTracker = new MockCostTracker();
    openaiMock.createImpl = () => Promise.resolve(fakeCompletion({}));
    openaiMock.ctorArgs = [];
  });

  it('VQ2-005 — throws when apiKey is empty', () => {
    expect(() =>
      createRealLayerTwoGateway({ apiKey: '', bus, costTracker }),
    ).toThrow(/ANTHROPIC_API_KEY is required/);
  });

  it('VQ2-005 — throws when apiKey is whitespace-only', () => {
    expect(() =>
      createRealLayerTwoGateway({ apiKey: '   ', bus, costTracker }),
    ).toThrow(/ANTHROPIC_API_KEY is required/);
  });

  it('VQ2-005 — produces a gateway that calls the wrapped Anthropic provider', async () => {
    openaiMock.createImpl = vi.fn(async () =>
      fakeCompletion({
        content: '{"hello":"world"}',
        promptTokens: 100,
        completionTokens: 50,
      }),
    );

    const gateway = createRealLayerTwoGateway({
      apiKey: 'sk-ant-test',
      bus,
      costTracker,
    });

    const response = await gateway.complete({
      taskType: 'voice.agent',
      messages: [{ role: 'user', content: 'hi' }],
    });

    expect(response.content).toBe('{"hello":"world"}');
    expect(openaiMock.createImpl).toHaveBeenCalledTimes(1);
  });

  it('VQ2-005 — wrapper emits cost_incurred event on successful response', async () => {
    openaiMock.createImpl = async () =>
      fakeCompletion({ promptTokens: 1_000_000, completionTokens: 0 });

    const gateway = createRealLayerTwoGateway({
      apiKey: 'sk-ant-test',
      bus,
      costTracker,
    });

    await gateway.complete({
      taskType: 'voice.agent',
      messages: [{ role: 'user', content: 'hi' }],
    });

    const costEvents = bus.filterByType('cost_incurred');
    expect(costEvents).toHaveLength(1);
    expect(costEvents[0]!.deltaCents).toBe(HAIKU_INPUT_CENTS_PER_MTOKEN);
    expect(costEvents[0]!.totalCents).toBe(HAIKU_INPUT_CENTS_PER_MTOKEN);
  });

  it('VQ2-005 — wrapper computes cents from usage.input_tokens via HAIKU_INPUT_CENTS_PER_MTOKEN', async () => {
    // Exactly 1M input tokens → exactly HAIKU_INPUT_CENTS_PER_MTOKEN cents.
    openaiMock.createImpl = async () =>
      fakeCompletion({ promptTokens: 1_000_000, completionTokens: 0 });

    const gateway = createRealLayerTwoGateway({
      apiKey: 'sk-ant-test',
      bus,
      costTracker,
    });

    await gateway.complete({
      taskType: 'voice.agent',
      messages: [{ role: 'user', content: 'hi' }],
    });

    expect(costTracker.totalCents()).toBe(HAIKU_INPUT_CENTS_PER_MTOKEN);
  });

  it('VQ2-005 — wrapper computes cents from output tokens via HAIKU_OUTPUT_CENTS_PER_MTOKEN', async () => {
    openaiMock.createImpl = async () =>
      fakeCompletion({ promptTokens: 0, completionTokens: 1_000_000 });

    const gateway = createRealLayerTwoGateway({
      apiKey: 'sk-ant-test',
      bus,
      costTracker,
    });

    await gateway.complete({
      taskType: 'voice.agent',
      messages: [{ role: 'user', content: 'hi' }],
    });

    expect(costTracker.totalCents()).toBe(HAIKU_OUTPUT_CENTS_PER_MTOKEN);
  });

  it('VQ2-005 — wrapper accumulates cache_read_input_tokens at the cache rate (cheaper than input)', async () => {
    // 1M tokens prompt, of which 1M are cache reads — billed entirely at
    // the discounted rate, not the regular input rate. The factory must
    // subtract the cached portion from the regular-input bucket so we
    // don't double-charge.
    openaiMock.createImpl = async () =>
      fakeCompletion({
        promptTokens: 1_000_000,
        completionTokens: 0,
        cachedTokens: 1_000_000,
      });

    const gateway = createRealLayerTwoGateway({
      apiKey: 'sk-ant-test',
      bus,
      costTracker,
    });

    await gateway.complete({
      taskType: 'voice.agent',
      messages: [{ role: 'user', content: 'hi' }],
    });

    expect(costTracker.totalCents()).toBe(HAIKU_CACHE_READ_CENTS_PER_MTOKEN);
    // Sanity check: the cache rate is genuinely cheaper than input
    // (this is the whole point of caching).
    expect(HAIKU_CACHE_READ_CENTS_PER_MTOKEN).toBeLessThan(
      HAIKU_INPUT_CENTS_PER_MTOKEN,
    );
  });

  it('VQ2-005 — wrapper does NOT emit cost on error (since usage may be missing)', async () => {
    openaiMock.createImpl = async () => {
      throw new Error('upstream 500');
    };

    const gateway = createRealLayerTwoGateway({
      apiKey: 'sk-ant-test',
      bus,
      costTracker,
    });

    await expect(
      gateway.complete({
        taskType: 'voice.agent',
        messages: [{ role: 'user', content: 'hi' }],
      }),
    ).rejects.toThrow();

    expect(bus.filterByType('cost_incurred')).toHaveLength(0);
    expect(costTracker.totalCents()).toBe(0);
    expect(costTracker.addCents).not.toHaveBeenCalled();
  });

  it('VQ2-005 — error responses propagate to caller without modification', async () => {
    const sentinel = new Error('rate limited') as Error & { status: number };
    sentinel.status = 429;
    openaiMock.createImpl = async () => {
      throw sentinel;
    };

    const gateway = createRealLayerTwoGateway({
      apiKey: 'sk-ant-test',
      bus,
      costTracker,
    });

    // The production gateway re-wraps non-AppError throws as
    // LLM_PROVIDER_ERROR (502). The wrapper must NOT swallow the call
    // — assert the rejection contains the original rate-limit signal in
    // the message so callers can match on it.
    await expect(
      gateway.complete({
        taskType: 'voice.agent',
        messages: [{ role: 'user', content: 'hi' }],
      }),
    ).rejects.toThrow(/rate limited/);
  });

  it('VQ2-005 — model defaults to claude-haiku-4-5-20251001 when not overridden', async () => {
    let observedModel: string | undefined;
    openaiMock.createImpl = async (req: unknown) => {
      observedModel = (req as { model?: string }).model;
      return fakeCompletion({});
    };

    const gateway = createRealLayerTwoGateway({
      apiKey: 'sk-ant-test',
      bus,
      costTracker,
    });

    await gateway.complete({
      taskType: 'voice.agent',
      messages: [{ role: 'user', content: 'hi' }],
    });

    expect(observedModel).toBe('claude-haiku-4-5-20251001');
  });

  it('VQ2-005 — model can be overridden via deps.model', async () => {
    let observedModel: string | undefined;
    openaiMock.createImpl = async (req: unknown) => {
      observedModel = (req as { model?: string }).model;
      return fakeCompletion({});
    };

    const gateway = createRealLayerTwoGateway({
      apiKey: 'sk-ant-test',
      bus,
      costTracker,
      model: 'claude-opus-4-7-20260101',
    });

    await gateway.complete({
      taskType: 'voice.agent',
      messages: [{ role: 'user', content: 'hi' }],
    });

    expect(observedModel).toBe('claude-opus-4-7-20260101');
  });

  it('VQ2-005 — baseUrl is forwarded to the SDK constructor (Anthropic OpenAI-compat endpoint)', async () => {
    createRealLayerTwoGateway({
      apiKey: 'sk-ant-test',
      bus,
      costTracker,
      baseUrl: 'https://example.test/v1/',
    });

    const lastCtor = openaiMock.ctorArgs[openaiMock.ctorArgs.length - 1] as {
      baseURL?: string;
    };
    expect(lastCtor.baseURL).toBe('https://example.test/v1/');
  });
});
