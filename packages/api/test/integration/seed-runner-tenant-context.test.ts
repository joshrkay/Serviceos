/**
 * Postgres integration — the operator seed CLI's raw tenant SQL runs under
 * the RLS runtime role (raw-pg audit 2026-10-23 §4 P2.9).
 *
 * `runSeed` inserted each seeded tenant's owner `users` row, and `cleanSeed`
 * deleted each seeded tenant's child rows, on a raw client that had only a
 * SESSION-level `set_config('app.current_tenant_id', …, false)` and no role:
 * the policies did not bind the privileged principal, so `WHERE tenant_id =
 * $1` (and, for the INSERT, the VALUES tenant) was the only boundary, and the
 * session GUC was unsafe under transaction pooling. With RLS_RUNTIME_ROLE on,
 * this suite proves:
 *
 *   1. the owner INSERT reports `rls_app_runtime` with the new tenant's GUC;
 *      re-stamped with another tenant it is refused by the policy's WITH
 *      CHECK (control: as the principal it lands in the other tenant);
 *   2. every cleanSeed child DELETE reports `rls_app_runtime` with the
 *      tenant's GUC, and the tenants-registry DELETE (no tenant_id, no RLS)
 *      runs as the connection principal in the same transaction;
 *   3. with the child DELETEs' tenant pin widened to the seeded tenant and
 *      another, RLS alone keeps the other tenant's rows (control: as the
 *      principal the same DELETEs remove them);
 *   4. the role holds what both need once migration 219's revocations are
 *      applied, and `tenants` is outside RLS;
 *   5. cleanSeed's atomicity is the same as before: a tenant's children and
 *      its registry row go in ONE transaction, so a registry DELETE that
 *      fails leaves every child row in place;
 *   6. the cost: the owner INSERT is one checkout of four statements, the
 *      clean one checkout of twelve per tenant, never two connections at once.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'crypto';
import type { Pool, PoolClient, QueryResult } from 'pg';
import { closeSharedTestDb, createTestTenant, getSharedTestDb, TENANT_CONTEXT_WITH_ROLE_SQL } from './shared';
import { probeStatementRoles } from './statement-role-probe';
import { countPoolTraffic, runtimeRoleGrantsMissingAfter219, widenTenantPredicates } from './tenant-predicate-probe';
import { cleanSeed, runSeed } from '../../src/seed/seed-runner';

const ORIGINAL_FLAG = process.env.RLS_RUNTIME_ROLE;
const OWNER_INSERT = /INSERT INTO users \(id, tenant_id, clerk_user_id/;
const CHILD_TABLES = ['appointments', 'estimates', 'jobs', 'service_locations', 'customers', 'audit_events', 'users'] as const;
const CHILD_DELETE = /^DELETE FROM (appointments|estimates|jobs|service_locations|customers|audit_events|users) WHERE tenant_id = \$1$/;
const ANY_DELETE = /^DELETE FROM /;
const flat = (sql: string) => sql.replace(/\s+/g, ' ').trim();

type QueryFn = (text: unknown, values?: unknown) => Promise<QueryResult>;

let pool: Pool;
let principal: string;
const otherTenants: string[] = [];

/** One seeded tenant with `customers` full customer → location → job → estimate → appointment chains. */
async function seedOne(p: Pool = pool, customers = 1): Promise<string> {
  const result = await runSeed(p, { tenantCount: 1, customersPerTenant: customers, startDate: new Date('2026-09-01T00:00:00Z') });
  return result.tenantIds[0];
}

/** A tenant the seed marker does not match, with a customer and an audit row of its own. */
async function otherTenant(): Promise<string> {
  const { tenantId } = await createTestTenant(pool);
  otherTenants.push(tenantId);
  await pool.query(`INSERT INTO customers (tenant_id, display_name, created_by) VALUES ($1, 'Other Customer', 'test')`, [tenantId]);
  await pool.query(
    `INSERT INTO audit_events (id, tenant_id, actor_id, actor_role, event_type, entity_type, entity_id, metadata, created_at)
     VALUES ($1, $2, 'test', 'system', 'seed_clean.test_marker', 'tenant', $3, '{}'::jsonb, now())`,
    [randomUUID(), tenantId, tenantId],
  );
  return tenantId;
}

/** Rows of `tenantId` in each child table cleanSeed deletes, plus its registry row. */
async function footprint(tenantId: string): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const table of CHILD_TABLES) {
    const { rows } = await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table} WHERE tenant_id = $1`, [tenantId]);
    out[table] = rows[0].n;
  }
  const { rows } = await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM tenants WHERE id = $1`, [tenantId]);
  out.tenants = rows[0].n;
  return out;
}

const GONE = Object.fromEntries([...CHILD_TABLES, 'tenants'].map((t) => [t, 0]));

