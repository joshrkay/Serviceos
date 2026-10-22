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
import { describe, it, expect } from 'vitest';
import {
  composeResilienceStack,
  fallbackReserveFor,
} from '../../../src/ai/gateway/compose-resilience';
import { CircuitBreakerRegistry, DEFAULT_BREAKER } from '../../../src/ai/gateway/breaker';
import { TenantQuotaRegistry } from '../../../src/ai/gateway/tenant-quota';
import { MIN_RETRY_BUDGET_MS } from '../../../src/ai/gateway/deadline';
import { AppError } from '../../../src/shared/errors';
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
    const start = Date.now();
    const elapsed = () => Date.now() - start;
    const primary = new HangingProvider('api.openai.com', elapsed);
    const fallback = new HangingProvider('openrouter.ai', elapsed);
    const budgetMs = 3_200;

    const err = await stack(primary, [fallback])
      .complete(request(budgetMs))
      .catch((e: unknown) => e);
    const total = elapsed();

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
  });

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
    const controller = new AbortController();
    const started = Date.now();
    setTimeout(() => controller.abort(new Error('caller hung up')), 100);
    const err = await stack(primary, [fallback])
      .complete({ ...request(5_000), signal: controller.signal })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AppError);
    expect(Date.now() - started).toBeLessThan(600);
    expect(fallback.calls).toHaveLength(0);
  });

  describe('fallbackReserveFor', () => {
    it.each([
      // [remainingMs, reserveCapMs, expectedReserve]
      [12_000, 2_500, 2_500], // prod classify: primary keeps 9.5s
      [8_000, 2_500, 2_000], // complex: capped at a quarter
      [4_000, 2_500, 1_000], // standard
      [2_000, 2_500, 0], // a quarter (500ms) is below a viable attempt -> no reserve
      [12_000, 0, 0], // reserve disabled
    ])('remaining %ims cap %ims -> reserve %ims', (remaining, cap, expected) => {
      expect(fallbackReserveFor(remaining, cap)).toBe(expected);
    });
  });
});
