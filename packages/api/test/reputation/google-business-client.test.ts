import { describe, it, expect } from 'vitest';
import {
  buildGoogleBusinessAuthUrl,
  exchangeAuthorizationCode,
  GoogleBusinessApiError,
  GoogleBusinessQuotaError,
  GOOGLE_BUSINESS_SCOPE,
  listReviews,
  parseStarRating,
} from '../../src/reputation/google-business-client';

function makeResponse(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): Response {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...headers,
    },
  });
}

describe('P7-026 parseStarRating', () => {
  it('maps Google enums to integers', () => {
    expect(parseStarRating('ONE')).toBe(1);
    expect(parseStarRating('TWO')).toBe(2);
    expect(parseStarRating('THREE')).toBe(3);
    expect(parseStarRating('FOUR')).toBe(4);
    expect(parseStarRating('FIVE')).toBe(5);
  });

  it('returns 0 for unspecified or missing', () => {
    expect(parseStarRating('STAR_RATING_UNSPECIFIED')).toBe(0);
    expect(parseStarRating(undefined)).toBe(0);
  });
});

describe('P7-026 buildGoogleBusinessAuthUrl', () => {
  it('produces a consent URL with business.manage scope + state', () => {
    const url = buildGoogleBusinessAuthUrl(
      {
        clientId: 'client123',
        clientSecret: 'secret',
        redirectUri: 'https://app.example.com/cb',
      },
      'state-token',
    );
    const parsed = new URL(url);
    expect(parsed.origin + parsed.pathname).toBe(
      'https://accounts.google.com/o/oauth2/v2/auth',
    );
    expect(parsed.searchParams.get('client_id')).toBe('client123');
    expect(parsed.searchParams.get('scope')).toBe(GOOGLE_BUSINESS_SCOPE);
    expect(parsed.searchParams.get('state')).toBe('state-token');
    expect(parsed.searchParams.get('access_type')).toBe('offline');
    expect(parsed.searchParams.get('prompt')).toBe('consent');
  });
});

describe('P7-026 exchangeAuthorizationCode', () => {
  it('returns parsed access + refresh tokens on 200', async () => {
    const fetchFn = async (): Promise<Response> =>
      makeResponse(200, {
        access_token: 'at',
        refresh_token: 'rt',
        expires_in: 1800,
      });
    const tokens = await exchangeAuthorizationCode(
      {
        clientId: 'c',
        clientSecret: 's',
        redirectUri: 'https://app.example.com/cb',
      },
      'auth-code',
      fetchFn,
    );
    expect(tokens.accessToken).toBe('at');
    expect(tokens.refreshToken).toBe('rt');
    // expires in 1800s → ~30 min from now
    expect(tokens.expiresAt.getTime()).toBeGreaterThan(
      Date.now() + 1700_000,
    );
  });

  it('throws on non-2xx', async () => {
    const fetchFn = async (): Promise<Response> =>
      makeResponse(401, 'invalid_grant');
    await expect(
      exchangeAuthorizationCode(
        { clientId: 'c', clientSecret: 's', redirectUri: '/' },
        'auth-code',
        fetchFn,
      ),
    ).rejects.toThrow(/Google business token exchange failed/);
  });

  it('throws when Google omits refresh_token', async () => {
    const fetchFn = async (): Promise<Response> =>
      makeResponse(200, { access_token: 'at', expires_in: 3600 });
    await expect(
      exchangeAuthorizationCode(
        { clientId: 'c', clientSecret: 's', redirectUri: '/' },
        'auth-code',
        fetchFn,
      ),
    ).rejects.toThrow(/access \+ refresh tokens/);
  });
});

