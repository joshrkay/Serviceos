/**
 * The operator seed CLI's two raw statements sets run in tenant transactions
 * under the RLS runtime role (raw-pg audit 2026-10-23 §4 P2.9): the owner
 * `users` INSERT, and `cleanSeed`'s per-tenant child DELETEs, which keep the
 * tenants-registry DELETE in the same transaction as the connection
 * principal. No session-level GUC is set any more.
 *
 * The pool is a fake that records every statement with the checkout it ran
 * on, so ordering and transaction boundaries are visible. The real-Postgres
 * proof (roles, the widened predicates, the grants, the cost) is
 * test/integration/seed-runner-tenant-context.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanSeed, runSeed } from '../../src/seed/seed-runner';
import { fakeTenantPool, type FakeResponder } from '../helpers/fake-tenant-pool';

const T1 = '5b0c7a1e-2d3f-4a5b-8c6d-7e8f9a0b1c2d';
const T2 = '6c1d8b2f-3e4a-4b6c-9d7e-8f9a0b1c2d3e';
const CONTEXT = "SELECT set_config('app.current_tenant_id', $1, true), set_config('role', 'rls_app_runtime', true)";
const CHILD_TABLES = ['appointments', 'estimates', 'jobs', 'service_locations', 'customers', 'audit_events', 'users'];
const flat = (sql: string) => sql.replace(/\s+/g, ' ').trim();

const ORIGINAL_FLAG = process.env.RLS_RUNTIME_ROLE;
beforeEach(() => {
  process.env.RLS_RUNTIME_ROLE = 'true';
});
afterEach(() => {
  if (ORIGINAL_FLAG === undefined) delete process.env.RLS_RUNTIME_ROLE;
  else process.env.RLS_RUNTIME_ROLE = ORIGINAL_FLAG;
});

/** Answers the tenants-registry INSERT the way PgTenantRepository.create reads it back. */
const tenantCreated: FakeResponder = (sql, values) =>
  /^INSERT INTO tenants/.test(flat(sql))
    ? { rows: [{ id: T1, owner_id: values?.[0], owner_email: values?.[1], name: values?.[2], created_at: new Date() }] }
    : undefined;

describe('runSeed — the owner users INSERT', () => {
  it('runs in a tenant transaction of its own: BEGIN, the GUC + role, the INSERT, COMMIT on one checkout', async () => {
    const fake = fakeTenantPool(tenantCreated);

    const result = await runSeed(fake.pool, { tenantCount: 1, customersPerTenant: 0 });

    expect(result.tenantIds).toEqual([T1]);
    expect(fake.checkouts()).toBe(2);
    expect(fake.open()).toBe(0);
    const owner = fake.statements.filter((s) => s.checkout === 1);
    expect(owner.map((s) => flat(s.sql))).toEqual([
      'BEGIN',
      CONTEXT,
      expect.stringMatching(/^INSERT INTO users \(id, tenant_id, clerk_user_id, email, role, first_name, last_name\)/),
      'COMMIT',
    ]);
    expect(owner[1].values).toEqual([T1]);
    expect(owner[2].values?.[1]).toBe(T1);
  });

  it('sets no session-level GUC and leaves nothing to RESET', async () => {
    const fake = fakeTenantPool(tenantCreated);

    await runSeed(fake.pool, { tenantCount: 1, customersPerTenant: 0 });

    const sql = fake.statements.map((s) => flat(s.sql));
    expect(sql.filter((s) => /set_config\('app\.current_tenant_id', \$1, false\)/.test(s))).toEqual([]);
    expect(sql.filter((s) => /^RESET\b/.test(s))).toEqual([]);
  });

  it('a failed INSERT rolls its transaction back, releases the client and fails the seed', async () => {
    const fake = fakeTenantPool((sql, values) => {
      if (/^INSERT INTO users/.test(flat(sql))) throw Object.assign(new Error('new row violates row-level security policy'), { code: '42501' });
      return tenantCreated(sql, values);
    });

    await expect(runSeed(fake.pool, { tenantCount: 1, customersPerTenant: 0 })).rejects.toThrow(/row-level security/);

    expect(fake.statements.filter((s) => s.checkout === 1).map((s) => flat(s.sql))).toEqual([
      'BEGIN',
      CONTEXT,
      expect.stringMatching(/^INSERT INTO users/),
      'ROLLBACK',
    ]);
    expect(fake.open()).toBe(0);
  });
});

describe('cleanSeed — per seeded tenant, one tenant transaction', () => {
  const enumerated = (ids: string[]): FakeResponder => (sql) =>
    /^SELECT id FROM tenants WHERE owner_email LIKE \$1/.test(flat(sql)) ? { rows: ids.map((id) => ({ id })) } : undefined;

  const expectedTransaction = [
    'BEGIN',
    CONTEXT,
    ...CHILD_TABLES.map((t) => `DELETE FROM ${t} WHERE tenant_id = $1`),
    'SET LOCAL ROLE NONE',
    'DELETE FROM tenants WHERE id = $1',
    'COMMIT',
  ];

  it('deletes the child rows under the tenant GUC + role in FK order, then the registry row as the principal, all in one transaction', async () => {
    const fake = fakeTenantPool(enumerated([T1, T2]));
    const log: string[] = [];

    expect(await cleanSeed(fake.pool, (line) => log.push(line))).toEqual({ tenantsRemoved: 2 });

    expect(fake.checkouts()).toBe(3);
    expect(fake.open()).toBe(0);
    for (const [checkout, tenantId] of [[1, T1], [2, T2]] as const) {
      const tx = fake.statements.filter((s) => s.checkout === checkout);
      expect(tx.map((s) => flat(s.sql))).toEqual(expectedTransaction);
      expect(tx[1].values).toEqual([tenantId]);
      for (const s of tx.slice(2)) if (s.values) expect(s.values).toEqual([tenantId]);
    }
    expect(log).toEqual([`  removed tenant ${T1}`, `  removed tenant ${T2}`]);
  });

  it('sets no session-level GUC and leaves nothing to RESET', async () => {
    const fake = fakeTenantPool(enumerated([T1]));

    await cleanSeed(fake.pool);

    const sql = fake.statements.map((s) => flat(s.sql));
    expect(sql.filter((s) => /set_config\('app\.current_tenant_id', \$1, false\)/.test(s))).toEqual([]);
    expect(sql.filter((s) => /^RESET\b/.test(s))).toEqual([]);
  });

  it('a failed child DELETE rolls the whole tenant back (no registry DELETE), stops the clean and releases the client', async () => {
    const fake = fakeTenantPool((sql, values) => {
      if (/^DELETE FROM users/.test(flat(sql))) throw new Error('boom');
      return enumerated([T1, T2])(sql, values);
    });

    await expect(cleanSeed(fake.pool)).rejects.toThrow('boom');

    const tx = fake.statements.filter((s) => s.checkout === 1).map((s) => flat(s.sql));
    expect(tx.at(-1)).toBe('ROLLBACK');
    expect(tx).not.toContain('DELETE FROM tenants WHERE id = $1');
    expect(fake.checkouts()).toBe(2);
    expect(fake.open()).toBe(0);
  });

  it('with no seeded tenant, reads the registry once and touches nothing else', async () => {
    const fake = fakeTenantPool(enumerated([]));
    const log: string[] = [];

    expect(await cleanSeed(fake.pool, (line) => log.push(line))).toEqual({ tenantsRemoved: 0 });

    expect(fake.statements.map((s) => flat(s.sql))).toEqual(['SELECT id FROM tenants WHERE owner_email LIKE $1']);
    expect(log).toEqual(['No seeded tenants found.']);
  });
});
