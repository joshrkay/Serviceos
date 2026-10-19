/**
 * Postgres integration — S6-1 of the "pick, don't build" plan (U7, D1).
 *
 * Migration 314_demo_calls, the platform tenant, the demo-tenant pool seed
 * and the one rule every owner, billing and analytics surface must obey: a
 * demo tenant (`tenants.demo`) and the platform tenant (`tenants.platform`)
 * are never listed, never reported, never forwarded to analytics.
 *
 * Everything here runs on real Postgres (the shared testcontainer, or
 * EXTERNAL_TEST_DB_URL): the real migration corpus, the real seed, the real
 * sweep selectors, the real enumerator. Nothing is mocked except the
 * Stripe-backed billing service the overage sweep calls, which is a spy that
 * must never be called for the demo tenant.
 *
 * Shared-DB rule (docs/solutions/test-failures/shared-db-integration-test-
 * grant-pollution.md): assertions are scoped to the rows this file owns —
 * the platform tenant at its fixed uuid and the pool tenants the seed names
 * by owner_id. Aggregate counts over the whole tenants table are never
 * asserted, and grant posture is proven by replaying the corpus, not read
 * from ambient catalog state.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { getSharedTestDb, createTestTenant, closeSharedTestDb } from './shared';
import { MIGRATIONS, getMigrationSQL } from '../../src/db/schema';
import { DEMO_PLATFORM_TENANT_ID } from '../../src/demo/platform-tenant';
import { applyTenantContext, clearTenantContext } from '../../src/db/rls-runtime-role';

const PLATFORM_TABLES = [
  'demo_calls',
  'demo_tenant_leases',
  'demo_inflight_jobs',
  'demo_call_budget',
  'demo_handoff_outbox',
  'signup_handoffs',
] as const;

/** Tables that carry no tenant_id at all (the plan's "platform table" posture). */
const NO_TENANT_ID = ['demo_calls', 'demo_call_budget', 'demo_handoff_outbox'] as const;

/** Tables whose tenant_id only NAMES a demo tenant: RLS-exempt, revoked from the runtime role. */
const NAMED_TENANT_TABLES = ['demo_tenant_leases', 'demo_inflight_jobs', 'signup_handoffs'] as const;

async function columns(pool: Pool, table: string): Promise<string[]> {
  const { rows } = await pool.query<{ column_name: string }>(
    `SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = $1 ORDER BY ordinal_position`,
    [table],
  );
  return rows.map((r) => r.column_name);
}

async function withTenantClient<T>(
  pool: Pool,
  tenantId: string,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await applyTenantContext(client, tenantId, { transactional: true });
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    await clearTenantContext(client);
    client.release();
  }
}

