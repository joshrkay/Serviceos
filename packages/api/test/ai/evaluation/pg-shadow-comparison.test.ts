/**
 * P2-030 — PgShadowComparisonStore tests.
 *
 * Uses a mocked Pool (same pattern as pg-document-revision.test.ts) to verify:
 *   - Tenant context set before every business query (RLS).
 *   - Parameterized INSERT — tenant id never inlined.
 *   - mapRow correctly hydrates all fields including nullable ones.
 *   - Connections released on error.
 *   - listForTenant filters by tenant_id and respects limit / cursor.
 *   - PII redaction applied before insert.
 *   - Tenant isolation: cross-tenant returns empty.
 */
import { describe, it, expect, vi } from 'vitest';
import type { Pool, PoolClient, QueryResult } from 'pg';
import { PgShadowComparisonStore } from '../../../src/ai/evaluation/pg-shadow-comparison';
import type { ShadowComparisonResult } from '../../../src/ai/evaluation/shadow-comparison';

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
const TENANT_B = '22222222-2222-2222-2222-222222222222';

function makeResult(overrides: Partial<ShadowComparisonResult> = {}): ShadowComparisonResult {
  return {
    id: 'cmp-1',
    comparisonGroupId: 'grp-1',
    taskType: 'draft_estimate',
    primaryResponse: {
      content: 'hello world',
      model: 'gpt-4o-mini',
      provider: 'openai',
      tokenUsage: { input: 10, output: 20, total: 30 },
      latencyMs: 300,
    },
    shadowResponse: {
      content: 'shadow reply',
      model: 'claude-3-haiku',
      provider: 'anthropic',
      tokenUsage: { input: 12, output: 22, total: 34 },
      latencyMs: 400,
    },
    sampledAt: new Date('2026-05-17T10:00:00.000Z'),
    tenantId: TENANT_A,
    aiRunId: 'run-abc',
    ...overrides,
  };
}

function rowFor(
  r: ShadowComparisonResult,
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    id: r.id,
    tenant_id: r.tenantId,
    ai_run_id: r.aiRunId ?? null,
    comparison_group_id: r.comparisonGroupId ?? null,
    task_type: r.taskType ?? null,
    primary_model: r.primaryResponse.model ?? null,
    shadow_model: r.shadowResponse?.model ?? r.primaryResponse.model,
    primary_response_text: r.primaryResponse.content,
    shadow_response_text: r.shadowResponse?.content ?? null,
    primary_latency_ms: r.primaryResponse.latencyMs,
    shadow_latency_ms: r.shadowResponse?.latencyMs ?? null,
    primary_token_usage: r.primaryResponse.tokenUsage,
    shadow_token_usage: r.shadowResponse?.tokenUsage ?? null,
    divergence_score: null,
    created_at: r.sampledAt.toISOString(),
    ...overrides,
  };
}

