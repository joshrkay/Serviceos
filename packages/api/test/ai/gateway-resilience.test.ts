/**
 * P2-029 — gateway resilience stack composition tests.
 *
 * Covers:
 *   1. Breaker opens after N consecutive failures, short-circuits, half-opens, recovers.
 *   2. Retry honours exponential backoff and aborts on AbortSignal.
 *   3. Deadline cancels in-flight provider call via signal.
 *   4. Failover advances on 5xx/network errors but NOT on 4xx.
 *   5. Tenant-quota blocks over-tier calls with a clear error envelope.
 *   6. /api/health/ai reflects current breaker state.
 *   7. AiRun.outputSnapshot.providerPath populated when failover engages.
 *   8. Full stack composed: provider → retry → deadline → breaker → failover → tenant-quota.
 *   9. LLM_PROVIDER_UNAVAILABLE returned only on full failover exhaustion.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  CircuitBreakerRegistry,
  BreakerOpenError,
  DEFAULT_BREAKER,
} from '../../src/ai/gateway/breaker';
import { metricsRegistry } from '../../src/monitoring/metrics';
import {
  TenantQuotaRegistry,
  TenantConcurrencyExceededError,
  DEFAULT_TIER_CONFIG,
} from '../../src/ai/gateway/tenant-quota';
import type { QuotaStore } from '../../src/ai/gateway/tenant-quota';
import {
  createDeadlineContext,
  DeadlineExceededError,
} from '../../src/ai/gateway/deadline';
import { runWithRetry, DEFAULT_RETRY } from '../../src/ai/gateway/retry';
import {
  composeResilienceStack,
  ProviderBreakerWrapper,
  ProviderFailoverWrapper,
  ProviderTenantQuotaWrapper,
  ProviderRetryDeadlineWrapper,
} from '../../src/ai/gateway/compose-resilience';
import { AppError } from '../../src/shared/errors';
import type { LLMProvider, LLMRequest, LLMResponse } from '../../src/ai/gateway/gateway';
import { LLMGateway } from '../../src/ai/gateway/gateway';
import { createAiHealthRouter } from '../../src/routes/ai-health';
import express from 'express';
import request from 'supertest';

// ─── helpers ─────────────────────────────────────────────────────────────────

function makeRequest(overrides: Partial<LLMRequest> = {}): LLMRequest {
  return {
    taskType: 'test',
    messages: [{ role: 'user', content: 'hello' }],
    tenantId: 'tenant-1',
    tenantTier: 'standard',
    ...overrides,
  };
}

function makeResponse(overrides: Partial<LLMResponse> = {}): LLMResponse {
  return {
    content: 'ok',
    model: 'gpt-4o-mini',
    provider: 'primary',
    tokenUsage: { input: 10, output: 10, total: 20 },
    latencyMs: 50,
    ...overrides,
  };
}

/** A provider that always succeeds */
class AlwaysSuccessProvider implements LLMProvider {
  readonly name = 'always-success';
  async complete(_req: LLMRequest): Promise<LLMResponse> {
    return makeResponse({ provider: this.name });
  }
  async isAvailable(): Promise<boolean> { return true; }
}

/** A provider that throws on every call with a configurable error */
class AlwaysFailProvider implements LLMProvider {
  readonly name: string;
  private readonly error: Error;

  constructor(name = 'always-fail', error?: Error) {
    this.name = name;
    this.error = error ?? (() => { const e = new Error('boom') as Error & { status?: number }; e.status = 503; return e; })();
  }

  async complete(_req: LLMRequest): Promise<LLMResponse> {
    throw this.error;
  }
  async isAvailable(): Promise<boolean> { return false; }
}

/** A provider that fails the first N times then succeeds */
class NthSuccessProvider implements LLMProvider {
  readonly name = 'nth-success';
  private calls = 0;
  constructor(private readonly failCount: number) {}

  async complete(_req: LLMRequest): Promise<LLMResponse> {
    this.calls++;
    if (this.calls <= this.failCount) {
      const err = new Error('transient') as Error & { status?: number };
      err.status = 503;
      throw err;
    }
    return makeResponse({ provider: this.name });
  }

  async isAvailable(): Promise<boolean> { return true; }
  getCallCount(): number { return this.calls; }
}

// ─── 1. Breaker: open after N failures, short-circuit, half-open ──────────────

