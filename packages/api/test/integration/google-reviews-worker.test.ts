/**
 * Postgres integration — Google Business reviews polling worker (P7-026 PR a).
 *
 * The handler / pagination / proposal-emission logic is covered by
 * test/workers/google-reviews.test.ts against in-memory repos. This file
 * drives runGoogleReviewsSweep with the production Pg repos to pin the
 * durable-queue guards the worker leans on in production:
 *
 *   1. google_reviews UNIQUE (tenant_id, external_review_id) + ON
 *      CONFLICT — re-runs of the sweep are no-ops; `inserted` flips to
 *      false on the second pass.
 *   2. review_poll_state ON CONFLICT (tenant_id) — cursor + backoff
 *      writes are race-free.
 *   3. RLS on google_reviews (FORCE ROW LEVEL SECURITY, migration 184)
 *      — cross-tenant queries via the production read path return zero.
 *   4. Throttling: a tenant with backoff_until > now is skipped without
 *      a Google call (throttled++); a 429 from Google records the
 *      quota state via the recordQuotaError SQL.
 *
 * Proposal emission is intentionally NOT wired here — it is fully
 * covered by the unit test and adds substantial fixture cost without
 * pinning any additional SQL.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Pool, PoolClient } from 'pg';
import { closeSharedTestDb, createTestTenant, getSharedTestDb } from './shared';
import { runGoogleReviewsSweep } from '../../src/workers/google-reviews';
import { PgReviewRepository } from '../../src/reputation/pg-review';
import { PgReviewPollStateRepository } from '../../src/reputation/poll-state';
import type {
  CredentialResolver,
  CredentialRow,
} from '../../src/integrations/credentials';
import type { GoogleFetch } from '../../src/reputation/google-business-client';
import { createLogger } from '../../src/logging/logger';

const logger = createLogger({ service: 'test', environment: 'test', level: 'error' });

// Bare GBP IDs — listReviews builds /accounts/${accountId}/locations/${locationId}/reviews,
// so passing the path prefix here would double it. Full Google resource paths
// (accounts/{a}/locations/{l}/reviews/{r}) are used below as external_review_id values
// because that IS what Google's `name` field carries on each review.
const ACCOUNT_ID = '123';
const LOCATION_ID = '456';

interface GoogleReviewFixture {
  externalReviewId: string;
  reviewer?: string;
  rating: 'ONE' | 'TWO' | 'THREE' | 'FOUR' | 'FIVE';
  comment?: string;
  updateTime: string;
}

/**
 * Mocked fetchFn that returns Google's listReviews shape for a fixed set
 * of reviews. Tracks how many times each URL was called so tests can
 * assert "Google was NOT called for the throttled tenant".
 */
function makeReviewsFetch(reviews: GoogleReviewFixture[]): {
  fetchFn: GoogleFetch;
  calls: string[];
} {
  const calls: string[] = [];
  const fetchFn: GoogleFetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : String(input);
    calls.push(url);
    const body = {
      reviews: reviews.map((r) => ({
        name: r.externalReviewId,
        starRating: r.rating,
        ...(r.reviewer ? { reviewer: { displayName: r.reviewer } } : {}),
        ...(r.comment ? { comment: r.comment } : {}),
        createTime: r.updateTime,
        updateTime: r.updateTime,
      })),
    };
    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      async json() {
        return body;
      },
      async text() {
        return JSON.stringify(body);
      },
    } as unknown as Response;
  }) as GoogleFetch;
  return { fetchFn, calls };
}

/** A fetchFn that returns 429 with a Retry-After header. */
function makeQuotaFetch(retryAfterSeconds = 30): {
  fetchFn: GoogleFetch;
  calls: string[];
} {
  const calls: string[] = [];
  const fetchFn: GoogleFetch = (async (input: RequestInfo | URL) => {
    calls.push(typeof input === 'string' ? input : String(input));
    return {
      ok: false,
      status: 429,
      headers: {
        get(name: string) {
          return name.toLowerCase() === 'retry-after' ? String(retryAfterSeconds) : null;
        },
      },
      async text() {
        return 'quota exceeded';
      },
      async json() {
        return {};
      },
    } as unknown as Response;
  }) as GoogleFetch;
  return { fetchFn, calls };
}

