/**
 * Unit tests for createAuthorizationLoader's MAPPING logic (mocked Pool).
 *
 * The real-schema proof (actual column names, cross-tenant null) lives in
 * test/integration/authorization-loader.test.ts per CLAUDE.md — these tests
 * pin the row→MembershipRecord mapping and the deliberate error-propagation
 * contract (a DB error must throw so resolveAuthorization fails CLOSED with
 * 503, never resolve null, which would read as a permanent no-membership 403).
 */
import { describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';
import { createAuthorizationLoader } from '../../src/auth/authorization-loader';

function poolReturning(rows: unknown[], rowCount = rows.length): Pool {
  return { query: vi.fn(async () => ({ rows, rowCount })) } as unknown as Pool;
}

describe('createAuthorizationLoader — mapping (unit)', () => {
  it('maps an active row: role passed through, null status defaults to active', async () => {
    const load = createAuthorizationLoader(
      poolReturning([{ role: 'dispatcher', status: null, deleted_at: null }]),
    );
    await expect(load('user_1', 'tenant_1')).resolves.toEqual({
      role: 'dispatcher',
      status: 'active',
      deleted: false,
    });
  });

  it('maps suspension and deletion flags', async () => {
    const suspended = createAuthorizationLoader(
      poolReturning([{ role: 'owner', status: 'suspended', deleted_at: null }]),
    );
    await expect(suspended('u', 't')).resolves.toEqual({
      role: 'owner',
      status: 'suspended',
      deleted: false,
    });

    const deleted = createAuthorizationLoader(
      poolReturning([{ role: 'owner', status: 'active', deleted_at: new Date('2026-07-01') }]),
    );
    await expect(deleted('u', 't')).resolves.toMatchObject({ deleted: true });
  });

  it('returns null for no membership row', async () => {
    const load = createAuthorizationLoader(poolReturning([], 0));
    await expect(load('user_none', 'tenant_1')).resolves.toBeNull();
  });

  it('queries by (tenant_id, clerk_user_id) in that parameter order', async () => {
    const pool = poolReturning([], 0);
    const load = createAuthorizationLoader(pool);
    await load('user_abc', 'tenant_xyz');
    const [sql, params] = vi.mocked(pool.query).mock.calls[0];
    expect(String(sql)).toMatch(/tenant_id = \$1 AND clerk_user_id = \$2/);
    expect(params).toEqual(['tenant_xyz', 'user_abc']);
  });

  it('propagates DB errors (never swallows into null) so the middleware fails closed', async () => {
    const pool = {
      query: vi.fn(async () => {
        throw new Error('connection refused');
      }),
    } as unknown as Pool;
    const load = createAuthorizationLoader(pool);
    await expect(load('u', 't')).rejects.toThrow('connection refused');
  });
});