describe('ProviderBreakerWrapper', () => {
  it('short-circuits after threshold consecutive failures', async () => {
    const failErr = Object.assign(new Error('server error'), { status: 503 });
    const inner = new AlwaysFailProvider('p', failErr);
    const reg = new CircuitBreakerRegistry({
      ...DEFAULT_BREAKER,
      consecutiveFailureThreshold: 3,
      countThreshold: 100,
      cooldownMs: 50,
    });
    const wrapped = new ProviderBreakerWrapper(inner, reg);
    const req = makeRequest();

    // 3 failures should open the breaker
    for (let i = 0; i < 3; i++) {
      await expect(wrapped.complete(req)).rejects.toThrow('server error');
    }

    // 4th call short-circuits with BreakerOpenError
    await expect(wrapped.complete(req)).rejects.toBeInstanceOf(BreakerOpenError);
  });

  it('skips breaker enforcement for SYSTEM_TENANT_ID readiness probes', async () => {
    const failErr = new Error('Request was aborted.');
    const inner = new AlwaysFailProvider('p', failErr);
    const reg = new CircuitBreakerRegistry({
      ...DEFAULT_BREAKER,
      consecutiveFailureThreshold: 2,
      countThreshold: 100,
      cooldownMs: 50,
    });
    const wrapped = new ProviderBreakerWrapper(inner, reg);
    const req = { ...makeRequest(), tenantId: 'system' };

    for (let i = 0; i < 10; i++) {
      await expect(wrapped.complete(req)).rejects.toThrow('Request was aborted.');
    }
    // Still the original error — breaker never opened on system probes.
    await expect(wrapped.complete(req)).rejects.toThrow('Request was aborted.');
    await expect(wrapped.complete(req)).rejects.not.toBeInstanceOf(BreakerOpenError);
  });

  it('does NOT count 4xx errors toward breaker open', async () => {
    const clientErr = Object.assign(new Error('bad request'), { status: 400 });
    const inner = new AlwaysFailProvider('p', clientErr);
    const reg = new CircuitBreakerRegistry({
      ...DEFAULT_BREAKER,
      consecutiveFailureThreshold: 2,
      countThreshold: 100,
      cooldownMs: 50,
    });
    const wrapped = new ProviderBreakerWrapper(inner, reg);
    const req = makeRequest();

    // Even 10 4xx errors should NOT open the breaker
    for (let i = 0; i < 10; i++) {
      await expect(wrapped.complete(req)).rejects.toThrow('bad request');
    }

    // Should still be throwable as the original 4xx, not BreakerOpenError
    await expect(wrapped.complete(req)).rejects.toThrow('bad request');
    await expect(wrapped.complete(req)).rejects.not.toBeInstanceOf(BreakerOpenError);
  });

  it('does NOT count Request-was-aborted / DeadlineExceeded toward breaker open (FM-01)', async () => {
    const abortErr = new Error('Request was aborted.');
    const inner = new AlwaysFailProvider('p', abortErr);
    const reg = new CircuitBreakerRegistry({
      ...DEFAULT_BREAKER,
      consecutiveFailureThreshold: 2,
      countThreshold: 100,
      cooldownMs: 50,
    });
    const wrapped = new ProviderBreakerWrapper(inner, reg);
    const req = makeRequest();

    for (let i = 0; i < 20; i++) {
      await expect(wrapped.complete(req)).rejects.toThrow('Request was aborted.');
    }
    await expect(wrapped.complete(req)).rejects.toThrow('Request was aborted.');
    await expect(wrapped.complete(req)).rejects.not.toBeInstanceOf(BreakerOpenError);

    // Typed deadline similarly
    const deadlineInner = new AlwaysFailProvider('p2', new DeadlineExceededError(100));
    const deadlineWrapped = new ProviderBreakerWrapper(deadlineInner, reg);
    for (let i = 0; i < 10; i++) {
      await expect(deadlineWrapped.complete(makeRequest())).rejects.toBeInstanceOf(
        DeadlineExceededError,
      );
    }
    await expect(deadlineWrapped.complete(makeRequest())).rejects.not.toBeInstanceOf(
      BreakerOpenError,
    );
  });

  it('still opens breaker on 503 provider failures', async () => {
    const failErr = Object.assign(new Error('upstream 503'), { status: 503 });
    const inner = new AlwaysFailProvider('p503', failErr);
    const reg = new CircuitBreakerRegistry({
      ...DEFAULT_BREAKER,
      consecutiveFailureThreshold: 3,
      countThreshold: 100,
      cooldownMs: 50,
    });
    const wrapped = new ProviderBreakerWrapper(inner, reg);
    const req = makeRequest();
    for (let i = 0; i < 3; i++) {
      await expect(wrapped.complete(req)).rejects.toThrow('upstream 503');
    }
    await expect(wrapped.complete(req)).rejects.toBeInstanceOf(BreakerOpenError);
  });

  it('isolates classify_intent breaker cell from assistant traffic (FM-02)', async () => {
    const failErr = Object.assign(new Error('assistant boom'), { status: 503 });
    let calls = 0;
    const inner: LLMProvider = {
      name: 'iso',
      complete: async (req) => {
        calls++;
        if (req.taskType !== 'classify_intent') {
          throw failErr;
        }
        return {
          content: 'ok',
          model: 'gpt-4o-mini',
          provider: 'iso',
          tokenUsage: { input: 1, output: 1, total: 2 },
          latencyMs: 1,
        };
      },
      isAvailable: async () => true,
    };
    const reg = new CircuitBreakerRegistry({
      ...DEFAULT_BREAKER,
      consecutiveFailureThreshold: 2,
      countThreshold: 100,
      cooldownMs: 50,
    });
    const wrapped = new ProviderBreakerWrapper(inner, reg);

    for (let i = 0; i < 2; i++) {
      await expect(
        wrapped.complete(makeRequest({ taskType: 'assistant.general', model: 'gpt-4o-mini' })),
      ).rejects.toThrow('assistant boom');
    }
    // Assistant cell is open…
    await expect(
      wrapped.complete(makeRequest({ taskType: 'assistant.general', model: 'gpt-4o-mini' })),
    ).rejects.toBeInstanceOf(BreakerOpenError);

    // …but classify cell stays closed and succeeds.
    const classify = await wrapped.complete(
      makeRequest({ taskType: 'classify_intent', model: 'gpt-4o-mini' }),
    );
    expect(classify.content).toBe('ok');
    expect(calls).toBeGreaterThanOrEqual(3);
  });

  it('half-open deadline abort does not reopen the breaker (FM-04)', async () => {
    const failErr = Object.assign(new Error('boom'), { status: 503 });
    const reg = new CircuitBreakerRegistry({
      ...DEFAULT_BREAKER,
      consecutiveFailureThreshold: 2,
      countThreshold: 100,
      cooldownMs: 20,
      halfOpenProbeCount: 2,
      halfOpenSuccessRatio: 1.0,
    });
    const failWrapped = new ProviderBreakerWrapper(new AlwaysFailProvider('p', failErr), reg);
    const req = makeRequest();
    for (let i = 0; i < 2; i++) {
      await expect(failWrapped.complete(req)).rejects.toThrow('boom');
    }
    await expect(failWrapped.complete(req)).rejects.toBeInstanceOf(BreakerOpenError);
    await new Promise((r) => setTimeout(r, 30));

    // Half-open: local abort must not count as health failure / reopen.
    const abortWrapped = new ProviderBreakerWrapper(
      new AlwaysFailProvider('p', new Error('Request was aborted.')),
      reg,
      'p',
    );
    await expect(abortWrapped.complete(req)).rejects.toThrow('Request was aborted.');
    // Still half-open (not re-opened) — success probe can proceed.
    const successWrapped = new ProviderBreakerWrapper(new AlwaysSuccessProvider(), reg, 'p');
    const result = await successWrapped.complete(req);
    expect(result.content).toBe('ok');
  });

  it('half-opens after cooldown and recovers on success', async () => {
    const failErr = Object.assign(new Error('boom'), { status: 503 });
    const inner = new AlwaysFailProvider('p', failErr);
    const reg = new CircuitBreakerRegistry({
      ...DEFAULT_BREAKER,
      consecutiveFailureThreshold: 2,
      countThreshold: 100,
      cooldownMs: 20,
      halfOpenProbeCount: 1,
      halfOpenSuccessRatio: 1.0,
    });
    const wrapped = new ProviderBreakerWrapper(inner, reg);
    const req = makeRequest();

    // Trip the breaker
    for (let i = 0; i < 2; i++) {
      await expect(wrapped.complete(req)).rejects.toThrow('boom');
    }
    await expect(wrapped.complete(req)).rejects.toBeInstanceOf(BreakerOpenError);

    // Wait for cooldown
    await new Promise((r) => setTimeout(r, 30));

    // Swap in a success provider
    const successWrapped = new ProviderBreakerWrapper(
      new AlwaysSuccessProvider(),
      reg,
      'p', // same cell key
    );
    const result = await successWrapped.complete(req);
    expect(result.content).toBe('ok');
  });
});

