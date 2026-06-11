/**
 * RV-005 — Unit tests for PgAttachmentRepository.
 *
 * Mirrors test/flags/pg-tenant-feature-flags.test.ts: mocked pool, no
 * Docker. Verifies tenant-context (GUC) lifecycle, explicit tenant_id
 * predicates (belt-and-braces alongside RLS), SQL shapes, and row mapping.
 * Real columns are pinned by the Docker-gated integration leak test
 * (test/integration/tenant-isolation.leak.test.ts).
 */
import { describe, it, expect, vi } from 'vitest';
import type { Pool, PoolClient, QueryResult } from 'pg';
import { PgAttachmentRepository } from '../../src/attachments/pg-attachment';

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
const ATTACHMENT_ID = '33333333-3333-3333-3333-333333333333';
const FILE_ID = '44444444-4444-4444-4444-444444444444';
const ENTITY_ID = '55555555-5555-5555-5555-555555555555';
const USER_ID = '66666666-6666-6666-6666-666666666666';

function attachmentRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: ATTACHMENT_ID,
    tenant_id: TENANT,
    file_id: FILE_ID,
    entity_type: 'job',
    entity_id: ENTITY_ID,
    kind: 'photo',
    caption: null,
    category: 'before',
    pair_group_id: null,
    pair_role: null,
    portal_visible: false,
    annotated_file_id: null,
    uploaded_by: USER_ID,
    source: 'app',
    sort_order: 0,
    archived_at: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  };
}

function makeAttachmentPool(rows: Record<string, unknown>[]) {
  return makeMockPool((sql) => {
    if (sql.includes('app.current_tenant_id')) return { rows: [] };
    return { rows };
  });
}

describe('PgAttachmentRepository tenant context lifecycle', () => {
  it('sets the tenant GUC before querying and RESETs it before release', async () => {
    const { pool, calls, getReleaseCount } = makeAttachmentPool([attachmentRow()]);
    const repo = new PgAttachmentRepository(pool);
    await repo.findById(TENANT, ATTACHMENT_ID);

    expect(calls[0].sql).toContain(`SET app.current_tenant_id = '${TENANT}'`);
    expect(calls[calls.length - 1].sql).toContain('RESET app.current_tenant_id');
    expect(getReleaseCount()).toBe(1);
  });
});

describe('PgAttachmentRepository.create', () => {
  it('INSERTs with explicit tenant_id param and maps the returned row', async () => {
    const { pool, calls } = makeAttachmentPool([attachmentRow()]);
    const repo = new PgAttachmentRepository(pool);

    const created = await repo.create(TENANT, {
      fileId: FILE_ID,
      entityType: 'job',
      entityId: ENTITY_ID,
      kind: 'photo',
      category: 'before',
      uploadedBy: USER_ID,
    });

    const insert = calls.find((c) => c.sql.includes('INSERT INTO attachments'));
    expect(insert).toBeDefined();
    expect(insert!.params[1]).toBe(TENANT);
    expect(insert!.params[2]).toBe(FILE_ID);
    expect(insert!.params[8]).toBe(USER_ID);

    expect(created.id).toBe(ATTACHMENT_ID);
    expect(created.tenantId).toBe(TENANT);
    expect(created.entityType).toBe('job');
    expect(created.kind).toBe('photo');
    expect(created.category).toBe('before');
    expect(created.portalVisible).toBe(false);
    expect(created.source).toBe('app');
    expect(created.sortOrder).toBe(0);
    expect(created.archivedAt).toBeUndefined();
  });

  it('defaults source to app and sort_order to 0', async () => {
    const { pool, calls } = makeAttachmentPool([attachmentRow()]);
    const repo = new PgAttachmentRepository(pool);
    await repo.create(TENANT, {
      fileId: FILE_ID,
      entityType: 'invoice',
      entityId: ENTITY_ID,
      kind: 'document',
    });
    const insert = calls.find((c) => c.sql.includes('INSERT INTO attachments'))!;
    expect(insert.params[9]).toBe('app');
    expect(insert.params[10]).toBe(0);
  });

  it('stores the Clerk id directly as uploaded_by (TEXT column accepts any string)', async () => {
    const clerkId = 'user_2abcDEF123';
    const { pool, calls } = makeAttachmentPool([attachmentRow({ uploaded_by: clerkId })]);
    const repo = new PgAttachmentRepository(pool);
    await repo.create(TENANT, {
      fileId: FILE_ID,
      entityType: 'job',
      entityId: ENTITY_ID,
      kind: 'photo',
      uploadedBy: clerkId,
    });
    const insert = calls.find((c) => c.sql.includes('INSERT INTO attachments'))!;
    expect(insert.params[8]).toBe(clerkId);
  });

  it('stores NULL uploaded_by when no uploadedBy is provided', async () => {
    const { pool, calls } = makeAttachmentPool([attachmentRow({ uploaded_by: null })]);
    const repo = new PgAttachmentRepository(pool);
    await repo.create(TENANT, {
      fileId: FILE_ID,
      entityType: 'job',
      entityId: ENTITY_ID,
      kind: 'photo',
    });
    const insert = calls.find((c) => c.sql.includes('INSERT INTO attachments'))!;
    expect(insert.params[8]).toBeNull();
  });
});