/**
 * Stub CredentialResolver that knows the tenants with active integrations.
 * Returns a plaintext-accessToken row so the worker bypasses the
 * TENANT_ENCRYPTION_KEY decrypt path (which is covered by the calendar
 * sync integration test).
 */
function makeCredentialResolver(
  active: Map<string, { accountId: string; locationId: string }>,
): CredentialResolver {
  return {
    async getCredential(tenantId: string, provider: string): Promise<CredentialRow | null> {
      if (provider !== 'google_business') return null;
      const cfg = active.get(tenantId);
      if (!cfg) return null;
      return {
        tenant_id: tenantId,
        provider,
        credentials: {
          accessToken: 'plaintext-test-token',
          accountId: cfg.accountId,
          locationId: cfg.locationId,
        },
        credential_version: 1,
      };
    },
    async close() {},
  };
}

/**
 * Unprivileged role + GUC pattern mirrored from rls-tenant-isolation.test.ts.
 * The testcontainer's default user is a SUPERUSER (bypasses RLS), so
 * `reviewRepo.findByExternalId(tenantA, externalIdB)` is filtered by
 * `WHERE tenant_id = $1 AND external_review_id = $2` whether RLS exists
 * or not. Querying through asTenant under this NOBYPASSRLS role without
 * a `tenant_id` predicate makes the policy itself the only thing gating
 * cross-tenant reads.
 */
const APP_ROLE = 'rls_app_runtime';

async function ensureRlsAppRole(pool: Pool): Promise<void> {
  await pool.query(`DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${APP_ROLE}') THEN
      CREATE ROLE ${APP_ROLE} NOLOGIN NOBYPASSRLS;
    END IF;
  END $$;`);
  await pool.query(`GRANT USAGE ON SCHEMA public TO ${APP_ROLE}`);
  await pool.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${APP_ROLE}`);
}

async function asTenant<T>(
  pool: Pool,
  tenantId: string,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SET LOCAL ROLE ${APP_ROLE}`);
    await client.query("SELECT set_config('app.current_tenant_id', $1, true)", [tenantId]);
    return await fn(client);
  } finally {
    await client.query('ROLLBACK').catch(() => undefined);
    client.release();
  }
}

