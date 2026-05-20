/**
 * PgReviewRepository unit smoke test — exercises the query string +
 * row mapping by stubbing `pool.connect()`. A full integration test
 * (real Postgres) lives in test/integration when CI provisions a DB
 * for this PR series. The smoke test catches schema/column drift
 * without standing up a container.
 */
import { describe, it, expect, vi } from 'vitest';
import { PgReviewRepository } from '../../src/reputation/pg-review';
import type { Pool } from 'pg';

function makeRow(overrides: Partial<ReturnType<typeof baseRow>> = {}) {
  return { ...baseRow(), ...overrides };
}

function baseRow() {
  return {
    id: '11111111-1111-1111-1111-111111111111',
    tenant_id: '22222222-2222-2222-2222-222222222222',
    external_review_id: 'accounts/A/locations/L/reviews/R1',
    location_id: 'accounts/A/locations/L',
    reviewer_display_name: 'Alice',
    reviewer_profile_url: null,
    rating: 5,
    comment_text: 'Great',
    review_create_time: '2026-05-17T10:00:00.000Z',
    review_update_time: '2026-05-17T10:00:00.000Z',
    first_fetched_at: '2026-05-17T10:01:00.000Z',
    last_fetched_at: '2026-05-17T10:01:00.000Z',
    is_insert: true,
  };
}

function makeMockPool(queryFn: ReturnType<typeof vi.fn>) {
  return {
    connect: vi.fn(async () => ({
      query: queryFn,
      release: vi.fn(),
    })),
  } as unknown as Pool;
}

describe('P7-026 PgReviewRepository', () => {
  it('upsert issues INSERT ... ON CONFLICT and maps result row', async () => {
    const row = makeRow();
    const queries: string[] = [];
    const queryFn = vi.fn(async (sql: string) => {
      queries.push(sql);
      if (sql.startsWith('SET app.current_tenant_id')) return { rows: [] };
      return { rows: [row] };
    });
    const repo = new PgReviewRepository(makeMockPool(queryFn));

    const result = await repo.upsert({
      id: row.id,
      tenantId: row.tenant_id,
      externalReviewId: row.external_review_id,
      locationId: row.location_id,
      reviewerDisplayName: row.reviewer_display_name,
      reviewerProfileUrl: row.reviewer_profile_url,
      rating: row.rating,
      commentText: row.comment_text,
      createTime: new Date(row.review_create_time),
      updateTime: new Date(row.review_update_time),
      firstFetchedAt: new Date(row.first_fetched_at),
      lastFetchedAt: new Date(row.last_fetched_at),
    });

    expect(result.inserted).toBe(true);
    expect(result.review.id).toBe(row.id);
    expect(result.review.tenantId).toBe(row.tenant_id);
    expect(result.review.rating).toBe(5);

    const insertSql = queries.find((q) => q.includes('INSERT INTO google_reviews'));
    expect(insertSql).toBeDefined();
    expect(insertSql).toContain('ON CONFLICT (tenant_id, external_review_id)');
    expect(insertSql).toContain('(xmax = 0)');
    // The ON CONFLICT branch updates last_fetched_at but must NOT touch
    // first_fetched_at — that's the whole point of splitting the column.
    expect(insertSql).toContain('last_fetched_at       = EXCLUDED.last_fetched_at');
    expect(insertSql).not.toMatch(/SET[^;]*first_fetched_at\s*=/);
  });

  it('upsert preserves first_fetched_at across re-upsert (mocked: ON CONFLICT branch)', async () => {
    // Simulate the SQL behavior: when the row already exists, Postgres
    // would return the existing first_fetched_at and the new
    // last_fetched_at. The mock stands in for that — we verify the repo
    // maps both columns through unchanged.
    const FIRST = '2026-05-17T10:01:00.000Z';
    const LATER = '2026-05-18T12:00:00.000Z';
    const row = makeRow({
      first_fetched_at: FIRST,
      last_fetched_at: LATER,
      is_insert: false,
    });
    const queryFn = vi.fn(async (sql: string) => {
      if (sql.startsWith('SET app.current_tenant_id')) return { rows: [] };
      return { rows: [row] };
    });
    const repo = new PgReviewRepository(makeMockPool(queryFn));

    const result = await repo.upsert({
      id: row.id,
      tenantId: row.tenant_id,
      externalReviewId: row.external_review_id,
      locationId: row.location_id,
      reviewerDisplayName: row.reviewer_display_name,
      reviewerProfileUrl: row.reviewer_profile_url,
      rating: row.rating,
      commentText: row.comment_text,
      createTime: new Date(row.review_create_time),
      updateTime: new Date(row.review_update_time),
      // Worker passes "now" for both — DB preserves the original
      // first_fetched_at and advances last_fetched_at.
      firstFetchedAt: new Date(LATER),
      lastFetchedAt: new Date(LATER),
    });

    expect(result.inserted).toBe(false);
    expect(result.review.firstFetchedAt.toISOString()).toBe(FIRST);
    expect(result.review.lastFetchedAt.toISOString()).toBe(LATER);
  });

  it('findByExternalId returns null when no row', async () => {
    const queryFn = vi.fn(async (sql: string) => {
      if (sql.startsWith('SET app.current_tenant_id')) return { rows: [] };
      return { rows: [] };
    });
    const repo = new PgReviewRepository(makeMockPool(queryFn));
    const result = await repo.findByExternalId(
      '22222222-2222-2222-2222-222222222222',
      'accounts/A/locations/L/reviews/MISSING',
    );
    expect(result).toBeNull();
  });

  it('findByExternalId maps row when present', async () => {
    const row = makeRow();
    const queryFn = vi.fn(async (sql: string) => {
      if (sql.startsWith('SET app.current_tenant_id')) return { rows: [] };
      return { rows: [row] };
    });
    const repo = new PgReviewRepository(makeMockPool(queryFn));
    const result = await repo.findByExternalId(
      row.tenant_id,
      row.external_review_id,
    );
    expect(result).not.toBeNull();
    expect(result?.externalReviewId).toBe(row.external_review_id);
    expect(result?.rating).toBe(5);
  });
});
