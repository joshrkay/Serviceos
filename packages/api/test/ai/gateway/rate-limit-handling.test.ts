/**
 * Provider throttle (HTTP 429) handling — regression suite for the
 * 2026-07-27 "17.4s hang + All providers failed. Last error: Request was
 * aborted." incident.
 *
 * Production evidence this suite encodes:
 *   GET  /v1/models           → 200, 123 models          (the key was fine)
 *   POST /v1/chat/completions → 429 in 0.30s
 *     rate_limit_exceeded / requests
 *     "Rate limit reached for gpt-4o-mini in organization org-… on requests
 *      per day (RPD): Limit 10000, Used 10000, Requested 1.
 *      Please try again in 8.64s."
 *   ai_runs durations: 17401 / 17412 / 17415 / 17425 / 17441 / 17479 ms
 *   ai_runs error:     "All providers failed. Last error: Request was aborted."
 *   config:            AI_CLASSIFY_INTENT_DEADLINE_MS=12000
 *
 * The 17.4s is 2 × the OpenAI SDK's own un-cancellable 8.64s retry sleep; the
 * third SDK attempt then observed our already-fired 12s AbortSignal and threw
 * APIUserAbortError('Request was aborted.'), so the 429 never reached our
 * classifier at all.
 *
 * No live provider calls anywhere in this file — the SDK client is stubbed.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  classifyError,
  isRateLimitError,
  isRetryable,
  planRateLimitWait,
  retryAfterMsFromError,
  runWithRetry,
  DEFAULT_RETRY,
  RETRY_AFTER_JITTER_MS,
  ProviderRateLimitError,
} from '../../../src/ai/gateway/retry';
import { adoptDeadline, MIN_RETRY_BUDGET_MS } from '../../../src/ai/gateway/deadline';
import {
  OpenAICompatibleProvider,
  normalizeProviderError,
  parseProviderRetryAfterMs,
  parseRateLimitResetMs,
  PROVIDER_SDK_MAX_RETRIES,
} from '../../../src/ai/providers/openai-compatible';
import { composeResilienceStack } from '../../../src/ai/gateway/compose-resilience';
import { AppError } from '../../../src/shared/errors';
import type {
  LLMProvider,
  LLMRequest,
  LLMResponse,
} from '../../../src/ai/gateway/gateway';

// ─── production constants ────────────────────────────────────────────────────

/** "Please try again in 8.64s." — delivered as `retry-after-ms: 8640`. */
const PROD_RETRY_AFTER_MS = 8_640;
/** AI_CLASSIFY_INTENT_DEADLINE_MS on production. */
const PROD_CLASSIFY_DEADLINE_MS = 12_000;
/** AI_LIGHTWEIGHT_DEADLINE_MS on production. */
const PROD_LIGHTWEIGHT_DEADLINE_MS = 6_000;
/** Verbatim provider text (org id redacted). */
const PROD_429_MESSAGE =
  '429 Rate limit reached for gpt-4o-mini in organization org-REDACTED on ' +
  'requests per day (RPD): Limit 10000, Used 10000, Requested 1. ' +
  'Please try again in 8.64s.';

/** The shape the OpenAI SDK hands us for a 429 (openai/error.js RateLimitError). */
function sdkRateLimitError(headers: Record<string, string> = {}): Error {
  return Object.assign(new Error(PROD_429_MESSAGE), {
    status: 429,
    type: 'rate_limit_exceeded',
    code: 'requests',
    headers,
  });
}

function statusError(status: number, message = `HTTP ${status}`): Error {
  return Object.assign(new Error(message), { status });
}

function okResponse(provider = 'stub'): LLMResponse {
  return {
    content: '{"ok":true}',
    model: 'gpt-4o-mini',
    provider,
    tokenUsage: { input: 10, output: 5, total: 15 },
    latencyMs: 5,
  };
}

/** Minimal LLMProvider whose behaviour is driven by a per-call script. */
class ScriptedProvider implements LLMProvider {
  readonly name = 'api.openai.com';
  calls = 0;
  constructor(private readonly step: (call: number) => LLMResponse) {}
  async complete(_request: LLMRequest): Promise<LLMResponse> {
    this.calls += 1;
    return this.step(this.calls);
  }
  async isAvailable(): Promise<boolean> {
    return true;
  }
}