describe('PgAttachmentRepository.findById', () => {
  it('queries with explicit tenant_id predicate', async () => {
    const { pool, calls } = makeAttachmentPool([attachmentRow()]);
    const repo = new PgAttachmentRepository(pool);
    await repo.findById(TENANT, ATTACHMENT_ID);

    const select = calls.find((c) => c.sql.includes('SELECT * FROM attachments'))!;
    expect(select.sql).toContain('tenant_id = $1');
    expect(select.params).toEqual([TENANT, ATTACHMENT_ID]);
  });

  it('returns null when no row matches', async () => {
    const { pool } = makeAttachmentPool([]);
    const repo = new PgAttachmentRepository(pool);
    expect(await repo.findById(TENANT, ATTACHMENT_ID)).toBeNull();
  });
});

describe('PgAttachmentRepository.listByEntity', () => {
  it('filters by tenant + entity, excludes archived by default, orders by sort_order then created_at', async () => {
    const { pool, calls } = makeAttachmentPool([attachmentRow()]);
    const repo = new PgAttachmentRepository(pool);
    const rows = await repo.listByEntity(TENANT, 'job', ENTITY_ID);

    const select = calls.find((c) => c.sql.includes('FROM attachments'))!;
    expect(select.sql).toContain('tenant_id = $1');
    expect(select.sql).toContain('entity_type = $2');
    expect(select.sql).toContain('entity_id = $3');
    expect(select.sql).toContain('archived_at IS NULL');
    expect(select.sql).toContain('ORDER BY sort_order ASC, created_at ASC');
    expect(select.params).toEqual([TENANT, 'job', ENTITY_ID]);
    expect(rows).toHaveLength(1);
  });

  it('includes archived rows when includeArchived is set', async () => {
    const { pool, calls } = makeAttachmentPool([attachmentRow({ archived_at: new Date().toISOString() })]);
    const repo = new PgAttachmentRepository(pool);
    const rows = await repo.listByEntity(TENANT, 'job', ENTITY_ID, { includeArchived: true });

    const select = calls.find((c) => c.sql.includes('FROM attachments'))!;
    expect(select.sql).not.toContain('archived_at IS NULL');
    expect(rows[0].archivedAt).toBeInstanceOf(Date);
  });
});

describe('PgAttachmentRepository.archive', () => {
  it('UPDATEs archived_at with COALESCE (idempotent) scoped by tenant_id', async () => {
    const archivedAt = new Date().toISOString();
    const { pool, calls } = makeAttachmentPool([attachmentRow({ archived_at: archivedAt })]);
    const repo = new PgAttachmentRepository(pool);
    const archived = await repo.archive(TENANT, ATTACHMENT_ID);

    const update = calls.find((c) => c.sql.includes('UPDATE attachments'))!;
    expect(update.sql).toContain('archived_at = COALESCE(archived_at, now())');
    expect(update.sql).toContain('tenant_id = $1');
    expect(update.params).toEqual([TENANT, ATTACHMENT_ID]);
    expect(archived!.archivedAt).toBeInstanceOf(Date);
  });

  it('returns null when the row is not in this tenant', async () => {
    const { pool } = makeAttachmentPool([]);
    const repo = new PgAttachmentRepository(pool);
    expect(await repo.archive(TENANT, ATTACHMENT_ID)).toBeNull();
  });
});

