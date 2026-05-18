import { describe, it, expect } from 'vitest';
import {
  buildGoogleBusinessAuthUrl,
  exchangeAuthorizationCode,
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

describe('parseStarRating', () => {
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

describe('buildGoogleBusinessAuthUrl', () => {
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

describe('exchangeAuthorizationCode', () => {
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

describe('listReviews', () => {
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
});
