/**
 * GATEWAY-03 — failover shares ONE end-to-end deadline.
 *
 * ProviderFailoverWrapper used to hand the same request to every provider, and
 * each ProviderRetryDeadlineWrapper then started a brand-new timer from
 * `request.deadlineMs`. With the documented dual-provider config (OpenAI +
 * OpenRouter fallback, 12s classify deadline) a hanging primary cost 12s and
 * the fallback another 12s: 24s of silence on a voice turn, the per-tenant
 * quota lease held the whole time, and the caller-visible budget (VOX-34) no
 * longer bounded the call. Local aborts are deliberately excluded from breaker
 * health (FM-01), so the breaker never opened to cut the cost either.
 *
 * These tests drive the real composeResilienceStack with providers that hang
 * until their AbortSignal fires.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  composeResilienceStack,
  fallbackReserveFor,
  ProviderRetryDeadlineWrapper,
} from '../../../src/ai/gateway/compose-resilience';
import {
  BreakerOpenError,
  CircuitBreakerRegistry,
  DEFAULT_BREAKER,
  isBreakerHealthFailure,
} from '../../../src/ai/gateway/breaker';
import { TenantQuotaRegistry, type QuotaStore } from '../../../src/ai/gateway/tenant-quota';
import {
  createDeadlineContext,
  DeadlineExceededError,
  isLocalDeadlineOrAbort,
  MIN_RETRY_BUDGET_MS,
} from '../../../src/ai/gateway/deadline';
import { DEFAULT_RETRY, runWithRetry } from '../../../src/ai/gateway/retry';
import { computeCostMicroCents } from '../../../src/ai/gateway/model-pricing';
import { InMemoryAiRunRepository } from '../../../src/ai/ai-run';
import { AppError } from '../../../src/shared/errors';
import { LLMGateway } from '../../../src/ai/gateway/gateway';
import type { LLMProvider, LLMRequest, LLMResponse } from '../../../src/ai/gateway/gateway';

/** Hangs until the request's signal aborts, then rejects like the OpenAI SDK. */
class HangingProvider implements LLMProvider {
  calls: Array<{ deadlineMs?: number; at: number }> = [];
  constructor(readonly name: string, private readonly t0: () => number) {}
  complete(req: LLMRequest): Promise<LLMResponse> {
    this.calls.push({ deadlineMs: req.deadlineMs, at: this.t0() });
    return new Promise((_resolve, reject) => {
      const abort = () =>
        reject(Object.assign(new Error('Request was aborted.'), { name: 'AbortError' }));
      if (req.signal?.aborted) return abort();
      req.signal?.addEventListener('abort', abort, { once: true });
    });
  }
  async isAvailable(): Promise<boolean> {
    return true;
  }
}

function request(deadlineMs: number): LLMRequest {
  return {
    taskType: 'classify_intent',
    tenantId: 'tenant-hang',
    model: 'gpt-4o-mini',
    messages: [{ role: 'user', content: 'hello?' }],
    deadlineMs,
  };
}

function stack(primary: LLMProvider, fallbacks: LLMProvider[], fallbackReserveMs?: number) {
  return composeResilienceStack(primary, {
    breakers: new CircuitBreakerRegistry(DEFAULT_BREAKER),
    quota: new TenantQuotaRegistry(),
    fallbackProviders: fallbacks,
    ...(fallbackReserveMs !== undefined ? { fallbackReserveMs } : {}),
  });
}

