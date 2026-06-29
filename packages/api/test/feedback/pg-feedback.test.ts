/**
 * Mocked-pool unit tests for PgFeedbackRequestRepository and
 * PgFeedbackResponseRepository.
 *
 * Verifies tenant context, parameterization, null/empty returns, and the
 * intentional design where findByToken is NOT tenant-scoped (public review
 * link flow — the token itself is the credential, mirroring the estimate
 * view-token lookup). Real RLS is covered in the Docker-gated integration suite.
 */
import { describe, it, expect, vi } from 'vitest';
import type { Pool, PoolClient, QueryResult } from 'pg';
import { PgFeedbackRequestRepository } from '../../src/feedback/pg-feedback-request';
import { PgFeedbackResponseRepository } from '../../src/feedback/pg-feedback-response';
import { FeedbackRequest } from '../../src/feedback/feedback-request';
import { FeedbackResponse } from '../../src/feedback/feedback-response';

type CapturedCall = { sql: string; params: unknown[] };
type Responder = (sql: string, params: unknown[]) => Record<string, unknown>[];

function makeMockPool(responder: Responder) {
  const calls: CapturedCall[] = [];
  let releaseCount = 0;
  const client: Partial<PoolClient> = {
    query: vi.fn(async (sql: string, params?: unknown[]) => {
      calls.push({ sql, params: params ?? [] });
      const rows = responder(sql, params ?? []);
      return { rows, rowCount: rows.length } as unknown as QueryResult;
    }) as unknown as PoolClient['query'],
    release: vi.fn(() => {
      releaseCount += 1;
    }) as unknown as PoolClient['release'],
  };
  const pool: Partial<Pool> = {
    connect: vi.fn(async () => client as PoolClient) as unknown as Pool['connect'],
  };
  return { pool: pool as Pool, calls, getReleaseCount: () => releaseCount };
}

const TENANT = '11111111-1111-1111-1111-111111111111';
const JOB_ID = '44444444-4444-4444-4444-444444444444';
const REQ_ID = '55555555-5555-5555-5555-555555555555';
const isContext = (sql: string) => sql.includes('app.current_tenant_id');

function requestRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: REQ_ID,
    tenant_id: TENANT,
    job_id: JOB_ID,
    token: 'tok_abc',
    status: 'pending',
    expires_at: new Date('2026-05-15T00:00:00.000Z').toISOString(),
    sent_at: null,
    created_at: new Date('2026-05-01T00:00:00.000Z').toISOString(),
    ...overrides,
  };
}

function makeRequest(overrides: Partial<FeedbackRequest> = {}): FeedbackRequest {
  return {
    id: REQ_ID,
    tenantId: TENANT,
    jobId: JOB_ID,
    token: 'tok_abc',
    status: 'pending',
    expiresAt: new Date('2026-05-15T00:00:00.000Z'),
    createdAt: new Date('2026-05-01T00:00:00.000Z'),
    ...overrides,
  };
}

describe('PgFeedbackRequestRepository.findByToken (intentionally not tenant-scoped)', () => {
  it('looks up by token WITHOUT setting tenant context (public link flow, by design)', async () => {
    const { pool, calls } = makeMockPool((sql) => (sql.includes('WHERE token') ? [requestRow()] : []));
    const result = await new PgFeedbackRequestRepository(pool).findByToken('tok_abc');
    expect(result?.id).toBe(REQ_ID);
    // No `SET app.current_tenant_id` — the token is the credential, so the
    // lookup must work before any tenant is known (same as estimate view-token).
    expect(calls.some((c) => isContext(c.sql))).toBe(false);
    const q = calls.find((c) => c.sql.includes('WHERE token'))!;
    expect(q.sql).not.toContain(TENANT);
    expect(q.params).toEqual(['tok_abc']);
  });

  it('returns null when no request matches the token', async () => {
    const { pool } = makeMockPool(() => []);
    expect(await new PgFeedbackRequestRepository(pool).findByToken('nope')).toBeNull();
  });
});

