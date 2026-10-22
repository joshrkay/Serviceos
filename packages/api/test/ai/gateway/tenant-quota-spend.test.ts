/**
 * GATEWAY-05 — the per-tenant token bucket actually bounds what a tenant
 * consumes.
 *
 * Before: ProviderTenantQuotaWrapper reserved only `content` chars/4 — no text
 * parts, no images, no output allowance — and release() floored any overage
 * at 0, so once the bucket drained every short-prompt / long-output call was
 * admitted after a few ms of refill and its real cost forgiven (a probe on the
 * standard tier consumed ~300x the refill rate).
 *
 * Now the wrapper reserves input (content + text parts + a per-image
 * allowance) plus request.maxTokens, refunds the unused part on release, and
 * an underestimate is carried as debt down to -bucketCapacity.
 *
 * Out of scope here: a money-denominated per-tenant spend cap (separate
 * product story) — this is the token fairness bucket only.
 */
import { describe, it, expect } from 'vitest';
import {
  TenantQuotaRegistry,
  TenantTokenBudgetExceededError,
  estimateTokens,
  type QuotaStore,
  type TenantQuotaTierConfig,
} from '../../../src/ai/gateway/tenant-quota';
import {
  IMAGE_PART_TOKEN_ALLOWANCE,
  ProviderTenantQuotaWrapper,
  estimateRequestTokens,
} from '../../../src/ai/gateway/compose-resilience';
import type { LLMProvider, LLMRequest, LLMResponse } from '../../../src/ai/gateway/gateway';

const tiers = (over: Partial<TenantQuotaTierConfig>): Record<string, TenantQuotaTierConfig> => ({
  standard: {
    maxConcurrency: 100,
    bucketCapacity: 2_000,
    refillTokensPerSec: 1_000,
    hardUpperBoundTokens: 1_000_000,
    ...over,
  },
});

describe('GATEWAY-05 — TenantQuotaRegistry carries debt', () => {
  it('an underestimate leaves the bucket negative, so the next call waits for it', async () => {
    const reg = new TenantQuotaRegistry(tiers({ refillTokensPerSec: 10 }));
    const lease = await reg.acquire({ tenantId: 't', estimatedTokens: 1_990 }); // bucket ~10
    await lease.release(1_000, 1_500); // actual 2,500 vs est 1,990 → 510 owed

    const err = await reg.acquire({ tenantId: 't', estimatedTokens: 1 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TenantTokenBudgetExceededError);
    // ~(1 + 500) / 10 tok/s ≈ 50s; a 0 floor would have said ~0.1s.
    expect((err as TenantTokenBudgetExceededError).retryAfterMs).toBeGreaterThan(45_000);
  });

  it('floors the debt at -bucketCapacity', async () => {
    const reg = new TenantQuotaRegistry(tiers({ refillTokensPerSec: 10 }));
    const lease = await reg.acquire({ tenantId: 't', estimatedTokens: 10 });
    await lease.release(1_000_000, 1_000_000);
    const err = (await reg
      .acquire({ tenantId: 't', estimatedTokens: 1 })
      .catch((e: unknown) => e)) as TenantTokenBudgetExceededError;
    // (1 + 2,000) / 10 tok/s ≈ 200s — the floor, not 200,000s of debt.
    expect(err.retryAfterMs).toBeGreaterThan(195_000);
    expect(err.retryAfterMs).toBeLessThan(205_000);
  });

  it('refunds an overestimate (capped at capacity)', async () => {
    const reg = new TenantQuotaRegistry(tiers({ refillTokensPerSec: 0.001 }));
    const lease = await reg.acquire({ tenantId: 't', estimatedTokens: 1_500 }); // bucket 500
    await lease.release(100, 100); // actual 200 → refund 1,300 → bucket 1,800
    const next = await reg.acquire({ tenantId: 't', estimatedTokens: 1_700 });
    await next.release();
  });

  it('after a drain, consumption stays within capacity + the refill window', async () => {
    const refill = 1_000;
    const capacity = 2_000;
    const reg = new TenantQuotaRegistry(tiers({ bucketCapacity: capacity, refillTokensPerSec: refill }));
    // Drain the bucket.
    const drain = await reg.acquire({ tenantId: 't', estimatedTokens: capacity });
    await drain.release(capacity, 0);

    // Small prompt, large real usage: est 10, actual 1,510 per call.
    const windowMs = 600;
    const start = Date.now();
    let consumed = 0;
    while (Date.now() - start < windowMs) {
      try {
        const lease = await reg.acquire({ tenantId: 't', estimatedTokens: 10 });
        await lease.release(10, 1_500);
        consumed += 1_510;
      } catch (err) {
        expect(err).toBeInstanceOf(TenantTokenBudgetExceededError);
      }
      await new Promise((r) => setTimeout(r, 5));
    }
    // A 0 floor admitted a call every ~10ms here (~90k tokens).
    expect(consumed).toBeLessThanOrEqual(capacity + (refill * windowMs) / 1_000);
  });
});

describe('GATEWAY-05 — ProviderTenantQuotaWrapper reserves what the call can spend', () => {
  function capturingQuota(): { quota: QuotaStore; estimates: number[] } {
    const estimates: number[] = [];
    return {
      estimates,
      quota: {
        acquire: async ({ estimatedTokens }) => {
          estimates.push(estimatedTokens);
          return { release: async () => undefined };
        },
      },
    };
  }

  const inner: LLMProvider = {
    name: 'stub',
    complete: async (): Promise<LLMResponse> => ({
      content: 'ok',
      model: 'gpt-4o',
      provider: 'stub',
      tokenUsage: { input: 1, output: 1, total: 2 },
      latencyMs: 1,
    }),
    isAvailable: async () => true,
  };

  const mmsRequest: LLMRequest = {
    taskType: 'mms_estimate',
    tenantId: 't',
    maxTokens: 4_096,
    messages: [
      { role: 'system', content: 'You price jobs from photos.' },
      {
        role: 'user',
        content: 'Quote this',
        parts: [
          { type: 'text', text: 'Water heater in the garage, leaking at the base.' },
          { type: 'image', url: 'https://example.com/a.jpg' },
          { type: 'image', url: 'https://example.com/b.jpg', detail: 'low' },
        ],
      },
    ],
  };

  it('counts content, text parts, a per-image allowance and maxTokens', async () => {
    const { quota, estimates } = capturingQuota();
    await new ProviderTenantQuotaWrapper(inner, quota).complete(mmsRequest);

    const contentOnly =
      estimateTokens('You price jobs from photos.') + estimateTokens('Quote this');
    const expected =
      contentOnly +
      estimateTokens('Water heater in the garage, leaking at the base.') +
      2 * IMAGE_PART_TOKEN_ALLOWANCE +
      4_096;
    expect(estimates).toEqual([expected]);
    expect(estimates[0]).toBeGreaterThan(contentOnly);
    expect(estimateRequestTokens(mmsRequest)).toBe(expected);
  });

  it('adds nothing for maxTokens when the request does not set it', () => {
    const req: LLMRequest = {
      taskType: 'x',
      messages: [{ role: 'user', content: 'abcdefgh' }],
    };
    expect(estimateRequestTokens(req)).toBe(2);
  });

  it('tolerates malformed parts without throwing', () => {
    const req = {
      taskType: 'x',
      messages: [{ role: 'user', content: 'abcd', parts: [null, { type: 'text' }] }],
    } as unknown as LLMRequest;
    expect(estimateRequestTokens(req)).toBe(1);
  });
});
