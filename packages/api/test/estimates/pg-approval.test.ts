/**
 * Mocked-pool unit tests for PgApprovalRepository and PgEditDeltaRepository.
 *
 * Integration tests cover real RLS; here we verify tenant context, parameterized
 * SQL, JSON encoding of metadata/deltas, null/empty returns, and row mapping
 * (including pending approvals with null approvedAt) without Docker.
 */
import { describe, it, expect, vi } from 'vitest';
import type { Pool, PoolClient, QueryResult } from 'pg';
import { PgApprovalRepository } from '../../src/estimates/pg-approval';
import { PgEditDeltaRepository } from '../../src/estimates/pg-edit-delta';
import { EstimateApproval } from '../../src/estimates/approval';
import { EstimateEditDelta } from '../../src/estimates/edit-delta';

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
const EST_ID = '33333333-3333-3333-3333-333333333333';
const isContext = (sql: string) => sql.includes('app.current_tenant_id');

describe('PgApprovalRepository', () => {
  function makeApproval(overrides: Partial<EstimateApproval> = {}): EstimateApproval {
    return {
      id: 'appr-1',
      tenantId: TENANT,
      estimateId: EST_ID,
      status: 'pending',
      approvedWithEdits: false,
      createdAt: new Date('2026-05-01T00:00:00.000Z'),
      ...overrides,
    };
  }

  function approvalRow(a: EstimateApproval): Record<string, unknown> {
    return {
      id: a.id,
      tenant_id: a.tenantId,
      estimate_id: a.estimateId,
      status: a.status,
      approved_by: a.approvedBy ?? null,
      approved_at: a.approvedAt ?? null,
      rejected_by: a.rejectedBy ?? null,
      rejected_at: a.rejectedAt ?? null,
      rejection_reason: a.rejectionReason ?? null,
      approved_with_edits: a.approvedWithEdits,
      final_revision_id: a.finalRevisionId ?? null,
      metadata: a.metadata ?? null,
      created_at: a.createdAt.toISOString(),
    };
  }

  it('create serializes metadata as JSON and parameterizes tenantId', async () => {
    const approval = makeApproval({ metadata: { source: 'ai', confidence: 0.9 } });
    const { pool, calls } = makeMockPool((sql) => (isContext(sql) ? [] : []));
    await new PgApprovalRepository(pool).create(approval);
    const insert = calls.find((c) => c.sql.includes('INSERT INTO estimate_approvals'))!;
    expect(insert.params[1]).toBe(TENANT);
    expect(insert.params[11]).toBe(JSON.stringify({ source: 'ai', confidence: 0.9 }));
  });

  it('create passes null metadata through when undefined', async () => {
    const { pool, calls } = makeMockPool((sql) => (isContext(sql) ? [] : []));
    await new PgApprovalRepository(pool).create(makeApproval());
    const insert = calls.find((c) => c.sql.includes('INSERT INTO estimate_approvals'))!;
    expect(insert.params[11]).toBeNull();
  });

  it('findByEstimate returns null when there is no approval', async () => {
    const { pool, calls } = makeMockPool((sql) => (isContext(sql) ? [] : []));
    expect(await new PgApprovalRepository(pool).findByEstimate(TENANT, EST_ID)).toBeNull();
    const q = calls.find((c) => c.sql.includes('FROM estimate_approvals'))!;
    expect(q.params).toEqual([TENANT, EST_ID]);
  });

  it('findByEstimate maps a pending approval with null approvedAt', async () => {
    const approval = makeApproval();
    const { pool } = makeMockPool((sql) => (isContext(sql) ? [] : [approvalRow(approval)]));
    const result = await new PgApprovalRepository(pool).findByEstimate(TENANT, EST_ID);
    expect(result?.status).toBe('pending');
    expect(result?.approvedAt).toBeUndefined();
    expect(result?.approvedWithEdits).toBe(false);
  });

  it('findByEstimate maps an approved approval with timestamp + metadata', async () => {
    const approval = makeApproval({
      status: 'approved',
      approvedBy: 'user-1',
      approvedAt: new Date('2026-05-02T00:00:00.000Z'),
      approvedWithEdits: true,
      metadata: { note: 'ok' },
    });
    const { pool } = makeMockPool((sql) => (isContext(sql) ? [] : [approvalRow(approval)]));
    const result = await new PgApprovalRepository(pool).findByEstimate(TENANT, EST_ID);
    expect(result?.status).toBe('approved');
    expect(result?.approvedAt?.toISOString()).toBe('2026-05-02T00:00:00.000Z');
    expect(result?.metadata).toEqual({ note: 'ok' });
  });

  it('findByTenant orders by created_at DESC and maps all rows', async () => {
    const a1 = makeApproval({ id: 'a1' });
    const a2 = makeApproval({ id: 'a2' });
    const { pool, calls } = makeMockPool((sql) =>
      isContext(sql) ? [] : [approvalRow(a1), approvalRow(a2)]
    );
    const result = await new PgApprovalRepository(pool).findByTenant(TENANT);
    expect(result.map((r) => r.id)).toEqual(['a1', 'a2']);
    expect(calls.find((c) => c.sql.includes('FROM estimate_approvals'))!.sql).toMatch(
      /ORDER\s+BY\s+created_at\s+DESC/
    );
  });
});

