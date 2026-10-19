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
import {
  DEMO_TRADES,
  buildDemoFixtureDeps,
  seedDemoTenantFromFixture,
  type DemoTrade,
} from '../../src/demo/fixture';
import { seedDemoTenantPool, demoPoolOwnerId } from '../../src/demo/seed-pool';
import { PgSettingsRepository } from '../../src/settings/pg-settings';
import { PgCatalogItemRepository } from '../../src/catalog/pg-catalog-item';
import { PgEstimateTemplateRepository } from '../../src/templates/pg-estimate-template';
import { PgPackActivationRepository } from '../../src/settings/pg-pack-activation';

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
      // Unique per run: the external test database persists between runs.
      const run = crypto.randomUUID().slice(0, 8);
      const open = (tenantId: string, hash: string, sid: string | null) =>
        pool.query(
          `INSERT INTO demo_tenant_leases (tenant_id, visitor_phone_hash, call_sid, expires_at)
           VALUES ($1, $2, $3, now() + interval '1 minute')`,
          [tenantId, hash, sid],
        );
      await open(t.tenantId, `hash-a-${run}`, `CA1${run}`);
      await expect(open(t.tenantId, `hash-b-${run}`, null)).rejects.toMatchObject({ code: '23505' });
      await expect(open(u.tenantId, `hash-a-${run}`, null)).rejects.toMatchObject({ code: '23505' });
      await expect(open(u.tenantId, `hash-c-${run}`, `CA1${run}`)).rejects.toMatchObject({ code: '23505' });
      // A released lease frees the tenant and the visitor.
      await pool.query(`UPDATE demo_tenant_leases SET released_at = now(), state = 'released' WHERE tenant_id = $1`, [t.tenantId]);
      await open(t.tenantId, `hash-a-${run}`, null);
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

    it('no demo or platform tenant holds a users row after the corpus replays (249 backfills one per tenant)', async () => {
      // 249_backfill_owner_memberships replays on every boot and inserts an
      // owner users row for EVERY tenant whose owner_id has none, which would
      // hand each demo tenant and the platform tenant a sign-in-shaped owner
      // (and put them on every surface that reads users). 314 runs after 249
      // in the same corpus statement and removes exactly those rows.
      const demoId = crypto.randomUUID();
      await pool.query(
        `INSERT INTO tenants (id, owner_id, owner_email, name, demo, demo_trade)
         VALUES ($1, $2, $3, 'Demo replay probe', true, 'plumbing')`,
        [demoId, `demo:probe:${demoId}`, `demo-probe-${demoId}@invalid.rivet.local`],
      );
      const control = await createTestTenant(pool);
      await pool.query(getMigrationSQL());
      const { rows } = await pool.query<{ tenant_id: string }>(
        `SELECT tenant_id FROM users WHERE tenant_id = ANY($1)`,
        [[demoId, DEMO_PLATFORM_TENANT_ID, control.tenantId]],
      );
      // The ordinary tenant keeps its owner; the hidden two have none.
      expect(rows.map((r) => r.tenant_id)).toEqual([control.tenantId]);
    });

    it('D1: the platform tenant can own a leads row (the demo visitor record)', async () => {
      const leadId = crypto.randomUUID();
      // One open lead per phone per tenant (idx_leads_phone_unique_open): a fresh number per run.
      const phone = `+1555${String(Math.floor(Math.random() * 1e7)).padStart(7, '0')}`;
      await withTenantClient(pool, DEMO_PLATFORM_TENANT_ID, (client) =>
        client.query(
          `INSERT INTO leads (id, tenant_id, company_name, primary_phone, source, source_detail, stage, created_by)
           VALUES ($1, $2, 'Demo Plumbing', $3, 'other', 'demo_call', 'new', 'system:demo')`,
          [leadId, DEMO_PLATFORM_TENANT_ID, phone],
        ),
      );
      const { rows } = await withTenantClient(pool, DEMO_PLATFORM_TENANT_ID, (client) =>
        client.query(`SELECT tenant_id FROM leads WHERE id = $1`, [leadId]),
      );
      expect(rows[0].tenant_id).toBe(DEMO_PLATFORM_TENANT_ID);
    });
  });

  describe('demo-tenant pool seed', () => {
    const PER_TRADE = 2;

    it('seed is idempotent: run twice yields exactly PER_TRADE × 4 tenants equal to the fixture', async () => {
      const ownerIds = DEMO_TRADES.flatMap((trade) =>
        Array.from({ length: PER_TRADE }, (_, i) => demoPoolOwnerId(trade, i + 1)),
      );
      // The pool's owner ids are fixed by design, so on a persistent external
      // database an earlier run may already have seeded some slots: the first
      // run creates exactly the missing ones, the second creates none.
      const before = await pool.query(`SELECT 1 FROM tenants WHERE owner_id = ANY($1)`, [ownerIds]);
      const first = await seedDemoTenantPool(pool, { perTrade: PER_TRADE, log: () => undefined });
      const second = await seedDemoTenantPool(pool, { perTrade: PER_TRADE, log: () => undefined });
      expect(first.created).toBe(PER_TRADE * DEMO_TRADES.length - (before.rowCount ?? 0));
      expect(second.created).toBe(0);
      expect([...second.tenantIds].sort()).toEqual([...first.tenantIds].sort());
      expect(first.tenantIds).toHaveLength(PER_TRADE * DEMO_TRADES.length);

      const { rows } = await pool.query<{ id: string; demo: boolean; platform: boolean; demo_trade: string; name: string }>(
        `SELECT id, demo, platform, demo_trade, name FROM tenants WHERE owner_id = ANY($1)`,
        [ownerIds],
      );
      expect(rows).toHaveLength(ownerIds.length);
      for (const r of rows) {
        expect(r.demo).toBe(true);
        expect(r.platform).toBe(false);
        expect(DEMO_TRADES).toContain(r.demo_trade);
      }
      // Demo tenants have no users rows: no owner can ever sign in to one.
      const users = await pool.query(`SELECT 1 FROM users WHERE tenant_id = ANY($1)`, [rows.map((r) => r.id)]);
      expect(users.rowCount).toBe(0);
      // The seed is audited on the demo tenant itself (the trail survives a reset).
      const audit = await withTenantClient(pool, rows[0].id, (c) =>
        c.query(`SELECT actor_id FROM audit_events WHERE tenant_id = $1 AND event_type = 'demo.tenant_seeded'`, [rows[0].id]),
      );
      expect(audit.rows).toHaveLength(1);
      expect(audit.rows[0].actor_id).toBe('system:demo-seed');

      // Settings, catalog and templates equal seedDemoTenantFromFixture's own
      // output on a fresh tenant of the same trade.
      const settingsRepo = new PgSettingsRepository(pool);
      const catalogRepo = new PgCatalogItemRepository(pool);
      const templateRepo = new PgEstimateTemplateRepository(pool);
      const packRepo = new PgPackActivationRepository(pool);
      const deps = buildDemoFixtureDeps(pool);
      const shape = async (tenantId: string) => {
        const s = await settingsRepo.findByTenant(tenantId);
        const items = await catalogRepo.listByTenant(tenantId);
        const templates = await templateRepo.findByTenant(tenantId);
        const packs = await packRepo.findByTenant(tenantId);
        return {
          timezone: s?.timezone,
          voiceId: s?.voiceId,
          packs: packs.map((p) => p.packId).sort(),
          activePacks: s?.activeVerticalPacks,
          items: items.map((i) => [i.name, i.unitPriceCents]).sort(),
          templates: templates.map((t) => t.name).sort(),
        };
      };
      for (const trade of DEMO_TRADES) {
        const pooled = rows.find((r) => r.demo_trade === trade)!;
        const fresh = await createTestTenant(pool);
        await pool.query(`DELETE FROM users WHERE tenant_id = $1`, [fresh.tenantId]);
        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          await seedDemoTenantFromFixture(client, { tenantId: fresh.tenantId, trade: trade as DemoTrade, slot: 9 }, deps);
          await client.query('COMMIT');
        } finally {
          await clearTenantContext(client);
          client.release();
        }
        const a = await shape(pooled.id);
        const b = await shape(fresh.tenantId);
        expect(a.items.length, `${trade} catalog seeded`).toBeGreaterThan(0);
        expect(a.templates.length, `${trade} templates seeded`).toBeGreaterThan(0);
        expect(a.timezone).toBe('America/New_York');
        expect(a.packs).toEqual([trade]);
        expect(a.voiceId).toBeTruthy();
        expect(a).toEqual(b);
      }
    });
  });
});