function request(overrides: Partial<LLMRequest> = {}): LLMRequest {
  return {
    taskType: 'classify_intent',
    tenantId: 'tenant-429',
    model: 'gpt-4o-mini',
    messages: [{ role: 'user', content: 'book me tuesday' }],
    ...overrides,
  };
}

// ─── 1. the 4xx/5xx classification table ─────────────────────────────────────

describe('429 handling — error classification table', () => {
  it.each([
    [401, 'permanent'],
    [403, 'permanent'],
    [400, 'permanent'],
    [404, 'permanent'],
    [429, 'rate_limited'],
    [500, 'transient'],
    [502, 'transient'],
    [503, 'transient'],
  ] as const)('classifies HTTP %i as %s', (status, expected) => {
    expect(classifyError(statusError(status))).toBe(expected);
  });

  it('classifies the typed ProviderRateLimitError as rate_limited', () => {
    const err = new ProviderRateLimitError({
      providerName: 'api.openai.com',
      providerMessage: PROD_429_MESSAGE,
      retryAfterMs: PROD_RETRY_AFTER_MS,
    });
    expect(classifyError(err)).toBe('rate_limited');
    expect(isRateLimitError(err)).toBe(true);
    expect(retryAfterMsFromError(err)).toBe(PROD_RETRY_AFTER_MS);
  });

  it('an explicit 429 outranks message sniffing (a throttle is not a timeout)', () => {
    // classifyError used to test isDeadlineExceeded() first, which matches on
    // the substrings "timeout"/"deadline" anywhere in the message.
    const err = new ProviderRateLimitError({
      providerName: 'api.openai.com',
      providerMessage: 'Rate limit reached; request timeout window resets shortly',
    });
    expect(classifyError(err)).toBe('rate_limited');
  });

  it('401 is not retryable at any attempt or budget', () => {
    expect(isRetryable('permanent', 1, DEFAULT_RETRY, 60_000)).toBe(false);
  });
});

// ─── 2. retry-after / x-ratelimit-reset-* header parsing ─────────────────────

describe('429 handling — retry-after header parsing', () => {
  it('prefers retry-after-ms (the header that produced the 8.64s waits)', () => {
    expect(
      parseProviderRetryAfterMs({ 'retry-after-ms': '8640', 'retry-after': '9' }),
    ).toBe(PROD_RETRY_AFTER_MS);
  });

  it('falls back to retry-after delta-seconds', () => {
    expect(parseProviderRetryAfterMs({ 'retry-after': '9' })).toBe(9_000);
  });

  it('falls back to retry-after as an HTTP-date', () => {
    const at = new Date(Date.now() + 5_000).toUTCString();
    const parsed = parseProviderRetryAfterMs({ 'retry-after': at });
    expect(parsed).toBeGreaterThan(3_000);
    expect(parsed).toBeLessThanOrEqual(6_000);
  });

  it('falls back to x-ratelimit-reset-requests', () => {
    expect(
      parseProviderRetryAfterMs({ 'x-ratelimit-reset-requests': '8.64s' }),
    ).toBe(PROD_RETRY_AFTER_MS);
  });

  it('falls back to x-ratelimit-reset-tokens when requests is absent', () => {
    expect(parseProviderRetryAfterMs({ 'x-ratelimit-reset-tokens': '2m30s' })).toBe(
      150_000,
    );
  });

  it('reads headers case-insensitively and from a Headers instance', () => {
    expect(parseProviderRetryAfterMs({ 'Retry-After-Ms': '1200' })).toBe(1_200);
    const headers = new Headers({ 'retry-after-ms': '1500' });
    expect(parseProviderRetryAfterMs(headers)).toBe(1_500);
  });

  it('returns undefined when the provider sent no usable hint', () => {
    expect(parseProviderRetryAfterMs({})).toBeUndefined();
    expect(parseProviderRetryAfterMs(undefined)).toBeUndefined();
    expect(parseProviderRetryAfterMs({ 'retry-after': 'soonish' })).toBeUndefined();
  });

  it.each([
    ['8.64s', 8_640],
    ['230ms', 230],
    ['6m0s', 360_000],
    ['1h2m3s', 3_723_000],
    ['0s', 0],
  ])('parses the OpenAI reset duration %s', (raw, expected) => {
    expect(parseRateLimitResetMs(raw)).toBe(expected);
  });

  it('does not read 230ms as 230 minutes', () => {
    expect(parseRateLimitResetMs('230ms')).toBeLessThan(1_000);
  });
});

