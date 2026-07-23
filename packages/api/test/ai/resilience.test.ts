/**
 * Vitest specs for the resilience layer:
 *   - retry: error classification, jitter bounds, deadline-aware skip
 *   - breaker: closed → open → half-open → closed hysteresis
 *   - tenant-quota: concurrency cap + token bucket
 *   - deadline: AbortSignal propagation
 */
import { describe, it, expect } from 'vitest';
import {
  classifyError,
  isRetryable,
  backoffDelayMs,
  runWithRetry,
  DEFAULT_RETRY,
} from '../../src/ai/gateway/retry';
import {
  CircuitBreakerRegistry,
  BreakerOpenError,
  DEFAULT_BREAKER,
} from '../../src/ai/gateway/breaker';
import {
  TenantQuotaRegistry,
  TenantConcurrencyExceededError,
  TenantTokenBudgetExceededError,
} from '../../src/ai/gateway/tenant-quota';
import {
  createDeadlineContext,
  DeadlineExceededError,
  isDeadlineExceeded,
} from '../../src/ai/gateway/deadline';

describe('retry classifyError', () => {
  it('treats 429 as rate_limited', () => {
    const err: Error & { status?: number } = new Error('429 too many');
    err.status = 429;
    expect(classifyError(err)).toBe('rate_limited');
  });
  it('treats 5xx as transient', () => {
    const err: Error & { status?: number } = new Error('boom');
    err.status = 503;
    expect(classifyError(err)).toBe('transient');
  });
  it('treats 4xx (non-429) as permanent', () => {
    const err: Error & { status?: number } = new Error('bad');
    err.status = 400;
    expect(classifyError(err)).toBe('permanent');
  });
  it('treats ECONNRESET-ish messages as transient', () => {
    expect(classifyError(new Error('socket hang up'))).toBe('transient');
  });
  it('treats DeadlineExceededError as timeout', () => {
    expect(classifyError(new DeadlineExceededError(100))).toBe('timeout');
  });
  it('treats OpenAI Request-was-aborted as timeout (deadline signal)', () => {
    expect(classifyError(new Error('Request was aborted.'))).toBe('timeout');
    const abortErr = new Error('The operation was aborted');
    abortErr.name = 'AbortError';
    expect(classifyError(abortErr)).toBe('timeout');
  });
});

describe('retry backoffDelayMs', () => {
  it('respects the cap', () => {
    const policy = { ...DEFAULT_RETRY, baseDelayMs: 100, capDelayMs: 1000 };
    const rng = () => 0.999;
    for (let i = 0; i < 10; i++) {
      const d = backoffDelayMs(i, policy, rng);
      expect(d).toBeLessThanOrEqual(1000);
    }
  });
  it('returns 0 when rng yields 0', () => {
    expect(backoffDelayMs(3, DEFAULT_RETRY, () => 0)).toBe(0);
  });
});

describe('retry isRetryable', () => {
  it('skips when remaining deadline is below the minimum budget', () => {
    expect(isRetryable('transient', 1, DEFAULT_RETRY, 200)).toBe(false);
  });
  it('skips permanent errors', () => {
    expect(isRetryable('permanent', 1, DEFAULT_RETRY, 5_000)).toBe(false);
  });
  it('allows transient retries within budget', () => {
    expect(isRetryable('transient', 1, DEFAULT_RETRY, 5_000)).toBe(true);
  });
});

describe('runWithRetry', () => {
  it('succeeds on the first attempt without retrying', async () => {
    let calls = 0;
    const result = await runWithRetry(
      async () => {
        calls++;
        return 'ok';
      },
      { sleep: async () => {}, rng: () => 0 },
    );
    expect(result).toBe('ok');
    expect(calls).toBe(1);
  });
  it('retries transient errors then succeeds', async () => {
    let calls = 0;
    const result = await runWithRetry(
      async () => {
        calls++;
        if (calls < 2) {
          const err: Error & { status?: number } = new Error('boom');
          err.status = 503;
          throw err;
        }
        return 'ok';
      },
      { sleep: async () => {}, rng: () => 0 },
    );
    expect(result).toBe('ok');
    expect(calls).toBe(2);
  });
  it('does not retry permanent errors', async () => {
    let calls = 0;
    await expect(
      runWithRetry(
        async () => {
          calls++;
          const err: Error & { status?: number } = new Error('bad');
          err.status = 400;
          throw err;
        },
        { sleep: async () => {} },
      ),
    ).rejects.toThrow('bad');
    expect(calls).toBe(1);
  });
});