describe('Postgres integration — demo tenants and the platform tenant are excluded everywhere (S6-1)', () => {
  let pool: Pool;

  beforeAll(async () => {
    pool = await getSharedTestDb();
  });

  afterAll(async () => {
    await closeSharedTestDb();
  });

  describe('migration 314_demo_calls', () => {
    it('creates the platform tenant at its fixed uuid, flagged platform and not demo (D1)', async () => {
      const { rows } = await pool.query(
        `SELECT id, owner_id, owner_email, demo, platform, demo_trade FROM tenants WHERE id = $1`,
        [DEMO_PLATFORM_TENANT_ID],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        id: DEMO_PLATFORM_TENANT_ID,
        owner_id: 'platform:demo',
        owner_email: 'platform-demo@invalid.rivet.local',
        demo: false,
        platform: true,
        demo_trade: null,
      });
    });

    it('creates every U7 platform table and the lease generation sequence', async () => {
      for (const table of PLATFORM_TABLES) {
        const cols = await columns(pool, table);
        expect(cols.length, `${table} missing`).toBeGreaterThan(0);
      }
      const seq = await pool.query(
        `SELECT 1 FROM pg_class WHERE relkind = 'S' AND relname = 'demo_lease_generation_seq'`,
      );
      expect(seq.rowCount).toBe(1);
    });

    it('pins the real columns S6-2..S6-9 write to', async () => {
      expect(await columns(pool, 'demo_calls')).toEqual(
        expect.arrayContaining([
          'id', 'phone_hash', 'trade', 'business_name', 'metro_code', 'metro_name', 'lease_id',
          'call_sid', 'status', 'lead_id', 'callback_deadline_at', 'budget_day', 'reserved_cents',
          'budget_released_at', 'allowance_window_start', 'allowance_released_at',
          'correlation_id', 'result', 'result_written_at', 'created_at', 'updated_at',
        ]),
      );
      expect(await columns(pool, 'demo_tenant_leases')).toEqual(
        expect.arrayContaining([
          'id', 'tenant_id', 'visitor_phone_hash', 'call_sid', 'leased_at', 'expires_at', 'state',
          'reset_started_at', 'reset_heartbeat_at', 'reset_token', 'generation', 'released_at',
          'renewed_at',
        ]),
      );
      expect(await columns(pool, 'demo_inflight_jobs')).toEqual(
        expect.arrayContaining([
          'id', 'tenant_id', 'lease_id', 'generation', 'message_id', 'attempt', 'claimed_at',
          'heartbeat_at',
        ]),
      );
      expect(await columns(pool, 'demo_call_budget')).toEqual([
        'day', 'calls_reserved', 'calls_cap', 'est_cost_cents', 'cost_cap_cents',
      ]);
      expect(await columns(pool, 'demo_handoff_outbox')).toEqual(
        expect.arrayContaining([
          'id', 'demo_call_id', 'lead_id', 'idempotency_key', 'handoff_expires_at', 'created_at',
          'sent_at', 'retired_at', 'send_claimed_at', 'attempts',
        ]),
      );
      expect(await columns(pool, 'signup_handoffs')).toEqual(
        expect.arrayContaining(['token_hash', 'lead_id', 'tenant_id', 'expires_at', 'consumed_at']),
      );
      for (const table of NO_TENANT_ID) {
        expect(await columns(pool, table), `${table} must carry no tenant_id`).not.toContain('tenant_id');
      }
    });

    it('platform tables have no row-level security (admin-write posture like tenants)', async () => {
      const { rows } = await pool.query<{ relname: string; relrowsecurity: boolean }>(
        `SELECT relname, relrowsecurity FROM pg_class
          WHERE relnamespace = 'public'::regnamespace AND relname = ANY($1)`,
        [[...PLATFORM_TABLES]],
      );
      expect(rows.map((r) => r.relname).sort()).toEqual([...PLATFORM_TABLES].sort());
      for (const r of rows) expect(r.relrowsecurity, `${r.relname} must not enable RLS`).toBe(false);
    });

    it('the corpus revokes rls_app_runtime on the tenant_id-naming platform tables (effect, not ambient state)', async () => {
      // Sibling suites GRANT ... ON ALL TABLES to the runtime role; reproduce
      // that dirty state and prove the replayed corpus (219 + 314's own
      // revoke) clears exactly these tables.
      await pool.query(
        `GRANT SELECT, INSERT, UPDATE, DELETE ON ${NAMED_TENANT_TABLES.join(', ')} TO rls_app_runtime`,
      );
      await pool.query(getMigrationSQL());
      const res = await pool.query<{ table_name: string; privilege_type: string }>(
        `SELECT table_name, privilege_type FROM information_schema.role_table_grants
          WHERE grantee = 'rls_app_runtime' AND table_schema = 'public' AND table_name = ANY($1)`,
        [[...NAMED_TENANT_TABLES]],
      );
      expect(res.rows.map((r) => `${r.table_name}:${r.privilege_type}`)).toEqual([]);
    });

    it('the partial unique indexes hold one open lease per tenant, per visitor, and one CallSid', async () => {
      const t = await createTestTenant(pool);
      const u = await createTestTenant(pool);
      const open = (tenantId: string, hash: string, sid: string | null) =>
        pool.query(
          `INSERT INTO demo_tenant_leases (tenant_id, visitor_phone_hash, call_sid, expires_at)
           VALUES ($1, $2, $3, now() + interval '1 minute')`,
          [tenantId, hash, sid],
        );
      await open(t.tenantId, 'hash-a', 'CA1');
      await expect(open(t.tenantId, 'hash-b', null)).rejects.toMatchObject({ code: '23505' });
      await expect(open(u.tenantId, 'hash-a', null)).rejects.toMatchObject({ code: '23505' });
      await expect(open(u.tenantId, 'hash-c', 'CA1')).rejects.toMatchObject({ code: '23505' });
      // A released lease frees the tenant and the visitor.
      await pool.query(`UPDATE demo_tenant_leases SET released_at = now(), state = 'released' WHERE tenant_id = $1`, [t.tenantId]);
      await open(t.tenantId, 'hash-a', null);
      await expect(
        pool.query(`UPDATE demo_tenant_leases SET state = 'bogus' WHERE tenant_id = $1`, [t.tenantId]),
      ).rejects.toMatchObject({ code: '23514' });
    });

    it('re-applies idempotently: the whole corpus replays on the populated database', async () => {
      expect(Object.keys(MIGRATIONS).at(-1)).toBe('314_demo_calls');
      await pool.query(getMigrationSQL());
      const { rowCount } = await pool.query(`SELECT 1 FROM tenants WHERE id = $1`, [DEMO_PLATFORM_TENANT_ID]);
      expect(rowCount).toBe(1);
    });

    it('D1: the platform tenant can own a leads row (the demo visitor record)', async () => {
      const leadId = crypto.randomUUID();
      await withTenantClient(pool, DEMO_PLATFORM_TENANT_ID, (client) =>
        client.query(
          `INSERT INTO leads (id, tenant_id, company_name, primary_phone, source, source_detail, stage, created_by)
           VALUES ($1, $2, 'Demo Plumbing', '+15555550100', 'other', 'demo_call', 'new', 'system:demo')`,
          [leadId, DEMO_PLATFORM_TENANT_ID],
        ),
      );
      const { rows } = await withTenantClient(pool, DEMO_PLATFORM_TENANT_ID, (client) =>
        client.query(`SELECT tenant_id FROM leads WHERE id = $1`, [leadId]),
      );
      expect(rows[0].tenant_id).toBe(DEMO_PLATFORM_TENANT_ID);
    });
  });
});
