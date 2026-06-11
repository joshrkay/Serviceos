/**
 * Mocked-pool unit tests for PgEstimateRepository.
 *
 * The live-DB equivalents (real RLS, real find_estimate_by_view_token) live in
 * the integration suite. These unit tests use a mocked Pool to verify, without
 * Docker, that the SQL layer:
 *   - sets tenant context (`SET app.current_tenant_id`) before tenant-scoped work
 *   - parameterizes tenantId in business queries (never inlined)
 *   - returns null/[] for empty result sets
 *   - clamps pagination at MAX_ESTIMATE_LIMIT
 *   - regenerates a UUID for non-UUID client-supplied line-item ids
 *   - releases the connection even when a query throws
 */
import { describe, it, expect, vi } from 'vitest';
import type { Pool, PoolClient, QueryResult } from 'pg';
import { PgEstimateRepository } from '../../src/estimates/pg-estimate';
import { Estimate, MAX_ESTIMATE_LIMIT } from '../../src/estimates/estimate';
import { buildLineItem, LineItem } from '../../src/shared/billing-engine';

type CapturedCall = { sql: string; params: unknown[] };
type Responder = (sql: string, params: unknown[]) => Record<string, unknown>[];

function makeMockPool(responder: Responder) {
  const calls: CapturedCall[] = [];
  let releaseCount = 0;

  const client: Partial<PoolClient> = {
    query: vi.fn(async (sql: string, params?: unknown[]) => {
      calls.push({ sql, params: params ?? [] });
      const rows = responder(sql, params ?? []);
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

  return { pool: pool as Pool, calls, getReleaseCount: () => releaseCount };
}

const TENANT = '11111111-1111-1111-1111-111111111111';
const OTHER_TENANT = '22222222-2222-2222-2222-222222222222';
const EST_ID = '33333333-3333-3333-3333-333333333333';
const JOB_ID = '44444444-4444-4444-4444-444444444444';

function makeEstimate(overrides: Partial<Estimate> = {}): Estimate {
  const now = new Date('2026-05-01T00:00:00.000Z');
  return {
    id: EST_ID,
    tenantId: TENANT,
    jobId: JOB_ID,
    estimateNumber: 'EST-001',
    status: 'draft',
    lineItems: [buildLineItem('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'Labor', 2, 5000, 1, true, 'labor')],
    totals: {
      subtotalCents: 10000,
      taxableSubtotalCents: 10000,
      discountCents: 0,
      taxRateBps: 825,
      taxCents: 825,
      totalCents: 10825,
    },
    createdBy: 'user-1',
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function estimateRow(e: Estimate): Record<string, unknown> {
  return {
    id: e.id,
    tenant_id: e.tenantId,
    job_id: e.jobId,
    estimate_number: e.estimateNumber,
    status: e.status,
    discount_cents: e.totals.discountCents,
    tax_rate_bps: e.totals.taxRateBps,
    subtotal_cents: e.totals.subtotalCents,
    taxable_subtotal_cents: e.totals.taxableSubtotalCents,
    tax_cents: e.totals.taxCents,
    total_cents: e.totals.totalCents,
    valid_until: e.validUntil ?? null,
    customer_message: e.customerMessage ?? null,
    internal_notes: e.internalNotes ?? null,
    view_token: e.viewToken ?? null,
    view_token_expires_at: e.viewTokenExpiresAt ?? null,
    sent_at: e.sentAt ?? null,
    last_dispatch_id: e.lastDispatchId ?? null,
    first_viewed_at: e.firstViewedAt ?? null,
    view_count: e.viewCount ?? null,
    accepted_at: e.acceptedAt ?? null,
    accepted_by_name: e.acceptedByName ?? null,
    accepted_by_ip: e.acceptedByIp ?? null,
    accepted_user_agent: e.acceptedUserAgent ?? null,
    accepted_signature_data: e.acceptedSignatureData ?? null,
    rejected_at: e.rejectedAt ?? null,
    rejected_reason: e.rejectedReason ?? null,
    created_by: e.createdBy,
    created_at: e.createdAt.toISOString(),
    updated_at: e.updatedAt.toISOString(),
  };
}

function lineItemRow(li: LineItem): Record<string, unknown> {
  return {
    id: li.id,
    description: li.description,
    category: li.category ?? 'other',
    quantity: li.quantity,
    unit_price_cents: li.unitPriceCents,
    total_cents: li.totalCents,
    sort_order: li.sortOrder,
    taxable: li.taxable,
  };
}

const isContext = (sql: string) =>
  sql.includes('app.current_tenant_id') ||
  sql.startsWith('BEGIN') ||
  sql.startsWith('COMMIT') ||
  sql.startsWith('ROLLBACK');

describe('PgEstimateRepository.findById', () => {
  it('returns mapped estimate with line items', async () => {
    const e = makeEstimate();
    const { pool, calls } = makeMockPool((sql) => {
      if (isContext(sql)) return [];
      if (sql.includes('FROM estimates')) return [estimateRow(e)];
      if (sql.includes('estimate_line_items')) return e.lineItems.map(lineItemRow);
      return [];
    });

    const result = await new PgEstimateRepository(pool).findById(TENANT, EST_ID);

    expect(result?.id).toBe(EST_ID);
    expect(result?.totals.totalCents).toBe(10825);
    expect(result?.lineItems).toHaveLength(1);
    expect(result?.lineItems[0].unitPriceCents).toBe(5000);

    const ctx = calls[0];
    expect(ctx.sql).toContain('app.current_tenant_id');
    const select = calls.find((c) => c.sql.includes('SELECT * FROM estimates'))!;
    expect(select.sql).toMatch(/WHERE\s+id\s*=\s*\$1\s+AND\s+tenant_id\s*=\s*\$2/);
    expect(select.sql).not.toContain(TENANT);
    expect(select.params).toEqual([EST_ID, TENANT]);
  });

  it('returns null when no estimate row matches', async () => {
    const { pool } = makeMockPool((sql) => (isContext(sql) ? [] : []));
    const result = await new PgEstimateRepository(pool).findById(TENANT, 'missing');
    expect(result).toBeNull();
  });

  it('returns null for an id owned by another tenant (no row under this tenant ctx)', async () => {
    const e = makeEstimate({ tenantId: OTHER_TENANT });
    // RLS would hide the cross-tenant row; mock that by only returning it when
    // the bound tenant param matches the row's tenant.
    const { pool } = makeMockPool((sql, params) => {
      if (isContext(sql)) return [];
      if (sql.includes('FROM estimates') && params[1] === e.tenantId) return [estimateRow(e)];
      return [];
    });
    const result = await new PgEstimateRepository(pool).findById(TENANT, EST_ID);
    expect(result).toBeNull();
  });

  it('releases the connection even when a query throws', async () => {
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
    await expect(new PgEstimateRepository(pool as Pool).findById(TENANT, EST_ID)).rejects.toThrow(
      'pg down'
    );
    expect(failingClient.release).toHaveBeenCalledTimes(1);
  });
});

describe('PgEstimateRepository.findByJob', () => {
  it('returns [] when the job has no estimates', async () => {
    const { pool, calls } = makeMockPool((sql) => (isContext(sql) ? [] : []));
    const result = await new PgEstimateRepository(pool).findByJob(TENANT, JOB_ID);
    expect(result).toEqual([]);
    const q = calls.find((c) => c.sql.includes('FROM estimates'))!;
    expect(q.sql).toMatch(/ORDER\s+BY\s+created_at\s+DESC/);
    expect(q.params).toEqual([TENANT, JOB_ID]);
  });

  it('returns multiple estimates each hydrated with its line items', async () => {
    const e1 = makeEstimate({ id: EST_ID });
    const e2 = makeEstimate({ id: '55555555-5555-5555-5555-555555555555', estimateNumber: 'EST-002' });
    const { pool } = makeMockPool((sql, params) => {
      if (isContext(sql)) return [];
      if (sql.includes('FROM estimates')) return [estimateRow(e1), estimateRow(e2)];
      if (sql.includes('estimate_line_items')) {
        const id = params[0];
        const e = id === e1.id ? e1 : e2;
        return e.lineItems.map(lineItemRow);
      }
      return [];
    });
    const result = await new PgEstimateRepository(pool).findByJob(TENANT, JOB_ID);
    expect(result.map((r) => r.id)).toEqual([e1.id, e2.id]);
  });
});

describe('PgEstimateRepository list filters + pagination', () => {
  it('clamps limit at MAX_ESTIMATE_LIMIT', async () => {
    const { pool, calls } = makeMockPool((sql) => (isContext(sql) ? [] : []));
    await new PgEstimateRepository(pool).findByTenant(TENANT, { limit: 999 });
    const dataQuery = calls.find((c) => c.sql.includes('FROM estimates') && c.sql.includes('LIMIT'))!;
    // params: [tenantId, limit, offset]
    expect(dataQuery.params).toContain(MAX_ESTIMATE_LIMIT);
    expect(dataQuery.params).not.toContain(999);
  });

  it('builds combined status + jobId + search WHERE clause with AND', async () => {
    const { pool, calls } = makeMockPool((sql) => (isContext(sql) ? [] : []));
    await new PgEstimateRepository(pool).findByTenant(TENANT, {
      status: 'sent',
      jobId: JOB_ID,
      search: 'roof',
    });
    const q = calls.find((c) => c.sql.includes('FROM estimates'))!;
    expect(q.sql).toMatch(/WHERE\s+tenant_id\s*=\s*\$1\s+AND\s+deleted_at\s+IS\s+NULL\s+AND\s+status\s*=\s*\$2\s+AND\s+job_id\s*=\s*\$3\s+AND/);
    expect(q.sql).toContain('ILIKE');
    expect(q.params).toEqual([TENANT, 'sent', JOB_ID, '%roof%']);
  });

  it('applies ascending sort when sort=asc', async () => {
    const { pool, calls } = makeMockPool((sql) => (isContext(sql) ? [] : []));
    await new PgEstimateRepository(pool).findByTenant(TENANT, { sort: 'asc', limit: 10 });
    const q = calls.find((c) => c.sql.includes('FROM estimates') && c.sql.includes('LIMIT'))!;
    expect(q.sql).toMatch(/ORDER\s+BY\s+created_at\s+ASC/);
  });

  it('listWithMeta returns data plus total from the count query', async () => {
    const e = makeEstimate();
    const { pool, calls } = makeMockPool((sql) => {
      if (isContext(sql)) return [];
      if (sql.includes('COUNT(*)')) return [{ total: 7 }];
      if (sql.includes('FROM estimates')) return [estimateRow(e)];
      if (sql.includes('estimate_line_items')) return e.lineItems.map(lineItemRow);
      return [];
    });
    const result = await new PgEstimateRepository(pool).listWithMeta(TENANT, { limit: 999 });
    expect(result.total).toBe(7);
    expect(result.data).toHaveLength(1);
    const countQ = calls.find((c) => c.sql.includes('COUNT(*)'))!;
    expect(countQ.sql).not.toContain(TENANT);
  });
});

describe('PgEstimateRepository.findByViewToken', () => {
  it('returns null when the token lookup finds nothing (no tenant context set)', async () => {
    const { pool, calls } = makeMockPool((sql) => {
      if (sql.includes('find_estimate_by_view_token')) return [];
      return [];
    });
    const result = await new PgEstimateRepository(pool).findByViewToken('bogus-token');
    expect(result).toBeNull();
    // withClient must not set tenant context for the global token lookup.
    expect(calls.some((c) => c.sql.includes('app.current_tenant_id'))).toBe(false);
    const tokenQ = calls.find((c) => c.sql.includes('find_estimate_by_view_token'))!;
    expect(tokenQ.params).toEqual(['bogus-token']);
  });

  it('resolves tenant from token then loads the estimate via tenant context', async () => {
    const e = makeEstimate();
    const { pool, calls } = makeMockPool((sql) => {
      if (sql.includes('find_estimate_by_view_token')) return [{ id: e.id, tenant_id: e.tenantId }];
      if (isContext(sql)) return [];
      if (sql.includes('FROM estimates')) return [estimateRow(e)];
      if (sql.includes('estimate_line_items')) return e.lineItems.map(lineItemRow);
      return [];
    });
    const result = await new PgEstimateRepository(pool).findByViewToken('valid-token');
    expect(result?.id).toBe(e.id);
    // Second step re-enters tenant context.
    expect(calls.some((c) => c.sql.includes('app.current_tenant_id'))).toBe(true);
  });
});

describe('PgEstimateRepository.create', () => {
  it('wraps insert in BEGIN/COMMIT, sets tenant context, parameterizes tenantId', async () => {
    const e = makeEstimate();
    const { pool, calls, getReleaseCount } = makeMockPool((sql) => (isContext(sql) ? [] : []));
    await new PgEstimateRepository(pool).create(e);

    expect(calls[0].sql).toBe('BEGIN');
    expect(calls[1].sql).toContain('app.current_tenant_id');
    expect(calls.some((c) => c.sql === 'COMMIT')).toBe(true);

    const insert = calls.find((c) => c.sql.includes('INSERT INTO estimates'))!;
    expect(insert.sql).not.toContain(TENANT);
    expect(insert.params[1]).toBe(TENANT);
    expect(insert.params[4]).toBe('draft');
    expect(getReleaseCount()).toBe(1);
  });

  it('regenerates a UUID for a non-UUID client-supplied line-item id', async () => {
    const e = makeEstimate({
      lineItems: [buildLineItem('temp-field-key', 'Labor', 1, 5000, 1, true)],
    });
    const { pool, calls } = makeMockPool((sql) => (isContext(sql) ? [] : []));
    await new PgEstimateRepository(pool).create(e);

    const liInsert = calls.find((c) => c.sql.includes('INSERT INTO estimate_line_items'))!;
    const insertedId = liInsert.params[0] as string;
    expect(insertedId).not.toBe('temp-field-key');
    expect(insertedId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
    );
  });

  it('preserves a valid UUID line-item id as-is', async () => {
    const validId = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
    const e = makeEstimate({ lineItems: [buildLineItem(validId, 'Labor', 1, 5000, 1, true)] });
    const { pool, calls } = makeMockPool((sql) => (isContext(sql) ? [] : []));
    await new PgEstimateRepository(pool).create(e);
    const liInsert = calls.find((c) => c.sql.includes('INSERT INTO estimate_line_items'))!;
    expect(liInsert.params[0]).toBe(validId);
  });

  it('defaults a missing line-item category to other', async () => {
    const e = makeEstimate({ lineItems: [buildLineItem('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'X', 1, 100, 1, true)] });
    const { pool, calls } = makeMockPool((sql) => (isContext(sql) ? [] : []));
    await new PgEstimateRepository(pool).create(e);
    const liInsert = calls.find((c) => c.sql.includes('INSERT INTO estimate_line_items'))!;
    expect(liInsert.params[4]).toBe('other');
  });

  it('rolls back and releases when the insert throws', async () => {
    const queryMock = vi
      .fn()
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // BEGIN
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // SET tenant
      .mockRejectedValueOnce(new Error('insert failed')); // INSERT estimates
    const client: Partial<PoolClient> = {
      query: queryMock as unknown as PoolClient['query'],
      release: vi.fn(),
    };
    const pool: Partial<Pool> = {
      connect: vi.fn(async () => client as PoolClient) as unknown as Pool['connect'],
    };
    await expect(new PgEstimateRepository(pool as Pool).create(makeEstimate())).rejects.toThrow(
      'insert failed'
    );
    expect(queryMock).toHaveBeenCalledWith('ROLLBACK');
    expect(client.release).toHaveBeenCalledTimes(1);
  });
});

describe('PgEstimateRepository.update', () => {
  it('skips the UPDATE when no mutable fields are supplied', async () => {
    const e = makeEstimate();
    const { pool, calls } = makeMockPool((sql) => {
      if (isContext(sql)) return [];
      if (sql.includes('SELECT * FROM estimates')) return [estimateRow(e)];
      if (sql.includes('estimate_line_items')) return e.lineItems.map(lineItemRow);
      return [];
    });
    const result = await new PgEstimateRepository(pool).update(TENANT, EST_ID, {});
    expect(calls.some((c) => c.sql.includes('UPDATE estimates'))).toBe(false);
    expect(result?.id).toBe(EST_ID);
  });

  it('builds a SET clause for supplied fields and parameterizes id + tenant last', async () => {
    const e = makeEstimate({ status: 'sent' });
    const { pool, calls } = makeMockPool((sql) => {
      if (isContext(sql)) return [];
      if (sql.includes('SELECT * FROM estimates')) return [estimateRow(e)];
      if (sql.includes('estimate_line_items')) return e.lineItems.map(lineItemRow);
      return [];
    });
    await new PgEstimateRepository(pool).update(TENANT, EST_ID, { status: 'sent' });
    const upd = calls.find((c) => c.sql.includes('UPDATE estimates'))!;
    expect(upd.sql).toMatch(/SET\s+status\s*=\s*\$1/);
    expect(upd.sql).toMatch(/WHERE\s+id\s*=\s*\$2\s+AND\s+tenant_id\s*=\s*\$3/);
    expect(upd.params).toEqual(['sent', EST_ID, TENANT]);
  });

  it('replaces line items by DELETE then re-INSERT when lineItems supplied', async () => {
    const e = makeEstimate();
    const { pool, calls } = makeMockPool((sql) => {
      if (isContext(sql)) return [];
      if (sql.includes('SELECT * FROM estimates')) return [estimateRow(e)];
      if (sql.includes('estimate_line_items') && sql.includes('SELECT')) {
        return e.lineItems.map(lineItemRow);
      }
      return [];
    });
    await new PgEstimateRepository(pool).update(TENANT, EST_ID, {
      lineItems: [buildLineItem('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'New', 1, 200, 1, true)],
    });
    expect(calls.some((c) => c.sql.includes('DELETE FROM estimate_line_items'))).toBe(true);
    expect(calls.some((c) => c.sql.includes('INSERT INTO estimate_line_items'))).toBe(true);
  });
});