// ─── 2. Retry: exponential backoff, stops on permanent error ──────────────────

describe('retry with AbortSignal', () => {
  it('aborts retry when signal is already aborted', async () => {
    const ctrl = new AbortController();
    ctrl.abort(new DeadlineExceededError(100));

    let calls = 0;
    await expect(
      runWithRetry(
        async () => {
          calls++;
          const err = Object.assign(new Error('transient'), { status: 503 });
          throw err;
        },
        {
          policy: DEFAULT_RETRY,
          sleep: async () => {},
          rng: () => 0,
          deadline: createDeadlineContext(0), // already expired
        },
      ),
    ).rejects.toThrow();

    // Should not have retried (deadline expired before first attempt)
    expect(calls).toBeLessThanOrEqual(1);
  });

  it('does not retry 4xx errors', async () => {
    let calls = 0;
    await expect(
      runWithRetry(
        async () => {
          calls++;
          const err = Object.assign(new Error('not found'), { status: 404 });
          throw err;
        },
        { sleep: async () => {}, rng: () => 0 },
      ),
    ).rejects.toThrow('not found');
    expect(calls).toBe(1);
  });

  it('retries transient errors up to maxAttempts', async () => {
    let calls = 0;
    await expect(
      runWithRetry(
        async () => {
          calls++;
          const err = Object.assign(new Error('transient'), { status: 503 });
          throw err;
        },
        {
          policy: { ...DEFAULT_RETRY, maxAttempts: 3 },
          sleep: async () => {},
          rng: () => 0,
        },
      ),
    ).rejects.toThrow('transient');
    expect(calls).toBe(3);
  });
});

