/**
 * P0-021 — PgDiffAnalysisRepository.
 *
 * The Postgres-backed DiffAnalysisRepository mirrors the InMemory contract:
 *   - create
 *   - findById
 *   - findByDocument
 *   - updateStatus  (the one mutating method — drives the worker state machine)
 *
 * These tests use a mocked Pool to verify:
 *   - Tenant context (`SET app.current_tenant_id`) is set before every query.
 *   - Every business query includes `WHERE tenant_id = $N` (defense-in-depth).
 *   - tenantId is parameterized — never inlined into the SQL string.
 *   - `id` is TEXT (deterministic key), not UUID — verify by passing a non-UUID
 *     id derived from `diffAnalysisIdFor`.
 *   - updateStatus only sets the columns the caller supplied (mirrors
 *     InMemory: passing `result?.diff` undefined leaves diff untouched).
 *   - Connections are released even on error.
 */
import { describe, it, expect, vi } from 'vitest';
import type { Pool, PoolClient, QueryResult } from 'pg';
import { PgDiffAnalysisRepository } from '../../src/ai/pg-diff-analysis';
import {
  DiffAnalysis,
  DiffEntry,
  diffAnalysisIdFor,
} from '../../src/ai/diff-analysis';

type CapturedCall = { sql: string; params: unknown[] };

function makeMockPool(rowsByCallIndex: Array<Record<string, unknown>[] | undefined>) {
  const calls: CapturedCall[] = [];
  let releaseCount = 0;

  const client: Partial<PoolClient> = {
    query: vi.fn(async (sql: string, params?: unknown[]) => {
      calls.push({ sql, params: params ?? [] });
      const rows = rowsByCallIndex[calls.length - 1] ?? [];
      return {
        rows,
        rowCount: rows.length,
        command: '',
        oid: 0,
        fields: [],
      } as unknown as QueryResult;
    }) as unknown as PoolClient['query'],
    release: vi.fn(() => {
      releaseCount += 1;
    }) as unknown as PoolClient['release'],
  };

  const pool: Partial<Pool> = {
    connect: vi.fn(async () => client as PoolClient) as unknown as Pool['connect'],
  };

  return {
    pool: pool as Pool,
    client,
    calls,
    getReleaseCount: () => releaseCount,
  };
}

const TENANT_A = '11111111-1111-1111-1111-111111111111';
const FROM_REV = '33333333-3333-3333-3333-333333333333';
const TO_REV = '44444444-4444-4444-4444-444444444444';
const DETERMINISTIC_ID = diffAnalysisIdFor({
  tenantId: TENANT_A,
  documentType: 'estimate',
  documentId: 'doc-1',
  fromRevisionId: FROM_REV,
  toRevisionId: TO_REV,
});

function makeAnalysis(overrides: Partial<DiffAnalysis> = {}): DiffAnalysis {
  return {
    id: DETERMINISTIC_ID,
    tenantId: TENANT_A,
    documentType: 'estimate',
    documentId: 'doc-1',
    fromRevisionId: FROM_REV,
    toRevisionId: TO_REV,
    diff: [],
    status: 'pending',
    createdAt: new Date('2026-04-28T10:00:00.000Z'),
    ...overrides,
  };
}

function rowFor(a: DiffAnalysis): Record<string, unknown> {
  return {
    id: a.id,
    tenant_id: a.tenantId,
    document_type: a.documentType,
    document_id: a.documentId,
    from_revision_id: a.fromRevisionId,
    to_revision_id: a.toRevisionId,
    diff: a.diff ?? [],
    summary: a.summary ?? null,
    status: a.status,
    error_message: a.errorMessage ?? null,
    created_at: a.createdAt.toISOString(),
  };
}

