/**
 * P7-026 final wiring — PgGoogleBusinessReplyResolver tests.
 *
 * Verifies the adapter that the cross-PR review flagged as missing:
 * without it, the execution handler's googleReplyResolver dep was
 * undefined and the public-reply path returned ok:true without
 * posting to Google. These tests exercise every null-returning path
 * plus the happy path.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  PgGoogleBusinessReplyResolver,
  parseReviewExternalId,
  parseLocationPath,
} from '../../src/reputation/pg-google-business-reply-resolver';
import {
  InMemoryReviewRepository,
  type Review,
} from '../../src/reputation/review';
import type {
  CredentialResolver,
  CredentialRow,
} from '../../src/integrations/credentials';

const TENANT = 'tenant-1';
const REVIEW_ID = 'review-1';

function makeReview(overrides: Partial<Review> = {}): Review {
  const now = new Date('2026-05-17T10:00:00Z');
  return {
    id: REVIEW_ID,
    tenantId: TENANT,
    externalReviewId: 'accounts/A/locations/L/reviews/upstream-r1',
    locationId: 'accounts/A/locations/L',
    reviewerDisplayName: 'Alice',
    reviewerProfileUrl: null,
    rating: 5,
    commentText: 'Great',
    createTime: now,
    updateTime: now,
    firstFetchedAt: now,
    lastFetchedAt: now,
    ...overrides,
  };
}

function makeResolver(
  credentials: Record<string, CredentialRow | null>,
): CredentialResolver {
  return {
    async getCredential(tenantId, _provider) {
      return credentials[tenantId] ?? null;
    },
    async close() {},
  };
}

function credRow(
  tenantId: string,
  creds: Record<string, unknown>,
): CredentialRow {
  return {
    tenant_id: tenantId,
    provider: 'google_business',
    credentials: creds,
    credential_version: 1,
  };
}

describe('P7-026 PgGoogleBusinessReplyResolver', () => {
  it('returns null when the review row is missing', async () => {
    const reviewRepo = new InMemoryReviewRepository();
    const credentialResolver = makeResolver({
      [TENANT]: credRow(TENANT, { accessToken: 'at' }),
    });
    const resolver = new PgGoogleBusinessReplyResolver(
      reviewRepo,
      credentialResolver,
      'enc-key-unused',
    );

    const result = await resolver.resolve(TENANT, 'missing-id');
    expect(result).toBeNull();
  });

  it('returns null when the tenant has no google_business credential', async () => {
    const reviewRepo = new InMemoryReviewRepository();
    await reviewRepo.upsert(makeReview());
    const credentialResolver = makeResolver({
      // Empty — the tenant has no integration row.
    });
    const resolver = new PgGoogleBusinessReplyResolver(
      reviewRepo,
      credentialResolver,
      'enc-key-unused',
    );

    const result = await resolver.resolve(TENANT, REVIEW_ID);
    expect(result).toBeNull();
  });

  it('returns null when the credential row has no access token', async () => {
    const reviewRepo = new InMemoryReviewRepository();
    await reviewRepo.upsert(makeReview());
    const credentialResolver = makeResolver({
      [TENANT]: credRow(TENANT, {
        providerData: { accountId: 'A', locationId: 'L' },
      }),
    });
    const resolver = new PgGoogleBusinessReplyResolver(
      reviewRepo,
      credentialResolver,
      'enc-key-unused',
    );

    const result = await resolver.resolve(TENANT, REVIEW_ID);
    expect(result).toBeNull();
  });

  it('returns full context when review + credential are present (providerData shape)', async () => {
    const reviewRepo = new InMemoryReviewRepository();
    await reviewRepo.upsert(makeReview());
    const credentialResolver = makeResolver({
      [TENANT]: credRow(TENANT, {
        accessToken: 'at-1',
        providerData: { accountId: 'A', locationId: 'L' },
      }),
    });
    const resolver = new PgGoogleBusinessReplyResolver(
      reviewRepo,
      credentialResolver,
      'enc-key-unused',
    );

    const result = await resolver.resolve(TENANT, REVIEW_ID);
    expect(result).toEqual({
      accessToken: 'at-1',
      accountId: 'A',
      locationId: 'L',
      reviewExternalId: 'upstream-r1',
    });
  });

  it('returns full context when providerData is missing but review.locationId carries the path', async () => {
    const reviewRepo = new InMemoryReviewRepository();
    await reviewRepo.upsert(makeReview());
    // Credential row carries the access token but NO providerData /
    // accountId / locationId — the resolver must fall back to parsing
    // the persisted review's `locationId`.
    const credentialResolver = makeResolver({
      [TENANT]: credRow(TENANT, { accessToken: 'at-1' }),
    });
    const resolver = new PgGoogleBusinessReplyResolver(
      reviewRepo,
      credentialResolver,
      'enc-key-unused',
    );

    const result = await resolver.resolve(TENANT, REVIEW_ID);
    expect(result).toEqual({
      accessToken: 'at-1',
      accountId: 'A',
      locationId: 'L',
      reviewExternalId: 'upstream-r1',
    });
  });

  it('returns null when externalReviewId lacks a reviews/ segment', async () => {
    const reviewRepo = new InMemoryReviewRepository();
    await reviewRepo.upsert(
      makeReview({ externalReviewId: 'corrupted-no-segment' }),
    );
    const credentialResolver = makeResolver({
      [TENANT]: credRow(TENANT, {
        accessToken: 'at',
        providerData: { accountId: 'A', locationId: 'L' },
      }),
    });
    const resolver = new PgGoogleBusinessReplyResolver(
      reviewRepo,
      credentialResolver,
      'enc-key-unused',
    );

    const result = await resolver.resolve(TENANT, REVIEW_ID);
    expect(result).toBeNull();
  });
});

// ─── Review-monitoring self-serve — expired-token refresh on the reply path ─
//
// The execution handler calls resolver.resolve() right before PUTting the
// reply; a token minted >1h before approval is dead. The resolver must
// refresh an expired access token via the stored refresh token, persist the
// rotation, and hand the handler a live token. When refresh fails it returns
// null so the handler surfaces an explicit ok:false (visible, not silent).
describe('PgGoogleBusinessReplyResolver — token refresh', () => {
  const NOW = new Date('2026-08-05T12:00:00Z');
  const CONFIG = {
    clientId: 'cid',
    clientSecret: 'csec',
    redirectUri: 'https://api.example.com/cb',
  };

  function seededRepo(): InMemoryReviewRepository {
    const repo = new InMemoryReviewRepository();
    void repo.upsert(makeReview());
    return repo;
  }

  it('refreshes an expired token, persists the rotation, and returns the fresh token', async () => {
    const persist = vi.fn(
      async (_tenantId: string, _accessToken: string, _expiresAt: Date) => {},
    );
    const tokenEndpoint = vi.fn(async () =>
      new Response(JSON.stringify({ access_token: 'at-new', expires_in: 3600 }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    const resolver = new PgGoogleBusinessReplyResolver(
      seededRepo(),
      makeResolver({
        [TENANT]: credRow(TENANT, {
          accessToken: 'at-expired',
          refreshToken: 'rt-1',
          accessTokenExpiresAt: '2026-08-05T11:00:00Z', // an hour stale
          providerData: { accountId: 'A', locationId: 'L' },
        }),
      }),
      'enc-key-unused',
      {
        googleConfig: CONFIG,
        credentialStore: { persistRotatedAccessToken: persist },
        fetchFn: tokenEndpoint as unknown as typeof fetch,
        now: () => NOW,
      },
    );

    const result = await resolver.resolve(TENANT, REVIEW_ID);
    expect(result?.accessToken).toBe('at-new');
    expect(tokenEndpoint).toHaveBeenCalledTimes(1);
    expect(persist).toHaveBeenCalledTimes(1);
    expect(persist.mock.calls[0][0]).toBe(TENANT);
    expect(persist.mock.calls[0][1]).toBe('at-new');
  });

  it('returns null (visible failure at the handler) when refresh fails', async () => {
    const resolver = new PgGoogleBusinessReplyResolver(
      seededRepo(),
      makeResolver({
        [TENANT]: credRow(TENANT, {
          accessToken: 'at-expired',
          refreshToken: 'rt-revoked',
          accessTokenExpiresAt: '2026-08-05T11:00:00Z',
          providerData: { accountId: 'A', locationId: 'L' },
        }),
      }),
      'enc-key-unused',
      {
        googleConfig: CONFIG,
        credentialStore: { persistRotatedAccessToken: async () => {} },
        fetchFn: (async () =>
          new Response('{"error":"invalid_grant"}', { status: 400 })) as unknown as typeof fetch,
        now: () => NOW,
      },
    );
    expect(await resolver.resolve(TENANT, REVIEW_ID)).toBeNull();
  });

  it('uses the stored token as-is when it has not expired (no refresh call)', async () => {
    const tokenEndpoint = vi.fn();
    const resolver = new PgGoogleBusinessReplyResolver(
      seededRepo(),
      makeResolver({
        [TENANT]: credRow(TENANT, {
          accessToken: 'at-live',
          refreshToken: 'rt-1',
          accessTokenExpiresAt: '2026-08-05T13:00:00Z', // an hour of life left
          providerData: { accountId: 'A', locationId: 'L' },
        }),
      }),
      'enc-key-unused',
      {
        googleConfig: CONFIG,
        credentialStore: { persistRotatedAccessToken: async () => {} },
        fetchFn: tokenEndpoint as unknown as typeof fetch,
        now: () => NOW,
      },
    );
    const result = await resolver.resolve(TENANT, REVIEW_ID);
    expect(result?.accessToken).toBe('at-live');
    expect(tokenEndpoint).not.toHaveBeenCalled();
  });
});

describe('P7-026 parseReviewExternalId', () => {
  it('returns the trailing leaf id', () => {
    expect(
      parseReviewExternalId('accounts/A/locations/L/reviews/r1'),
    ).toBe('r1');
  });

  it('returns null when no reviews/ segment is present', () => {
    expect(parseReviewExternalId('accounts/A/locations/L')).toBeNull();
  });

  it('returns null when the leaf is empty', () => {
    expect(parseReviewExternalId('accounts/A/reviews/')).toBeNull();
  });
});

describe('P7-026 parseLocationPath', () => {
  it('extracts accountId and locationId', () => {
    expect(parseLocationPath('accounts/A/locations/L')).toEqual({
      accountId: 'A',
      locationId: 'L',
    });
  });

  it('returns empty fields when segments are absent', () => {
    expect(parseLocationPath('not-a-path')).toEqual({});
  });
});