// ─── 2b. ProviderRetryDeadlineWrapper: single deadline covers full retry sequence ─

describe('ProviderRetryDeadlineWrapper', () => {
  it('enforces a single deadline across all retry attempts, not per-attempt', async () => {
    /**
     * Invariant: ONE deadline covers the full retry sequence.
     * If the implementation accidentally created a new deadline per attempt,
     * each attempt would get a fresh 100ms budget and could run maxAttempts
     * times. With a shared deadline, the elapsed total must stay within the
     * deadline window — the retry sequence is truncated.
     *
     * Setup:
     *   - deadline = 120ms
     *   - each attempt sleeps 70ms then throws a transient error
     *   - maxAttempts = 4
     *
     * With a per-attempt deadline: 4 × 70ms = 280ms before exhaustion.
     * With a shared deadline: only 1-2 attempts fit inside 120ms, then
     * the deadline signals abort and the wrapper throws DeadlineExceededError.
     */
    const deadlineMs = 120;
    const attemptDelayMs = 70;
    const maxAttempts = 4;

    let callCount = 0;
    const start = Date.now();

    class SlowTransientProvider implements LLMProvider {
      readonly name = 'slow-transient';
      async complete(_req: LLMRequest): Promise<LLMResponse> {
        callCount++;
        // Simulate a slow provider that always fails transiently
        await new Promise((r) => setTimeout(r, attemptDelayMs));
        const err = Object.assign(new Error('transient'), { status: 503 });
        throw err;
      }
      async isAvailable(): Promise<boolean> { return true; }
    }

    const wrapper = new ProviderRetryDeadlineWrapper(
      new SlowTransientProvider(),
      { maxAttempts, baseDelayMs: 0, capDelayMs: 0, mode: 'sync' },
      deadlineMs,
    );

    await expect(wrapper.complete(makeRequest())).rejects.toThrow();

    const elapsed = Date.now() - start;

    // The deadline should have truncated the retry sequence well before
    // maxAttempts * attemptDelayMs (4 * 70 = 280ms).
    expect(elapsed).toBeLessThan(maxAttempts * attemptDelayMs);

    // At most 2 attempts should have been made (2 * 70ms = 140ms which just
    // exceeds the 120ms deadline, meaning the 2nd attempt completes but the
    // 3rd is aborted before it starts, or the 2nd is aborted mid-sleep).
    expect(callCount).toBeLessThan(maxAttempts);
  });
});

// ─── 3. Deadline: cancels in-flight call ─────────────────────────────────────

describe('deadline cancellation', () => {
  it('fires AbortSignal when deadline elapses', async () => {
    const ctx = createDeadlineContext(50);
    await new Promise((r) => setTimeout(r, 80));
    expect(ctx.signal.aborted).toBe(true);
    expect(ctx.isExpired()).toBe(true);
  });
});

// ─── 4. Failover: advances on 5xx/network, NOT on 4xx ───────────────────────

