import { describe, it, expect, vi } from 'vitest';
import type { Pool, PoolClient, QueryResult } from 'pg';
import { withTenantSession } from '../../src/db/rls-runtime-role';

const TENANT = '11111111-1111-1111-1111-111111111111';

function mockClient(): { client: PoolClient; release: ReturnType<typeof vi.fn>; calls: string[] } {
  const calls: string[] = [];
  const release = vi.fn();
  const query = vi.fn(async (sql: string | { text: string }) => {
    const text = typeof sql === 'string' ? sql : sql.text;
    calls.push(text);
    return { rows: [], rowCount: 0 } as unknown as QueryResult;
  });
  return { client: { query, release } as unknown as PoolClient, release, calls };
}

/**
 * U2b — `withTenantSession` is the pooling-safe replacement for the plain-`SET`
 * + `clearTenantContext` pattern (analytics / digest builders). It must wrap the
 * work in a SET LOCAL transaction so the tenant context and queries share one
 * backend under PgBouncer transaction pooling.
 */
describe('withTenantSession', () => {
  it('wraps work in BEGIN → SET LOCAL → COMMIT and releases once', async () => {
    const m = mockClient();
    const pool = { connect: vi.fn(async () => m.client) } as unknown as Pool;

    const out = await withTenantSession(pool, TENANT, async () => 'ok');

    expect(out).toBe('ok');
    expect(m.calls[0]).toBe('BEGIN');
    expect(m.calls.some((c) => c.includes("set_config('app.current_tenant_id'"))).toBe(true);
    expect(m.calls).toContain('COMMIT');
    expect(m.calls).not.toContain('ROLLBACK');
    expect(m.release).toHaveBeenCalledTimes(1);
  });

  it('rolls back and rethrows when the callback throws', async () => {
    const m = mockClient();
    const pool = { connect: vi.fn(async () => m.client) } as unknown as Pool;

    await expect(
      withTenantSession(pool, TENANT, async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');

    expect(m.calls).toContain('BEGIN');
    expect(m.calls).toContain('ROLLBACK');
    expect(m.calls).not.toContain('COMMIT');
    expect(m.release).toHaveBeenCalledTimes(1);
  });
});