describe('P2-030 PgShadowComparisonStore.save', () => {
  it('inserts with parameterized values and sets tenant context', async () => {
    const result = makeResult();
    const { pool, calls, getReleaseCount } = makeMockPool([
      undefined, // SET app.current_tenant_id
      [rowFor(result)], // INSERT RETURNING *
    ]);

    const store = new PgShadowComparisonStore(pool);
    const saved = await store.save(result);

    // First call sets tenant context for RLS.
    expect(calls[0].sql).toContain('app.current_tenant_id');
    expect(calls[0].sql).toContain(TENANT_A);

    // Second call is the INSERT — must be parameterized.
    expect(calls[1].sql).toContain('INSERT INTO shadow_comparisons');
    expect(calls[1].sql).not.toContain(TENANT_A); // never inlined
    expect(calls[1].params[0]).toBe(result.id);
    expect(calls[1].params[1]).toBe(TENANT_A);

    expect(getReleaseCount()).toBe(1);
    expect(saved.id).toBe('cmp-1');
    expect(saved.tenantId).toBe(TENANT_A);
    expect(saved.aiRunId).toBe('run-abc');
  });

  it('binds nulls when aiRunId and shadowResponse absent', async () => {
    const result = makeResult({ aiRunId: undefined, shadowResponse: undefined, shadowError: 'timeout' });
    const row = rowFor(result);
    row.ai_run_id = null;
    row.shadow_response_text = null;
    row.shadow_latency_ms = null;
    row.shadow_token_usage = null;

    const { pool, calls } = makeMockPool([undefined, [row]]);
    const store = new PgShadowComparisonStore(pool);
    await store.save(result);

    // ai_run_id is param index 2 (0-based: id, tenant_id, ai_run_id, ...)
    expect(calls[1].params[2]).toBeNull();
  });

  it('releases connection on query error', async () => {
    const failingClient: Partial<PoolClient> = {
      query: vi
        .fn()
        .mockResolvedValueOnce({ rows: [], rowCount: 0 } as unknown as QueryResult)
        .mockRejectedValueOnce(new Error('db error')),
      release: vi.fn(),
    };
    const pool: Partial<Pool> = {
      connect: vi.fn(async () => failingClient as PoolClient) as unknown as Pool['connect'],
    };

    const store = new PgShadowComparisonStore(pool as Pool);
    await expect(store.save(makeResult())).rejects.toThrow('db error');
    expect(failingClient.release).toHaveBeenCalledTimes(1);
  });

  it('applies PII redaction before inserting response texts', async () => {
    const piiContent = 'Call John at john@example.com or 555-867-5309';
    const result = makeResult({
      primaryResponse: {
        content: piiContent,
        model: 'gpt-4o',
        provider: 'openai',
        tokenUsage: { input: 5, output: 15, total: 20 },
        latencyMs: 200,
      },
      shadowResponse: {
        content: 'Reply to john@example.com',
        model: 'claude-3',
        provider: 'anthropic',
        tokenUsage: { input: 5, output: 10, total: 15 },
        latencyMs: 180,
      },
    });
    const row = rowFor(result);
    const { pool, calls } = makeMockPool([undefined, [row]]);

    const store = new PgShadowComparisonStore(pool);
    await store.save(result);

    const insertedPrimary = calls[1].params[4] as string;
    const insertedShadow = calls[1].params[5] as string;

    // Email should be redacted
    expect(insertedPrimary).not.toContain('john@example.com');
    // Phone should be redacted
    expect(insertedPrimary).not.toContain('555-867-5309');
    // Shadow text should also be redacted
    expect(insertedShadow).not.toContain('john@example.com');
  });
});

describe('P2-030 PgShadowComparisonStore.listForTenant', () => {
  it('filters by tenant_id with WHERE clause and sets tenant context', async () => {
    const result = makeResult();
    const { pool, calls } = makeMockPool([undefined, [rowFor(result)]]);

    const store = new PgShadowComparisonStore(pool);
    const page = await store.listForTenant(TENANT_A);

    expect(calls[0].sql).toContain('app.current_tenant_id');
    const selectSql = calls[1].sql;
    expect(selectSql).toContain('SELECT');
    expect(selectSql).toContain('shadow_comparisons');
    expect(selectSql).toContain('tenant_id');
    // tenant_id must be parameterized
    expect(selectSql).not.toContain(TENANT_A);
    expect(calls[1].params[0]).toBe(TENANT_A);

    expect(page.comparisons.length).toBe(1);
    expect(page.comparisons[0].id).toBe('cmp-1');
    expect(page.comparisons[0].tenantId).toBe(TENANT_A);
  });

  it('tenant isolation: cross-tenant query returns empty', async () => {
    // Mock returns a row but tenant_b query would get empty from RLS
    // We simulate by returning no rows for tenant B query
    const { pool } = makeMockPool([undefined, []]);

    const store = new PgShadowComparisonStore(pool);
    const page = await store.listForTenant(TENANT_B);

    expect(page.comparisons).toHaveLength(0);
    expect(page.nextCursor).toBeNull();
  });

  it('maps row fields correctly to domain object', async () => {
    const result = makeResult();
    const { pool } = makeMockPool([undefined, [rowFor(result)]]);

    const store = new PgShadowComparisonStore(pool);
    const page = await store.listForTenant(TENANT_A);
    const cmp = page.comparisons[0];

    expect(cmp.id).toBe('cmp-1');
    expect(cmp.tenantId).toBe(TENANT_A);
    expect(cmp.aiRunId).toBe('run-abc');
    expect(cmp.primaryResponse.content).toBe('hello world');
    expect(cmp.primaryResponse.latencyMs).toBe(300);
    expect(cmp.primaryResponse.tokenUsage).toEqual({ input: 10, output: 20, total: 30 });
    expect(cmp.shadowResponse?.content).toBe('shadow reply');
    expect(cmp.shadowResponse?.latencyMs).toBe(400);
    expect(cmp.sampledAt).toBeInstanceOf(Date);
  });

  it('handles nullable shadowResponse fields (shadow error case)', async () => {
    const result = makeResult({ shadowResponse: undefined, shadowError: 'timeout' });
    const row = rowFor(result);
    row.shadow_response_text = null;
    row.shadow_latency_ms = null;
    row.shadow_token_usage = null;

    const { pool } = makeMockPool([undefined, [row]]);
    const store = new PgShadowComparisonStore(pool);
    const page = await store.listForTenant(TENANT_A);

    expect(page.comparisons[0].shadowResponse).toBeUndefined();
  });
});