describe('P0-021 PgDiffAnalysisRepository.create', () => {
  it('PgDiffAnalysis inserts with parameterized values and sets tenant context', async () => {
    const analysis = makeAnalysis();
    const { pool, calls, getReleaseCount } = makeMockPool([
      undefined,
      [rowFor(analysis)],
    ]);

    const repo = new PgDiffAnalysisRepository(pool);
    const result = await repo.create(analysis);

    expect(calls[0].sql).toContain('app.current_tenant_id');
    expect(calls[0].sql).toContain(TENANT_A);

    expect(calls[1].sql).toContain('INSERT INTO diff_analyses');
    expect(calls[1].sql).not.toContain(TENANT_A);
    expect(calls[1].params[0]).toBe(DETERMINISTIC_ID); // TEXT id, not a UUID
    expect(calls[1].params[1]).toBe(TENANT_A);
    expect(calls[1].params[2]).toBe('estimate');
    expect(calls[1].params[3]).toBe('doc-1');
    expect(calls[1].params[4]).toBe(FROM_REV);
    expect(calls[1].params[5]).toBe(TO_REV);
    expect(calls[1].params[6]).toBe(JSON.stringify([])); // diff JSONB
    expect(calls[1].params[7]).toBeNull(); // summary
    expect(calls[1].params[8]).toBe('pending');
    expect(calls[1].params[9]).toBeNull(); // error_message
    expect(calls[1].params[10]).toBe(analysis.createdAt);

    expect(getReleaseCount()).toBe(1);
    expect(result.id).toBe(DETERMINISTIC_ID);
    expect(result.status).toBe('pending');
    expect(result.diff).toEqual([]);
  });

  it('PgDiffAnalysis create encodes a non-empty diff array as JSON for JSONB binding', async () => {
    const diff: DiffEntry[] = [
      { path: 'lineItems[0].priceCents', type: 'changed', oldValue: 100, newValue: 200 },
    ];
    const analysis = makeAnalysis({
      diff,
      summary: '1 change(s): 0 added, 0 removed, 1 changed',
      status: 'completed',
    });
    const { pool, calls } = makeMockPool([undefined, [rowFor(analysis)]]);

    await new PgDiffAnalysisRepository(pool).create(analysis);

    expect(calls[1].params[6]).toBe(JSON.stringify(diff));
    expect(calls[1].params[7]).toBe('1 change(s): 0 added, 0 removed, 1 changed');
    expect(calls[1].params[8]).toBe('completed');
  });

  it('PgDiffAnalysis releases the connection even when the query throws', async () => {
    const failingClient: Partial<PoolClient> = {
      query: vi
        .fn()
        .mockResolvedValueOnce({ rows: [], rowCount: 0 } as unknown as QueryResult)
        .mockRejectedValueOnce(new Error('pg down')),
      release: vi.fn(),
    };
    const pool: Partial<Pool> = {
      connect: vi.fn(async () => failingClient as PoolClient) as unknown as Pool['connect'],
    };

    const repo = new PgDiffAnalysisRepository(pool as Pool);
    await expect(repo.create(makeAnalysis())).rejects.toThrow('pg down');
    expect(failingClient.release).toHaveBeenCalledTimes(1);
  });
});