describe('PgEditDeltaRepository', () => {
  function makeDelta(overrides: Partial<EstimateEditDelta> = {}): EstimateEditDelta {
    return {
      id: 'delta-1',
      tenantId: TENANT,
      estimateId: EST_ID,
      fromRevisionId: 'rev-1',
      toRevisionId: 'rev-2',
      deltas: [{ type: 'price_changed', lineItemId: 'li-1', oldValue: 100, newValue: 200 }],
      summary: '1 change(s)',
      createdAt: new Date('2026-05-01T00:00:00.000Z'),
      ...overrides,
    };
  }

  function deltaRow(d: EstimateEditDelta, diffAsString: boolean): Record<string, unknown> {
    return {
      id: d.id,
      tenant_id: d.tenantId,
      document_type: 'estimate',
      document_id: d.estimateId,
      from_revision_id: d.fromRevisionId,
      to_revision_id: d.toRevisionId,
      diff: diffAsString ? JSON.stringify(d.deltas) : d.deltas,
      summary: d.summary,
      created_at: d.createdAt.toISOString(),
    };
  }

  it('create writes into diff_analyses with document_type=estimate and JSON diff', async () => {
    const delta = makeDelta();
    const { pool, calls } = makeMockPool((sql) => (isContext(sql) ? [] : []));
    await new PgEditDeltaRepository(pool).create(delta);
    const insert = calls.find((c) => c.sql.includes('INSERT INTO diff_analyses'))!;
    expect(insert.params[1]).toBe(TENANT);
    expect(insert.params[2]).toBe('estimate');
    expect(insert.params[3]).toBe(EST_ID);
    expect(insert.params[6]).toBe(JSON.stringify(delta.deltas));
    expect(insert.params[8]).toBe('completed');
  });

  it('findByEstimate returns [] when none exist and orders ASC', async () => {
    const { pool, calls } = makeMockPool((sql) => (isContext(sql) ? [] : []));
    expect(await new PgEditDeltaRepository(pool).findByEstimate(TENANT, EST_ID)).toEqual([]);
    const q = calls.find((c) => c.sql.includes('FROM diff_analyses'))!;
    expect(q.sql).toMatch(/ORDER\s+BY\s+created_at\s+ASC/);
    expect(q.params).toEqual([TENANT, 'estimate', EST_ID]);
  });

  it('findByEstimate parses a string diff column to DeltaEntry[]', async () => {
    const delta = makeDelta();
    const { pool } = makeMockPool((sql) => (isContext(sql) ? [] : [deltaRow(delta, true)]));
    const result = await new PgEditDeltaRepository(pool).findByEstimate(TENANT, EST_ID);
    expect(result[0].deltas).toEqual(delta.deltas);
    expect(result[0].estimateId).toBe(EST_ID);
  });

  it('findByEstimate passes through an already-parsed JSONB diff', async () => {
    const delta = makeDelta();
    const { pool } = makeMockPool((sql) => (isContext(sql) ? [] : [deltaRow(delta, false)]));
    const result = await new PgEditDeltaRepository(pool).findByEstimate(TENANT, EST_ID);
    expect(result[0].deltas).toEqual(delta.deltas);
  });
});
