/**
 * VOX-32 / VOX-34 — AI gateway resilience P1s.
 *
 * VOX-32: empty/malformed provider output must be classified transient and
 *         retried within the deadline (a bare Error was treated as permanent).
 * VOX-34: latency-critical (lightweight/voice-hot-path) tasks must inherit the
 *         resolved tier's tighter default deadline, not the universal 8s
 *         fallback; heavier tasks keep the larger budget; explicit
 *         request.deadlineMs still wins.
 */
import { describe, it, expect } from 'vitest';
import {
  classifyError,
  runWithRetry,
  EmptyProviderResponseError,
  DEFAULT_RETRY,
} from '../../src/ai/gateway/retry';
import { OpenAICompatibleProvider } from '../../src/ai/providers/openai-compatible';
import { LLMGateway } from '../../src/ai/gateway/gateway';
import type { LLMProvider, LLMRequest, LLMResponse } from '../../src/ai/gateway/gateway';
import { resolveTierDeadlineMs } from '../../src/config/ai-routing';
import { STAGE_BUDGETS } from '../../src/ai/gateway/deadline';

// ─── helpers ─────────────────────────────────────────────────────────────────

function makeResponse(overrides: Partial<LLMResponse> = {}): LLMResponse {
  return {
    content: 'ok',
    model: 'gpt-4o-mini',
    provider: 'capture',
    tokenUsage: { input: 10, output: 10, total: 20 },
    latencyMs: 10,
    ...overrides,
  };
}

/** Records the request it receives so we can assert the resolved deadline. */
class CapturingProvider implements LLMProvider {
  readonly name = 'capture';
  lastRequest?: LLMRequest;
  async complete(req: LLMRequest): Promise<LLMResponse> {
    this.lastRequest = req;
    return makeResponse({ provider: this.name });
  }
  async isAvailable(): Promise<boolean> {
    return true;
  }
}

function makeGateway(provider: CapturingProvider): LLMGateway {
  return new LLMGateway(
    { defaultProvider: provider.name },
    new Map<string, LLMProvider>([[provider.name, provider]]),
  );
}

// ─── VOX-32: empty-content is transient + retried; 4xx is not ─────────────────

describe('VOX-32 — empty/malformed provider output is retryable', () => {
  it('classifies EmptyProviderResponseError as transient', () => {
    expect(classifyError(new EmptyProviderResponseError('empty'))).toBe('transient');
  });

  it('classifies a 4xx provider error as permanent', () => {
    const err = Object.assign(new Error('bad request'), { status: 400 });
    expect(classifyError(err)).toBe('permanent');
  });

  it('runWithRetry retries an empty-content error up to maxAttempts', async () => {
    let calls = 0;
    await expect(
      runWithRetry(
        async () => {
          calls++;
          throw new EmptyProviderResponseError('empty content');
        },
        { policy: { ...DEFAULT_RETRY, maxAttempts: 3 }, sleep: async () => {}, rng: () => 0 },
      ),
    ).rejects.toBeInstanceOf(EmptyProviderResponseError);
    // Retried: 3 attempts total, not a single permanent failure.
    expect(calls).toBe(3);
  });

  it('runWithRetry recovers when a later attempt returns content', async () => {
    let calls = 0;
    const result = await runWithRetry(
      async () => {
        calls++;
        if (calls === 1) throw new EmptyProviderResponseError('empty content');
        return 'recovered';
      },
      { policy: { ...DEFAULT_RETRY, maxAttempts: 3 }, sleep: async () => {}, rng: () => 0 },
    );
    expect(result).toBe('recovered');
    expect(calls).toBe(2);
  });

  it('runWithRetry does NOT retry a 4xx error', async () => {
    let calls = 0;
    await expect(
      runWithRetry(
        async () => {
          calls++;
          throw Object.assign(new Error('not found'), { status: 404 });
        },
        { policy: { ...DEFAULT_RETRY, maxAttempts: 3 }, sleep: async () => {}, rng: () => 0 },
      ),
    ).rejects.toThrow('not found');
    expect(calls).toBe(1);
  });

  it('OpenAICompatibleProvider throws a typed empty-response error on empty content', async () => {
    const provider = new OpenAICompatibleProvider({
      apiKey: 'test-key',
      baseURL: 'https://api.openai.com/v1',
    });
    // Stub the OpenAI client so complete() returns a structurally-empty choice.
    (provider as unknown as {
      client: { chat: { completions: { create: () => Promise<unknown> } } };
    }).client = {
      chat: {
        completions: {
          create: async () => ({
            choices: [{ message: { content: '' } }],
            model: 'gpt-4o-mini',
            usage: { prompt_tokens: 1, completion_tokens: 0, total_tokens: 1 },
          }),
        },
      },
    } as never;

    await expect(
      provider.complete({
        taskType: 'classify_intent',
        messages: [{ role: 'user', content: 'hi' }],
      }),
    ).rejects.toBeInstanceOf(EmptyProviderResponseError);
  });
});

// ─── VOX-34: per-tier default deadline applied by gateway.complete ────────────

describe('VOX-34 — per-tier default deadline', () => {
  it('lightweight/classify_intent without an explicit deadline gets the tighter tier budget, not 8s', async () => {
    const provider = new CapturingProvider();
    const gateway = makeGateway(provider);

    await gateway.complete({
      taskType: 'classify_intent',
      tenantId: 'tenant-vox-34',
      messages: [{ role: 'user', content: 'book me tuesday' }],
    });

    const applied = provider.lastRequest?.deadlineMs;
    expect(applied).toBe(resolveTierDeadlineMs('lightweight'));
    // The whole point: it is tighter than the universal 8s fallback.
    expect(applied).toBeLessThan(STAGE_BUDGETS.defaultTotal);
    expect(applied).not.toBe(STAGE_BUDGETS.defaultTotal);
  });

  it('complex task keeps the larger tier budget', async () => {
    const provider = new CapturingProvider();
    const gateway = makeGateway(provider);

    await gateway.complete({
      taskType: 'draft_estimate',
      tenantId: 'tenant-vox-34',
      messages: [{ role: 'user', content: 'quote a bathroom remodel' }],
    });

    expect(provider.lastRequest?.deadlineMs).toBe(resolveTierDeadlineMs('complex'));
    // Sanity: complex budget is strictly larger than the lightweight one.
    expect(resolveTierDeadlineMs('complex')).toBeGreaterThan(
      resolveTierDeadlineMs('lightweight'),
    );
  });

  it('an explicit request.deadlineMs always wins over the tier default', async () => {
    const provider = new CapturingProvider();
    const gateway = makeGateway(provider);

    await gateway.complete({
      taskType: 'classify_intent',
      tenantId: 'tenant-vox-34',
      messages: [{ role: 'user', content: 'hi' }],
      deadlineMs: 250,
    });

    expect(provider.lastRequest?.deadlineMs).toBe(250);
  });
});