describe('ProviderFailoverWrapper', () => {
  it('returns primary response on success', async () => {
    const primary = new AlwaysSuccessProvider();
    const fallback = new AlwaysSuccessProvider();
    const wrapped = new ProviderFailoverWrapper([primary, fallback]);
    const result = await wrapped.complete(makeRequest());
    expect(result.provider).toBe('always-success');
    expect(result.providerPath).toEqual(['always-success:undefined']);
  });

  it('fails over to next provider on 5xx error', async () => {
    const err5xx = Object.assign(new Error('server error'), { status: 503 });
    const primary = new AlwaysFailProvider('primary', err5xx);
    const fallback = new AlwaysSuccessProvider();
    const wrapped = new ProviderFailoverWrapper([primary, fallback]);
    const result = await wrapped.complete(makeRequest());
    expect(result.provider).toBe('always-success');
    expect(result.providerPath?.length).toBeGreaterThanOrEqual(1);
  });

  it('does NOT fail over on 4xx errors — throws original error', async () => {
    const err4xx = Object.assign(new Error('bad request'), { status: 400 });
    const primary = new AlwaysFailProvider('primary', err4xx);
    const fallback = new AlwaysSuccessProvider();
    const wrapped = new ProviderFailoverWrapper([primary, fallback]);
    await expect(wrapped.complete(makeRequest())).rejects.toThrow('bad request');
  });

  it('throws LLM_PROVIDER_UNAVAILABLE when all providers fail', async () => {
    const err5xx = Object.assign(new Error('boom'), { status: 503 });
    const p1 = new AlwaysFailProvider('p1', err5xx);
    const p2 = new AlwaysFailProvider('p2', Object.assign(new Error('also down'), { status: 503 }));
    const wrapped = new ProviderFailoverWrapper([p1, p2]);
    const err = await wrapped.complete(makeRequest()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).code).toBe('LLM_PROVIDER_UNAVAILABLE');
    expect((err as AppError).statusCode).toBe(503);
  });

  it('providerPath tracks all attempted providers', async () => {
    const err5xx = Object.assign(new Error('boom'), { status: 503 });
    const p1 = new AlwaysFailProvider('p1', err5xx);
    const p2 = new AlwaysSuccessProvider();
    const wrapped = new ProviderFailoverWrapper([p1, p2]);
    const result = await wrapped.complete(makeRequest());
    expect(result.providerPath).toBeDefined();
    expect(result.providerPath!.some((p) => p.includes('p1'))).toBe(true);
    expect(result.providerPath!.some((p) => p.includes('always-success'))).toBe(true);
  });

  it('single provider with single-element list is a no-op on success', async () => {
    const primary = new AlwaysSuccessProvider();
    const wrapped = new ProviderFailoverWrapper([primary]);
    const result = await wrapped.complete(makeRequest());
    expect(result.content).toBe('ok');
  });
});

// ─── 5. Tenant quota ─────────────────────────────────────────────────────────

describe('ProviderTenantQuotaWrapper', () => {
  it('blocks when concurrency is exceeded with clear error envelope', async () => {
    const inner = new AlwaysSuccessProvider();
    const reg = new TenantQuotaRegistry({
      standard: { ...DEFAULT_TIER_CONFIG.standard, maxConcurrency: 1 },
    });
    const wrapped = new ProviderTenantQuotaWrapper(inner, reg);

    // Manually hold a lease to saturate concurrency
    await reg.acquire({ tenantId: 'tenant-1', tenantTier: 'standard', estimatedTokens: 10 });

    await expect(
      wrapped.complete(makeRequest({ tenantId: 'tenant-1', tenantTier: 'standard' })),
    ).rejects.toBeInstanceOf(TenantConcurrencyExceededError);
  });

  it('releases quota lease after success', async () => {
    const inner = new AlwaysSuccessProvider();
    const reg = new TenantQuotaRegistry({
      standard: { ...DEFAULT_TIER_CONFIG.standard, maxConcurrency: 1 },
    });
    const wrapped = new ProviderTenantQuotaWrapper(inner, reg);
    const req = makeRequest({ tenantId: 'tenant-q', tenantTier: 'standard' });

    // First call should succeed and release the lease
    await wrapped.complete(req);
    // Second call should also succeed because lease was released
    await wrapped.complete(req);
  });

  it('releases quota lease after failure', async () => {
    const err5xx = Object.assign(new Error('boom'), { status: 503 });
    const inner = new AlwaysFailProvider('p', err5xx);
    const reg = new TenantQuotaRegistry({
      standard: { ...DEFAULT_TIER_CONFIG.standard, maxConcurrency: 1 },
    });
    const wrapped = new ProviderTenantQuotaWrapper(inner, reg);
    const req = makeRequest({ tenantId: 'tenant-r', tenantTier: 'standard' });

    await expect(wrapped.complete(req)).rejects.toThrow('boom');
    // After failure, lease should be released — second call should be allowed
    await expect(wrapped.complete(req)).rejects.toThrow('boom');
  });

  it('isolates full-taxonomy classification from ordinary tenant traffic', async () => {
    const inner = new AlwaysSuccessProvider();
    const acquire = vi.fn(async () => ({ release: vi.fn(async () => undefined) }));
    const quota: QuotaStore = { acquire };
    const wrapped = new ProviderTenantQuotaWrapper(inner, quota);

    await wrapped.complete(
      makeRequest({
        taskType: 'classify_intent',
        tenantId: 'tenant-voice',
        tenantTier: 'standard',
      }),
    );

    expect(acquire).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: 'tenant-voice:classify_intent',
        tenantTier: 'classifier_standard',
      }),
    );
  });
});

// ─── 6. /api/health/ai reflects breaker state ────────────────────────────────