describe('P0-021 PgDiffAnalysisRepository.findById', () => {
  it('PgDiffAnalysis findById filters by tenant_id and id, parameterized', async () => {
    const analysis = makeAnalysis();
    const { pool, calls } = makeMockPool([undefined, [rowFor(analysis)]]);

    const result = await new PgDiffAnalysisRepository(pool).findById(
      TENANT_A,
      DETERMINISTIC_ID
    );

    const sql = calls[1].sql;
    expect(sql).toContain('SELECT * FROM diff_analyses');
    expect(sql).toMatch(/WHERE\s+tenant_id\s*=\s*\$1\s+AND\s+id\s*=\s*\$2/);
    expect(sql).not.toContain(TENANT_A);
    expect(calls[1].params).toEqual([TENANT_A, DETERMINISTIC_ID]);

    expect(result?.id).toBe(DETERMINISTIC_ID);
    expect(result?.fromRevisionId).toBe(FROM_REV);
    expect(result?.toRevisionId).toBe(TO_REV);
  });

  it('PgDiffAnalysis findById returns null when no row matches', async () => {
    const { pool } = makeMockPool([undefined, []]);
    const result = await new PgDiffAnalysisRepository(pool).findById(TENANT_A, 'missing');
    expect(result).toBeNull();
  });

  it('PgDiffAnalysis findById hydrates JSONB diff column to DiffEntry[]', async () => {
    // pg decodes JSONB to JS values directly; the row mock provides an
    // already-parsed array, the repo just passes it through.
    const diff: DiffEntry[] = [
      { path: 'a.b', type: 'added', newValue: 1 },
      { path: 'c', type: 'removed', oldValue: 'x' },
    ];
    const analysis = makeAnalysis({ diff, status: 'completed' });
    const { pool } = makeMockPool([undefined, [rowFor(analysis)]]);
    const result = await new PgDiffAnalysisRepository(pool).findById(
      TENANT_A,
      DETERMINISTIC_ID
    );
    expect(result?.diff).toEqual(diff);
  });
});

describe('P0-021 PgDiffAnalysisRepository.findByDocument', () => {
  it('PgDiffAnalysis findByDocument filters by tenant + type + id and orders by created_at DESC', async () => {
    const a1 = makeAnalysis({ id: 'diff:1' });
    const a2 = makeAnalysis({ id: 'diff:2' });
    const { pool, calls } = makeMockPool([undefined, [rowFor(a1), rowFor(a2)]]);

    const results = await new PgDiffAnalysisRepository(pool).findByDocument(
      TENANT_A,
      'estimate',
      'doc-1'
    );

    const sql = calls[1].sql;
    expect(sql).toContain('FROM diff_analyses');
    expect(sql).toMatch(
      /WHERE\s+tenant_id\s*=\s*\$1\s+AND\s+document_type\s*=\s*\$2\s+AND\s+document_id\s*=\s*\$3/
    );
    expect(sql).toMatch(/ORDER\s+BY\s+created_at\s+DESC/);
    expect(sql).not.toContain(TENANT_A);
    expect(calls[1].params).toEqual([TENANT_A, 'estimate', 'doc-1']);

    expect(results).toHaveLength(2);
    expect(results.map((r) => r.id)).toEqual(['diff:1', 'diff:2']);
  });

  it('PgDiffAnalysis findByDocument returns empty array when no rows match', async () => {
    const { pool } = makeMockPool([undefined, []]);
    const results = await new PgDiffAnalysisRepository(pool).findByDocument(
      TENANT_A,
      'invoice',
      'no-such-doc'
    );
    expect(results).toEqual([]);
  });
});

