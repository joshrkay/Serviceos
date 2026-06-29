/**
 * Unit tests for the dispatch repository — InMemory status lifecycle, tenant
 * isolation, listByTenant filtering/pagination, plus mocked-pool tests for the
 * Postgres implementation (tenant context, parameterization, COALESCE on
 * updateStatus, entity-type filter). Real RLS is covered by the integration suite.
 */
import { describe, it, expect, vi } from 'vitest';
import type { Pool, PoolClient, QueryResult } from 'pg';
import {
  InMemoryDispatchRepository,
  PgDispatchRepository,
} from '../../src/notifications/dispatch-repository';

const TENANT = '11111111-1111-1111-1111-111111111111';
const OTHER = '22222222-2222-2222-2222-222222222222';

describe('InMemoryDispatchRepository', () => {
  it('defaults status to sent and leaves providerMessageId undefined when omitted', async () => {
    const repo = new InMemoryDispatchRepository();
    const row = await repo.create({
      tenantId: TENANT,
      entityType: 'estimate',
      entityId: 'e-1',
      channel: 'sms',
      recipient: '+15550001111',
      provider: 'twilio',
    });
    expect(row.status).toBe('sent');
    expect(row.providerMessageId).toBeUndefined();
  });

  it('transitions status sent -> delivered -> failed -> bounced', async () => {
    const repo = new InMemoryDispatchRepository();
    const row = await repo.create({
      tenantId: TENANT,
      entityType: 'invoice',
      entityId: 'i-1',
      channel: 'email',
      recipient: 'a@b.com',
      provider: 'sendgrid',
    });
    const delivered = await repo.updateStatus(TENANT, row.id, 'delivered', new Date('2026-05-01T00:00:00Z'));
    expect(delivered?.status).toBe('delivered');
    expect(delivered?.deliveredAt?.toISOString()).toBe('2026-05-01T00:00:00.000Z');

    const failed = await repo.updateStatus(TENANT, row.id, 'failed', undefined, 'hard bounce');
    expect(failed?.status).toBe('failed');
    // deliveredAt preserved (COALESCE-equivalent) when not re-supplied.
    expect(failed?.deliveredAt?.toISOString()).toBe('2026-05-01T00:00:00.000Z');
    expect(failed?.errorMessage).toBe('hard bounce');

    const bounced = await repo.updateStatus(TENANT, row.id, 'bounced');
    expect(bounced?.status).toBe('bounced');
  });

  it('rejects cross-tenant updateStatus by returning null', async () => {
    const repo = new InMemoryDispatchRepository();
    const row = await repo.create({
      tenantId: TENANT,
      entityType: 'estimate',
      entityId: 'e-1',
      channel: 'sms',
      recipient: '+1',
      provider: 'twilio',
    });
    expect(await repo.updateStatus(OTHER, row.id, 'delivered')).toBeNull();
  });

  it('listByTenant filters by entityType and paginates', async () => {
    const repo = new InMemoryDispatchRepository();
    for (const t of ['estimate', 'invoice', 'estimate'] as const) {
      await repo.create({ tenantId: TENANT, entityType: t, entityId: t, channel: 'sms', recipient: '+1', provider: 'twilio' });
    }
    const all = await repo.listByTenant(TENANT);
    expect(all.total).toBe(3);
    const estimates = await repo.listByTenant(TENANT, { entityType: 'estimate' });
    expect(estimates.total).toBe(2);
    expect(estimates.dispatches.every((d) => d.entityType === 'estimate')).toBe(true);

    const page = await repo.listByTenant(TENANT, { limit: 1, offset: 1 });
    expect(page.dispatches).toHaveLength(1);
    expect(page.total).toBe(3);
  });
});

// ── PgDispatchRepository (mocked pool) ───────────────────────────────
type CapturedCall = { sql: string; params: unknown[] };