// ─── 3. provider adapter normalization + the SDK-retry regression guard ──────

describe('429 handling — OpenAICompatibleProvider', () => {
  function stubProvider(behaviour: () => Promise<unknown>): OpenAICompatibleProvider {
    const provider = new OpenAICompatibleProvider({
      apiKey: 'test-key',
      baseURL: 'https://api.openai.com/v1',
    });
    (
      provider as unknown as {
        client: { chat: { completions: { create: () => Promise<unknown> } } };
      }
    ).client = {
      chat: { completions: { create: behaviour } },
    } as never;
    return provider;
  }

  it('never lets the OpenAI SDK retry on its own (source of the 17.4s)', () => {
    // The SDK default is maxRetries: 2, and its retry sleep is a plain
    // setTimeout that ignores the AbortSignal — 2 × 8.64s ran entirely
    // outside our 12s deadline before the third attempt threw
    // APIUserAbortError('Request was aborted.').
    expect(PROVIDER_SDK_MAX_RETRIES).toBe(0);
    const provider = new OpenAICompatibleProvider({
      apiKey: 'test-key',
      baseURL: 'https://api.openai.com/v1',
    });
    const client = (provider as unknown as { client: { maxRetries: number } }).client;
    expect(client.maxRetries).toBe(0);
  });

  it('normalizes a 429 into a typed error carrying the provider type/code/message', async () => {
    const provider = stubProvider(async () => {
      throw sdkRateLimitError({ 'retry-after-ms': '8640' });
    });

    const err = await provider
      .complete(request())
      .then(() => null)
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ProviderRateLimitError);
    const rl = err as ProviderRateLimitError;
    expect(rl.code).toBe('PROVIDER_RATE_LIMITED');
    expect(rl.status).toBe(429);
    expect(rl.retryAfterMs).toBe(PROD_RETRY_AFTER_MS);
    expect(rl.providerErrorType).toBe('rate_limit_exceeded');
    expect(rl.providerErrorCode).toBe('requests');
    // The provider's own words survive — not flattened to a generic abort.
    expect(rl.message).toContain('requests per day (RPD)');
    expect(rl.message).not.toContain('Request was aborted');
  });

  it('passes 401 / 403 / 5xx through untouched', () => {
    const auth = statusError(401, '401 Incorrect API key provided');
    expect(normalizeProviderError(auth, 'api.openai.com')).toBe(auth);
    const forbidden = statusError(403);
    expect(normalizeProviderError(forbidden, 'api.openai.com')).toBe(forbidden);
    const server = statusError(503);
    expect(normalizeProviderError(server, 'api.openai.com')).toBe(server);
  });

  it('still produces a typed 429 when the provider sends no retry-after at all', () => {
    const normalized = normalizeProviderError(sdkRateLimitError(), 'api.openai.com');
    expect(normalized).toBeInstanceOf(ProviderRateLimitError);
    expect((normalized as ProviderRateLimitError).retryAfterMs).toBeUndefined();
  });
});

// ─── 4. the wait-or-fail-fast rule, at production numbers ────────────────────