describe('P7-026 listReviews', () => {
  it('returns reviews + nextPageToken on success', async () => {
    let capturedUrl = '';
    const fetchFn = async (
      url: string | URL | Request,
      _init?: RequestInit,
    ): Promise<Response> => {
      capturedUrl = url.toString();
      return makeResponse(200, {
        reviews: [
          {
            name: 'accounts/A/locations/L/reviews/R1',
            reviewer: { displayName: 'Alice' },
            starRating: 'FIVE',
            comment: 'Great',
            createTime: '2026-05-10T10:00:00Z',
            updateTime: '2026-05-10T10:00:00Z',
          },
        ],
        nextPageToken: 'next-page',
      });
    };
    const page = await listReviews('access-token', 'A', 'L', null, fetchFn);
    expect(page.reviews).toHaveLength(1);
    expect(page.reviews[0].name).toBe('accounts/A/locations/L/reviews/R1');
    expect(page.nextPageToken).toBe('next-page');
    expect(capturedUrl).toContain(
      'mybusiness.googleapis.com/v4/accounts/A/locations/L/reviews',
    );
    expect(capturedUrl).not.toContain('pageToken');
  });

  it('passes pageToken when supplied', async () => {
    let capturedUrl = '';
    const fetchFn = async (
      url: string | URL | Request,
    ): Promise<Response> => {
      capturedUrl = url.toString();
      return makeResponse(200, { reviews: [], nextPageToken: undefined });
    };
    const page = await listReviews('at', 'A', 'L', 'tok-2', fetchFn);
    expect(capturedUrl).toContain('pageToken=tok-2');
    expect(page.nextPageToken).toBeNull();
  });

  it('returns empty list when reviews field is absent', async () => {
    const fetchFn = async (): Promise<Response> => makeResponse(200, {});
    const page = await listReviews('at', 'A', 'L', null, fetchFn);
    expect(page.reviews).toEqual([]);
    expect(page.nextPageToken).toBeNull();
  });

  it('throws GoogleBusinessQuotaError on 429 with retry-after', async () => {
    const fetchFn = async (): Promise<Response> =>
      makeResponse(429, 'quota exceeded', { 'Retry-After': '60' });
    try {
      await listReviews('at', 'A', 'L', null, fetchFn);
      throw new Error('expected GoogleBusinessQuotaError');
    } catch (err) {
      expect(err).toBeInstanceOf(GoogleBusinessQuotaError);
      expect((err as GoogleBusinessQuotaError).retryAfterSeconds).toBe(60);
      expect((err as GoogleBusinessQuotaError).status).toBe(429);
    }
  });

  it('throws GoogleBusinessQuotaError on 429 without retry-after', async () => {
    const fetchFn = async (): Promise<Response> =>
      makeResponse(429, 'quota exceeded');
    try {
      await listReviews('at', 'A', 'L', null, fetchFn);
      throw new Error('expected GoogleBusinessQuotaError');
    } catch (err) {
      expect(err).toBeInstanceOf(GoogleBusinessQuotaError);
      expect((err as GoogleBusinessQuotaError).retryAfterSeconds).toBeUndefined();
    }
  });

  it('throws generic Error on other non-2xx', async () => {
    const fetchFn = async (): Promise<Response> =>
      makeResponse(500, 'upstream broken');
    await expect(
      listReviews('at', 'A', 'L', null, fetchFn),
    ).rejects.toThrow(/Google Business listReviews failed \(500\)/);
  });

  it('throws GoogleBusinessApiError when reviews[].starRating is an unexpected enum', async () => {
    const fetchFn = async (): Promise<Response> =>
      makeResponse(200, {
        reviews: [
          {
            name: 'accounts/A/locations/L/reviews/R1',
            // Google has never published "SIX_STARS" — schema must reject.
            starRating: 'SIX_STARS',
            createTime: '2026-05-10T10:00:00Z',
          },
        ],
      });
    await expect(
      listReviews('at', 'A', 'L', null, fetchFn),
    ).rejects.toThrow(GoogleBusinessApiError);
  });

  it('throws GoogleBusinessApiError when reviews[].name is missing (required field)', async () => {
    const fetchFn = async (): Promise<Response> =>
      makeResponse(200, {
        reviews: [
          {
            // no `name` field at all — schema requires it for dedupe
            starRating: 'FIVE',
            createTime: '2026-05-10T10:00:00Z',
          },
        ],
      });
    await expect(
      listReviews('at', 'A', 'L', null, fetchFn),
    ).rejects.toThrow(GoogleBusinessApiError);
  });

  it('GoogleBusinessApiError attaches the Zod error as .cause for diagnostics', async () => {
    const fetchFn = async (): Promise<Response> =>
      makeResponse(200, { reviews: [{ starRating: 'SIX_STARS' }] });
    try {
      await listReviews('at', 'A', 'L', null, fetchFn);
      throw new Error('expected GoogleBusinessApiError');
    } catch (err) {
      expect(err).toBeInstanceOf(GoogleBusinessApiError);
      expect((err as Error & { cause?: unknown }).cause).toBeDefined();
    }
  });

  it('GoogleBusinessApiError is NOT a GoogleBusinessQuotaError (distinct classes)', () => {
    const err = new GoogleBusinessApiError('test');
    expect(err).toBeInstanceOf(GoogleBusinessApiError);
    expect(err).not.toBeInstanceOf(GoogleBusinessQuotaError);
  });

  it('accepts well-formed responses with passthrough fields (forward-compat)', async () => {
    const fetchFn = async (): Promise<Response> =>
      makeResponse(200, {
        reviews: [
          {
            name: 'accounts/A/locations/L/reviews/R1',
            starRating: 'FIVE',
            createTime: '2026-05-10T10:00:00Z',
            // unknown field Google may add later — must NOT reject
            futureField: { nested: 'value' },
          },
        ],
        // unknown top-level field — must NOT reject
        unknownTopLevel: 42,
      });
    const page = await listReviews('at', 'A', 'L', null, fetchFn);
    expect(page.reviews).toHaveLength(1);
    expect(page.reviews[0].name).toBe('accounts/A/locations/L/reviews/R1');
  });
});

