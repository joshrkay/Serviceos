/**
 * Postgres integration — the call-establishment and escalation lookups run
 * under the RLS runtime role (raw-pg audit 2026-10-23 §4 P1.4).
 *
 * `identifyCaller` (customers, every inbound call) and
 * `pgSupervisorPresenceLoader` (users, the emergency / auto-approve
 * presence check) ran `WHERE tenant_id = $1` straight on the pool, as the
 * privileged principal, so the WHERE clause was the only tenant boundary.
 * For each, with RLS_RUNTIME_ROLE on, this suite proves:
 *
 *   1. it still answers for its own tenant against the real columns, and
 *      every statement it runs reports `rls_app_runtime` with the calling
 *      tenant's GUC (statement-role-probe);
 *   2. with the WHERE clause's tenant pin widened to both seeded tenants, RLS
 *      alone keeps the other tenant out (the answer does not change);
 *   3. control: the same widened statement run as the connection principal
 *      DOES reach the other tenant — so (2) is a test that can fail;
 *   4. the role holds the grants it needs once migration 219's revocations
 *      are applied (the suite's setup re-grants everything).
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { closeSharedTestDb, createTestTenant, getSharedTestDb } from './shared';
import { probeStatementRoles } from './statement-role-probe';
import { runtimeRoleGrantsMissingAfter219, widenTenantPredicates } from './tenant-predicate-probe';
import { identifyCaller } from '../../src/ai/skills/identify-caller';
import { pgSupervisorPresenceLoader } from '../../src/ai/supervisor-presence';

const ORIGINAL_FLAG = process.env.RLS_RUNTIME_ROLE;

let pool: Pool;
const tenantIds: string[] = [];

interface Seeded {
  tenantId: string;
  ownerUserId: string;
}

async function seedTenant(mode: 'supervisor' | 'tech'): Promise<Seeded> {
  const { tenantId, userId } = await createTestTenant(pool);
  tenantIds.push(tenantId);
  await pool.query(`UPDATE users SET current_mode = $2 WHERE id = $1`, [userId, mode]);
  return { tenantId, ownerUserId: userId };
}

async function insertCustomer(t: Seeded, phone: string): Promise<string> {
  const id = crypto.randomUUID();
  await pool.query(
    `INSERT INTO customers (id, tenant_id, first_name, last_name, display_name, primary_phone, created_by)
     VALUES ($1, $2, 'Same', 'Phone', 'Same Phone', $3, $4)`,
    [id, t.tenantId, phone, t.ownerUserId],
  );
  return id;
}

/** A NANP number unlikely to collide with another suite's customers. */
function randomPhone(): string {
  return `+1512555${String(Math.floor(Math.random() * 10_000)).padStart(4, '0')}`;
}

beforeAll(async () => {
  pool = await getSharedTestDb();
});

beforeEach(() => {
  process.env.RLS_RUNTIME_ROLE = 'true';
});

afterEach(() => {
  if (ORIGINAL_FLAG === undefined) delete process.env.RLS_RUNTIME_ROLE;
  else process.env.RLS_RUNTIME_ROLE = ORIGINAL_FLAG;
});

afterAll(async () => {
  for (const id of tenantIds) {
    await pool.query('DELETE FROM customers WHERE tenant_id = $1', [id]).catch(() => undefined);
    await pool.query('DELETE FROM users WHERE tenant_id = $1', [id]).catch(() => undefined);
    await pool.query('DELETE FROM tenants WHERE id = $1', [id]).catch(() => undefined);
  }
  await closeSharedTestDb();
});