describe('GATEWAY-03 — one deadline across failover', () => {
  it('two hanging providers fail within the single budget, not 2x', async () => {
    // On a fake clock (timers, hrtime, Date) the deadline math runs exactly:
    // with real timers a slice timer firing late under suite load ate the
    // reserve's 100ms of headroom and the fallback was skipped (A-R2).
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'hrtime'] });
    try {
      await twoHangingProvidersWithinOneBudget();
    } finally {
      vi.useRealTimers();
    }
  });

  async function twoHangingProvidersWithinOneBudget(): Promise<void> {
    const start = Date.now();
    const elapsed = () => Date.now() - start;
    const primary = new HangingProvider('api.openai.com', elapsed);
    const fallback = new HangingProvider('openrouter.ai', elapsed);
    const budgetMs = 3_200;

    let total = Number.NaN;
    const settled = stack(primary, [fallback])
      .complete(request(budgetMs))
      .catch((e: unknown) => {
        total = elapsed();
        return e;
      });
    await vi.advanceTimersByTimeAsync(budgetMs + 1_000);
    const err = await settled;

    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).code).toBe('LLM_PROVIDER_UNAVAILABLE');
    // The whole chain stays inside the caller's budget (small timer slack).
    expect(total).toBeLessThan(budgetMs + 250);
    expect(total).toBeGreaterThanOrEqual(budgetMs - 50);

    // The primary got a slice that leaves a reserve for the fallback...
    expect(primary.calls).toHaveLength(1);
    const primarySlice = primary.calls[0].deadlineMs!;
    expect(primarySlice).toBeLessThan(budgetMs);
    expect(budgetMs - fallbackReserveFor(budgetMs, 2_500) - primarySlice).toBeLessThanOrEqual(5);
    expect(budgetMs - fallbackReserveFor(budgetMs, 2_500) - primarySlice).toBeGreaterThanOrEqual(0);
    // ...and the fallback ran with no more than what was left.
    expect(fallback.calls).toHaveLength(1);
    const fallbackCall = fallback.calls[0];
    expect(fallbackCall.deadlineMs!).toBeLessThanOrEqual(budgetMs - fallbackCall.at + 5);
    expect(fallbackCall.deadlineMs!).toBeGreaterThanOrEqual(MIN_RETRY_BUDGET_MS);
  }

  it('does not advance to the fallback when less than a viable attempt remains', async () => {
    const start = Date.now();
    const elapsed = () => Date.now() - start;
    const primary = new HangingProvider('api.openai.com', elapsed);
    const fallback = new HangingProvider('openrouter.ai', elapsed);
    // Budget too small to reserve a viable fallback attempt: the primary keeps
    // the whole budget and the fallback is never started past the deadline.
    const budgetMs = 1_200;

    const err = await stack(primary, [fallback])
      .complete(request(budgetMs))
      .catch((e: unknown) => e);

    expect((err as AppError).code).toBe('LLM_PROVIDER_UNAVAILABLE');
    expect(elapsed()).toBeLessThan(budgetMs + 250);
    expect(budgetMs - primary.calls[0].deadlineMs!).toBeLessThanOrEqual(5);
    expect(fallback.calls).toHaveLength(0);
    expect((err as AppError).details?.providerPath).toEqual(['api.openai.com:gpt-4o-mini']);
  });

  it('a single provider still gets the full budget (no reserve without a fallback)', async () => {
    const primary = new HangingProvider('api.openai.com', () => 0);
    const budgetMs = 900;
    await stack(primary, []).complete(request(budgetMs)).catch(() => undefined);
    expect(budgetMs - primary.calls[0].deadlineMs!).toBeLessThanOrEqual(5);
  });

  it('a fast primary failure leaves the fallback the rest of the budget', async () => {
    const primary: LLMProvider = {
      name: 'api.openai.com',
      complete: async () => {
        throw Object.assign(new Error('upstream 503'), { status: 503 });
      },
      isAvailable: async () => true,
    };
    let fallbackDeadline: number | undefined;
    const fallback: LLMProvider = {
      name: 'openrouter.ai',
      complete: async (req) => {
        fallbackDeadline = req.deadlineMs;
        return {
          content: 'ok',
          model: req.model ?? 'x',
          provider: 'openrouter.ai',
          tokenUsage: { input: 1, output: 1, total: 2 },
          latencyMs: 1,
        };
      },
      isAvailable: async () => true,
    };
    const budgetMs = 4_000;
    // The 503 is retried by the primary's retry wrapper within a few hundred
    // ms; the fallback then gets everything that is left, not just the reserve.
    const res = await stack(primary, [fallback]).complete(request(budgetMs));
    expect(res.content).toBe('ok');
    expect(fallbackDeadline!).toBeGreaterThan(fallbackReserveFor(budgetMs, 2_500));
    expect(fallbackDeadline!).toBeLessThanOrEqual(budgetMs);
  });

  it('honours the caller signal: an aborted caller stops the whole chain', async () => {
    const primary = new HangingProvider('api.openai.com', () => 0);
    const fallback = new HangingProvider('openrouter.ai', () => 0);
    const breakers = new CircuitBreakerRegistry(DEFAULT_BREAKER);
    // The primary's cell for this request (gpt family, classify_intent → the
    // classify cell). releaseReservation proves the outcome went through it.
    const primaryCell = breakers.cell({ provider: 'api.openai.com', modelFamily: 'gpt', taskClass: 'classify' });
    const onResult = vi.spyOn(primaryCell, 'onResult');
    const releaseReservation = vi.spyOn(primaryCell, 'releaseReservation');
    const controller = new AbortController();
    const started = Date.now();
    setTimeout(() => controller.abort(new Error('caller hung up')), 100);
    const err = await composeResilienceStack(primary, {
      breakers,
      quota: new TenantQuotaRegistry(),
      fallbackProviders: [fallback],
    })
      .complete({ ...request(5_000), signal: controller.signal })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AppError);
    expect(Date.now() - started).toBeLessThan(600);
    expect(fallback.calls).toHaveLength(0);
    // The caller hanging up says nothing about the provider's health (FM-01):
    // the breaker counts no failure, whatever reason the caller aborted with.
    // The chain settles on the abort itself; the breaker sees the retry
    // wrapper's outcome a few microtasks later (no backoff since A3-6), so
    // wait for its verdict.
    await vi.waitFor(() =>
      expect(releaseReservation.mock.calls.length + onResult.mock.calls.length).toBe(1),
    );
    expect(primary.calls).toHaveLength(1);
    expect(onResult.mock.calls.filter(([success]) => success === false)).toHaveLength(0);
    expect(releaseReservation).toHaveBeenCalledTimes(1);
    expect(breakers.getProviderStates()).toEqual([
      expect.objectContaining({ provider: 'api.openai.com', breakerState: 'closed', lastError: undefined }),
    ]);
  });

  it('a caller abort with a reason of its own surfaces as a local abort that keeps the reason as its cause', async () => {
    const deaf = new DeafProvider('deaf', () => 0);
    const reason = new Error('caller hung up');
    const controller = new AbortController();
    setTimeout(() => controller.abort(reason), 50);
    const err = await new ProviderRetryDeadlineWrapper(deaf, DEFAULT_RETRY, 8_000)
      .complete({ ...request(5_000), signal: controller.signal })
      .catch((e: unknown) => e);
    expect(isLocalDeadlineOrAbort(err)).toBe(true);
    expect(isBreakerHealthFailure(err)).toBe(false);
    expect((err as Error).cause).toBe(reason);
    expect((err as Error).message).toContain('caller hung up');
    expect(deaf.calls).toHaveLength(1);
  });

  it('a local-shaped caller abort reason passes through unchanged', async () => {
    const deaf = new DeafProvider('deaf', () => 0);
    const reason = new DeadlineExceededError(50);
    const controller = new AbortController();
    setTimeout(() => controller.abort(reason), 50);
    const err = await new ProviderRetryDeadlineWrapper(deaf, DEFAULT_RETRY, 8_000)
      .complete({ ...request(5_000), signal: controller.signal })
      .catch((e: unknown) => e);
    expect(err).toBe(reason);
  });

  describe('fallbackReserveFor', () => {
    it.each([
      // [remainingMs, reserveCapMs, expectedReserve]
      [12_000, 2_500, 2_500], // prod classify: primary keeps 9.5s
      [8_000, 2_500, 2_000], // complex: capped at a quarter
      [4_000, 2_500, 1_000], // standard
      [2_000, 2_500, 0], // a quarter (500ms) is below a viable attempt -> no reserve
      [12_000, 0, 0], // reserve disabled
      [2_799, 2_500, 0], // still below a viable attempt -> no reserve
      // A carved reserve is never smaller than a viable attempt plus timer
      // slack: a quarter of 2.8s / 3.2s (700ms / 800ms) left a late slice
      // timer room to skip the fallback the reserve was carved for.
      [2_800, 2_500, 1_000],
      [3_200, 2_500, 1_000],
      [12_000, 750, 1_000], // a cap below the floor is raised to it
      [12_000, 699, 0], // a cap below a viable attempt still disables it
    ])('remaining %ims cap %ims -> reserve %ims', (remaining, cap, expected) => {
      expect(fallbackReserveFor(remaining, cap)).toBe(expected);
    });

    it('a carved reserve always leaves the primary a viable slice', () => {
      for (let remaining = 0; remaining <= 15_000; remaining += 50) {
        const reserve = fallbackReserveFor(remaining, 2_500);
        if (reserve > 0) expect(remaining - reserve).toBeGreaterThanOrEqual(MIN_RETRY_BUDGET_MS);
      }
    });
  });

  // A-R2 — the event loop is busy when the primary's slice ends, so its slice
  // timer fires late and the reserve has shrunk by that much when the chain
  // decides whether to advance. A reserve carved 50ms (3s budget -> 750ms) or
  // 100ms (3.2s -> 800ms) above a viable attempt was then below
  // MIN_RETRY_BUDGET_MS, and the fallback it was carved for never ran.
  //
  // A3-7 — on a fake clock (setTimeout, clearTimeout, Date, hrtime) with the
  // lateness injected, not on real timers with a busy loop: every timer due
  // while the loop is "busy" (from 10ms before the slice ends, for lateMs +
  // 10ms) fires when it frees up, exactly as a blocked event loop delivers
  // them. The outcome no longer depends on how loaded the machine is.
  it.each([
    [3_000, 60],
    [3_200, 120],
  ])(
    'a %ims budget whose primary slice timer fires %ims late still runs the fallback inside the budget',
    async (budgetMs, lateMs) => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'hrtime'] });
      const start = Date.now();
      const elapsed = () => Date.now() - start;
      const sliceMs = budgetMs - fallbackReserveFor(budgetMs, 2_500);
      const restoreTimers = busyEventLoop(elapsed, sliceMs - 10, sliceMs + lateMs);
      try {
        const primary = new HangingProvider('api.openai.com', elapsed);
        let fallbackCall: { deadlineMs?: number; at: number } | undefined;
        const fallback = answering('openrouter.ai', { input: 1, output: 1, total: 2 }, (req) => {
          fallbackCall = { deadlineMs: req.deadlineMs, at: elapsed() };
        });

        let settledAt = Number.NaN;
        const settled = stack(primary, [fallback])
          .complete(request(budgetMs))
          .then(
            (res) => ({ res }),
            (err: unknown) => ({ err }),
          )
          .finally(() => {
            settledAt = elapsed();
          });
        await vi.advanceTimersByTimeAsync(budgetMs + 1_000);
        const outcome = await settled;

        expect(outcome).not.toHaveProperty('err');
        const res = (outcome as { res: LLMResponse }).res;
        expect(res.content).toBe('answer from openrouter.ai');
        expect(res.providerPath).toEqual(['api.openai.com:gpt-4o-mini', 'openrouter.ai:gpt-4o-mini']);
        expect(primary.calls).toHaveLength(1);
        // The fallback started late by at least the blocked time, still with
        // a viable attempt, and the chain stayed inside the one budget.
        expect(fallbackCall).toBeDefined();
        expect(fallbackCall!.at).toBeGreaterThanOrEqual(sliceMs + lateMs - 5);
        expect(fallbackCall!.deadlineMs!).toBeGreaterThanOrEqual(MIN_RETRY_BUDGET_MS);
        expect(fallbackCall!.deadlineMs!).toBeLessThanOrEqual(budgetMs - fallbackCall!.at + 5);
        expect(settledAt).toBeLessThan(budgetMs);
      } finally {
        restoreTimers();
        vi.useRealTimers();
      }
    },
  );
});