describe('P0-021 PgDiffAnalysisRepository.updateStatus', () => {
  it('PgDiffAnalysis updateStatus with no result payload only sets status', async () => {
    const analysis = makeAnalysis({ status: 'processing' });
    const { pool, calls } = makeMockPool([undefined, [rowFor(analysis)]]);

    const result = await new PgDiffAnalysisRepository(pool).updateStatus(
      TENANT_A,
      DETERMINISTIC_ID,
      'processing'
    );

    const sql = calls[1].sql;
    expect(sql).toContain('UPDATE diff_analyses');
    expect(sql).toMatch(/SET\s+status\s*=\s*\$3/);
    expect(sql).not.toContain('diff =');
    expect(sql).not.toContain('summary =');
    expect(sql).not.toContain('error_message =');
    expect(sql).toMatch(/WHERE\s+tenant_id\s*=\s*\$1\s+AND\s+id\s*=\s*\$2/);
    expect(sql).not.toContain(TENANT_A);
    expect(calls[1].params).toEqual([TENANT_A, DETERMINISTIC_ID, 'processing']);
    expect(result?.status).toBe('processing');
  });

  it('PgDiffAnalysis updateStatus(completed) writes diff + summary', async () => {
    const diff: DiffEntry[] = [{ path: 'x', type: 'added', newValue: 1 }];
    const analysis = makeAnalysis({ status: 'completed', diff, summary: 'done' });
    const { pool, calls } = makeMockPool([undefined, [rowFor(analysis)]]);

    const result = await new PgDiffAnalysisRepository(pool).updateStatus(
      TENANT_A,
      DETERMINISTIC_ID,
      'completed',
      { diff, summary: 'done' }
    );

    const sql = calls[1].sql;
    expect(sql).toMatch(/SET\s+status\s*=\s*\$3,\s*diff\s*=\s*\$4::jsonb,\s*summary\s*=\s*\$5/);
    expect(calls[1].params).toEqual([
      TENANT_A,
      DETERMINISTIC_ID,
      'completed',
      JSON.stringify(diff),
      'done',
    ]);
    expect(result?.summary).toBe('done');
    expect(result?.diff).toEqual(diff);
  });

  it('PgDiffAnalysis updateStatus(failed) writes error_message into the dedicated column', async () => {
    const analysis = makeAnalysis({ status: 'failed', errorMessage: 'boom' });
    const { pool, calls } = makeMockPool([undefined, [rowFor(analysis)]]);

    await new PgDiffAnalysisRepository(pool).updateStatus(
      TENANT_A,
      DETERMINISTIC_ID,
      'failed',
      { error: 'boom' }
    );

    const sql = calls[1].sql;
    expect(sql).toMatch(/SET\s+status\s*=\s*\$3,\s*error_message\s*=\s*\$4/);
    expect(calls[1].params).toEqual([TENANT_A, DETERMINISTIC_ID, 'failed', 'boom']);
  });

  it('PgDiffAnalysis updateStatus returns null when no row matches', async () => {
    const { pool } = makeMockPool([undefined, []]);
    const result = await new PgDiffAnalysisRepository(pool).updateStatus(
      TENANT_A,
      'no-such-id',
      'completed'
    );
    expect(result).toBeNull();
  });
});

describe('P0-021 PgDiffAnalysisRepository tenant isolation invariants', () => {
  it('PgDiffAnalysis sets tenant context before every business query', async () => {
    const analysis = makeAnalysis();
    const buildPool = () => makeMockPool([undefined, [rowFor(analysis)]]);

    let { pool, calls } = buildPool();
    await new PgDiffAnalysisRepository(pool).create(analysis);
    expect(calls[0].sql).toContain('app.current_tenant_id');

    ({ pool, calls } = buildPool());
    await new PgDiffAnalysisRepository(pool).findById(TENANT_A, DETERMINISTIC_ID);
    expect(calls[0].sql).toContain('app.current_tenant_id');

    ({ pool, calls } = buildPool());
    await new PgDiffAnalysisRepository(pool).findByDocument(TENANT_A, 'estimate', 'doc-1');
    expect(calls[0].sql).toContain('app.current_tenant_id');

    ({ pool, calls } = buildPool());
    await new PgDiffAnalysisRepository(pool).updateStatus(
      TENANT_A,
      DETERMINISTIC_ID,
      'processing'
    );
    expect(calls[0].sql).toContain('app.current_tenant_id');
  });

  it('PgDiffAnalysis never interpolates tenantId into business-query SQL strings', async () => {
    const analysis = makeAnalysis();
    const { pool, calls } = makeMockPool([undefined, [rowFor(analysis)]]);
    await new PgDiffAnalysisRepository(pool).findByDocument(TENANT_A, 'estimate', 'doc-1');

    const businessQueries = calls.filter((c) => !c.sql.includes('app.current_tenant_id'));
    expect(businessQueries.length).toBeGreaterThan(0);
    for (const c of businessQueries) {
      expect(c.sql).not.toContain(TENANT_A);
    }
  });
});
