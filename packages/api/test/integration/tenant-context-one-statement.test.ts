/**
 * Postgres integration — applyTenantContext's transactional path sets the
 * tenant GUC and the RLS runtime role in ONE statement:
 *
 *   SELECT set_config('app.current_tenant_id', $1, true),
 *          set_config('role', 'rls_app_runtime', true)
 *
 * instead of the set_config followed by `SET LOCAL ROLE rls_app_runtime`. Every
 * tenant session in the app (repositories, withTenantClient, the /api request
 * transaction, workers) pays one round trip less. Proven here against real
 * Postgres, because only a real server says what `set_config('role', …)` does:
 *
 * - inside the transaction the statements run as rls_app_runtime with the
 *   tenant's GUC, and the policies bound them (another tenant's row is
 *   invisible even with no tenant predicate);
 * - both settings reset at COMMIT and at ROLLBACK;
 * - SAVEPOINT / ROLLBACK TO SAVEPOINT / RELEASE treat the two settings exactly
 *   as they treated the two-statement form (each scenario is run both ways and
 *   the observations compared);
 * - with RLS_RUNTIME_ROLE off the path is unchanged: the GUC alone, no role.
 */
import crypto from 'crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { closeSharedTestDb, createTestTenant, getSharedTestDb, TENANT_CONTEXT_WITH_ROLE_SQL } from './shared';
import { applyTenantContext } from '../../src/db/rls-runtime-role';
import { withTenantConnection } from '../../src/db/tenant-transaction';
import { countPoolTraffic } from './tenant-predicate-probe';

const ORIGINAL_FLAG = process.env.RLS_RUNTIME_ROLE;
const ROLE = 'rls_app_runtime';

let pool: Pool;
let principal: string;
let tenantA: { tenantId: string; userId: string };
let tenantB: { tenantId: string; userId: string };
let customerA: string;
let customerB: string;

type Apply = (client: PoolClient, tenantId: string) => Promise<void>;

/** The current one-statement form. */
const oneStatement: Apply = (client, tenantId) => applyTenantContext(client, tenantId, { transactional: true });

/** The two-statement form this replaces, as the reference for "behaves the same as before". */
const twoStatements: Apply = async (client, tenantId) => {
  await client.query("SELECT set_config('app.current_tenant_id', $1, true)", [tenantId]);
  await client.query(`SET LOCAL ROLE ${ROLE}`);
};

interface Seen {
  user: string;
  tenant: string;
}

async function observe(client: PoolClient): Promise<Seen> {
  const { rows } = await client.query<Seen>(
    `SELECT current_user AS "user", COALESCE(current_setting('app.current_tenant_id', true), '') AS tenant`,
  );
  return rows[0]!;
}

/** Run `scenario` on a fresh connection and return what it observed. */
async function onFreshClient(scenario: (client: PoolClient) => Promise<Seen[]>): Promise<Seen[]> {
  const client = await pool.connect();
  try {
    return await scenario(client);
  } finally {
    await client.query('ROLLBACK').catch(() => undefined);
    client.release();
  }
}

async function seedCustomer(t: { tenantId: string; userId: string }): Promise<string> {
  const id = crypto.randomUUID();
  await pool.query(
    `INSERT INTO customers (id, tenant_id, first_name, last_name, display_name, created_by)
     VALUES ($1, $2, 'One', 'Statement', 'One Statement', $3)`,
    [id, t.tenantId, t.userId],
  );
  return id;
}

beforeAll(async () => {
  pool = await getSharedTestDb();
  principal = (await pool.query<{ u: string }>('SELECT session_user AS u')).rows[0]!.u;
  tenantA = await createTestTenant(pool);
  tenantB = await createTestTenant(pool);
  customerA = await seedCustomer(tenantA);
  customerB = await seedCustomer(tenantB);
});

afterEach(() => {
  if (ORIGINAL_FLAG === undefined) delete process.env.RLS_RUNTIME_ROLE;
  else process.env.RLS_RUNTIME_ROLE = ORIGINAL_FLAG;
});

afterAll(async () => {
  await pool.query('DELETE FROM customers WHERE id = ANY($1::uuid[])', [[customerA, customerB]]);
  await closeSharedTestDb();
});