function makeMockPool(responder: (sql: string, params: unknown[]) => Record<string, unknown>[]) {
  const calls: CapturedCall[] = [];
  const client: Partial<PoolClient> = {
    query: vi.fn(async (sql: string, params?: unknown[]) => {
      calls.push({ sql, params: params ?? [] });
      const rows = responder(sql, params ?? []);
      return { rows, rowCount: rows.length } as unknown as QueryResult;
    }) as unknown as PoolClient['query'],
    release: vi.fn() as unknown as PoolClient['release'],
  };
  const pool: Partial<Pool> = {
    connect: vi.fn(async () => client as PoolClient) as unknown as Pool['connect'],
  };
  return { pool: pool as Pool, calls };
}

const isContext = (sql: string) => sql.includes('app.current_tenant_id');

function dispatchRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'd-1',
    tenant_id: TENANT,
    entity_type: 'estimate',
    entity_id: 'e-1',
    channel: 'sms',
    recipient: '+15550001111',
    provider: 'twilio',
    provider_message_id: null,
    status: 'sent',
    error_message: null,
    idempotency_key: null,
    sent_at: new Date('2026-05-01T00:00:00Z').toISOString(),
    delivered_at: null,
    ...overrides,
  };
}

describe('PgDispatchRepository (mocked pool)', () => {
  it('create sets tenant context, parameterizes tenantId, and binds null providerMessageId', async () => {
    const { pool, calls } = makeMockPool((sql) => (isContext(sql) ? [] : [dispatchRow()]));
    const result = await new PgDispatchRepository(pool).create({
      tenantId: TENANT,
      entityType: 'estimate',
      entityId: 'e-1',
      channel: 'sms',
      recipient: '+15550001111',
      provider: 'twilio',
    });
    expect(result.providerMessageId).toBeUndefined();
    // U2b-2: context is now set_config under a SET LOCAL transaction (calls[0] is BEGIN).
    expect(calls.some((c) => c.sql.includes('app.current_tenant_id'))).toBe(true);
    const insert = calls.find((c) => c.sql.includes('INSERT INTO message_dispatches'))!;
    expect(insert.sql).not.toContain(TENANT);
    expect(insert.params[1]).toBe(TENANT);
    expect(insert.params[7]).toBeNull(); // provider_message_id
    expect(insert.params[8]).toBe('sent'); // default status
  });

  it('updateStatus uses COALESCE for delivered_at + error_message and is tenant+id scoped', async () => {
    const { pool, calls } = makeMockPool((sql) =>
      isContext(sql) ? [] : [dispatchRow({ status: 'delivered' })]
    );
    await new PgDispatchRepository(pool).updateStatus(TENANT, 'd-1', 'delivered');
    const upd = calls.find((c) => c.sql.includes('UPDATE message_dispatches'))!;
    expect(upd.sql).toMatch(/delivered_at\s*=\s*COALESCE\(\$4,\s*delivered_at\)/);
    expect(upd.sql).toMatch(/error_message\s*=\s*COALESCE\(\$5,\s*error_message\)/);
    expect(upd.sql).toMatch(/WHERE\s+id\s*=\s*\$1\s+AND\s+tenant_id\s*=\s*\$2/);
    expect(upd.params).toEqual(['d-1', TENANT, 'delivered', null, null]);
  });

  it('updateStatus returns null when no row matches (cross-tenant / missing)', async () => {
    const { pool } = makeMockPool((sql) => (isContext(sql) ? [] : []));
    expect(await new PgDispatchRepository(pool).updateStatus(TENANT, 'missing', 'failed')).toBeNull();
  });

  it('listByTenant appends an entity_type predicate when filtering', async () => {
    const { pool, calls } = makeMockPool((sql) => {
      if (isContext(sql)) return [];
      if (sql.includes('COUNT(*)')) return [{ total: 1 }];
      return [dispatchRow()];
    });
    const result = await new PgDispatchRepository(pool).listByTenant(TENANT, { entityType: 'estimate' });
    expect(result.total).toBe(1);
    const dataQ = calls.find((c) => c.sql.includes('ORDER BY sent_at DESC'))!;
    expect(dataQ.sql).toContain('AND entity_type = $2');
    expect(dataQ.params.slice(0, 2)).toEqual([TENANT, 'estimate']);
  });
});
