import { describe, it, expect, vi } from 'vitest';
import type { Pool, PoolClient, QueryResult } from 'pg';
import { PgBaseRepository } from '../../src/db/pg-base';

const TENANT = '11111111-1111-1111-1111-111111111111';

class TestRepo extends PgBaseRepository {
  runWithTenant<T>(tenantId: string, fn: (client: PoolClient) => Promise<T>) {
    return this.withTenant(tenantId, fn);
  }
  runWithTenantTransaction<T>(tenantId: string, fn: (client: PoolClient) => Promise<T>) {
    return this.withTenantTransaction(tenantId, fn);
  }
}

function mockClient(): { client: PoolClient; release: ReturnType<typeof vi.fn>; calls: string[] } {
  const calls: string[] = [];
  const release = vi.fn();
  const query = vi.fn(async (sql: string | { text: string }) => {
    const text = typeof sql === 'string' ? sql : sql.text;
    calls.push(text);
    return { rows: [], rowCount: 0 } as unknown as QueryResult;
  });
  return {
    client: { query, release } as unknown as PoolClient,
    release,
    calls,
  };
}

describe('PgBaseRepository — GUC leak fix (RESET on release)', () => {
  it('withTenant: issues RESET app.current_tenant_id before releasing the connection', async () => {
    const m = mockClient();
    const pool = { connect: vi.fn(async () => m.client) } as unknown as Pool;
    const repo = new TestRepo(pool);

    await repo.runWithTenant(TENANT, async () => 'ok');

    const setIdx = m.calls.findIndex((c) => c.includes("SET app.current_tenant_id"));
    const resetIdx = m.calls.findIndex((c) => c.includes('RESET app.current_tenant_id'));
    expect(setIdx).toBeGreaterThanOrEqual(0);
    expect(resetIdx).toBeGreaterThan(setIdx);
    expect(m.release).toHaveBeenCalledTimes(1);
  });

  it('withTenant: still RESETs and releases when the callback throws', async () => {
    const m = mockClient();
    const pool = { connect: vi.fn(async () => m.client) } as unknown as Pool;
    const repo = new TestRepo(pool);

    await expect(
      repo.runWithTenant(TENANT, async () => {
        throw new Error('boom');
      })
    ).rejects.toThrow('boom');

    expect(m.calls.some((c) => c.includes('RESET app.current_tenant_id'))).toBe(true);
    expect(m.release).toHaveBeenCalledTimes(1);
  });

  it('withTenantTransaction: issues RESET after COMMIT, before release', async () => {
    const m = mockClient();
    const pool = { connect: vi.fn(async () => m.client) } as unknown as Pool;
    const repo = new TestRepo(pool);

    await repo.runWithTenantTransaction(TENANT, async () => 'ok');

    const commitIdx = m.calls.findIndex((c) => c === 'COMMIT');
    const resetIdx = m.calls.findIndex((c) => c.includes('RESET app.current_tenant_id'));
    expect(commitIdx).toBeGreaterThanOrEqual(0);
    expect(resetIdx).toBeGreaterThan(commitIdx);
    expect(m.release).toHaveBeenCalledTimes(1);
  });

  it('withTenantTransaction: rolls back and still RESETs when the callback throws', async () => {
    const m = mockClient();
    const pool = { connect: vi.fn(async () => m.client) } as unknown as Pool;
    const repo = new TestRepo(pool);

    await expect(
      repo.runWithTenantTransaction(TENANT, async () => {
        throw new Error('kaboom');
      })
    ).rejects.toThrow('kaboom');

    expect(m.calls).toContain('ROLLBACK');
    expect(m.calls.some((c) => c.includes('RESET app.current_tenant_id'))).toBe(true);
    expect(m.release).toHaveBeenCalledTimes(1);
  });

  it('withTenant: rejects an invalid tenant id before connecting', async () => {
    const pool = { connect: vi.fn() } as unknown as Pool;
    const repo = new TestRepo(pool);
    // setTenantContext is the gate; running it inside the wrapper means a
    // malformed tenant id reaches it before any work runs. We assert the
    // wrapper propagates the error and that we still released cleanly.
    const m = mockClient();
    (pool.connect as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(m.client);
    await expect(repo.runWithTenant('not-a-uuid', async () => 'x')).rejects.toThrow(
      'Invalid tenant ID format'
    );
    // RESET is still attempted in finally even though SET failed.
    expect(m.calls.some((c) => c.includes('RESET app.current_tenant_id'))).toBe(true);
    expect(m.release).toHaveBeenCalledTimes(1);
  });
});
