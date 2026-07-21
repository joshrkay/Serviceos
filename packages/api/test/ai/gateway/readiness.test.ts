import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  clearAiCompletionProbeCache,
  probeAiCompletion,
} from '../../../src/ai/gateway/readiness';
import type { LLMRequest, LLMResponse } from '../../../src/ai/gateway/gateway';

describe('probeAiCompletion', () => {
  beforeEach(() => {
    clearAiCompletionProbeCache();
  });

  it('happy path — ok true with model and latency', async () => {
    const complete = vi.fn(async (_req: LLMRequest): Promise<LLMResponse> => ({
      content: 'ok',
      model: 'gpt-4o-mini',
      tokenUsage: { input: 1, output: 1, total: 2 },
    }));

    const result = await probeAiCompletion({ complete }, { cacheTtlMs: 60_000 });

    expect(result.ok).toBe(true);
    expect(result.model).toBe('gpt-4o-mini');
    expect(result.cached).toBe(false);
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    expect(complete).toHaveBeenCalledTimes(1);
    expect(complete.mock.calls[0][0].taskType).toBe('classify_intent');
    expect(complete.mock.calls[0][0].tenantId).toBe('system');
  });

  it('error path — ok false with stable errorCode', async () => {
    const complete = vi.fn(async () => {
      throw new Error('404 The model `claude-sonnet-4-6` does not exist');
    });

    const result = await probeAiCompletion({ complete });

    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe('model_not_found');
    expect(result.cached).toBe(false);
  });

  it('caches result within TTL', async () => {
    let now = 1_000;
    const complete = vi.fn(async (): Promise<LLMResponse> => ({
      content: 'ok',
      model: 'gpt-4o-mini',
      tokenUsage: { input: 1, output: 1, total: 2 },
    }));

    const first = await probeAiCompletion(
      { complete },
      { cacheTtlMs: 30_000, now: () => now },
    );
    now += 1_000;
    const second = await probeAiCompletion(
      { complete },
      { cacheTtlMs: 30_000, now: () => now },
    );

    expect(first.cached).toBe(false);
    expect(second.cached).toBe(true);
    expect(complete).toHaveBeenCalledTimes(1);
  });

  it('maps auth failures to errorCode auth', async () => {
    const complete = vi.fn(async () => {
      throw new Error('401 Incorrect API key provided');
    });
    const result = await probeAiCompletion({ complete });
    expect(result.errorCode).toBe('auth');
  });
});