describe('Google Reviews worker — integration', () => {
  let pool: Pool;
  let reviewRepo: PgReviewRepository;
  let pollStateRepo: PgReviewPollStateRepository;
  let tenantA: { tenantId: string; userId: string };

  beforeAll(async () => {
    pool = await getSharedTestDb();
    reviewRepo = new PgReviewRepository(pool);
    pollStateRepo = new PgReviewPollStateRepository(pool);
    await ensureRlsAppRole(pool);
  });

  beforeEach(async () => {
    tenantA = await createTestTenant(pool);
  });

  afterAll(async () => {
    await closeSharedTestDb();
  });

  it('happy path: sweep persists new reviews + advances the per-tenant cursor', async () => {
    const credentialResolver = makeCredentialResolver(
      new Map([[tenantA.tenantId, { accountId: ACCOUNT_ID, locationId: LOCATION_ID }]]),
    );
    const { fetchFn, calls } = makeReviewsFetch([
      {
        externalReviewId: `accounts/123/locations/456/reviews/r1`,
        reviewer: 'Alice',
        rating: 'FIVE',
        comment: 'Fantastic service',
        updateTime: '2026-06-19T10:00:00Z',
      },
      {
        externalReviewId: `accounts/123/locations/456/reviews/r2`,
        reviewer: 'Bob',
        rating: 'FOUR',
        comment: 'Solid work',
        updateTime: '2026-06-19T09:00:00Z',
      },
    ]);

    const result = await runGoogleReviewsSweep({
      reviewRepo,
      pollStateRepo,
      credentialResolver,
      listTenantIds: async () => [tenantA.tenantId],
      fetchFn,
      logger,
    });

    expect(result.tenants).toBe(1);
    expect(result.fetched).toBe(2);
    expect(result.persisted).toBe(2);
    expect(result.throttled).toBe(0);
    expect(result.failed).toBe(0);
    expect(calls).toHaveLength(1);

    // Both rows live in google_reviews via the production read path.
    const r1 = await reviewRepo.findByExternalId(
      tenantA.tenantId,
      'accounts/123/locations/456/reviews/r1',
    );
    const r2 = await reviewRepo.findByExternalId(
      tenantA.tenantId,
      'accounts/123/locations/456/reviews/r2',
    );
    expect(r1?.rating).toBe(5);
    expect(r2?.rating).toBe(4);

    // Cursor advanced to the newest review's updateTime.
    const state = await pollStateRepo.getPollState(tenantA.tenantId);
    expect(state).not.toBeNull();
    expect(state!.cursor).not.toBeNull();
    expect(state!.backoffUntil).toBeNull();
    expect(state!.consecutive429Count).toBe(0);
  });

  it('idempotent on re-sweep: a second sweep with the same upstream data persists nothing new', async () => {
    const credentialResolver = makeCredentialResolver(
      new Map([[tenantA.tenantId, { accountId: ACCOUNT_ID, locationId: LOCATION_ID }]]),
    );
    const { fetchFn } = makeReviewsFetch([
      {
        externalReviewId: 'accounts/123/locations/456/reviews/r_idem',
        reviewer: 'Carol',
        rating: 'THREE',
        comment: 'OK',
        updateTime: '2026-06-19T11:00:00Z',
      },
    ]);

    const first = await runGoogleReviewsSweep({
      reviewRepo,
      pollStateRepo,
      credentialResolver,
      listTenantIds: async () => [tenantA.tenantId],
      fetchFn,
      logger,
    });
    expect(first.persisted).toBe(1);

    const second = await runGoogleReviewsSweep({
      reviewRepo,
      pollStateRepo,
      credentialResolver,
      listTenantIds: async () => [tenantA.tenantId],
      fetchFn,
      logger,
    });
    // The upsert flipped to inserted=false; nothing new persists.
    expect(second.persisted).toBe(0);
    expect(second.fetched).toBeGreaterThanOrEqual(0);
  });

  it('throttling: a tenant whose backoff_until is in the future is skipped — no Google call, throttled++', async () => {
    // Pre-seed a backoff that hasn't lifted.
    await pollStateRepo.recordQuotaError(tenantA.tenantId, 60);

    const credentialResolver = makeCredentialResolver(
      new Map([[tenantA.tenantId, { accountId: ACCOUNT_ID, locationId: LOCATION_ID }]]),
    );
    const { fetchFn, calls } = makeReviewsFetch([]);

    const result = await runGoogleReviewsSweep({
      reviewRepo,
      pollStateRepo,
      credentialResolver,
      listTenantIds: async () => [tenantA.tenantId],
      fetchFn,
      logger,
    });

    expect(result.throttled).toBe(1);
    expect(result.fetched).toBe(0);
    expect(result.persisted).toBe(0);
    // Google must NOT have been called for the throttled tenant.
    expect(calls).toHaveLength(0);
  });

  it('429 from Google: throttled++ AND poll state stamps backoff_until + consecutive_429_count', async () => {
    const credentialResolver = makeCredentialResolver(
      new Map([[tenantA.tenantId, { accountId: ACCOUNT_ID, locationId: LOCATION_ID }]]),
    );
    const { fetchFn } = makeQuotaFetch(45);

    const before = await pollStateRepo.getPollState(tenantA.tenantId);
    expect(before).toBeNull();

    const result = await runGoogleReviewsSweep({
      reviewRepo,
      pollStateRepo,
      credentialResolver,
      listTenantIds: async () => [tenantA.tenantId],
      fetchFn,
      logger,
    });

    expect(result.throttled).toBe(1);
    expect(result.persisted).toBe(0);

    const after = await pollStateRepo.getPollState(tenantA.tenantId);
    expect(after).not.toBeNull();
    expect(after!.consecutive429Count).toBe(1);
    expect(after!.backoffUntil).not.toBeNull();
    // backoffUntil must be in the future after a quota error.
    expect(after!.backoffUntil!.getTime()).toBeGreaterThan(Date.now());
  });

  it('silently skips tenants with no integration row (not counted as failed)', async () => {
    const credentialResolver = makeCredentialResolver(new Map()); // no integrations
    const { fetchFn, calls } = makeReviewsFetch([]);

    const result = await runGoogleReviewsSweep({
      reviewRepo,
      pollStateRepo,
      credentialResolver,
      listTenantIds: async () => [tenantA.tenantId],
      fetchFn,
      logger,
    });

    expect(result.tenants).toBe(1);
    expect(result.failed).toBe(0);
    expect(result.persisted).toBe(0);
    expect(calls).toHaveLength(0);
  });

  it('tenant isolation: reviews persisted under tenant A are invisible to tenant B under RLS', async () => {
    const tenantB = await createTestTenant(pool);
    const credentialResolver = makeCredentialResolver(
      new Map([
        [tenantA.tenantId, { accountId: ACCOUNT_ID, locationId: LOCATION_ID }],
        [tenantB.tenantId, { accountId: '789', locationId: '012' }],
      ]),
    );
    // One review per tenant — disambiguated by their accountId in the URL.
    const fetchFn: GoogleFetch = (async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : String(input);
      const externalId = url.includes('accounts/789')
        ? 'accounts/789/locations/012/reviews/iso_b'
        : 'accounts/123/locations/456/reviews/iso_a';
      const body = {
        reviews: [
          {
            name: externalId,
            starRating: 'FIVE',
            reviewer: { displayName: 'Iso' },
            comment: 'Tenant-scoped',
            createTime: '2026-06-19T12:00:00Z',
            updateTime: '2026-06-19T12:00:00Z',
          },
        ],
      };
      return {
        ok: true,
        status: 200,
        headers: { get: () => null },
        async json() {
          return body;
        },
        async text() {
          return JSON.stringify(body);
        },
      } as unknown as Response;
    }) as GoogleFetch;

    await runGoogleReviewsSweep({
      reviewRepo,
      pollStateRepo,
      credentialResolver,
      listTenantIds: async () => [tenantA.tenantId, tenantB.tenantId],
      fetchFn,
      logger,
    });

    // Each tenant sees only its own review via the prod read path.
    const aSees = await reviewRepo.findByExternalId(
      tenantA.tenantId,
      'accounts/123/locations/456/reviews/iso_a',
    );
    const bSees = await reviewRepo.findByExternalId(
      tenantB.tenantId,
      'accounts/789/locations/012/reviews/iso_b',
    );
    expect(aSees).not.toBeNull();
    expect(bSees).not.toBeNull();

    // RLS proof: under each tenant's GUC and the unprivileged role,
    // enumerate google_reviews WITHOUT a `tenant_id` predicate. Only the
    // policy can gate this read — if it were dropped, the assertion fails.
    const externalIdsUnderA = await asTenant(pool, tenantA.tenantId, (client) =>
      client.query(`SELECT external_review_id FROM google_reviews`).then((r) =>
        r.rows.map((row: { external_review_id: string }) => row.external_review_id),
      ),
    );
    const externalIdsUnderB = await asTenant(pool, tenantB.tenantId, (client) =>
      client.query(`SELECT external_review_id FROM google_reviews`).then((r) =>
        r.rows.map((row: { external_review_id: string }) => row.external_review_id),
      ),
    );
    expect(externalIdsUnderA).toContain('accounts/123/locations/456/reviews/iso_a');
    expect(externalIdsUnderA).not.toContain('accounts/789/locations/012/reviews/iso_b');
    expect(externalIdsUnderB).toContain('accounts/789/locations/012/reviews/iso_b');
    expect(externalIdsUnderB).not.toContain('accounts/123/locations/456/reviews/iso_a');
  });
});