describe('429 handling — planRateLimitWait', () => {
  it('waits when 8.64s fits inside a 12s classify_intent deadline', () => {
    // ~300ms already spent on the 429 itself.
    const remaining = PROD_CLASSIFY_DEADLINE_MS - 300;
    const plan = planRateLimitWait(PROD_RETRY_AFTER_MS, remaining, () => 0);
    expect(plan).toEqual({ action: 'wait', delayMs: PROD_RETRY_AFTER_MS });
    expect(PROD_RETRY_AFTER_MS + MIN_RETRY_BUDGET_MS).toBeLessThan(remaining);
  });

  it('fails fast when 8.64s does NOT fit the 6s lightweight deadline', () => {
    const plan = planRateLimitWait(
      PROD_RETRY_AFTER_MS,
      PROD_LIGHTWEIGHT_DEADLINE_MS - 300,
      () => 0,
    );
    expect(plan).toEqual({ action: 'fail-fast' });
  });

  it('fails fast on the second 429 of a 12s turn rather than overshooting', () => {
    // After one honoured 8.64s wait there is ~3s left — not enough for another.
    const remainingAfterFirstWait = PROD_CLASSIFY_DEADLINE_MS - PROD_RETRY_AFTER_MS - 600;
    expect(
      planRateLimitWait(PROD_RETRY_AFTER_MS, remainingAfterFirstWait, () => 0),
    ).toEqual({ action: 'fail-fast' });
  });

  it('falls back to jittered backoff when there is no retry-after', () => {
    expect(planRateLimitWait(undefined, 10_000, () => 0)).toEqual({ action: 'backoff' });
  });

  it('adds jitter so a throttled fleet does not re-synchronise on the reset', () => {
    const low = planRateLimitWait(1_000, 60_000, () => 0);
    const high = planRateLimitWait(1_000, 60_000, () => 0.99);
    expect(low).toEqual({ action: 'wait', delayMs: 1_000 });
    expect(high.action).toBe('wait');
    const highDelay = (high as { delayMs: number }).delayMs;
    expect(highDelay).toBeGreaterThan(1_000);
    expect(highDelay).toBeLessThanOrEqual(1_000 + RETRY_AFTER_JITTER_MS);
  });
});

// ─── 5. runWithRetry — the three required 429 scenarios + 401 + 5xx ──────────

describe('429 handling — runWithRetry', () => {
  it('a 429 whose retry-after fits the deadline: waits once, then succeeds', async () => {
    const deadline = adoptDeadline(PROD_CLASSIFY_DEADLINE_MS);
    const slept: number[] = [];
    let calls = 0;

    const result = await runWithRetry(
      async () => {
        calls += 1;
        if (calls === 1) {
          throw new ProviderRateLimitError({
            providerName: 'api.openai.com',
            providerMessage: PROD_429_MESSAGE,
            retryAfterMs: PROD_RETRY_AFTER_MS,
          });
        }
        return 'classified';
      },
      {
        deadline,
        sleep: async (ms) => {
          slept.push(ms);
        },
        rng: () => 0,
      },
    );
    deadline.abort();

    expect(result).toBe('classified');
    expect(calls).toBe(2);
    // Waited the provider's own number, not a 100ms backoff guess.
    expect(slept).toEqual([PROD_RETRY_AFTER_MS]);
  });

  it('a 429 whose retry-after exceeds the deadline: fails fast, never sleeps', async () => {
    const deadline = adoptDeadline(PROD_LIGHTWEIGHT_DEADLINE_MS);
    const slept: number[] = [];
    let calls = 0;
    const startedAt = Date.now();

    const err = await runWithRetry(
      async () => {
        calls += 1;
        throw new ProviderRateLimitError({
          providerName: 'api.openai.com',
          providerMessage: PROD_429_MESSAGE,
          retryAfterMs: PROD_RETRY_AFTER_MS,
          providerErrorType: 'rate_limit_exceeded',
          providerErrorCode: 'requests',
        });
      },
      {
        deadline,
        sleep: async (ms) => {
          slept.push(ms);
        },
        rng: () => 0,
      },
    )
      .then(() => null)
      .catch((e: unknown) => e);
    deadline.abort();

    expect(err).toBeInstanceOf(ProviderRateLimitError);
    expect(calls).toBe(1);
    expect(slept).toEqual([]);
    // Well under the deadline — no 17s hang on a 6s budget.
    expect(Date.now() - startedAt).toBeLessThan(1_000);
    expect((err as Error).message).toContain('requests per day (RPD)');
    expect((err as Error).message).not.toContain('Request was aborted');
  });

  it('a 429 with no retry-after backs off with jitter instead of hammering', async () => {
    const deadline = adoptDeadline(PROD_CLASSIFY_DEADLINE_MS);
    const attempts: Array<{ delayMs: number; honoredRetryAfter?: boolean }> = [];
    let calls = 0;

    const err = await runWithRetry(
      async () => {
        calls += 1;
        throw new ProviderRateLimitError({
          providerName: 'api.openai.com',
          providerMessage: PROD_429_MESSAGE,
        });
      },
      {
        deadline,
        sleep: async () => {},
        // Max jitter draw: proves the delay is a random draw, not a constant.
        rng: () => 0.999,
        onAttempt: (info) => attempts.push(info),
      },
    )
      .then(() => null)
      .catch((e: unknown) => e);
    deadline.abort();

    expect(err).toBeInstanceOf(ProviderRateLimitError);
    expect(calls).toBe(DEFAULT_RETRY.maxAttempts);
    expect(attempts.every((a) => a.honoredRetryAfter === false)).toBe(true);
    expect(attempts.map((a) => a.delayMs)).toEqual([99, 199]);
  });

  it('401 fails immediately with no retries', async () => {
    const deadline = adoptDeadline(PROD_CLASSIFY_DEADLINE_MS);
    const slept: number[] = [];
    let calls = 0;

    const err = await runWithRetry(
      async () => {
        calls += 1;
        throw statusError(401, '401 Incorrect API key provided: sk-***');
      },
      { deadline, sleep: async (ms) => void slept.push(ms) },
    )
      .then(() => null)
      .catch((e: unknown) => e);
    deadline.abort();

    expect(calls).toBe(1);
    expect(slept).toEqual([]);
    // Loud: the provider's own diagnosis reaches the caller intact.
    expect((err as Error).message).toContain('Incorrect API key');
  });

  it('403 fails immediately with no retries', async () => {
    let calls = 0;
    await expect(
      runWithRetry(
        async () => {
          calls += 1;
          throw statusError(403, '403 Project does not have access to model');
        },
        { sleep: async () => {} },
      ),
    ).rejects.toThrow('403 Project does not have access to model');
    expect(calls).toBe(1);
  });

  it('5xx retries with exponential jittered backoff, then succeeds', async () => {
    const deadline = adoptDeadline(PROD_CLASSIFY_DEADLINE_MS);
    const attempts: Array<{ delayMs: number; errClass: string }> = [];
    let calls = 0;

    const result = await runWithRetry(
      async () => {
        calls += 1;
        if (calls < 3) throw statusError(503, '503 Service Unavailable');
        return 'recovered';
      },
      {
        deadline,
        sleep: async () => {},
        rng: () => 0.999,
        onAttempt: (info) => attempts.push(info),
      },
    );
    deadline.abort();

    expect(result).toBe('recovered');
    expect(calls).toBe(3);
    expect(attempts.map((a) => a.errClass)).toEqual(['transient', 'transient']);
    // base 100 → ceilings 100 then 200; the doubling is the backoff.
    expect(attempts.map((a) => a.delayMs)).toEqual([99, 199]);
  });
});