describe('PgFeedbackRequestRepository tenant-scoped methods', () => {
  it('create sets tenant context and parameterizes tenantId', async () => {
    const { pool, calls, getReleaseCount } = makeMockPool((sql) =>
      isContext(sql) ? [] : [requestRow()]
    );
    await new PgFeedbackRequestRepository(pool).create(makeRequest());
    // U2b-2: context is now set_config under a SET LOCAL transaction (calls[0] is BEGIN).
    expect(calls.some((c) => c.sql.includes('app.current_tenant_id'))).toBe(true);
    const insert = calls.find((c) => c.sql.includes('INSERT INTO feedback_requests'))!;
    expect(insert.sql).not.toContain(TENANT);
    expect(insert.params[1]).toBe(TENANT);
    expect(getReleaseCount()).toBe(1);
  });

  it('findByJob returns null when no request and is tenant-scoped', async () => {
    const { pool, calls } = makeMockPool((sql) => (isContext(sql) ? [] : []));
    expect(await new PgFeedbackRequestRepository(pool).findByJob(TENANT, JOB_ID)).toBeNull();
    const q = calls.find((c) => c.sql.includes('FROM feedback_requests'))!;
    expect(q.sql).toMatch(/WHERE\s+tenant_id\s*=\s*\$1\s+AND\s+job_id\s*=\s*\$2/);
    expect(q.params).toEqual([TENANT, JOB_ID]);
  });

  it('markSubmitted writes status=submitted scoped by tenant + id', async () => {
    const { pool, calls } = makeMockPool((sql) => (isContext(sql) ? [] : []));
    await new PgFeedbackRequestRepository(pool).markSubmitted(TENANT, REQ_ID);
    const upd = calls.find((c) => c.sql.includes('UPDATE feedback_requests'))!;
    expect(upd.sql).toContain("status = 'submitted'");
    expect(upd.sql).toMatch(/WHERE\s+tenant_id\s*=\s*\$1\s+AND\s+id\s*=\s*\$2/);
    expect(upd.params).toEqual([TENANT, REQ_ID]);
  });
});

describe('PgFeedbackResponseRepository', () => {
  function responseRow(overrides: Partial<Record<string, unknown>> = {}) {
    return {
      id: 'resp-1',
      tenant_id: TENANT,
      request_id: REQ_ID,
      job_id: JOB_ID,
      rating: 5,
      comment: 'Great work',
      submitted_at: new Date('2026-05-03T00:00:00.000Z').toISOString(),
      ...overrides,
    };
  }

  function makeResponse(overrides: Partial<FeedbackResponse> = {}): FeedbackResponse {
    return {
      id: 'resp-1',
      tenantId: TENANT,
      requestId: REQ_ID,
      jobId: JOB_ID,
      rating: 5,
      comment: 'Great work',
      submittedAt: new Date('2026-05-03T00:00:00.000Z'),
      ...overrides,
    };
  }

  it('create persists with tenant context and maps the returned row', async () => {
    const { pool, calls } = makeMockPool((sql) => (isContext(sql) ? [] : [responseRow()]));
    const result = await new PgFeedbackResponseRepository(pool).create(makeResponse());
    expect(result.rating).toBe(5);
    const insert = calls.find((c) => c.sql.includes('INSERT INTO feedback_responses'))!;
    expect(insert.params[1]).toBe(TENANT);
  });

  it('create maps a null comment to null', async () => {
    const { pool } = makeMockPool((sql) =>
      isContext(sql) ? [] : [responseRow({ comment: null })]
    );
    const result = await new PgFeedbackResponseRepository(pool).create(makeResponse({ comment: null }));
    expect(result.comment).toBeNull();
  });

  it('findByRequest returns null when no response exists (replay/idempotency check)', async () => {
    const { pool, calls } = makeMockPool((sql) => (isContext(sql) ? [] : []));
    expect(await new PgFeedbackResponseRepository(pool).findByRequest(TENANT, REQ_ID)).toBeNull();
    const q = calls.find((c) => c.sql.includes('FROM feedback_responses'))!;
    expect(q.params).toEqual([TENANT, REQ_ID]);
  });

  it('listByTenant returns rows + total and clamps default limit/offset', async () => {
    const { pool, calls } = makeMockPool((sql) => {
      if (isContext(sql)) return [];
      if (sql.includes('COUNT(*)')) return [{ total: '3' }];
      return [responseRow({ id: 'r1' }), responseRow({ id: 'r2' })];
    });
    const result = await new PgFeedbackResponseRepository(pool).listByTenant(TENANT);
    expect(result.total).toBe(3);
    expect(result.responses.map((r) => r.id)).toEqual(['r1', 'r2']);
    const dataQ = calls.find((c) => c.sql.includes('ORDER BY submitted_at DESC'))!;
    expect(dataQ.params).toEqual([TENANT, 50, 0]);
  });
});
