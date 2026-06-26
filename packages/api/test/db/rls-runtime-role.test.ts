import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import {
  applyTenantContext,
  applyCrossTenantRole,
  clearTenantContext,
  isRlsRuntimeRoleEnabled,
  verifyRlsRuntimeRole,
} from '../../src/db/rls-runtime-role';

const TENANT = '11111111-2222-3333-4444-555555555555';

function fakeClient(): { client: PoolClient; calls: Array<{ sql: string; params?: unknown[] }> } {
  const calls: Array<{ sql: string; params?: unknown[] }> = [];
  const client = {
    query: vi.fn(async (sql: string, params?: unknown[]) => {
      calls.push({ sql, params });
      return { rows: [], rowCount: 0 };
    }),
  } as unknown as PoolClient;
  return { client, calls };
}

const ORIGINAL = process.env.RLS_RUNTIME_ROLE;
beforeEach(() => {
  delete process.env.RLS_RUNTIME_ROLE;
});
afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.RLS_RUNTIME_ROLE;
  else process.env.RLS_RUNTIME_ROLE = ORIGINAL;
  vi.restoreAllMocks();
});

describe('rls-runtime-role helper (U3)', () => {
  describe('isRlsRuntimeRoleEnabled', () => {
    it('is false unless RLS_RUNTIME_ROLE is exactly "true"', () => {
      expect(isRlsRuntimeRoleEnabled()).toBe(false);
      process.env.RLS_RUNTIME_ROLE = 'false';
      expect(isRlsRuntimeRoleEnabled()).toBe(false);
      process.env.RLS_RUNTIME_ROLE = '1';
      expect(isRlsRuntimeRoleEnabled()).toBe(false);
      process.env.RLS_RUNTIME_ROLE = 'true';
      expect(isRlsRuntimeRoleEnabled()).toBe(true);
    });
  });

  describe('applyTenantContext — flag OFF (default): only the GUC, no role', () => {
    it('session mode emits SET app.current_tenant_id and no SET ROLE', async () => {
      const { client, calls } = fakeClient();
      await applyTenantContext(client, TENANT);
      expect(calls).toHaveLength(1);
      expect(calls[0].sql).toContain(`SET app.current_tenant_id = '${TENANT}'`);
      expect(calls.some((c) => /SET ROLE/i.test(c.sql))).toBe(false);
    });

    it('transactional mode emits set_config and no SET LOCAL ROLE', async () => {
      const { client, calls } = fakeClient();
      await applyTenantContext(client, TENANT, { transactional: true });
      expect(calls).toHaveLength(1);
      expect(calls[0].sql).toContain('set_config');
      expect(calls[0].params).toEqual([TENANT]);
      expect(calls.some((c) => /SET (LOCAL )?ROLE/i.test(c.sql))).toBe(false);
    });
  });

  describe('applyTenantContext — flag ON: GUC + the runtime role', () => {
    beforeEach(() => {
      process.env.RLS_RUNTIME_ROLE = 'true';
    });

    it('session mode emits SET ROLE rls_app_runtime after the GUC', async () => {
      const { client, calls } = fakeClient();
      await applyTenantContext(client, TENANT);
      expect(calls).toHaveLength(2);
      expect(calls[0].sql).toContain('SET app.current_tenant_id');
      expect(calls[1].sql).toBe('SET ROLE rls_app_runtime');
    });

    it('transactional mode emits SET LOCAL ROLE rls_app_runtime', async () => {
      const { client, calls } = fakeClient();
      await applyTenantContext(client, TENANT, { transactional: true });
      expect(calls).toHaveLength(2);
      expect(calls[0].sql).toContain('set_config');
      expect(calls[1].sql).toBe('SET LOCAL ROLE rls_app_runtime');
    });
  });

  describe('applyTenantContext rejects a malformed tenant id (session path validates UUID)', () => {
    it('throws before issuing any query', async () => {
      const { client, calls } = fakeClient();
      await expect(applyTenantContext(client, 'not-a-uuid')).rejects.toThrow();
      expect(calls).toHaveLength(0);
    });
  });

  describe('clearTenantContext', () => {
    it('resets the role first, then the GUC', async () => {
      const { client, calls } = fakeClient();
      await clearTenantContext(client);
      expect(calls.map((c) => c.sql)).toEqual(['RESET ROLE', 'RESET app.current_tenant_id']);
    });

    it('is tolerant of a broken client (swallows query errors)', async () => {
      const client = {
        query: vi.fn(async () => {
          throw new Error('connection terminated');
        }),
      } as unknown as PoolClient;
      await expect(clearTenantContext(client)).resolves.toBeUndefined();
    });
  });

  describe('applyCrossTenantRole', () => {
    it('flag OFF: issues no SET ROLE (runs as the connection principal)', async () => {
      const { client, calls } = fakeClient();
      await applyCrossTenantRole(client);
      expect(calls).toHaveLength(0);
    });

    it('flag ON: SET ROLE rls_cross_tenant', async () => {
      process.env.RLS_RUNTIME_ROLE = 'true';
      const { client, calls } = fakeClient();
      await applyCrossTenantRole(client);
      expect(calls.map((c) => c.sql)).toEqual(['SET ROLE rls_cross_tenant']);
    });
  });

  describe('verifyRlsRuntimeRole', () => {
    it('is a no-op when the flag is off (never touches the pool)', async () => {
      const connect = vi.fn();
      await verifyRlsRuntimeRole({ connect } as unknown as Pool);
      expect(connect).not.toHaveBeenCalled();
    });

    it('resolves when the role is assumable', async () => {
      process.env.RLS_RUNTIME_ROLE = 'true';
      const release = vi.fn();
      const client = { query: vi.fn(async () => ({ rows: [] })), release } as unknown as PoolClient;
      const pool = { connect: vi.fn(async () => client) } as unknown as Pool;
      await expect(verifyRlsRuntimeRole(pool)).resolves.toBeUndefined();
      expect(release).toHaveBeenCalled();
    });

    it('throws a helpful error and releases the client when the role is not assumable', async () => {
      process.env.RLS_RUNTIME_ROLE = 'true';
      const release = vi.fn();
      const client = {
        query: vi.fn(async (sql: string) => {
          if (/SET ROLE/i.test(sql)) throw new Error('permission denied to set role "rls_app_runtime"');
          return { rows: [] };
        }),
        release,
      } as unknown as PoolClient;
      const pool = { connect: vi.fn(async () => client) } as unknown as Pool;
      await expect(verifyRlsRuntimeRole(pool)).rejects.toThrow(/not assumable/);
      expect(release).toHaveBeenCalled();
    });

    it('probes BOTH roles — throws naming rls_cross_tenant when only it is unassumable', async () => {
      process.env.RLS_RUNTIME_ROLE = 'true';
      const release = vi.fn();
      const client = {
        query: vi.fn(async (sql: string) => {
          if (/SET ROLE rls_cross_tenant/.test(sql)) {
            throw new Error('permission denied to set role "rls_cross_tenant"');
          }
          return { rows: [] }; // rls_app_runtime + RESET ROLE succeed
        }),
        release,
      } as unknown as PoolClient;
      const pool = { connect: vi.fn(async () => client) } as unknown as Pool;
      await expect(verifyRlsRuntimeRole(pool)).rejects.toThrow(/rls_cross_tenant.*not assumable/);
      expect(release).toHaveBeenCalled();
    });
  });
});