/**
 * On a fake clock, make the event loop "busy" from `fromMs` to `untilMs`
 * (measured by `elapsed`): a timer that falls due in that window fires when
 * it ends, the way a blocked loop delivers it, while the clock reads the
 * real (late) time. Returns the restore function.
 */
function busyEventLoop(elapsed: () => number, fromMs: number, untilMs: number): () => void {
  const fakeSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = ((fn: (...args: unknown[]) => void, delayMs?: number, ...args: unknown[]) => {
    const now = elapsed();
    const dueAt = now + (delayMs ?? 0);
    const wait = dueAt >= fromMs && dueAt < untilMs ? untilMs - now : delayMs;
    return fakeSetTimeout(fn, wait, ...args);
  }) as typeof setTimeout;
  return () => {
    globalThis.setTimeout = fakeSetTimeout;
  };
}

// ── C-1699-P2 — a provider that ignores its abort must not eat the reserve ──
//
// `settleByDeadline` in the failover chain only listened to the WHOLE-chain
// deadline. A primary that ignores its AbortSignal and never settles left the
// retry wrapper pending past its slice, so the chain waited out the entire
// budget and the fallback's reserved window was never used. Each provider
// attempt now settles when its own slice deadline aborts; the abandoned
// promise is dropped, so its late answer can never become a second result.