// ─── 6. end-to-end through the composed resilience stack ─────────────────────

describe('429 handling — composeResilienceStack', () => {
  it('surfaces LLM_RATE_LIMITED (429), not "All providers failed / Request was aborted"', async () => {
    const provider = new ScriptedProvider(() => {
      throw new ProviderRateLimitError({
        providerName: 'api.openai.com',
        providerMessage: PROD_429_MESSAGE,
        retryAfterMs: PROD_RETRY_AFTER_MS,
        providerErrorType: 'rate_limit_exceeded',
        providerErrorCode: 'requests',
      });
    });
    const stack = composeResilienceStack(provider, {
      // Smaller than the 8.64s retry-after → unsatisfiable → fail fast.
      defaultDeadlineMs: 1_000,
    });

    const startedAt = Date.now();
    const err = await stack
      .complete(request())
      .then(() => null)
      .catch((e: unknown) => e);
    const elapsedMs = Date.now() - startedAt;

    expect(err).toBeInstanceOf(AppError);
    const appErr = err as AppError;
    expect(appErr.code).toBe('LLM_RATE_LIMITED');
    expect(appErr.statusCode).toBe(429);
    expect(appErr.details?.rateLimited).toBe(true);
    expect(appErr.details?.retryAfterMs).toBe(PROD_RETRY_AFTER_MS);
    expect(appErr.details?.providerErrorType).toBe('rate_limit_exceeded');
    expect(appErr.details?.providerErrorCode).toBe('requests');

    // The message names the cause AND the remedy.
    expect(appErr.message).toContain('rate limit');
    expect(appErr.message).toContain('retry after 8.6s');
    expect(appErr.message).toContain('requests per day (RPD)');
    // The two strings the owner actually saw in production must be gone.
    expect(appErr.message).not.toContain('All providers failed');
    expect(appErr.message).not.toContain('Request was aborted');

    // No retry storm, and nowhere near the 17.4s / 12s overshoot.
    expect(provider.calls).toBe(1);
    expect(elapsedMs).toBeLessThan(1_000);
  });

  it('honours a retry-after that fits, and still lands inside the deadline', async () => {
    // Scaled 10:1 from production (864ms retry-after) so the suite stays fast
    // while exercising the real sleep path end to end.
    const scaledRetryAfterMs = 864;
    const deadlineMs = 2_000;
    const provider = new ScriptedProvider((call) => {
      if (call === 1) {
        throw new ProviderRateLimitError({
          providerName: 'api.openai.com',
          providerMessage: PROD_429_MESSAGE,
          retryAfterMs: scaledRetryAfterMs,
        });
      }
      return okResponse('api.openai.com');
    });
    const stack = composeResilienceStack(provider, { defaultDeadlineMs: deadlineMs });

    const startedAt = Date.now();
    const response = await stack.complete(request());
    const elapsedMs = Date.now() - startedAt;

    expect(response.content).toBe('{"ok":true}');
    expect(provider.calls).toBe(2);
    // It really waited (no busy retry), and it really respected the deadline.
    expect(elapsedMs).toBeGreaterThanOrEqual(scaledRetryAfterMs);
    expect(elapsedMs).toBeLessThan(deadlineMs);
  });

  it('401 is re-thrown untouched — no failover, no retries, no 503 wrapper', async () => {
    const authError = statusError(401, '401 Incorrect API key provided: sk-***');
    const provider = new ScriptedProvider(() => {
      throw authError;
    });
    const stack = composeResilienceStack(provider, { defaultDeadlineMs: 5_000 });

    const err = await stack
      .complete(request())
      .then(() => null)
      .catch((e: unknown) => e);

    expect(err).toBe(authError);
    expect(provider.calls).toBe(1);
    expect(err).not.toBeInstanceOf(AppError);
  });

  it('5xx still retries inside the deadline and recovers', async () => {
    const provider = new ScriptedProvider((call) => {
      if (call < 3) throw statusError(503, '503 Service Unavailable');
      return okResponse('api.openai.com');
    });
    const stack = composeResilienceStack(provider, { defaultDeadlineMs: 5_000 });

    const response = await stack.complete(request());

    expect(response.content).toBe('{"ok":true}');
    expect(provider.calls).toBe(3);
  });

  it('a non-throttle exhaustion still reports LLM_PROVIDER_UNAVAILABLE (503)', async () => {
    // Guard against over-reach: only 429 gets the new class.
    const provider = new ScriptedProvider(() => {
      throw statusError(503, '503 Service Unavailable');
    });
    const stack = composeResilienceStack(provider, { defaultDeadlineMs: 400 });

    const err = await stack
      .complete(request())
      .then(() => null)
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).code).toBe('LLM_PROVIDER_UNAVAILABLE');
    expect((err as AppError).statusCode).toBe(503);
  });
});

// ─── 7. failover: a throttled primary should try the fallback provider ───────

describe('429 handling — failover', () => {
  it('advances to the fallback provider on a 429 before giving up', async () => {
    const primary = new ScriptedProvider(() => {
      throw new ProviderRateLimitError({
        providerName: 'api.openai.com',
        providerMessage: PROD_429_MESSAGE,
        retryAfterMs: PROD_RETRY_AFTER_MS,
      });
    });
    const fallback: LLMProvider = {
      name: 'openrouter.ai',
      complete: vi.fn(async () => okResponse('openrouter.ai')),
      isAvailable: async () => true,
    };
    const stack = composeResilienceStack(primary, {
      fallbackProviders: [fallback],
      defaultDeadlineMs: 1_000,
    });

    const response = await stack.complete(request());

    expect(response.provider).toBe('openrouter.ai');
    expect(fallback.complete).toHaveBeenCalledTimes(1);
    expect(primary.calls).toBe(1);
  });
});