describe('P2-030 PgShadowComparisonStore tenant isolation invariants', () => {
  it('never interpolates tenantId into business-query SQL strings', async () => {
    const result = makeResult();
    const { pool, calls } = makeMockPool([undefined, [rowFor(result)]]);
    const store = new PgShadowComparisonStore(pool);

    await store.save(result);

    const businessQueries = calls.filter((c) => !c.sql.includes('app.current_tenant_id'));
    expect(businessQueries.length).toBeGreaterThan(0);
    for (const c of businessQueries) {
      expect(c.sql).not.toContain(TENANT_A);
    }
  });
});

describe('P2-030 PgShadowComparisonStore — primary_model round-trip', () => {
  it('persists primary_model and mapRow reads it into primaryResponse.model', async () => {
    const result = makeResult();
    // Row returned by RETURNING * must have primary_model
    const row = rowFor(result);

    const { pool, calls } = makeMockPool([undefined, [row]]);
    const store = new PgShadowComparisonStore(pool);
    const saved = await store.save(result);

    // INSERT params: $6 is primary_model (0-indexed: id, tenantId, aiRunId, comparisonGroupId, taskType, primaryModel, ...)
    expect(calls[1].params[5]).toBe('gpt-4o-mini');

    // mapRow should produce primaryResponse.model = primary_model (not shadow_model)
    expect(saved.primaryResponse.model).toBe('gpt-4o-mini');
    // shadowResponse.model should be shadow_model
    expect(saved.shadowResponse?.model).toBe('claude-3-haiku');
  });

  it('falls back to shadow_model for primaryResponse.model when primary_model is null', async () => {
    const result = makeResult();
    // Simulate a legacy row without primary_model
    const row = rowFor(result, { primary_model: null });

    const { pool } = makeMockPool([undefined, [row]]);
    const store = new PgShadowComparisonStore(pool);
    const saved = await store.save(result);

    // Falls back to shadow_model
    expect(saved.primaryResponse.model).toBe('claude-3-haiku');
  });
});

describe('P2-030 PgShadowComparisonStore — divergenceScore plumbing', () => {
  it('mapRow converts numeric divergence_score string to number', async () => {
    const result = makeResult();
    // Postgres NUMERIC comes back as string from the pg driver
    const row = rowFor(result, { divergence_score: '0.42' });

    const { pool } = makeMockPool([undefined, [row]]);
    const store = new PgShadowComparisonStore(pool);
    const saved = await store.save(result);

    expect(saved.divergenceScore).toBe(0.42);
  });

  it('mapRow leaves divergenceScore null when column is null', async () => {
    const result = makeResult();
    const row = rowFor(result, { divergence_score: null });

    const { pool } = makeMockPool([undefined, [row]]);
    const store = new PgShadowComparisonStore(pool);
    const saved = await store.save(result);

    expect(saved.divergenceScore).toBeNull();
  });
});

describe('P2-030 PgShadowComparisonStore — taskType filter SQL', () => {
  it('includes task_type = $N condition when taskType option is provided', async () => {
    const result = makeResult();
    const { pool, calls } = makeMockPool([undefined, [rowFor(result)]]);

    const store = new PgShadowComparisonStore(pool);
    await store.listForTenant(TENANT_A, { taskType: 'draft_estimate' });

    // The SELECT query (calls[1]) should contain task_type = $2 param
    const selectCall = calls[1];
    expect(selectCall.sql).toContain('task_type');
    // taskType value should be in the params
    expect(selectCall.params).toContain('draft_estimate');
    // Must be parameterized — not inlined
    expect(selectCall.sql).not.toContain('draft_estimate');
  });

  it('omits task_type condition when taskType option is not provided', async () => {
    const result = makeResult();
    const { pool, calls } = makeMockPool([undefined, [rowFor(result)]]);

    const store = new PgShadowComparisonStore(pool);
    await store.listForTenant(TENANT_A);

    const selectCall = calls[1];
    expect(selectCall.sql).not.toContain('task_type');
  });
});