// ─── Review-monitoring self-serve: 401 detection + token refresh ────────────
//
// Google access tokens expire after ~1h. The client must surface a 401 as a
// typed GoogleBusinessAuthError (distinct from quota/schema errors) so the
// worker + reply resolver can branch into the shared refresh-and-retry path,
// and `refreshAccessToken` must implement the refresh_token grant.
import {
  GoogleBusinessAuthError,
  refreshAccessToken,
  replyToReview,
  listAccounts,
  listLocations,
} from '../../src/reputation/google-business-client';

describe('GoogleBusinessAuthError (401 detection)', () => {
  it('listReviews throws GoogleBusinessAuthError on 401', async () => {
    const fetchFn = async (): Promise<Response> =>
      makeResponse(401, { error: 'invalid_token' });
    await expect(listReviews('stale', 'A', 'L', null, fetchFn)).rejects.toThrow(
      GoogleBusinessAuthError,
    );
  });

  it('replyToReview throws GoogleBusinessAuthError on 401', async () => {
    const fetchFn = async (): Promise<Response> =>
      makeResponse(401, { error: 'invalid_token' });
    await expect(
      replyToReview('stale', 'A', 'L', 'r1', 'Thanks!', fetchFn),
    ).rejects.toThrow(GoogleBusinessAuthError);
  });

  it('is distinct from quota + schema errors', () => {
    const err = new GoogleBusinessAuthError('nope');
    expect(err).toBeInstanceOf(GoogleBusinessAuthError);
    expect(err).not.toBeInstanceOf(GoogleBusinessQuotaError);
    expect(err).not.toBeInstanceOf(GoogleBusinessApiError);
    expect(err.status).toBe(401);
  });

  it('a 429 still throws GoogleBusinessQuotaError, not the auth error', async () => {
    const fetchFn = async (): Promise<Response> =>
      makeResponse(429, 'slow down', { 'Retry-After': '30' });
    await expect(listReviews('at', 'A', 'L', null, fetchFn)).rejects.toThrow(
      GoogleBusinessQuotaError,
    );
  });
});

describe('refreshAccessToken', () => {
  const config = {
    clientId: 'cid',
    clientSecret: 'csec',
    redirectUri: 'https://api.example.com/cb',
  };

  it('POSTs the refresh_token grant and returns the rotated token + expiry', async () => {
    let capturedBody = '';
    const fetchFn = async (
      _input: string | URL | Request,
      init?: RequestInit,
    ): Promise<Response> => {
      capturedBody = String(init?.body);
      return makeResponse(200, { access_token: 'AT-new', expires_in: 3600 });
    };
    const before = Date.now();
    const rotated = await refreshAccessToken(config, 'RT-1', fetchFn);
    expect(rotated.accessToken).toBe('AT-new');
    expect(rotated.expiresAt.getTime()).toBeGreaterThanOrEqual(
      before + 3600_000 - 5_000,
    );
    const params = new URLSearchParams(capturedBody);
    expect(params.get('grant_type')).toBe('refresh_token');
    expect(params.get('refresh_token')).toBe('RT-1');
    expect(params.get('client_id')).toBe('cid');
    expect(params.get('client_secret')).toBe('csec');
  });

  it('throws GoogleBusinessAuthError when Google rejects the refresh', async () => {
    const fetchFn = async (): Promise<Response> =>
      makeResponse(400, { error: 'invalid_grant' });
    await expect(refreshAccessToken(config, 'RT-revoked', fetchFn)).rejects.toThrow(
      GoogleBusinessAuthError,
    );
  });

  it('throws GoogleBusinessAuthError when no access_token comes back', async () => {
    const fetchFn = async (): Promise<Response> => makeResponse(200, {});
    await expect(refreshAccessToken(config, 'RT-1', fetchFn)).rejects.toThrow(
      GoogleBusinessAuthError,
    );
  });
});

describe('listAccounts / listLocations (connect-flow discovery)', () => {
  it('returns account resource names', async () => {
    const fetchFn = async (input: string | URL | Request): Promise<Response> => {
      expect(String(input)).toContain('/v4/accounts');
      return makeResponse(200, {
        accounts: [{ name: 'accounts/123' }, { name: 'accounts/456' }],
      });
    };
    expect(await listAccounts('at', fetchFn)).toEqual([
      'accounts/123',
      'accounts/456',
    ]);
  });

  it('returns location resource names for an account', async () => {
    const fetchFn = async (input: string | URL | Request): Promise<Response> => {
      expect(String(input)).toContain('/v4/accounts/123/locations');
      return makeResponse(200, {
        locations: [{ name: 'accounts/123/locations/999' }],
      });
    };
    expect(await listLocations('at', '123', fetchFn)).toEqual([
      'accounts/123/locations/999',
    ]);
  });

  it('listAccounts throws GoogleBusinessAuthError on 401', async () => {
    const fetchFn = async (): Promise<Response> =>
      makeResponse(401, { error: 'invalid_token' });
    await expect(listAccounts('stale', fetchFn)).rejects.toThrow(
      GoogleBusinessAuthError,
    );
  });

  it('tolerates an empty accounts list', async () => {
    const fetchFn = async (): Promise<Response> => makeResponse(200, {});
    expect(await listAccounts('at', fetchFn)).toEqual([]);
  });
});
