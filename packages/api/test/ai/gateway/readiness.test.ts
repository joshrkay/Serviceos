import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  clearAiCompletionProbeCache,
  probeAiCompletion,
  resolveCompletionProbeTimeoutMs,
} from '../../../src/ai/gateway/readiness';
import type { LLMRequest, LLMResponse } from '../../../src/ai/gateway/gateway';

describe('probeAiCompletion', () => {
  const prevProbeTimeout = process.env.AI_COMPLETION_PROBE_TIMEOUT_MS;
  const prevClassifyDeadline = process.env.AI_CLASSIFY_INTENT_DEADLINE_MS;

  beforeEach(() => {
    clearAiCompletionProbeCache();
    delete process.env.AI_COMPLETION_PROBE_TIMEOUT_MS;
    delete process.env.AI_CLASSIFY_INTENT_DEADLINE_MS;
  });

  afterEach(() => {
    if (prevProbeTimeout === undefined) delete process.env.AI_COMPLETION_PROBE_TIMEOUT_MS;
    else process.env.AI_COMPLETION_PROBE_TIMEOUT_MS = prevProbeTimeout;
    if (prevClassifyDeadline === undefined) delete process.env.AI_CLASSIFY_INTENT_DEADLINE_MS;
    else process.env.AI_CLASSIFY_INTENT_DEADLINE_MS = prevClassifyDeadline;
  });

  it('default timeout is at least 10s and tracks classify deadline', () => {
    expect(resolveCompletionProbeTimeoutMs()).toBeGreaterThanOrEqual(10_000);
    process.env.AI_CLASSIFY_INTENT_DEADLINE_MS = '12000';
    expect(resolveCompletionProbeTimeoutMs()).toBe(12_000);
    process.env.AI_COMPLETION_PROBE_TIMEOUT_MS = '15000';
    expect(resolveCompletionProbeTimeoutMs()).toBe(15_000);
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
    expect(complete.mock.calls[0][0].signal).toBeInstanceOf(AbortSignal);
    expect(complete.mock.calls[0][0].deadlineMs).toBeGreaterThanOrEqual(10_000);
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