/** Ignores its AbortSignal entirely; settles only when the test says so. */
class DeafProvider implements LLMProvider {
  calls: Array<{ deadlineMs?: number; at: number }> = [];
  private readonly pending: Array<{
    resolve: (r: LLMResponse) => void;
    reject: (e: unknown) => void;
  }> = [];
  constructor(readonly name: string, private readonly t0: () => number) {}
  complete(req: LLMRequest): Promise<LLMResponse> {
    this.calls.push({ deadlineMs: req.deadlineMs, at: this.t0() });
    return new Promise((resolve, reject) => this.pending.push({ resolve, reject }));
  }
  /** The upstream finally answers — long after the caller moved on. */
  settleLate(response: LLMResponse): void {
    for (const p of this.pending) p.resolve(response);
  }
  failLate(err: unknown): void {
    for (const p of this.pending) p.reject(err);
  }
  async isAvailable(): Promise<boolean> {
    return true;
  }
}

function answering(
  name: string,
  tokenUsage: LLMResponse['tokenUsage'],
  onCall: (req: LLMRequest) => void = () => undefined,
): LLMProvider {
  return {
    name,
    complete: async (req) => {
      onCall(req);
      return {
        content: `answer from ${name}`,
        model: req.model ?? 'x',
        provider: name,
        tokenUsage,
        latencyMs: 1,
      };
    },
    isAvailable: async () => true,
  };
}

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 20));