describe('applyTenantContext, transactional, RLS_RUNTIME_ROLE=true: tenant and role in one statement (real Postgres)', () => {
  const flagOn = () => {
    process.env.RLS_RUNTIME_ROLE = 'true';
  };

  it('a tenant session costs BEGIN, the one context statement, the work and COMMIT', async () => {
    flagOn();
    const traffic = countPoolTraffic(pool);

    const seen = await withTenantConnection(traffic.pool, tenantA.tenantId, observe);

    expect(seen).toEqual({ user: ROLE, tenant: tenantA.tenantId });
    expect(traffic.statements().map((s) => s.replace(/\s+/g, ' ').trim())).toEqual([
      'BEGIN',
      TENANT_CONTEXT_WITH_ROLE_SQL,
      `SELECT current_user AS "user", COALESCE(current_setting('app.current_tenant_id', true), '') AS tenant`,
      'COMMIT',
    ]);
    expect(traffic.checkouts()).toBe(1);
  });

  it('inside the transaction: current_user is rls_app_runtime and the policies bound every read', async () => {
    flagOn();
    await onFreshClient(async (client) => {
      await client.query('BEGIN');
      await oneStatement(client, tenantA.tenantId);

      expect(await observe(client)).toEqual({ user: ROLE, tenant: tenantA.tenantId });
      // No tenant predicate: RLS alone scopes the read to tenant A.
      const all = await client.query<{ tenant_id: string }>('SELECT tenant_id FROM customers');
      expect(all.rows.length).toBeGreaterThan(0);
      expect(all.rows.every((r) => r.tenant_id === tenantA.tenantId)).toBe(true);
      // Tenant B's row is invisible even by its id; A's own row is not.
      expect((await client.query('SELECT 1 FROM customers WHERE id = $1', [customerB])).rowCount).toBe(0);
      expect((await client.query('SELECT 1 FROM customers WHERE id = $1', [customerA])).rowCount).toBe(1);
      return [];
    });
  });

  it('both settings reset at COMMIT and at ROLLBACK: the connection is the principal again and sees both tenants', async () => {
    flagOn();
    for (const end of ['COMMIT', 'ROLLBACK']) {
      const seen = await onFreshClient(async (client) => {
        await client.query('BEGIN');
        await oneStatement(client, tenantA.tenantId);
        const inside = await observe(client);
        await client.query(end);
        const after = await observe(client);
        const both = await client.query<{ n: number }>(
          'SELECT count(DISTINCT tenant_id)::int AS n FROM customers WHERE id = ANY($1::uuid[])',
          [[customerA, customerB]],
        );
        expect(both.rows[0]!.n).toBe(2);
        return [inside, after];
      });
      expect(seen, end).toEqual([
        { user: ROLE, tenant: tenantA.tenantId },
        { user: principal, tenant: '' },
      ]);
    }
  });

  // Each scenario returns its observations; it runs once with the one-statement
  // form and once with the two-statement form, and the two must agree.
  const scenarios: Record<string, (client: PoolClient, apply: Apply) => Promise<Seen[]>> = {
    'context, then a savepoint that switches tenant, rolled back to': async (client, apply) => {
      await client.query('BEGIN');
      await apply(client, tenantA.tenantId);
      await client.query('SAVEPOINT s1');
      await apply(client, tenantB.tenantId);
      const inner = await observe(client);
      await client.query('ROLLBACK TO SAVEPOINT s1');
      const restored = await observe(client);
      await client.query('COMMIT');
      return [inner, restored, await observe(client)];
    },
    'a savepoint, then context, rolled back to': async (client, apply) => {
      await client.query('BEGIN');
      await client.query('SAVEPOINT s1');
      await apply(client, tenantA.tenantId);
      const inner = await observe(client);
      await client.query('ROLLBACK TO SAVEPOINT s1');
      const restored = await observe(client);
      await client.query('COMMIT');
      return [inner, restored, await observe(client)];
    },
    'a savepoint, then context, released': async (client, apply) => {
      await client.query('BEGIN');
      await client.query('SAVEPOINT s1');
      await apply(client, tenantA.tenantId);
      await client.query('RELEASE SAVEPOINT s1');
      const kept = await observe(client);
      await client.query('ROLLBACK');
      return [kept, await observe(client)];
    },
    'context, then a failed statement in a savepoint, rolled back to (TransactionScope.savepoint)': async (client, apply) => {
      await client.query('BEGIN');
      await apply(client, tenantA.tenantId);
      await client.query('SAVEPOINT sp_1');
      await expect(client.query('SELECT 1 / 0')).rejects.toThrow();
      await client.query('ROLLBACK TO SAVEPOINT sp_1');
      await client.query('RELEASE SAVEPOINT sp_1');
      const restored = await observe(client);
      await client.query('COMMIT');
      return [restored, await observe(client)];
    },
  };

  it.each(Object.keys(scenarios))('SAVEPOINT: %s — the same as the two-statement form', async (name) => {
    flagOn();
    const now = await onFreshClient((client) => scenarios[name]!(client, oneStatement));
    const before = await onFreshClient((client) => scenarios[name]!(client, twoStatements));
    expect(now).toEqual(before);
    // And concretely: nothing ever ran as anything but the role or the principal.
    for (const s of now) expect([ROLE, principal]).toContain(s.user);
  });

  it('SAVEPOINT: the concrete answers (rolled-back settings return to their values at the savepoint)', async () => {
    flagOn();
    const a = tenantA.tenantId;
    const b = tenantB.tenantId;
    const off: Seen = { user: principal, tenant: '' };
    expect(await onFreshClient((c) => scenarios['context, then a savepoint that switches tenant, rolled back to']!(c, oneStatement))).toEqual([
      { user: ROLE, tenant: b },
      { user: ROLE, tenant: a },
      off,
    ]);
    expect(await onFreshClient((c) => scenarios['a savepoint, then context, rolled back to']!(c, oneStatement))).toEqual([
      { user: ROLE, tenant: a },
      off,
      off,
    ]);
    expect(await onFreshClient((c) => scenarios['a savepoint, then context, released']!(c, oneStatement))).toEqual([
      { user: ROLE, tenant: a },
      off,
    ]);
  });
});

describe('applyTenantContext, transactional, RLS_RUNTIME_ROLE off: unchanged (real Postgres)', () => {
  it('only the GUC: one statement, the connection principal stays current_user', async () => {
    delete process.env.RLS_RUNTIME_ROLE;
    const traffic = countPoolTraffic(pool);

    const seen = await withTenantConnection(traffic.pool, tenantA.tenantId, observe);

    expect(seen).toEqual({ user: principal, tenant: tenantA.tenantId });
    expect(traffic.statements()[1]).toBe("SELECT set_config('app.current_tenant_id', $1, true)");
    expect(traffic.statements()).toHaveLength(4);
  });
});
