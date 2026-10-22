/**
 * Reliability #5 — the Google Business Profile wrappers back the OAuth
 * callback, the connect-flow discovery and the reply executor. Called without
 * an injected fetch (production), every call is bounded at 10 s and fails the
 * way a network failure does (the fetch rejection propagates).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  exchangeAuthorizationCode,
  listAccounts,
  listLocationDetails,
  listReviews,
  refreshAccessToken,
  replyToReview,
} from '../../src/reputation/google-business-client';
import { hangingFetch, settleWithin, useProviderClock } from '../helpers/hanging-fetch';

const oauth = { clientId: 'c', clientSecret: 's', redirectUri: 'https://app/cb' };

describe('Google Business Profile client — bounded when no fetch is injected', () => {
  beforeEach(() => useProviderClock());
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it.each<{ name: string; run: () => Promise<unknown> }>([
    { name: 'authorization-code exchange', run: () => exchangeAuthorizationCode(oauth, 'code') },
    { name: 'access-token refresh', run: () => refreshAccessToken(oauth, 'refresh') },
    { name: 'reviews page', run: () => listReviews('tok', 'acc', 'loc') },
    { name: 'review reply', run: () => replyToReview('tok', 'acc', 'loc', 'rev', 'Thanks!') },
    { name: 'account discovery', run: () => listAccounts('tok') },
    { name: 'location discovery', run: () => listLocationDetails('tok', 'acc') },
  ])('$name times out at 10 s like a network failure', async ({ run }) => {
    const fetchMock = hangingFetch();
    vi.stubGlobal('fetch', fetchMock);

    const outcome = await settleWithin(run(), 10_000);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(outcome.status).toBe('rejected');
    expect((outcome as { reason: Error }).reason.name).toBe('TimeoutError');
  });
});