describe('C-1699-P2 — each provider attempt settles by its own slice deadline', () => {
  it('a primary that ignores abort and never settles still leaves the fallback its reserved window', async () => {
    const start = Date.now();
    const elapsed = () => Date.now() - start;
    const primary = new DeafProvider('api.openai.com', elapsed);
    let fallbackCall: { deadlineMs?: number; at: number } | undefined;
    const fallback = answering('openrouter.ai', { input: 1, output: 1, total: 2 }, (req) => {
      fallbackCall = { deadlineMs: req.deadlineMs, at: elapsed() };
    });
    // 4s → a 1s reserve: 300ms of timer slack before the fallback would no
    // longer fit a viable attempt.
    const budgetMs = 4_000;
    const reserveMs = fallbackReserveFor(budgetMs, 2_500); // 1_000

    const res = await stack(primary, [fallback]).complete(request(budgetMs));

    expect(res.content).toBe('answer from openrouter.ai');
    expect(res.providerPath).toEqual(['api.openai.com:gpt-4o-mini', 'openrouter.ai:gpt-4o-mini']);
    // The fallback started when the primary's SLICE ran out, not when the
    // whole budget did, and had at least a viable attempt left.
    expect(fallbackCall).toBeDefined();
    expect(fallbackCall!.at).toBeGreaterThanOrEqual(budgetMs - reserveMs - 50);
    expect(fallbackCall!.at).toBeLessThan(budgetMs - MIN_RETRY_BUDGET_MS);
    expect(fallbackCall!.deadlineMs!).toBeGreaterThanOrEqual(MIN_RETRY_BUDGET_MS - 1);
    expect(elapsed()).toBeLessThan(budgetMs);
    // The spent slice leaves no budget for a retry of the deaf primary.
    expect(primary.calls).toHaveLength(1);
  });

  it('ProviderRetryDeadlineWrapper rejects at its own deadline when the provider ignores the abort', async () => {
    const deaf = new DeafProvider('deaf', () => 0);
    const started = Date.now();
    const err = await new ProviderRetryDeadlineWrapper(deaf, DEFAULT_RETRY, 8_000)
      .complete({ ...request(300) })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DeadlineExceededError);
    expect(Date.now() - started).toBeLessThan(600);
    expect(deaf.calls).toHaveLength(1);
  }, 5_000);

  it('an abandoned attempt returns its half-open breaker probe slot instead of wedging the cell', async () => {
    // One failure opens the cell, a 20ms cooldown, ONE half-open probe.
    const breakers = new CircuitBreakerRegistry({
      ...DEFAULT_BREAKER,
      consecutiveFailureThreshold: 1,
      cooldownMs: 20,
      cooldownCapMs: 20,
      halfOpenProbeCount: 1,
    });
    let mode: 'fail' | 'deaf' | 'ok' = 'fail';
    const deaf = new DeafProvider('api.openai.com', () => 0);
    const primary: LLMProvider = {
      name: 'api.openai.com',
      complete: async (req) => {
        if (mode === 'fail') throw Object.assign(new Error('upstream 500'), { status: 500 });
        if (mode === 'deaf') return deaf.complete(req);
        return answering('api.openai.com', { input: 1, output: 1, total: 2 }).complete(req);
      },
      isAvailable: async () => true,
    };
    const resilient = composeResilienceStack(primary, {
      breakers,
      quota: new TenantQuotaRegistry(),
      retryPolicy: { ...DEFAULT_RETRY, maxAttempts: 1 },
    });

    await resilient.complete(request(1_000)).catch(() => undefined); // opens the cell
    await new Promise((resolve) => setTimeout(resolve, 40)); // cooldown → half-open

    mode = 'deaf';
    await resilient.complete(request(300)).catch(() => undefined); // takes the only probe slot

    // The deaf probe was a local deadline (not a health failure), so its slot
    // must come back: the next caller is admitted, not BreakerOpenError'd.
    mode = 'ok';
    const res = await resilient.complete(request(1_000)).catch((e: unknown) => e);
    expect(res).not.toBeInstanceOf(AppError);
    expect((res as LLMResponse).content).toBe('answer from api.openai.com');
    expect(res).not.toBeInstanceOf(BreakerOpenError);
  });

  it('gateway: one ai_runs completion charged to the fallback; the abandoned primary settling late changes nothing', async () => {
    const model = 'claude-haiku-4-5-20251001';
    const tenantId = 'tenant-deaf-primary';
    const fallbackUsage = { input: 40, output: 10, total: 50 };
    const primary = new DeafProvider('api.openai.com', () => 0);
    const fallback = answering('openrouter.ai', fallbackUsage);

    const releases: Array<[number | undefined, number | undefined]> = [];
    const quota: QuotaStore = {
      acquire: async () => ({
        release: async (input?: number, output?: number) => {
          releases.push([input, output]);
        },
      }),
    };
    const resilient = composeResilienceStack(primary, {
      breakers: new CircuitBreakerRegistry(DEFAULT_BREAKER),
      quota,
      fallbackProviders: [fallback],
    });
    const aiRunRepo = new InMemoryAiRunRepository();
    const updateStatus = vi.spyOn(aiRunRepo, 'updateStatus');
    const gateway = new LLMGateway(
      { defaultProvider: 'resilient' },
      new Map<string, LLMProvider>([['resilient', resilient]]),
      undefined,
      aiRunRepo,
    );

    const res = await gateway.complete({
      taskType: 'classify_intent',
      tenantId,
      model,
      messages: [{ role: 'user', content: 'hello?' }],
      deadlineMs: 4_000,
    });

    expect(res.provider).toBe('openrouter.ai');
    expect(res.content).toBe('answer from openrouter.ai');
    const fallbackCost = computeCostMicroCents(model, fallbackUsage);
    expect(fallbackCost).toBeGreaterThan(0);
    expect(res.costMicroCents).toBe(fallbackCost);

    // The deaf primary finally answers (a big bill), then a second attempt
    // shape — a late rejection — for good measure. Neither may surface.
    primary.settleLate({
      content: 'late primary answer',
      model,
      provider: 'api.openai.com',
      tokenUsage: { input: 90_000, output: 90_000, total: 180_000 },
      latencyMs: 9_999,
    });
    primary.failLate(new Error('late primary failure'));
    await flush();

    const runs = await aiRunRepo.findByTaskType(tenantId, 'classify_intent');
    expect(runs).toHaveLength(1);
    expect(runs[0].status).toBe('completed');
    expect(runs[0].tokenUsage).toEqual(fallbackUsage);
    expect(runs[0].costMicroCents).toBe(fallbackCost);
    expect(updateStatus).toHaveBeenCalledTimes(1);
    // The tenant quota lease was released exactly once, reconciled to the
    // fallback's real usage — never to the abandoned primary's.
    expect(releases).toEqual([[fallbackUsage.input, fallbackUsage.output]]);
  });
});