describe('identifyCaller — customers lookup under the RLS runtime role (real Postgres)', () => {
  let a: Seeded;
  let b: Seeded;
  let phone: string;
  let aCustomer: string;
  let bCustomer: string;

  beforeAll(async () => {
    a = await seedTenant('supervisor');
    b = await seedTenant('supervisor');
    phone = randomPhone();
    aCustomer = await insertCustomer(a, phone);
    bCustomer = await insertCustomer(b, phone);
  });

  it("matches the calling tenant's customer, the lookup running as rls_app_runtime for that tenant", async () => {
    const probe = probeStatementRoles(pool, /FROM customers/);

    const result = await identifyCaller({ tenantId: a.tenantId, fromPhone: phone, pool: probe.pool });

    expect(result).toMatchObject({ status: 'matched', customerId: aCustomer });
    expect(probe.seen).toHaveLength(1);
    expect(probe.seen[0]).toMatchObject({ role: 'rls_app_runtime', tenantGuc: a.tenantId });
  });

  it("with the tenant pin widened to both tenants, RLS still hides the other tenant's same-number customer", async () => {
    const widened = widenTenantPredicates(pool, { target: /FROM customers/, tenants: [a.tenantId, b.tenantId] });

    const result = await identifyCaller({ tenantId: a.tenantId, fromPhone: phone, pool: widened.pool });

    expect(widened.rewritten).toHaveLength(1);
    expect(result).toMatchObject({ status: 'matched', customerId: aCustomer });
  });

  it('control: the same widened lookup run as the connection principal reaches the other tenant', async () => {
    const widened = widenTenantPredicates(pool, {
      target: /FROM customers/,
      tenants: [a.tenantId, b.tenantId],
      asPrincipal: true,
    });

    const result = await identifyCaller({ tenantId: a.tenantId, fromPhone: phone, pool: widened.pool });

    expect(widened.rewritten).toHaveLength(1);
    expect(result.status).toBe('multiple');
    if (result.status === 'multiple') {
      expect(result.candidates.map((c) => c.customerId).sort()).toEqual([aCustomer, bCustomer].sort());
    }
  });
});

describe('pgSupervisorPresenceLoader — users presence check under the RLS runtime role (real Postgres)', () => {
  let unsupervised: Seeded;
  let supervised: Seeded;

  beforeAll(async () => {
    unsupervised = await seedTenant('tech');
    supervised = await seedTenant('supervisor');
  });

  it('answers for the calling tenant, the users read running as rls_app_runtime for that tenant', async () => {
    const probe = probeStatementRoles(pool, /FROM users/);
    const load = pgSupervisorPresenceLoader(probe.pool);

    expect(await load(unsupervised.tenantId)).toBe(false);
    expect(await load(supervised.tenantId)).toBe(true);

    expect(probe.seen).toEqual([
      expect.objectContaining({ role: 'rls_app_runtime', tenantGuc: unsupervised.tenantId }),
      expect.objectContaining({ role: 'rls_app_runtime', tenantGuc: supervised.tenantId }),
    ]);
  });

  it("with the tenant pin widened to both tenants, RLS still keeps the other tenant's supervisor out", async () => {
    const widened = widenTenantPredicates(pool, {
      target: /FROM users/,
      tenants: [unsupervised.tenantId, supervised.tenantId],
    });

    expect(await pgSupervisorPresenceLoader(widened.pool)(unsupervised.tenantId)).toBe(false);
    expect(widened.rewritten).toHaveLength(1);
  });

  it('control: the same widened read run as the connection principal sees the other tenant\'s supervisor', async () => {
    const widened = widenTenantPredicates(pool, {
      target: /FROM users/,
      tenants: [unsupervised.tenantId, supervised.tenantId],
      asPrincipal: true,
    });

    expect(await pgSupervisorPresenceLoader(widened.pool)(unsupervised.tenantId)).toBe(true);
    expect(widened.rewritten).toHaveLength(1);
  });
});

describe('grants: rls_app_runtime keeps what these lookups need after migration 219', () => {
  it('customers and users stay SELECT-able (219 revokes only tenant_id tables without RLS)', async () => {
    expect(await runtimeRoleGrantsMissingAfter219(pool, [['customers', 'SELECT'], ['users', 'SELECT']])).toEqual([]);
  });

  it('control: the replayed 219 does revoke an RLS-exempt tenant_id table', async () => {
    expect(await runtimeRoleGrantsMissingAfter219(pool, [['oauth_states', 'SELECT']])).toEqual(['oauth_states:SELECT']);
  });
});
