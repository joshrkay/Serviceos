import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { PoolClient } from 'pg';
import {
  isSupervisorPresent,
  pgSupervisorPresenceLoader,
  setSupervisorPresenceLoader,
  _resetSupervisorPresenceCache,
  SUPERVISOR_PRESENCE_TTL_MS,
} from '../../src/ai/supervisor-presence';
import { tenantContextStore } from '../../src/middleware/tenant-context';
import { fakeTenantPool } from '../helpers/fake-tenant-pool';

describe('P12-004 — isSupervisorPresent', () => {
  beforeEach(() => {
    _resetSupervisorPresenceCache();
    setSupervisorPresenceLoader(null);
  });

  it('returns true (permissive) when no loader is wired', async () => {
    const result = await isSupervisorPresent('tenant-A');
    expect(result).toBe(true);
  });

  it('delegates to the wired loader and returns its boolean', async () => {
    const loader = vi.fn(async (tenantId: string) => tenantId === 'present');
    setSupervisorPresenceLoader(loader);

    expect(await isSupervisorPresent('present')).toBe(true);
    expect(await isSupervisorPresent('absent')).toBe(false);
    expect(loader).toHaveBeenCalledTimes(2);
  });

  it('caches results per tenant for the configured TTL', async () => {
    const loader = vi.fn(async () => true);
    setSupervisorPresenceLoader(loader);

    // First call: hits the loader.
    await isSupervisorPresent('tenant-A', 1_000);
    expect(loader).toHaveBeenCalledTimes(1);

    // Second call within TTL: cache hit.
    await isSupervisorPresent('tenant-A', 1_000 + 5_000);
    expect(loader).toHaveBeenCalledTimes(1);

    // Different tenant within TTL: separate cache entry, hits loader.
    await isSupervisorPresent('tenant-B', 1_000 + 5_000);
    expect(loader).toHaveBeenCalledTimes(2);
  });

  it('refetches after the TTL window elapses', async () => {
    let supervisorPresent = true;
    const loader = vi.fn(async () => supervisorPresent);
    setSupervisorPresenceLoader(loader);

    await isSupervisorPresent('tenant-A', 1_000);
    expect(loader).toHaveBeenCalledTimes(1);

    // Flip the underlying state; cache still holds the old answer.
    supervisorPresent = false;
    await isSupervisorPresent('tenant-A', 1_000 + 1_000);
    expect(loader).toHaveBeenCalledTimes(1); // cache hit; still true

    // Advance past TTL — loader runs again, picks up the new state.
    const result = await isSupervisorPresent(
      'tenant-A',
      1_000 + SUPERVISOR_PRESENCE_TTL_MS + 1,
    );
    expect(loader).toHaveBeenCalledTimes(2);
    expect(result).toBe(false);
  });

  it('falls back to permissive (true) when the loader throws', async () => {
    const loader = vi.fn(async () => {
      throw new Error('db down');
    });
    setSupervisorPresenceLoader(loader);

    const result = await isSupervisorPresent('tenant-A');
    expect(result).toBe(true);
    expect(loader).toHaveBeenCalledTimes(1);
  });
});

describe('pgSupervisorPresenceLoader — tenant context (raw-pg audit §4 P1.4)', () => {
  const TENANT = '00000000-0000-4000-8000-0000000005e1';

  it('reads users in a tenant transaction on one checkout: BEGIN, the tenant GUC, the EXISTS, COMMIT', async () => {
    const fake = fakeTenantPool((sql) => (sql.includes('FROM users') ? { rows: [{ present: true }] } : undefined));

    expect(await pgSupervisorPresenceLoader(fake.pool)(TENANT)).toBe(true);

    expect(fake.checkouts()).toBe(1);
    expect(fake.open()).toBe(0);
    expect(fake.statements.map((s) => s.sql.trim().split(/\s+/)[0])).toEqual(['BEGIN', 'SELECT', 'SELECT', 'COMMIT']);
    expect(fake.statements[1]).toMatchObject({
      sql: expect.stringContaining("set_config('app.current_tenant_id'"),
      values: [TENANT],
    });
    expect(fake.work()).toEqual([
      expect.objectContaining({ sql: expect.stringContaining('WHERE tenant_id = $1'), values: [TENANT] }),
    ]);
  });

  it('answers false when the EXISTS finds no supervisor', async () => {
    const fake = fakeTenantPool((sql) => (sql.includes('FROM users') ? { rows: [{ present: false }] } : undefined));
    expect(await pgSupervisorPresenceLoader(fake.pool)(TENANT)).toBe(false);
  });

  it("inside a request scoped to the same tenant, reads on the request's client and takes no checkout", async () => {
    const fake = fakeTenantPool();
    const requestQuery = vi.fn(async () => ({ rows: [{ present: true }] }));
    const client = { query: requestQuery } as unknown as PoolClient;

    const present = await tenantContextStore.run({ client, tenantId: TENANT }, () =>
      pgSupervisorPresenceLoader(fake.pool)(TENANT),
    );

    expect(present).toBe(true);
    expect(fake.checkouts()).toBe(0);
    expect(requestQuery).toHaveBeenCalledOnce();
  });
});
