/**
 * Mocked-pool unit tests for PgNoteRepository.
 *
 * The integration suite exercises real RLS; here we verify, without Docker,
 * the tenant-context setting, parameterization, null/empty returns, the
 * empty-update fallback (auto-stamps updated_at), and the delete rowCount path.
 */
import { describe, it, expect, vi } from 'vitest';
import type { Pool, PoolClient, QueryResult } from 'pg';
import { PgNoteRepository } from '../../src/notes/pg-note';
import { InternalNote, NoteEntityType } from '../../src/notes/note';

type CapturedCall = { sql: string; params: unknown[] };
type Responder = (sql: string, params: unknown[]) => { rows: Record<string, unknown>[]; rowCount?: number };

function makeMockPool(responder: Responder) {
  const calls: CapturedCall[] = [];
  let releaseCount = 0;
  const client: Partial<PoolClient> = {
    query: vi.fn(async (sql: string, params?: unknown[]) => {
      calls.push({ sql, params: params ?? [] });
      const res = responder(sql, params ?? []);
      return { rows: res.rows, rowCount: res.rowCount ?? res.rows.length } as unknown as QueryResult;
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
const NOTE_ID = '33333333-3333-3333-3333-333333333333';
const isContext = (sql: string) => sql.includes('app.current_tenant_id');

function noteRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: NOTE_ID,
    tenant_id: TENANT,
    entity_type: 'job',
    entity_id: 'job-1',
    content: 'Customer prefers morning visits',
    author_id: 'user-1',
    author_role: 'owner',
    is_pinned: false,
    created_at: new Date('2026-05-01T00:00:00.000Z').toISOString(),
    updated_at: new Date('2026-05-01T00:00:00.000Z').toISOString(),
    ...overrides,
  };
}

function makeNote(overrides: Partial<InternalNote> = {}): InternalNote {
  const now = new Date('2026-05-01T00:00:00.000Z');
  return {
    id: NOTE_ID,
    tenantId: TENANT,
    entityType: 'job',
    entityId: 'job-1',
    content: 'Customer prefers morning visits',
    authorId: 'user-1',
    authorRole: 'owner',
    isPinned: false,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

describe('PgNoteRepository.create', () => {
  it('inserts with tenant context and parameterized values', async () => {
    const { pool, calls, getReleaseCount } = makeMockPool((sql) =>
      isContext(sql) ? { rows: [] } : { rows: [noteRow()] }
    );
    const result = await new PgNoteRepository(pool).create(makeNote());
    expect(result.id).toBe(NOTE_ID);
    // U2b-2: context is now set_config under a SET LOCAL transaction (calls[0] is BEGIN).
    expect(calls.some((c) => c.sql.includes('app.current_tenant_id'))).toBe(true);
    const insert = calls.find((c) => c.sql.includes('INSERT INTO notes'))!;
    expect(insert.sql).not.toContain(TENANT);
    expect(insert.params[1]).toBe(TENANT);
    expect(getReleaseCount()).toBe(1);
  });
});

describe('PgNoteRepository.findById', () => {
  it('returns mapped note', async () => {
    const { pool, calls } = makeMockPool((sql) =>
      isContext(sql) ? { rows: [] } : { rows: [noteRow()] }
    );
    const result = await new PgNoteRepository(pool).findById(TENANT, NOTE_ID);
    expect(result?.entityType).toBe('job');
    const q = calls.find((c) => c.sql.includes('SELECT * FROM notes'))!;
    expect(q.sql).toMatch(/WHERE\s+id\s*=\s*\$1\s+AND\s+tenant_id\s*=\s*\$2/);
    expect(q.params).toEqual([NOTE_ID, TENANT]);
  });

  it('returns null when missing or cross-tenant', async () => {
    const { pool } = makeMockPool((sql) => (isContext(sql) ? { rows: [] } : { rows: [] }));
    expect(await new PgNoteRepository(pool).findById(TENANT, 'missing')).toBeNull();
  });
});

describe('PgNoteRepository.findByEntity', () => {
  it('returns [] when entity has no notes', async () => {
    const { pool, calls } = makeMockPool((sql) => (isContext(sql) ? { rows: [] } : { rows: [] }));
    const result = await new PgNoteRepository(pool).findByEntity(TENANT, 'customer', 'cust-1');
    expect(result).toEqual([]);
    const q = calls.find((c) => c.sql.includes('FROM notes'))!;
    expect(q.sql).toMatch(/ORDER\s+BY\s+created_at\s+DESC/);
    expect(q.params).toEqual([TENANT, 'customer', 'cust-1']);
  });

  it('maps multiple notes', async () => {
    const { pool } = makeMockPool((sql) =>
      isContext(sql)
        ? { rows: [] }
        : { rows: [noteRow({ id: 'n1' }), noteRow({ id: 'n2', is_pinned: true })] }
    );
    const result = await new PgNoteRepository(pool).findByEntity(TENANT, 'job', 'job-1');
    expect(result.map((n) => n.id)).toEqual(['n1', 'n2']);
    expect(result[1].isPinned).toBe(true);
  });

  it('round-trips all five entity types', async () => {
    const types: NoteEntityType[] = ['customer', 'location', 'job', 'estimate', 'invoice'];
    for (const entityType of types) {
      const { pool, calls } = makeMockPool((sql) =>
        isContext(sql) ? { rows: [] } : { rows: [noteRow({ entity_type: entityType })] }
      );
      const result = await new PgNoteRepository(pool).findByEntity(TENANT, entityType, 'e-1');
      expect(result[0].entityType).toBe(entityType);
      expect(calls.find((c) => c.sql.includes('FROM notes'))!.params[1]).toBe(entityType);
    }
  });
});

describe('PgNoteRepository.update', () => {
  it('auto-stamps updated_at even when only content is supplied', async () => {
    const { pool, calls } = makeMockPool((sql) =>
      isContext(sql) ? { rows: [] } : { rows: [noteRow({ content: 'Edited' })] }
    );
    const result = await new PgNoteRepository(pool).update(TENANT, NOTE_ID, { content: 'Edited' });
    expect(result?.content).toBe('Edited');
    const upd = calls.find((c) => c.sql.includes('UPDATE notes'))!;
    expect(upd.sql).toContain('content = $1');
    expect(upd.sql).toContain('updated_at = $2');
    expect(upd.sql).toMatch(/WHERE\s+id\s*=\s*\$3\s+AND\s+tenant_id\s*=\s*\$4/);
  });

  it('stamps updated_at via the fallback when no fields are supplied', async () => {
    // updates = {} → setClauses never empty (else-branch stamps updated_at),
    // so an UPDATE still runs.
    const { pool, calls } = makeMockPool((sql) =>
      isContext(sql) ? { rows: [] } : { rows: [noteRow()] }
    );
    await new PgNoteRepository(pool).update(TENANT, NOTE_ID, {});
    const upd = calls.find((c) => c.sql.includes('UPDATE notes'))!;
    expect(upd.sql).toContain('updated_at = $1');
  });

  it('updates is_pinned when supplied', async () => {
    const { pool, calls } = makeMockPool((sql) =>
      isContext(sql) ? { rows: [] } : { rows: [noteRow({ is_pinned: true })] }
    );
    const result = await new PgNoteRepository(pool).update(TENANT, NOTE_ID, { isPinned: true });
    expect(result?.isPinned).toBe(true);
    expect(calls.find((c) => c.sql.includes('UPDATE notes'))!.sql).toContain('is_pinned = $1');
  });

  it('returns null when the row to update does not exist', async () => {
    const { pool } = makeMockPool((sql) =>
      isContext(sql) ? { rows: [] } : { rows: [], rowCount: 0 }
    );
    expect(await new PgNoteRepository(pool).update(TENANT, 'missing', { content: 'x' })).toBeNull();
  });
});

describe('PgNoteRepository.delete', () => {
  it('returns true when a row was deleted', async () => {
    const { pool, calls } = makeMockPool((sql) =>
      isContext(sql) ? { rows: [] } : { rows: [], rowCount: 1 }
    );
    expect(await new PgNoteRepository(pool).delete(TENANT, NOTE_ID)).toBe(true);
    const del = calls.find((c) => c.sql.includes('DELETE FROM notes'))!;
    expect(del.params).toEqual([NOTE_ID, TENANT]);
  });

  it('returns false when nothing matched (missing or cross-tenant)', async () => {
    const { pool } = makeMockPool((sql) =>
      isContext(sql) ? { rows: [] } : { rows: [], rowCount: 0 }
    );
    expect(await new PgNoteRepository(pool).delete(TENANT, 'missing')).toBe(false);
  });
});