describe('CircuitBreakerRegistry', () => {
  it('opens on consecutive-failure threshold', async () => {
    const reg = new CircuitBreakerRegistry({
      ...DEFAULT_BREAKER,
      consecutiveFailureThreshold: 3,
      cooldownMs: 50,
    });
    const parts = { provider: 'p', modelFamily: 'm' };
    for (let i = 0; i < 3; i++) {
      await expect(
        reg.run(parts, async () => {
          throw new Error('boom');
        }),
      ).rejects.toThrow('boom');
    }
    await expect(reg.run(parts, async () => 'ok')).rejects.toBeInstanceOf(BreakerOpenError);
  });

  it('transitions through open → half-open → closed', async () => {
    const reg = new CircuitBreakerRegistry({
      ...DEFAULT_BREAKER,
      consecutiveFailureThreshold: 2,
      cooldownMs: 20,
      halfOpenProbeCount: 2,
      halfOpenSuccessRatio: 0.5,
    });
    const parts = { provider: 'p2', modelFamily: 'm' };
    await expect(
      reg.run(parts, async () => {
        throw new Error('e');
      }),
    ).rejects.toThrow();
    await expect(
      reg.run(parts, async () => {
        throw new Error('e');
      }),
    ).rejects.toThrow();
    expect(reg.cell(parts).getState()).toBe('open');

    await new Promise((r) => setTimeout(r, 30));
    // After cooldown, the cell should now be in half-open and pass.
    expect(reg.cell(parts).canPass()).toBe(true);
    const ok = await reg.run(parts, async () => 'ok');
    expect(ok).toBe('ok');
    const ok2 = await reg.run(parts, async () => 'ok');
    expect(ok2).toBe('ok');
    expect(reg.cell(parts).getState()).toBe('closed');
  });

  it('caps CONCURRENT half-open probes at halfOpenProbeCount (no stampede)', async () => {
    const reg = new CircuitBreakerRegistry({
      ...DEFAULT_BREAKER,
      consecutiveFailureThreshold: 2,
      cooldownMs: 20,
      halfOpenProbeCount: 2,
      halfOpenSuccessRatio: 0.5,
    });
    const parts = { provider: 'p3', modelFamily: 'm' };
    for (let i = 0; i < 2; i++) {
      await expect(
        reg.run(parts, async () => {
          throw new Error('e');
        }),
      ).rejects.toThrow();
    }
    await new Promise((r) => setTimeout(r, 30));
    expect(reg.cell(parts).getState()).toBe('half-open');

    // Fire 5 requests at once while half-open, each op held open until we
    // release it. run() must reserve a probe slot atomically — only 2 ops
    // may start; the rest reject with BreakerOpenError instead of flooding
    // the recovering provider.
    let started = 0;
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const results = await Promise.allSettled(
      Array.from({ length: 5 }, () =>
        reg.run(parts, async () => {
          started++;
          await gate;
          return 'ok';
        }).finally(() => release()),
      ),
    );
    expect(started).toBe(2);
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(rejected).toHaveLength(3);
    for (const r of rejected) {
      expect((r as PromiseRejectedResult).reason).toBeInstanceOf(BreakerOpenError);
    }
  });
});

describe('TenantQuotaRegistry', () => {
  it('rejects when concurrency cap is full', async () => {
    const reg = new TenantQuotaRegistry({
      standard: {
        maxConcurrency: 1,
        bucketCapacity: 100,
        refillTokensPerSec: 10,
        hardUpperBoundTokens: 1000,
      },
    });
    await reg.acquire({ tenantId: 't1', estimatedTokens: 10 });
    await expect(reg.acquire({ tenantId: 't1', estimatedTokens: 10 })).rejects.toBeInstanceOf(
      TenantConcurrencyExceededError,
    );
  });

  it('rejects when token bucket is empty', async () => {
    const reg = new TenantQuotaRegistry({
      standard: {
        maxConcurrency: 5,
        bucketCapacity: 5,
        refillTokensPerSec: 1,
        hardUpperBoundTokens: 1000,
      },
    });
    await expect(
      reg.acquire({ tenantId: 't2', estimatedTokens: 100 }),
    ).rejects.toBeInstanceOf(TenantTokenBudgetExceededError);
  });

  it('refunds unused tokens on release', async () => {
    const reg = new TenantQuotaRegistry({
      standard: {
        maxConcurrency: 5,
        bucketCapacity: 100,
        refillTokensPerSec: 1,
        hardUpperBoundTokens: 1000,
      },
    });
    const lease = await reg.acquire({ tenantId: 't3', estimatedTokens: 50 });
    await lease.release(10, 5); // actual = 15, refund 35
    // Should be able to acquire another 80 tokens now.
    const lease2 = await reg.acquire({ tenantId: 't3', estimatedTokens: 80 });
    await lease2.release();
  });
});

describe('deadline context', () => {
  it('expires on time', async () => {
    const ctx = createDeadlineContext(50);
    await new Promise((r) => setTimeout(r, 80));
    expect(ctx.isExpired()).toBe(true);
    expect(ctx.signal.aborted).toBe(true);
    expect(isDeadlineExceeded(ctx.signal.reason)).toBe(true);
  });

  it('reports decreasing remainingMs', () => {
    const ctx = createDeadlineContext(1_000);
    const r1 = ctx.remainingMs();
    expect(r1).toBeLessThanOrEqual(1_000);
    expect(r1).toBeGreaterThan(0);
    ctx.abort();
  });
});