/** Rewrites the owner INSERT's VALUES tenant ($2) to `other`; `asPrincipal` resets the role first. */
function restampOwnerInsert(real: Pool, other: string, opts: { asPrincipal?: boolean } = {}): { pool: Pool; rewritten: string[] } {
  const rewritten: string[] = [];
  const stamp = `(CASE WHEN $2::uuid IS NOT NULL THEN '${other}'::uuid END)`;
  const connect = async (): Promise<PoolClient> => {
    const client = await real.connect();
    const inner = client.query as unknown as QueryFn;
    (client as unknown as { query: QueryFn }).query = async (text, values) => {
      const sql = typeof text === 'string' ? text : null;
      if (sql === null || !OWNER_INSERT.test(sql)) return inner.call(client, text, values);
      const next = sql.replace(/VALUES \(\$1, \$2,/, `VALUES ($1, ${stamp},`);
      rewritten.push(next);
      if (opts.asPrincipal) await inner.call(client, 'RESET ROLE');
      return inner.call(client, next, values);
    };
    const innerRelease = client.release;
    client.release = (err?: Error | boolean) => {
      delete (client as unknown as { query?: QueryFn }).query;
      return innerRelease(err);
    };
    return client;
  };
  const query = async (text: unknown, values?: unknown): Promise<QueryResult> => {
    const client = await connect();
    try {
      return await (client.query as unknown as QueryFn)(text, values);
    } finally {
      client.release();
    }
  };
  const proxied = new Proxy(real, {
    get(target, prop) {
      if (prop === 'connect') return connect;
      if (prop === 'query') return query;
      const value = Reflect.get(target, prop, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return { pool: proxied, rewritten };
}

beforeAll(async () => {
  pool = await getSharedTestDb();
  principal = (await pool.query<{ u: string }>('SELECT current_user AS u')).rows[0].u;
});

beforeEach(async () => {
  process.env.RLS_RUNTIME_ROLE = 'true';
  // cleanSeed removes every seeded tenant in the database (earlier files' and
  // this file's earlier cases'); start each case from none so its counts are
  // its own.
  await pool.query(`DELETE FROM conversations WHERE created_by = 'seed-clean-test'`);
  await cleanSeed(pool);
});

afterEach(() => {
  if (ORIGINAL_FLAG === undefined) delete process.env.RLS_RUNTIME_ROLE;
  else process.env.RLS_RUNTIME_ROLE = ORIGINAL_FLAG;
});

afterAll(async () => {
  await pool.query(`DELETE FROM conversations WHERE created_by = 'seed-clean-test'`).catch(() => undefined);
  await cleanSeed(pool).catch(() => undefined);
  for (const id of otherTenants) {
    for (const table of ['customers', 'audit_events', 'users']) {
      await pool.query(`DELETE FROM ${table} WHERE tenant_id = $1`, [id]).catch(() => undefined);
    }
    await pool.query('DELETE FROM tenants WHERE id = $1', [id]).catch(() => undefined);
  }
  await closeSharedTestDb();
});

describe('runSeed — the owner users INSERT under the RLS runtime role (real Postgres)', () => {
  it("runs as rls_app_runtime with the new tenant's GUC, and the owner row lands", async () => {
    const probe = probeStatementRoles(pool, OWNER_INSERT);

    const tenantId = await seedOne(probe.pool);

    expect(probe.seen).toEqual([expect.objectContaining({ role: 'rls_app_runtime', tenantGuc: tenantId })]);
    const { rows } = await pool.query(`SELECT role, email FROM users WHERE tenant_id = $1`, [tenantId]);
    expect(rows).toEqual([{ role: 'owner', email: 'owner@seed-tenant-01.example.com' }]);
  });

  it("re-stamped with another tenant, the INSERT is refused by the policy's WITH CHECK: the seed fails and no owner row lands", async () => {
    const other = await otherTenant();
    const restamped = restampOwnerInsert(pool, other);

    await expect(seedOne(restamped.pool, 0)).rejects.toThrow(/row-level security/);

    expect(restamped.rewritten).toHaveLength(1);
    const { rows } = await pool.query(`SELECT 1 FROM users WHERE tenant_id = $1 AND clerk_user_id LIKE 'seed-owner-%'`, [other]);
    expect(rows).toHaveLength(0);
  });

  it('control: the same re-stamped INSERT as the connection principal lands in the other tenant', async () => {
    const other = await otherTenant();
    const restamped = restampOwnerInsert(pool, other, { asPrincipal: true });

    await seedOne(restamped.pool, 0);

    const { rows } = await pool.query(`SELECT role FROM users WHERE tenant_id = $1 AND clerk_user_id LIKE 'seed-owner-%'`, [other]);
    expect(rows).toEqual([{ role: 'owner' }]);
  });
});

describe('cleanSeed — the child DELETEs under the RLS runtime role, the registry row as the principal (real Postgres)', () => {
  it("every child DELETE runs as rls_app_runtime with the tenant's GUC; the tenants DELETE runs as the connection principal", async () => {
    const tenantId = await seedOne();
    const probe = probeStatementRoles(pool, ANY_DELETE);

    expect(await cleanSeed(probe.pool)).toEqual({ tenantsRemoved: 1 });

    expect(probe.seen.map((s) => [flat(s.sql), s.role, s.tenantGuc])).toEqual([
      ...CHILD_TABLES.map((t) => [`DELETE FROM ${t} WHERE tenant_id = $1`, 'rls_app_runtime', tenantId]),
      ['DELETE FROM tenants WHERE id = $1', principal, tenantId],
    ]);
    expect(await footprint(tenantId)).toEqual(GONE);
  });

  it("with the child DELETEs' tenant pin widened to the seeded tenant and another, RLS alone keeps the other tenant's rows", async () => {
    const tenantId = await seedOne();
    const other = await otherTenant();
    const before = await footprint(other);
    const widened = widenTenantPredicates(pool, { target: CHILD_DELETE, tenants: [tenantId, other] });

    await cleanSeed(widened.pool);

    expect(widened.rewritten).toHaveLength(CHILD_TABLES.length);
    expect(await footprint(tenantId)).toEqual(GONE);
    expect(await footprint(other)).toEqual(before);
    expect(before).toMatchObject({ customers: 1, audit_events: 1, users: 1, tenants: 1 });
  });

  it("control: the same widened DELETEs as the connection principal remove the other tenant's rows", async () => {
    const tenantId = await seedOne();
    const other = await otherTenant();
    const widened = widenTenantPredicates(pool, { target: CHILD_DELETE, tenants: [tenantId, other], asPrincipal: true });

    await cleanSeed(widened.pool);

    expect(await footprint(other)).toMatchObject({ customers: 0, audit_events: 0, users: 0, tenants: 1 });
  });

  it('atomic as before: when the registry row cannot go, every child row of the tenant stays; once it can, one clean removes it all', async () => {
    const tenantId = await seedOne(pool, 2);
    const before = await footprint(tenantId);
    expect(before).toMatchObject({ customers: 2, jobs: 2, estimates: 2, appointments: 2, service_locations: 2, users: 1, tenants: 1 });
    // A row cleanSeed does not delete still references the tenant (FK, no cascade).
    await pool.query(`INSERT INTO conversations (id, tenant_id, created_by) VALUES ($1, $2, 'seed-clean-test')`, [randomUUID(), tenantId]);

    await expect(cleanSeed(pool)).rejects.toMatchObject({ code: '23503' });
    expect(await footprint(tenantId)).toEqual(before);

    await pool.query(`DELETE FROM conversations WHERE tenant_id = $1`, [tenantId]);
    expect(await cleanSeed(pool)).toEqual({ tenantsRemoved: 1 });
    expect(await footprint(tenantId)).toEqual(GONE);
  });
});

describe('grants: rls_app_runtime keeps what the seed CLI needs after migration 219', () => {
  it('users stays insertable and every child table deletable; tenants is outside RLS', async () => {
    expect(
      await runtimeRoleGrantsMissingAfter219(pool, [['users', 'INSERT'], ...CHILD_TABLES.map((t) => [t, 'DELETE'] as const)]),
    ).toEqual([]);
    const { rows } = await pool.query(`SELECT relrowsecurity FROM pg_class WHERE oid = 'public.tenants'::regclass`);
    expect(rows).toEqual([{ relrowsecurity: false }]);
  });
});

describe('seed CLI — cost (real Postgres, RLS_RUNTIME_ROLE=true)', () => {
  it('the owner INSERT is one checkout of four statements (BEGIN, the context, the INSERT, COMMIT), and the seed never holds two connections (base: one checkout of three, a session GUC, the INSERT, its RESET)', async () => {
    const traffic = countPoolTraffic(pool);

    await seedOne(traffic.pool, 0);

    expect({ checkouts: traffic.checkouts(), maxOpen: traffic.maxOpen(), open: traffic.open() }).toEqual({ checkouts: 2, maxOpen: 1, open: 0 });
    expect(traffic.statements().map(flat)).toEqual([
      expect.stringMatching(/^INSERT INTO tenants/),
      'BEGIN',
      TENANT_CONTEXT_WITH_ROLE_SQL,
      expect.stringMatching(OWNER_INSERT),
      'COMMIT',
    ]);
  });

  it('the clean is the registry read plus one checkout of twelve statements per tenant, never two connections at once (base: the same twelve, a session GUC set before BEGIN and RESET after COMMIT in place of the context and the role switch)', async () => {
    await seedOne();
    const traffic = countPoolTraffic(pool);

    await cleanSeed(traffic.pool);

    expect({ checkouts: traffic.checkouts(), maxOpen: traffic.maxOpen(), open: traffic.open() }).toEqual({ checkouts: 2, maxOpen: 1, open: 0 });
    expect(traffic.statements().map(flat)).toEqual([
      'SELECT id FROM tenants WHERE owner_email LIKE $1',
      'BEGIN',
      TENANT_CONTEXT_WITH_ROLE_SQL,
      ...CHILD_TABLES.map((t) => `DELETE FROM ${t} WHERE tenant_id = $1`),
      'SET LOCAL ROLE NONE',
      'DELETE FROM tenants WHERE id = $1',
      'COMMIT',
    ]);
  });
});
