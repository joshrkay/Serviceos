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
});
