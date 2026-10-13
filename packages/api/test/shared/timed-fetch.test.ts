import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { timedFetch } from '../../src/shared/timed-fetch';
import { hangingFetch, settleWithin, useProviderClock } from '../helpers/hanging-fetch';

describe('timedFetch', () => {
  beforeEach(() => useProviderClock());
  afterEach(() => vi.useRealTimers());

  it('a caller-supplied signal still aborts the request before the deadline', async () => {
    const base = hangingFetch();
    const caller = new AbortController();
    const pending = timedFetch(10_000, base as unknown as typeof fetch)('https://api.example/x', {
      signal: caller.signal,
    });
    caller.abort(new Error('caller gave up'));

    const outcome = await settleWithin(pending, 0);

    expect(outcome.status).toBe('rejected');
    expect((outcome as { reason: Error }).reason.message).toBe('caller gave up');
  });

  it('the deadline also covers reading the body (headers arrive, the body stalls)', async () => {
    // Like undici: the response resolves, then the body read rejects when the signal aborts.
    const base = (async (_input: unknown, init?: RequestInit) => ({
      ok: true,
      status: 200,
      json: () =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal!.reason), { once: true });
        }),
    })) as unknown as typeof fetch;

    const res = await timedFetch(10_000, base)('https://api.example/x');
    const outcome = await settleWithin(res.json(), 10_000);

    expect(outcome.status).toBe('rejected');
    expect((outcome as { reason: Error }).reason.name).toBe('TimeoutError');
  });
});
