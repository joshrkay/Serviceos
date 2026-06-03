/**
 * DB-level Row-Level-Security enforcement.
 *
 * Every other test that touches tenant isolation does so at the application
 * layer (repositories with `WHERE tenant_id = $1`, mocked ownership guards).
 * Nothing proves that the Postgres RLS policies in schema.ts — the backstop
 * that's supposed to catch a missing/buggy WHERE clause — actually isolate
 * tenants. This file does.
 *
 * Why a dedicated role: the testcontainer's default user is a SUPERUSER, and
 * superusers bypass RLS unconditionally (FORCE or not). So isolation can only
 * be observed by connecting as an unprivileged role — which is also how a
 * correct production runtime should connect. We create `rls_app_runtime`
 * (NOBYPASSRLS) and run every assertion through it.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool, PoolClient } from 'pg';
import { getSharedTestDb, createTestTenant, closeSharedTestDb } from './shared';

const APP_ROLE = 'rls_app_runtime';

/**
 * Run `fn` on a connection that behaves like the production app: an
 * unprivileged role with `app.current_tenant_id` set for the duration of a
 * transaction (mirrors src/db/tenant-transaction.ts). Always rolls back so
 * the test is side-effect free.
 */
async function asTenant<T>(
  pool: Pool,
  tenantId: string | null,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SET LOCAL ROLE ${APP_ROLE}`);
    if (tenantId !== null) {
      await client.query("SELECT set_config('app.current_tenant_id', $1, true)", [tenantId]);
    }
    return await fn(client);
  } finally {
    await client.query('ROLLBACK').catch(() => undefined);
    client.release();
  }
}

async function seedCustomer(pool: Pool, tenantId: string, createdBy: string, name: string): Promise<string> {
  const id = crypto.randomUUID();
  await pool.query(
    `INSERT INTO customers (id, tenant_id, first_name, last_name, display_name, created_by)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [id, tenantId, name, 'Test', name + ' Test', createdBy],
  );
  return id;
}

describe('RLS tenant isolation (DB-level enforcement)', () => {
  let pool: Pool;
  let tenantA: { tenantId: string; userId: string };
  let tenantB: { tenantId: string; userId: string };
  let customerA: string;
  let customerB: string;

  beforeAll(async () => {
    pool = await getSharedTestDb();

    // Unprivileged role that models the production app runtime. Idempotent so
    // re-runs against the shared container don't fail on the existing role.
    await pool.query(`DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${APP_ROLE}') THEN
        CREATE ROLE ${APP_ROLE} NOLOGIN NOBYPASSRLS;
      END IF;
    END $$;`);
    await pool.query(`GRANT USAGE ON SCHEMA public TO ${APP_ROLE}`);
    await pool.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${APP_ROLE}`);

    // Seed two tenants and a customer for each (inserted as superuser, which
    // bypasses RLS — exactly what we want for fixture setup).
    tenantA = await createTestTenant(pool);
    tenantB = await createTestTenant(pool);
    customerA = await seedCustomer(pool, tenantA.tenantId, tenantA.userId, 'Alice');
    customerB = await seedCustomer(pool, tenantB.tenantId, tenantB.userId, 'Bob');
  });

  afterAll(async () => {
    await closeSharedTestDb();
  });

  describe('read isolation', () => {
    it('a tenant sees only its own customers', async () => {
      const rows = await asTenant(pool, tenantA.tenantId, async (c) => {
        const r = await c.query<{ id: string }>('SELECT id FROM customers');
        return r.rows.map((row) => row.id);
      });
      expect(rows).toContain(customerA);
      expect(rows).not.toContain(customerB);
    });

    it('switching tenant context flips visibility — no bleed', async () => {
      const rows = await asTenant(pool, tenantB.tenantId, async (c) => {
        const r = await c.query<{ id: string }>('SELECT id FROM customers');
        return r.rows.map((row) => row.id);
      });
      expect(rows).toContain(customerB);
      expect(rows).not.toContain(customerA);
    });

    it('an unknown tenant context sees nothing (cannot enumerate other tenants)', async () => {
      const strangerTenant = crypto.randomUUID();
      const count = await asTenant(pool, strangerTenant, async (c) => {
        const r = await c.query<{ id: string }>('SELECT id FROM customers');
        return r.rows.length;
      });
      expect(count).toBe(0);
    });

    it('isolation also holds on a second tenant-scoped table (users)', async () => {
      const rows = await asTenant(pool, tenantA.tenantId, async (c) => {
        const r = await c.query<{ tenant_id: string }>('SELECT tenant_id FROM users');
        return r.rows.map((row) => row.tenant_id);
      });
      expect(rows.every((t) => t === tenantA.tenantId)).toBe(true);
      expect(rows).not.toContain(tenantB.tenantId);
    });
  });

  describe('write isolation', () => {
    it('cannot read a row by id when scoped to a different tenant', async () => {
      const found = await asTenant(pool, tenantA.tenantId, async (c) => {
        const r = await c.query('SELECT id FROM customers WHERE id = $1', [customerB]);
        return r.rows.length;
      });
      expect(found).toBe(0);
    });

    it('cannot UPDATE a row belonging to another tenant', async () => {
      const updated = await asTenant(pool, tenantA.tenantId, async (c) => {
        const r = await c.query(
          "UPDATE customers SET first_name = 'Hacked' WHERE id = $1",
          [customerB],
        );
        return r.rowCount;
      });
      // RLS makes the other tenant's row invisible to UPDATE → zero rows match.
      expect(updated).toBe(0);

      // Confirm tenant B's row is untouched (read back as superuser).
      const check = await pool.query<{ first_name: string }>(
        'SELECT first_name FROM customers WHERE id = $1',
        [customerB],
      );
      expect(check.rows[0].first_name).toBe('Bob');
    });

    it('cannot INSERT a row attributed to another tenant (WITH CHECK)', async () => {
      await expect(
        asTenant(pool, tenantA.tenantId, async (c) => {
          await c.query(
            `INSERT INTO customers (id, tenant_id, display_name, created_by)
             VALUES ($1, $2, $3, $4)`,
            [crypto.randomUUID(), tenantB.tenantId, 'Forged', tenantA.userId],
          );
        }),
      ).rejects.toThrow(/row-level security/i);
    });
  });

  describe('schema invariant', () => {
    // Tables that carry a tenant_id but are deliberately NOT under tenant RLS.
    // Each must stay justified — anything else with a tenant_id is a leak risk.
    //   platform_deprovision_log: cross-tenant ops audit; written after the
    //     tenant row is purged and must stay readable by platform admins.
    //   oauth_states: short-lived (5 min) OAuth handshake rows looked up only
    //     by their unguessable PK, which is the handshake secret.
    const RLS_EXEMPT = new Set(['platform_deprovision_log', 'oauth_states']);

    it('every tenant-scoped table has RLS enabled (except documented exemptions)', async () => {
      const { rows } = await pool.query<{ tablename: string }>(`
        SELECT c.relname AS tablename
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public'
          AND c.relkind = 'r'
          AND EXISTS (
            SELECT 1 FROM pg_attribute a
            WHERE a.attrelid = c.oid AND a.attname = 'tenant_id' AND NOT a.attisdropped
          )
          AND c.relrowsecurity = false
        ORDER BY c.relname
      `);
      const unprotected = rows.map((r) => r.tablename).filter((t) => !RLS_EXEMPT.has(t));
      expect(unprotected).toEqual([]);
    });
  });
});
