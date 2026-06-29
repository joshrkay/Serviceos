/**
 * P0-021 — PgDocumentRevisionRepository.
 *
 * The Postgres-backed DocumentRevisionRepository is append-only:
 *   - create
 *   - findById
 *   - findByDocument
 *   - getNextVersion
 *
 * These tests verify (with a mocked Pool) that:
 *   - Tenant context (`SET app.current_tenant_id`) is set before every query.
 *   - Every business query includes `WHERE tenant_id = $N` (defense-in-depth).
 *   - tenantId is parameterized — never inlined into the SQL string.
 *   - Connections are released even on error.
 *   - Row mapping correctly hydrates DocumentRevision shape (incl. nullable
 *     aiRunId / metadata).
 *   - getNextVersion returns max(version)+1 (or 1 when no rows exist).
 */
import { describe, it, expect, vi } from 'vitest';
import type { Pool, PoolClient, QueryResult } from 'pg';
import { PgDocumentRevisionRepository } from '../../src/ai/pg-document-revision';
import type { DocumentRevision } from '../../src/ai/document-revision';

type CapturedCall = { sql: string; params: unknown[] };

function makeMockPool(rowsByCallIndex: Array<Record<string, unknown>[] | undefined>) {
  const calls: CapturedCall[] = [];
  let releaseCount = 0;

  // U2b-2: the standalone tenant path is now a SET LOCAL transaction. Skip the
  // transaction-control framing (BEGIN/COMMIT/ROLLBACK/RESET/SET ROLE) from both
  // the recorded calls and the row-index, so positional row arrays and the
  // calls[0]=context / calls[1]=business assertions are unchanged. The context
  // statement is now `set_config('app.current_tenant_id',$1,true)` (tenant in
  // params, not the SQL string).
  const CONTROL = /^\s*(BEGIN|COMMIT|ROLLBACK|RESET\b|SET\s+(LOCAL\s+)?ROLE\b)/i;
  const client: Partial<PoolClient> = {
    query: vi.fn(async (sql: string, params?: unknown[]) => {
      if (CONTROL.test(typeof sql === 'string' ? sql : '')) {
        return { rows: [], rowCount: 0, command: '', oid: 0, fields: [] } as unknown as QueryResult;
      }
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
const TENANT_B = '22222222-2222-2222-2222-222222222222';

function makeRevision(overrides: Partial<DocumentRevision> = {}): DocumentRevision {
  return {
    id: 'rev-1',
    tenantId: TENANT_A,
    documentType: 'estimate',
    documentId: 'doc-1',
    version: 1,
    snapshot: { total: 12345 },
    source: 'ai_generated',
    actorId: 'user_clerk_abc',
    actorRole: 'owner',
    aiRunId: 'run-1',
    metadata: { model: 'claude-opus' },
    createdAt: new Date('2026-04-28T10:00:00.000Z'),
    ...overrides,
  };
}

function rowFor(r: DocumentRevision): Record<string, unknown> {
  return {
    id: r.id,
    tenant_id: r.tenantId,
    document_type: r.documentType,
    document_id: r.documentId,
    version: r.version,
    snapshot: r.snapshot,
    source: r.source,
    actor_id: r.actorId,
    actor_role: r.actorRole,
    ai_run_id: r.aiRunId ?? null,
    metadata: r.metadata ?? null,
    created_at: r.createdAt.toISOString(),
  };
}

describe('P0-021 PgDocumentRevisionRepository.create', () => {
  it('PgDocumentRevision inserts with parameterized values and sets tenant context', async () => {
    const rev = makeRevision();
    const { pool, calls, getReleaseCount } = makeMockPool([
      undefined, // SET app.current_tenant_id
      [rowFor(rev)], // INSERT ... RETURNING *
    ]);

    const repo = new PgDocumentRevisionRepository(pool);
    const result = await repo.create(rev);

    // First call sets tenant context for RLS (set_config binds the tenant as a
    // parameter under the SET LOCAL transaction — no longer in the SQL string).
    expect(calls[0].sql).toContain('app.current_tenant_id');
    expect(calls[0].params).toContain(TENANT_A);

    // Second call is the INSERT — must be parameterized.
    expect(calls[1].sql).toContain('INSERT INTO document_revisions');
    expect(calls[1].sql).not.toContain(TENANT_A); // never inlined
    expect(calls[1].params[0]).toBe(rev.id);
    expect(calls[1].params[1]).toBe(rev.tenantId);
    expect(calls[1].params[2]).toBe('estimate');
    expect(calls[1].params[3]).toBe('doc-1');
    expect(calls[1].params[4]).toBe(1);
    // snapshot is JSON-encoded for JSONB binding
    expect(calls[1].params[5]).toBe(JSON.stringify({ total: 12345 }));
    expect(calls[1].params[6]).toBe('ai_generated');
    expect(calls[1].params[7]).toBe('user_clerk_abc');
    expect(calls[1].params[8]).toBe('owner');
    expect(calls[1].params[9]).toBe('run-1');
    expect(calls[1].params[10]).toBe(JSON.stringify({ model: 'claude-opus' }));
    expect(calls[1].params[11]).toBe(rev.createdAt);

    expect(getReleaseCount()).toBe(1);

    expect(result.id).toBe('rev-1');
    expect(result.documentType).toBe('estimate');
    expect(result.snapshot).toEqual({ total: 12345 });
    expect(result.aiRunId).toBe('run-1');
    expect(result.metadata).toEqual({ model: 'claude-opus' });
  });

  it('PgDocumentRevision binds nulls when aiRunId / metadata are absent', async () => {
    const rev = makeRevision({ aiRunId: undefined, metadata: undefined });
    const { pool, calls } = makeMockPool([undefined, [rowFor(rev)]]);

    await new PgDocumentRevisionRepository(pool).create(rev);

    expect(calls[1].params[9]).toBeNull(); // ai_run_id
    expect(calls[1].params[10]).toBeNull(); // metadata
  });

  it('PgDocumentRevision releases the connection even when the query throws', async () => {
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

    const repo = new PgDocumentRevisionRepository(pool as Pool);
    await expect(repo.create(makeRevision())).rejects.toThrow('pg down');
    expect(failingClient.release).toHaveBeenCalledTimes(1);
  });
});

describe('P0-021 PgDocumentRevisionRepository.findById', () => {
  it('PgDocumentRevision findById filters by tenant_id and id, parameterized', async () => {
    const rev = makeRevision();
    const { pool, calls } = makeMockPool([undefined, [rowFor(rev)]]);
    const repo = new PgDocumentRevisionRepository(pool);

    const result = await repo.findById(TENANT_A, 'rev-1');

    const sql = calls[1].sql;
    expect(sql).toContain('SELECT * FROM document_revisions');
    expect(sql).toMatch(/WHERE\s+tenant_id\s*=\s*\$1\s+AND\s+id\s*=\s*\$2/);
    expect(sql).not.toContain(TENANT_A);
    expect(calls[1].params).toEqual([TENANT_A, 'rev-1']);

    expect(result?.id).toBe('rev-1');
    expect(result?.documentType).toBe('estimate');
  });

  it('PgDocumentRevision findById returns null when no row matches', async () => {
    const { pool } = makeMockPool([undefined, []]);
    const repo = new PgDocumentRevisionRepository(pool);
    const result = await repo.findById(TENANT_B, 'missing');
    expect(result).toBeNull();
  });
});

describe('P0-021 PgDocumentRevisionRepository.findByDocument', () => {
  it('PgDocumentRevision findByDocument filters by tenant + type + id and orders by version DESC', async () => {
    const r2 = makeRevision({ id: 'rev-2', version: 2 });
    const r1 = makeRevision({ id: 'rev-1', version: 1 });
    // Repo sorts via SQL ORDER BY version DESC; mock just returns rows
    // in the order we want them surfaced.
    const { pool, calls } = makeMockPool([undefined, [rowFor(r2), rowFor(r1)]]);
    const repo = new PgDocumentRevisionRepository(pool);

    const results = await repo.findByDocument(TENANT_A, 'estimate', 'doc-1');

    const sql = calls[1].sql;
    expect(sql).toContain('FROM document_revisions');
    expect(sql).toMatch(
      /WHERE\s+tenant_id\s*=\s*\$1\s+AND\s+document_type\s*=\s*\$2\s+AND\s+document_id\s*=\s*\$3/
    );
    expect(sql).toMatch(/ORDER\s+BY\s+version\s+DESC/);
    expect(sql).not.toContain(TENANT_A);
    expect(calls[1].params).toEqual([TENANT_A, 'estimate', 'doc-1']);

    expect(results.map((r) => r.version)).toEqual([2, 1]);
  });

  it('PgDocumentRevision findByDocument returns empty array when no rows match', async () => {
    const { pool } = makeMockPool([undefined, []]);
    const repo = new PgDocumentRevisionRepository(pool);
    const results = await repo.findByDocument(TENANT_A, 'invoice', 'nope');
    expect(results).toEqual([]);
  });
});

describe('P0-021 PgDocumentRevisionRepository.getNextVersion', () => {
  it('PgDocumentRevision getNextVersion returns max(version)+1 from the DB', async () => {
    const { pool, calls } = makeMockPool([
      undefined,
      [{ max_version: 3 }],
    ]);
    const repo = new PgDocumentRevisionRepository(pool);

    const next = await repo.getNextVersion(TENANT_A, 'estimate', 'doc-1');

    const sql = calls[1].sql;
    expect(sql).toContain('MAX(version)');
    expect(sql).toMatch(
      /WHERE\s+tenant_id\s*=\s*\$1\s+AND\s+document_type\s*=\s*\$2\s+AND\s+document_id\s*=\s*\$3/
    );
    expect(sql).not.toContain(TENANT_A);
    expect(calls[1].params).toEqual([TENANT_A, 'estimate', 'doc-1']);
    expect(next).toBe(4);
  });

  it('PgDocumentRevision getNextVersion returns 1 when no revisions exist', async () => {
    // COALESCE in the SQL guarantees max_version is 0 when the table has
    // no matching rows; our mock returns the COALESCE'd value directly.
    const { pool } = makeMockPool([undefined, [{ max_version: 0 }]]);
    const repo = new PgDocumentRevisionRepository(pool);
    const next = await repo.getNextVersion(TENANT_A, 'estimate', 'never-seen');
    expect(next).toBe(1);
  });

  it('PgDocumentRevision getNextVersion handles numeric strings from pg (BIGINT/NUMERIC)', async () => {
    // pg can return COUNT/MAX as strings depending on driver version /
    // column type. The repo wraps the result in Number(...), so verify
    // that path works.
    const { pool } = makeMockPool([undefined, [{ max_version: '7' }]]);
    const repo = new PgDocumentRevisionRepository(pool);
    const next = await repo.getNextVersion(TENANT_A, 'invoice', 'doc-x');
    expect(next).toBe(8);
  });
});

describe('P0-021 PgDocumentRevisionRepository tenant isolation invariants', () => {
  it('PgDocumentRevision sets tenant context before every business query', async () => {
    const rev = makeRevision();
    const buildPool = () =>
      makeMockPool([
        undefined, // SET app.current_tenant_id
        [rowFor(rev)],
      ]);

    let { pool, calls } = buildPool();
    await new PgDocumentRevisionRepository(pool).create(rev);
    expect(calls[0].sql).toContain('app.current_tenant_id');

    ({ pool, calls } = buildPool());
    await new PgDocumentRevisionRepository(pool).findById(TENANT_A, 'rev-1');
    expect(calls[0].sql).toContain('app.current_tenant_id');

    ({ pool, calls } = buildPool());
    await new PgDocumentRevisionRepository(pool).findByDocument(
      TENANT_A,
      'estimate',
      'doc-1'
    );
    expect(calls[0].sql).toContain('app.current_tenant_id');

    const versionPool = makeMockPool([undefined, [{ max_version: 0 }]]);
    await new PgDocumentRevisionRepository(versionPool.pool).getNextVersion(
      TENANT_A,
      'estimate',
      'doc-1'
    );
    expect(versionPool.calls[0].sql).toContain('app.current_tenant_id');
  });

  it('PgDocumentRevision never interpolates tenantId into business-query SQL strings', async () => {
    const rev = makeRevision();
    const { pool, calls } = makeMockPool([undefined, [rowFor(rev)]]);
    const repo = new PgDocumentRevisionRepository(pool);

    await repo.findByDocument(TENANT_A, 'estimate', 'doc-1');

    const businessQueries = calls.filter((c) => !c.sql.includes('app.current_tenant_id'));
    expect(businessQueries.length).toBeGreaterThan(0);
    for (const c of businessQueries) {
      expect(c.sql).not.toContain(TENANT_A);
    }
  });
});