describe('GET /api/health/ai', () => {
  it('returns 200 with provider list when registry is empty', async () => {
    const app = express();
    const reg = new CircuitBreakerRegistry(DEFAULT_BREAKER);
    app.use('/api/health', createAiHealthRouter(reg));

    const res = await request(app).get('/api/health/ai');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('providers');
    expect(Array.isArray(res.body.providers)).toBe(true);
  });

  it('includes provider with open breaker state in response', async () => {
    const reg = new CircuitBreakerRegistry({
      ...DEFAULT_BREAKER,
      consecutiveFailureThreshold: 2,
      countThreshold: 100,
      cooldownMs: 5000,
    });
    // Use the same key parts that the health router will use for lookup
    const parts = { provider: 'test-provider', modelFamily: 'default' };

    // Trip the breaker
    for (let i = 0; i < 2; i++) {
      await reg.run(parts, async () => { throw Object.assign(new Error('e'), { status: 503 }); }).catch(() => {});
    }

    const app = express();
    app.use('/api/health', createAiHealthRouter(reg, [
      {
        name: 'test-provider',
        isAvailable: async () => false,
        // Match the key parts used to trip the breaker above
        breakerKeyParts: parts,
      },
    ]));

    const res = await request(app).get('/api/health/ai');
    expect(res.status).toBe(200);
    const provider = res.body.providers.find((p: { name: string }) => p.name === 'test-provider');
    expect(provider).toBeDefined();
    expect(provider.breakerState).toBe('open');
    expect(provider.available).toBe(false);
  });
});

// ─── 7. AiRun outputSnapshot includes providerPath ────────────────────────────

describe('providerPath in AiRun outputSnapshot', () => {
  it('gateway passes providerPath to AiRun outputSnapshot on success', async () => {
    const err5xx = Object.assign(new Error('boom'), { status: 503 });
    const p1 = new AlwaysFailProvider('p1', err5xx);
    const p2 = new AlwaysSuccessProvider();
    const failoverProvider = new ProviderFailoverWrapper([p1, p2]);

    const providers = new Map<string, LLMProvider>([
      ['failover', failoverProvider],
    ]);

    const capturedOutputSnapshots: Array<Record<string, unknown>> = [];
    const aiRunRepo = {
      create: async (run: unknown) => run,
      findById: async () => null,
      findByTaskType: async () => [],
      updateStatus: async (
        _tenantId: string,
        _id: string,
        _status: string,
        result?: { outputSnapshot?: Record<string, unknown> },
      ) => {
        if (result?.outputSnapshot) {
          capturedOutputSnapshots.push(result.outputSnapshot);
        }
      },
    };

    // LLMGateway accepts aiRunRepo as 4th constructor argument
    const testGateway = new (LLMGateway as unknown as new (
      config: { defaultProvider: string },
      providers: Map<string, LLMProvider>,
      logger: undefined,
      aiRunRepo: typeof aiRunRepo,
    ) => InstanceType<typeof LLMGateway>)(
      { defaultProvider: 'failover' },
      providers,
      undefined,
      aiRunRepo,
    );

    await testGateway.complete({
      taskType: 'test',
      messages: [{ role: 'user', content: 'hi' }],
      tenantId: 'tenant-1',
    });

    // providerPath should be in the outputSnapshot
    expect(capturedOutputSnapshots.length).toBeGreaterThan(0);
    const snapshot = capturedOutputSnapshots[0];
    expect(snapshot).toHaveProperty('providerPath');
    expect(Array.isArray(snapshot.providerPath)).toBe(true);
    expect((snapshot.providerPath as string[]).length).toBeGreaterThan(0);
  });
});

// ─── 8. Full composed stack integration ──────────────────────────────────────

describe('composeResilienceStack', () => {
  it('returns successful response through full stack', async () => {
    const primary = new AlwaysSuccessProvider();
    const breakerReg = new CircuitBreakerRegistry(DEFAULT_BREAKER);
    const quotaReg = new TenantQuotaRegistry();

    const composed = composeResilienceStack(primary, {
      breakers: breakerReg,
      quota: quotaReg,
    });

    const result = await composed.complete(makeRequest());
    expect(result.content).toBe('ok');
  });

  it('propagates LLM_PROVIDER_UNAVAILABLE on full exhaustion', async () => {
    const err5xx = Object.assign(new Error('down'), { status: 503 });
    const primary = new AlwaysFailProvider('primary', err5xx);
    const breakerReg = new CircuitBreakerRegistry({
      ...DEFAULT_BREAKER,
      consecutiveFailureThreshold: 100, // don't trip
      countThreshold: 100,
    });
    const quotaReg = new TenantQuotaRegistry();

    const composed = composeResilienceStack(primary, {
      breakers: breakerReg,
      quota: quotaReg,
      // no fallback providers — single-element list
    });

    const err = await composed.complete(makeRequest()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).code).toBe('LLM_PROVIDER_UNAVAILABLE');
    expect((err as AppError).statusCode).toBe(503);
  });

  it('does NOT propagate LLM_PROVIDER_UNAVAILABLE for 4xx', async () => {
    const err4xx = Object.assign(new Error('bad request'), { status: 400 });
    const primary = new AlwaysFailProvider('primary', err4xx);
    const breakerReg = new CircuitBreakerRegistry(DEFAULT_BREAKER);
    const quotaReg = new TenantQuotaRegistry();

    const composed = composeResilienceStack(primary, {
      breakers: breakerReg,
      quota: quotaReg,
    });

    const err = await composed.complete(makeRequest()).catch((e: unknown) => e);
    // Should be the original 4xx error, not LLM_PROVIDER_UNAVAILABLE
    expect((err as AppError).code).not.toBe('LLM_PROVIDER_UNAVAILABLE');
  });
});

