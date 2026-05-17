/**
 * P7-026 — google-reviews polling worker tests (PR-a scope).
 *
 * Covers:
 *   - new review detection within 15-minute poll cycle (mocked API)
 *   - idempotent re-poll: same review only inserted once
 *   - 429 → backoff schedule advances (1m → 5m → 15m → 1h)
 *   - successful poll resets backoff state
 *   - classifier failure does not crash the sweep
 *
 * The brand-voice / customer-matcher / pii-redactor / proposal tests
 * land alongside the modules they cover in PR-b and PR-c.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import { createLogger } from '../../src/logging/logger';
import {
  BACKOFF_BUCKETS_MS,
  runGoogleReviewsSweep,
  GoogleReviewsWorkerDeps,
} from '../../src/workers/google-reviews';
import {
  GoogleBusinessClient,
  GoogleBusinessRateLimitedError,
} from '../../src/reputation/google-business-client';
import {
  InMemoryGoogleBusinessConnectionRepository,
} from '../../src/reputation/connection-repository';
import {
  InMemoryGoogleReviewRepository,
} from '../../src/reputation/review-repository';
import { HeuristicReviewClassifier } from '../../src/reputation/classifier-stub';
import type {
  GoogleBusinessConnection,
  GoogleReviewApiPayload,
} from '../../src/reputation/types';

const logger = createLogger({ service: 'test', environment: 'test', level: 'error' });

function makeConnection(overrides?: Partial<GoogleBusinessConnection>): GoogleBusinessConnection {
  const now = new Date('2026-05-17T12:00:00Z');
  return {
    id: uuidv4(),
    tenantId: '11111111-1111-1111-1111-111111111111',
    locationId: 'loc-1',
    accountId: 'acct-1',
    accessTokenEncrypted: 'enc:access',
    refreshTokenEncrypted: 'enc:refresh',
    accessTokenExpiresAt: new Date('2026-12-31T00:00:00Z'),
    status: 'active',
    backoffAttempts: 0,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function makeWireReview(overrides?: Partial<GoogleReviewApiPayload>): GoogleReviewApiPayload {
  return {
    reviewId: 'rv-' + uuidv4(),
    reviewer: { displayName: 'Mrs. Donovan' },
    starRating: 'ONE',
    comment: 'Carlos never showed up for the 5pm appointment. Awful service.',
    createTime: '2026-05-17T11:50:00Z',
    ...overrides,
  };
}

interface StubFetchOptions {
  status?: number;
  body?: unknown;
  retryAfter?: string;
}

function stubFetch(opts: StubFetchOptions): typeof fetch {
  const status = opts.status ?? 200;
  const body = opts.body ?? { reviews: [] };
  const headers = new Headers();
  if (opts.retryAfter !== undefined) headers.set('Retry-After', opts.retryAfter);
  return (async () => {
    return new Response(JSON.stringify(body), {
      status,
      headers,
    });
  }) as unknown as typeof fetch;
}

function makeDeps(deps?: Partial<GoogleReviewsWorkerDeps>): GoogleReviewsWorkerDeps {
  return {
    connectionRepo: new InMemoryGoogleBusinessConnectionRepository(),
    reviewRepo: new InMemoryGoogleReviewRepository(),
    client: new GoogleBusinessClient(stubFetch({ body: { reviews: [] } })),
    classifier: new HeuristicReviewClassifier(),
    logger,
    decryptAccessToken: (enc) => enc, // identity for tests
    ...deps,
  };
}

describe('P7-026 google reviews sweep — PR-a (poll + model)', () => {
  let connectionRepo: InMemoryGoogleBusinessConnectionRepository;
  let reviewRepo: InMemoryGoogleReviewRepository;

  beforeEach(() => {
    connectionRepo = new InMemoryGoogleBusinessConnectionRepository();
    reviewRepo = new InMemoryGoogleReviewRepository();
  });

  it('P7-026 detects a new review within a single 15-minute poll cycle', async () => {
    const conn = makeConnection();
    await connectionRepo.create(conn);
    const wire = makeWireReview();

    const deps = makeDeps({
      connectionRepo,
      reviewRepo,
      client: new GoogleBusinessClient(stubFetch({ body: { reviews: [wire] } })),
    });

    const result = await runGoogleReviewsSweep(deps);

    expect(result.connections).toBe(1);
    expect(result.newReviews).toBe(1);
    expect(result.rateLimited).toBe(0);
    expect(result.failed).toBe(0);

    const persisted = await reviewRepo.findByGoogleId(conn.tenantId, wire.reviewId);
    expect(persisted).not.toBeNull();
    expect(persisted?.reviewerName).toBe('Mrs. Donovan');
    expect(persisted?.rating).toBe(1);
    expect(persisted?.classification).toBe('specific_complaint');
  });

  it('P7-026 is idempotent on re-poll: the same google_review_id is not duplicated', async () => {
    const conn = makeConnection();
    await connectionRepo.create(conn);
    const wire = makeWireReview();

    const fetchImpl = stubFetch({ body: { reviews: [wire] } });
    const deps = makeDeps({
      connectionRepo,
      reviewRepo,
      client: new GoogleBusinessClient(fetchImpl),
    });

    const first = await runGoogleReviewsSweep(deps);
    expect(first.newReviews).toBe(1);

    // Second sweep with the same wire payload. Without lastPolledAt
    // gating, upsert's unique-key behaviour must prevent duplication.
    const second = await runGoogleReviewsSweep(deps);
    expect(second.newReviews).toBe(0);
    const all = await reviewRepo.findByTenant(conn.tenantId);
    expect(all).toHaveLength(1);
  });

  it('P7-026 escalates backoff on HTTP 429 (1m → 5m → 15m → 1h)', async () => {
    const conn = makeConnection();
    await connectionRepo.create(conn);

    const fetchImpl = (async () => {
      return new Response('Rate limit exceeded', { status: 429 });
    }) as unknown as typeof fetch;

    const t0 = new Date('2026-05-17T12:00:00Z');
    const deps = makeDeps({
      connectionRepo,
      reviewRepo,
      client: new GoogleBusinessClient(fetchImpl),
      now: () => t0,
      rng: () => 0.5, // jitter midpoint
    });

    // First 429 → bucket[0] = 1m
    await runGoogleReviewsSweep(deps);
    let stored = await connectionRepo.findById(conn.tenantId, conn.id);
    expect(stored?.backoffAttempts).toBe(1);
    const firstBackoff = (stored?.backoffUntil?.getTime() ?? 0) - t0.getTime();
    expect(firstBackoff).toBeGreaterThanOrEqual(BACKOFF_BUCKETS_MS[0]! * 0.8);
    expect(firstBackoff).toBeLessThanOrEqual(BACKOFF_BUCKETS_MS[0]! * 1.2);

    // Force findPollCandidates to include the connection again by
    // clearing backoffUntil between calls (simulates time passing).
    await connectionRepo.update(conn.tenantId, conn.id, { backoffUntil: null });

    // Second 429 → bucket[1] = 5m
    await runGoogleReviewsSweep(deps);
    stored = await connectionRepo.findById(conn.tenantId, conn.id);
    expect(stored?.backoffAttempts).toBe(2);
    const secondBackoff = (stored?.backoffUntil?.getTime() ?? 0) - t0.getTime();
    expect(secondBackoff).toBeGreaterThanOrEqual(BACKOFF_BUCKETS_MS[1]! * 0.8);
    expect(secondBackoff).toBeLessThanOrEqual(BACKOFF_BUCKETS_MS[1]! * 1.2);

    await connectionRepo.update(conn.tenantId, conn.id, { backoffUntil: null });

    // Third 429 → bucket[2] = 15m
    await runGoogleReviewsSweep(deps);
    stored = await connectionRepo.findById(conn.tenantId, conn.id);
    expect(stored?.backoffAttempts).toBe(3);
    const thirdBackoff = (stored?.backoffUntil?.getTime() ?? 0) - t0.getTime();
    expect(thirdBackoff).toBeGreaterThanOrEqual(BACKOFF_BUCKETS_MS[2]! * 0.8);
    expect(thirdBackoff).toBeLessThanOrEqual(BACKOFF_BUCKETS_MS[2]! * 1.2);

    await connectionRepo.update(conn.tenantId, conn.id, { backoffUntil: null });

    // Fourth 429 → bucket[3] = 1h (and never exceeds it on further attempts)
    await runGoogleReviewsSweep(deps);
    stored = await connectionRepo.findById(conn.tenantId, conn.id);
    expect(stored?.backoffAttempts).toBe(4);
    const fourthBackoff = (stored?.backoffUntil?.getTime() ?? 0) - t0.getTime();
    expect(fourthBackoff).toBeGreaterThanOrEqual(BACKOFF_BUCKETS_MS[3]! * 0.8);
    expect(fourthBackoff).toBeLessThanOrEqual(BACKOFF_BUCKETS_MS[3]! * 1.2);
  });

  it('P7-026 honors Google Retry-After when it is longer than our bucket', async () => {
    const conn = makeConnection();
    await connectionRepo.create(conn);

    const fetchImpl = (async () =>
      new Response('Rate limited', {
        status: 429,
        headers: { 'Retry-After': '7200' }, // 2 hours
      })) as unknown as typeof fetch;

    const t0 = new Date('2026-05-17T12:00:00Z');
    const deps = makeDeps({
      connectionRepo,
      reviewRepo,
      client: new GoogleBusinessClient(fetchImpl),
      now: () => t0,
      rng: () => 0.5,
    });

    await runGoogleReviewsSweep(deps);

    const stored = await connectionRepo.findById(conn.tenantId, conn.id);
    const backoffMs = (stored?.backoffUntil?.getTime() ?? 0) - t0.getTime();
    // 2h server hint dominates the 1m first bucket
    expect(backoffMs).toBeGreaterThanOrEqual(7200 * 1000);
  });

  it('P7-026 clears backoff state on a successful poll', async () => {
    const conn = makeConnection({
      backoffAttempts: 2,
      backoffUntil: new Date('2026-01-01T00:00:00Z'), // in past — eligible
    });
    await connectionRepo.create(conn);

    const deps = makeDeps({
      connectionRepo,
      reviewRepo,
      client: new GoogleBusinessClient(stubFetch({ body: { reviews: [] } })),
    });

    await runGoogleReviewsSweep(deps);

    const stored = await connectionRepo.findById(conn.tenantId, conn.id);
    expect(stored?.backoffAttempts).toBe(0);
    expect(stored?.backoffUntil).toBeUndefined();
    expect(stored?.lastPolledAt).toBeDefined();
  });

  it('P7-026 skips connections still inside their backoff window', async () => {
    const conn = makeConnection({
      backoffUntil: new Date('2099-01-01T00:00:00Z'), // future
    });
    await connectionRepo.create(conn);

    const deps = makeDeps({
      connectionRepo,
      reviewRepo,
      client: new GoogleBusinessClient(stubFetch({ body: { reviews: [makeWireReview()] } })),
      now: () => new Date('2026-05-17T12:00:00Z'),
    });

    const result = await runGoogleReviewsSweep(deps);
    expect(result.connections).toBe(0); // findPollCandidates filtered it out
    expect(result.newReviews).toBe(0);
  });

  it('P7-026 keeps sweeping when classifier throws on one review', async () => {
    const conn = makeConnection();
    await connectionRepo.create(conn);

    const failingClassifier = {
      async classify() {
        throw new Error('classifier exploded');
      },
    };

    const deps = makeDeps({
      connectionRepo,
      reviewRepo,
      classifier: failingClassifier,
      client: new GoogleBusinessClient(stubFetch({ body: { reviews: [makeWireReview()] } })),
    });

    const result = await runGoogleReviewsSweep(deps);
    expect(result.failed).toBe(0); // classifier failure doesn't bubble
    expect(result.newReviews).toBe(1); // review still persisted

    const reviews = await reviewRepo.findByTenant(conn.tenantId);
    expect(reviews).toHaveLength(1);
    expect(reviews[0]?.classification).toBeUndefined();
  });

  it('P7-026 isolates per-connection failures so one tenant cannot crash the sweep', async () => {
    const goodConn = makeConnection({
      tenantId: '22222222-2222-2222-2222-222222222222',
    });
    const badConn = makeConnection({
      tenantId: '33333333-3333-3333-3333-333333333333',
      accessTokenEncrypted: 'enc:bad',
    });
    await connectionRepo.create(goodConn);
    await connectionRepo.create(badConn);

    // The first call (alphabetically first connection) succeeds; the
    // second throws a non-429 transport error.
    let callCount = 0;
    const fetchImpl = (async (url: string) => {
      callCount++;
      if (callCount === 2) {
        return new Response('boom', { status: 500 });
      }
      return new Response(JSON.stringify({ reviews: [makeWireReview()] }), {
        status: 200,
      });
    }) as unknown as typeof fetch;

    const deps = makeDeps({
      connectionRepo,
      reviewRepo,
      client: new GoogleBusinessClient(fetchImpl),
    });

    const result = await runGoogleReviewsSweep(deps);
    expect(result.connections).toBe(2);
    expect(result.newReviews).toBe(1);
    expect(result.failed).toBe(1);
  });
});

describe('P7-026 GoogleBusinessClient HTTP behaviour', () => {
  it('P7-026 throws GoogleBusinessRateLimitedError on HTTP 429', async () => {
    const client = new GoogleBusinessClient((async () =>
      new Response('rate limit', {
        status: 429,
        headers: { 'Retry-After': '60' },
      })) as unknown as typeof fetch);
    await expect(
      client.listReviews({
        accountId: 'a',
        locationId: 'l',
        accessToken: 'tok',
      }),
    ).rejects.toBeInstanceOf(GoogleBusinessRateLimitedError);
  });

  it('P7-026 parses an empty reviews list', async () => {
    const client = new GoogleBusinessClient((async () =>
      new Response(JSON.stringify({}), { status: 200 })) as unknown as typeof fetch);
    const res = await client.listReviews({
      accountId: 'a',
      locationId: 'l',
      accessToken: 'tok',
    });
    expect(res.reviews).toEqual([]);
  });

  it('P7-026 surfaces non-429 errors as GoogleBusinessApiError', async () => {
    const client = new GoogleBusinessClient((async () =>
      new Response('Forbidden', { status: 403 })) as unknown as typeof fetch);
    await expect(
      client.listReviews({
        accountId: 'a',
        locationId: 'l',
        accessToken: 'tok',
      }),
    ).rejects.toMatchObject({ statusCode: 502, code: 'GOOGLE_BUSINESS_API_ERROR' });
  });
});

describe('P7-026 HeuristicReviewClassifier (stub for PR-a)', () => {
  const c = new HeuristicReviewClassifier();
  it('P7-026 classifies 5-star reviews as praise', async () => {
    expect(await c.classify({ rating: 5, commentText: 'Great work!' })).toBe('praise');
  });
  it('P7-026 classifies 1-star with detail as specific_complaint', async () => {
    expect(
      await c.classify({
        rating: 1,
        commentText: 'They never showed up after promising 5pm window.',
      }),
    ).toBe('specific_complaint');
  });
  it('P7-026 classifies short 1-star as vague_complaint', async () => {
    expect(await c.classify({ rating: 1, commentText: 'Bad.' })).toBe('vague_complaint');
  });
  it('P7-026 catches wrong_business marker', async () => {
    expect(
      await c.classify({ rating: 2, commentText: 'Wrong business, I never used them.' }),
    ).toBe('wrong_business');
  });
});