// ── A3-6 — a caller abort is final: no backoff before giving up ──────────
//
// runWithRetry classified the abort as retryable (a timeout) and judged the
// budget by remainingMs(), which ignores the aborted flag - so after a caller
// hung up it slept one backoff (~100ms) before the loop noticed the abort and
// stopped. The breaker only sees the retry wrapper's outcome after that
// sleep, so a half-open probe slot stayed reserved for it and the next caller
// got BreakerOpenError for nothing.
describe('A3-6 — an aborted deadline is not retried', () => {
  it('runWithRetry throws the abort at once: no backoff sleep, no retry attempt', async () => {
    const deadline = createDeadlineContext(5_000);
    const sleep = vi.fn(async () => undefined);
    const onAttempt = vi.fn();
    const abortError = Object.assign(new Error('Request was aborted.'), { name: 'AbortError' });
    const op = vi.fn(async () => {
      deadline.abort(new Error('caller hung up'));
      throw abortError;
    });

    try {
      await expect(
        runWithRetry(op, { deadline, sleep, onAttempt, rng: () => 0.99 }),
      ).rejects.toBe(abortError);
    } finally {
      deadline.abort();
    }

    expect(op).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
    expect(onAttempt).not.toHaveBeenCalled();
  });

  it('a live deadline still retries a transient failure after its backoff', async () => {
    const deadline = createDeadlineContext(5_000);
    const sleep = vi.fn(async () => undefined);
    let calls = 0;
    const op = async () => {
      calls += 1;
      if (calls === 1) throw Object.assign(new Error('upstream 503'), { status: 503 });
      return 'ok';
    };
    try {
      await expect(runWithRetry(op, { deadline, sleep, rng: () => 0.99 })).resolves.toBe('ok');
    } finally {
      deadline.abort();
    }
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it('on a fake clock: a caller abort returns the half-open probe slot with no time passing', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'hrtime'] });
    // A backoff that is never 0, so a sleep would always be a real wait.
    const random = vi.spyOn(Math, 'random').mockReturnValue(0.5);
    try {
      // One failure opens the cell, a 20ms cooldown, ONE half-open probe.
      const breakers = new CircuitBreakerRegistry({
        ...DEFAULT_BREAKER,
        consecutiveFailureThreshold: 1,
        cooldownMs: 20,
        cooldownCapMs: 20,
        halfOpenProbeCount: 1,
      });
      let mode: 'fail' | 'hang' | 'ok' = 'fail';
      const hanging = new HangingProvider('api.openai.com', () => 0);
      const primary: LLMProvider = {
        name: 'api.openai.com',
        complete: async (req) => {
          if (mode === 'fail') throw Object.assign(new Error('upstream 500'), { status: 500 });
          if (mode === 'hang') return hanging.complete(req);
          return answering('api.openai.com', { input: 1, output: 1, total: 2 }).complete(req);
        },
        isAvailable: async () => true,
      };
      // The default retry policy: an abort WOULD be retried after a backoff.
      const resilient = composeResilienceStack(primary, { breakers, quota: new TenantQuotaRegistry() });
      const cell = breakers.cell({ provider: 'api.openai.com', modelFamily: 'gpt', taskClass: 'classify' });
      const releaseReservation = vi.spyOn(cell, 'releaseReservation');

      const opening = resilient.complete(request(1_000)).catch(() => undefined);
      await vi.advanceTimersByTimeAsync(1_500); // the 500s and their backoffs: the cell opens
      await opening;
      await vi.advanceTimersByTimeAsync(40); // cooldown -> half-open on the next caller

      mode = 'hang';
      const controller = new AbortController();
      const probe = resilient
        .complete({ ...request(5_000), signal: controller.signal })
        .catch((e: unknown) => e);
      await vi.advanceTimersByTimeAsync(0);
      expect(hanging.calls).toHaveLength(1); // the probe holds the only slot

      controller.abort(new Error('caller hung up'));
      // Microtasks only: the clock does not move.
      for (let i = 0; i < 20; i++) await Promise.resolve();

      expect(await probe).toBeInstanceOf(AppError);
      expect(releaseReservation).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0); // no backoff sleep pending
      // The slot is back: the next caller is admitted, not BreakerOpenError'd.
      mode = 'ok';
      const res = await resilient.complete(request(1_000)).catch((e: unknown) => e);
      expect(res).not.toBeInstanceOf(AppError);
      expect((res as LLMResponse).content).toBe('answer from api.openai.com');
      expect(hanging.calls).toHaveLength(1); // and the aborted probe was never retried
    } finally {
      random.mockRestore();
      vi.useRealTimers();
    }
  });
});