describe('PgAttachmentRepository.setPortalVisibility', () => {
  it('UPDATEs portal_visible scoped by tenant_id', async () => {
    const { pool, calls } = makeAttachmentPool([attachmentRow({ portal_visible: true })]);
    const repo = new PgAttachmentRepository(pool);
    const updated = await repo.setPortalVisibility(TENANT, ATTACHMENT_ID, true);

    const update = calls.find((c) => c.sql.includes('UPDATE attachments'))!;
    expect(update.sql).toContain('portal_visible = $3');
    expect(update.sql).toContain('tenant_id = $1');
    expect(update.params).toEqual([TENANT, ATTACHMENT_ID, true]);
    expect(updated!.portalVisible).toBe(true);
  });

  it('returns null when the row is not in this tenant', async () => {
    const { pool } = makeAttachmentPool([]);
    const repo = new PgAttachmentRepository(pool);
    expect(await repo.setPortalVisibility(TENANT, ATTACHMENT_ID, true)).toBeNull();
  });
});

describe('PgAttachmentRepository.pair', () => {
  const OTHER_ID = '88888888-8888-8888-8888-888888888888';
  const PAIR_GROUP_ID = '77777777-7777-7777-7777-777777777777';

  it('runs both UPDATEs inside a transaction and returns both mapped rows', async () => {
    let callIndex = 0;
    const rows = [
      attachmentRow({ pair_group_id: PAIR_GROUP_ID, pair_role: 'before' }),
      attachmentRow({ id: OTHER_ID, pair_group_id: PAIR_GROUP_ID, pair_role: 'after' }),
    ];
    const { pool, calls } = makeMockPool((sql, _params) => {
      if (sql.includes('app.current_tenant_id') || sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK' || sql.includes('RESET')) {
        return { rows: [] };
      }
      // Return the appropriate row for each UPDATE call
      const row = rows[callIndex++] ?? rows[rows.length - 1];
      return { rows: [row], rowCount: 1 };
    });
    const repo = new PgAttachmentRepository(pool);
    const result = await repo.pair(TENANT, ATTACHMENT_ID, 'before', OTHER_ID, 'after', PAIR_GROUP_ID);

    const updates = calls.filter((c) => c.sql.includes('UPDATE attachments'));
    expect(updates).toHaveLength(2);
    expect(updates[0].sql).toContain('pair_group_id = $3');
    expect(updates[0].sql).toContain('pair_role = $4');
    expect(updates[0].sql).toContain('tenant_id = $1');
    expect(updates[0].params).toEqual([TENANT, ATTACHMENT_ID, PAIR_GROUP_ID, 'before']);
    expect(updates[1].params).toEqual([TENANT, OTHER_ID, PAIR_GROUP_ID, 'after']);
    expect(result.attachment.pairGroupId).toBe(PAIR_GROUP_ID);
    expect(result.attachment.pairRole).toBe('before');
    expect(result.other.pairGroupId).toBe(PAIR_GROUP_ID);
    expect(result.other.pairRole).toBe('after');
  });

  it('throws and rolls back when the first row is not found', async () => {
    const { pool } = makeMockPool((sql) => {
      if (sql.includes('app.current_tenant_id') || sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK' || sql.includes('RESET')) {
        return { rows: [] };
      }
      return { rows: [], rowCount: 0 };
    });
    const repo = new PgAttachmentRepository(pool);
    await expect(
      repo.pair(TENANT, ATTACHMENT_ID, 'before', OTHER_ID, 'after', PAIR_GROUP_ID)
    ).rejects.toThrow();
  });
});