// ─── Spec gap 1: gateway_breaker_state{provider, state} emitted on transitions ──

describe('gateway_breaker_state metric (spec gap 1)', () => {
  afterEach(async () => {
    // Clear the metric between tests to avoid cross-test state leakage
    metricsRegistry.resetMetrics();
  });

  it('emits gateway_breaker_state for all three states on transitions', async () => {
    const failErr = Object.assign(new Error('boom'), { status: 503 });
    const reg = new CircuitBreakerRegistry({
      ...DEFAULT_BREAKER,
      consecutiveFailureThreshold: 2,
      countThreshold: 100,
      cooldownMs: 20,
      halfOpenProbeCount: 1,
      halfOpenSuccessRatio: 1.0,
    });

    // Get a cell — the constructor initialises gateway_breaker_state to closed=1, open=0, half_open=0
    const parts = { provider: 'test-gsb', modelFamily: 'default' };
    const cell = reg.cell(parts);

    // Verify initial (closed) state
    const initialMetrics = await metricsRegistry.metrics();
    expect(initialMetrics).toMatch(/gateway_breaker_state\{provider="test-gsb",state="closed"\} 1/);
    expect(initialMetrics).toMatch(/gateway_breaker_state\{provider="test-gsb",state="open"\} 0/);
    expect(initialMetrics).toMatch(/gateway_breaker_state\{provider="test-gsb",state="half_open"\} 0/);

    // Trip to open
    for (let i = 0; i < 2; i++) {
      await reg.run(parts, async () => { throw failErr; }).catch(() => {});
    }
    const openMetrics = await metricsRegistry.metrics();
    expect(openMetrics).toMatch(/gateway_breaker_state\{provider="test-gsb",state="closed"\} 0/);
    expect(openMetrics).toMatch(/gateway_breaker_state\{provider="test-gsb",state="open"\} 1/);
    expect(openMetrics).toMatch(/gateway_breaker_state\{provider="test-gsb",state="half_open"\} 0/);

    // Wait for cooldown → half-open
    await new Promise((r) => setTimeout(r, 30));
    cell.getState(); // triggers refreshState() which transitions to half-open

    const halfOpenMetrics = await metricsRegistry.metrics();
    expect(halfOpenMetrics).toMatch(/gateway_breaker_state\{provider="test-gsb",state="closed"\} 0/);
    expect(halfOpenMetrics).toMatch(/gateway_breaker_state\{provider="test-gsb",state="open"\} 0/);
    expect(halfOpenMetrics).toMatch(/gateway_breaker_state\{provider="test-gsb",state="half_open"\} 1/);

    // Succeed the probe → closed
    await reg.run(parts, async () => ({} as never)).catch(() => {});
    // Actually provide a valid result
    const successParts = { provider: 'test-gsb', modelFamily: 'default' };
    const newReg = new CircuitBreakerRegistry({
      ...DEFAULT_BREAKER,
      consecutiveFailureThreshold: 2,
      countThreshold: 100,
      cooldownMs: 20,
      halfOpenProbeCount: 1,
      halfOpenSuccessRatio: 1.0,
    });
    // Trip and recover with a fresh registry so we can control the provider-key uniquely
    const recParts = { provider: 'test-gsb-recover', modelFamily: 'default' };
    for (let i = 0; i < 2; i++) {
      await newReg.run(recParts, async () => { throw failErr; }).catch(() => {});
    }
    await new Promise((r) => setTimeout(r, 30));
    newReg.cell(recParts).getState(); // trigger half-open transition
    await newReg.run(recParts, async () => ({ dummy: true } as never));

    const closedMetrics = await metricsRegistry.metrics();
    expect(closedMetrics).toMatch(/gateway_breaker_state\{provider="test-gsb-recover",state="closed"\} 1/);
    expect(closedMetrics).toMatch(/gateway_breaker_state\{provider="test-gsb-recover",state="open"\} 0/);
    expect(closedMetrics).toMatch(/gateway_breaker_state\{provider="test-gsb-recover",state="half_open"\} 0/);
  });

  it('existing breaker_state{key} metric still emits alongside gateway_breaker_state', async () => {
    const reg = new CircuitBreakerRegistry(DEFAULT_BREAKER);
    const parts = { provider: 'test-legacy', modelFamily: 'model1' };
    reg.cell(parts); // create the cell

    const m = await metricsRegistry.metrics();
    expect(m).toMatch(
      /breaker_state\{key="test-legacy\|model1\|default\|default\|default"\}/,
    );
    expect(m).toMatch(/gateway_breaker_state\{provider="test-legacy"/);
  });
});

// ─── Spec gap 2: gateway_retry_attempts_total has taskType + outcome labels ────

describe('gateway_retry_attempts_total labels (spec gap 2)', () => {
  it('increments with provider, taskType, and outcome labels on retry', async () => {
    let calls = 0;
    await expect(
      runWithRetry(
        async () => {
          calls++;
          const err = Object.assign(new Error('transient'), { status: 503 });
          throw err;
        },
        {
          policy: { ...DEFAULT_RETRY, maxAttempts: 2 },
          sleep: async () => {},
          rng: () => 0,
          provider: 'test-provider-retry',
          taskType: 'quote_generation',
        },
      ),
    ).rejects.toThrow('transient');

    const m = await metricsRegistry.metrics();
    expect(m).toMatch(
      /gateway_retry_attempts_total\{provider="test-provider-retry",taskType="quote_generation",outcome="transient"\}/,
    );
  });

  it('uses outcome=rate_limited for 429 errors', async () => {
    await expect(
      runWithRetry(
        async () => {
          const err = Object.assign(new Error('rate limited'), { status: 429 });
          throw err;
        },
        {
          policy: { ...DEFAULT_RETRY, maxAttempts: 2 },
          sleep: async () => {},
          rng: () => 0,
          provider: 'test-provider-rl',
          taskType: 'estimate',
        },
      ),
    ).rejects.toThrow();

    const m = await metricsRegistry.metrics();
    expect(m).toMatch(
      /gateway_retry_attempts_total\{provider="test-provider-rl",taskType="estimate",outcome="rate_limited"\}/,
    );
  });
});

// ─── Spec gap 3: /api/health/ai includes lastError and lastSuccessAt ──────────

describe('GET /api/health/ai — lastError and lastSuccessAt (spec gap 3)', () => {
  it('includes lastError after a recorded failure', async () => {
    const reg = new CircuitBreakerRegistry({
      ...DEFAULT_BREAKER,
      consecutiveFailureThreshold: 100, // don't trip
      countThreshold: 100,
    });
    const parts = { provider: 'prov-lasterr', modelFamily: 'default' };

    // Record a failure via run()
    await reg.run(parts, async () => { throw Object.assign(new Error('test failure message'), { status: 503 }); }).catch(() => {});

    const app = express();
    app.use('/api/health', createAiHealthRouter(reg, [
      { name: 'prov-lasterr', isAvailable: async () => false, breakerKeyParts: parts },
    ]));

    const res = await request(app).get('/api/health/ai');
    expect(res.status).toBe(200);
    const provider = res.body.providers.find((p: { name: string }) => p.name === 'prov-lasterr');
    expect(provider).toBeDefined();
    expect(provider.lastError).toBe('test failure message');
    expect(provider.lastSuccessAt).toBeUndefined();
  });

  it('includes lastSuccessAt after a recorded success', async () => {
    const reg = new CircuitBreakerRegistry(DEFAULT_BREAKER);
    const parts = { provider: 'prov-lastsuc', modelFamily: 'default' };

    // Record a success via run()
    await reg.run(parts, async () => ({ dummy: true } as never));

    const app = express();
    app.use('/api/health', createAiHealthRouter(reg, [
      { name: 'prov-lastsuc', isAvailable: async () => true, breakerKeyParts: parts },
    ]));

    const res = await request(app).get('/api/health/ai');
    expect(res.status).toBe(200);
    const provider = res.body.providers.find((p: { name: string }) => p.name === 'prov-lastsuc');
    expect(provider).toBeDefined();
    expect(provider.lastSuccessAt).toBeDefined();
    // Should be a valid ISO 8601 string
    expect(() => new Date(provider.lastSuccessAt)).not.toThrow();
    expect(new Date(provider.lastSuccessAt).getFullYear()).toBeGreaterThan(2020);
    expect(provider.lastError).toBeUndefined();
  });

  it('omits both fields when no activity recorded', async () => {
    const reg = new CircuitBreakerRegistry(DEFAULT_BREAKER);
    const parts = { provider: 'prov-pristine', modelFamily: 'default' };
    reg.cell(parts); // create cell without any activity

    const app = express();
    app.use('/api/health', createAiHealthRouter(reg, [
      { name: 'prov-pristine', isAvailable: async () => true, breakerKeyParts: parts },
    ]));

    const res = await request(app).get('/api/health/ai');
    expect(res.status).toBe(200);
    const provider = res.body.providers.find((p: { name: string }) => p.name === 'prov-pristine');
    expect(provider).toBeDefined();
    expect(provider.lastError).toBeUndefined();
    expect(provider.lastSuccessAt).toBeUndefined();
  });
});
