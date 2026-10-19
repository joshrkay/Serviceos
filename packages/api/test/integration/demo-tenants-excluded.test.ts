/**
 * Postgres integration — S6-1 of the "pick, don't build" plan (U7, D1).
 *
 * Migration 317_demo_calls, the platform tenant, the demo-tenant pool seed
 * and the one rule every owner, billing and analytics surface must obey: a
 * demo tenant (`tenants.demo`) and the platform tenant (`tenants.platform`)
 * are never listed, never reported, never forwarded to analytics.
 *
 * Everything here runs on real Postgres (the shared testcontainer, or
 * EXTERNAL_TEST_DB_URL): the real migration corpus, the real seed, the real
 * sweep selectors, the real enumerator, the real admin router and usage
 * repository, the real audit repository. The only stand-ins are recorders at
 * the far side of a selector: the Stripe-backed billing service and usage sum
 * the overage sweep calls, the overdue sweep's per-tenant invoice read (as
 * in sweep-tenant-fanout.test.ts), the admin router's job queue and the
 * PostHog record call. Each records which tenant ids the real selector
 * handed it; none of them answers a database question.
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
import { readFileSync, readdirSync, statSync } from 'fs';
import { join, relative } from 'path';
import express, { type Request, type Response, type NextFunction } from 'express';
import request from 'supertest';
import { v4 as uuidv4 } from 'uuid';
import { listAllTenantIds } from '../../src/tenants/list-tenant-ids';
import { runSetupReminderSweep } from '../../src/workers/setup-reminder-sweep';
import { runTrialReminderSweep } from '../../src/workers/trial-reminder-sweep';
import { runDunningSweep } from '../../src/workers/dunning-sweep';
import { runOverageSettlementReconciliation } from '../../src/workers/overage-settlement-reconciliation';
import { runOverdueInvoiceSweep } from '../../src/workers/overdue-invoice-worker';
import { InMemoryDeliveryProvider } from '../../src/notifications/delivery-provider';
import { createLogger } from '../../src/logging/logger';
import { PgCustomerRepository } from '../../src/customers/pg-customer';
import { PgLocationRepository } from '../../src/locations/pg-location';
import { PgJobRepository } from '../../src/jobs/pg-job';
import { PgInvoiceRepository } from '../../src/invoices/pg-invoice';
import { buildLineItem, calculateDocumentTotals } from '../../src/shared/billing-engine';
import { createAdminTenantsRouter } from '../../src/routes/admin-tenants';
import { PgTenantUsageRepository } from '../../src/admin/pg-tenant-usage';
import { InMemoryPlatformAdminChecker, requirePlatformAdmin } from '../../src/auth/platform-admin';
import type { AuthenticatedRequest } from '../../src/auth/clerk';
import { createAuditEvent, InMemoryAuditRepository } from '../../src/audit/audit';
import { PgAuditRepository } from '../../src/audit/pg-audit';
import { ForwardingAuditRepository } from '../../src/audit/forwarding-audit-repository';
import { createHiddenTenantCheck } from '../../src/demo/hidden-tenant';

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

  describe('migration 317_demo_calls', () => {
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
      // that dirty state and prove the replayed corpus (219 + 317's own
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
      // 317 must run after 249 in the corpus (see the next test). It is no
      // longer the last key: later migrations follow it in file order.
      const keys = Object.keys(MIGRATIONS);
      expect(keys).toContain('317_demo_calls');
      expect(keys.indexOf('317_demo_calls')).toBeGreaterThan(keys.indexOf('249_backfill_owner_memberships'));
      await pool.query(getMigrationSQL());
      const { rowCount } = await pool.query(`SELECT 1 FROM tenants WHERE id = $1`, [DEMO_PLATFORM_TENANT_ID]);
      expect(rowCount).toBe(1);
    });

    it('no demo or platform tenant holds a users row after the corpus replays (249 backfills one per tenant)', async () => {
      // 249_backfill_owner_memberships replays on every boot and inserts an
      // owner users row for EVERY tenant whose owner_id has none, which would
      // hand each demo tenant and the platform tenant a sign-in-shaped owner
      // (and put them on every surface that reads users). 317 runs after 249
      // in the same corpus statement and removes exactly those rows.
      const demoId = crypto.randomUUID();
      await pool.query(
        `INSERT INTO tenants (id, owner_id, owner_email, name, demo, demo_trade)
         VALUES ($1, $2, $3, 'Demo replay probe', true, NULL)`,
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
      // No demo_trade, and removed here, so no pool pick can ever lease the probe.
      await pool.query(`DELETE FROM tenants WHERE id = $1`, [demoId]);
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

  // ── The exclusion (plan "Never visible to owners", D1's listing guard) ──
  //
  // Each hidden tenant below is a probe this file owns: one demo tenant and
  // one platform-flagged tenant, each put in the state that makes an
  // ordinary tenant a candidate (unfinished setup, a trial about to end, a
  // past-due grace, a stale and a gap overage settlement, an open overdue
  // invoice), next to an ordinary CONTROL tenant in the same state. Every
  // assertion is a pair: the control IS selected (the test can see the
  // selector) and the hidden tenants are NOT. Probes carry no demo_trade, so
  // no pool pick (S6-3) can ever lease one; the platform probe is removed
  // in afterAll. Clocks sit far from today (1971 / 2099) so this file's
  // tenants sort first under each sweep's LIMIT on a shared database.
  describe('every tenant lister excludes demo and platform tenants', () => {
    const logger = createLogger({ service: 'test', environment: 'test', level: 'error' });
    const FAR = new Date('2099-01-01T12:00:00.000Z');
    const HOUR = 3_600_000;
    let demoId: string;
    let platformId: string;
    let controlId: string;
    const email = (id: string) => `excl-${id}@test.dev`;

    // The stale settlement covers an older period than the last closed one
    // (1970-12 .. 1971-01), so the same tenant is also a gap candidate.
    async function primeCandidate(tenantId: string): Promise<void> {
      await pool.query(
        `UPDATE tenants
            SET owner_email = $2,
                created_at = '1971-01-01T00:00:00Z',
                subscription_status = 'trialing',
                trial_ends_at = $3,
                plan_id = 'starter',
                current_period_start = '1971-01-01T00:00:00Z',
                current_period_end = '1971-02-01T00:00:00Z',
                stripe_customer_id = $4
          WHERE id = $1`,
        [tenantId, email(tenantId), new Date(FAR.getTime() + 60 * HOUR), `cus_excl_${tenantId.slice(0, 8)}`],
      );
      await pool.query(
        `INSERT INTO call_usage_settlements
           (id, tenant_id, period_start, period_end, plan_id, billable_seconds, billable_minutes,
            overage_minutes, customer_charge_cents, status, updated_at)
         VALUES (gen_random_uuid(), $1, '1970-10-01T00:00:00Z', '1970-11-01T00:00:00Z', 'starter',
                 0, 0, 0, 0, 'failed', '1971-01-02T00:00:00Z')`,
        [tenantId],
      );
    }

    async function seedOpenInvoice(tenantId: string): Promise<void> {
      const customerId = uuidv4();
      await new PgCustomerRepository(pool).create({
        id: customerId, tenantId, firstName: 'Open', lastName: 'Invoice', displayName: 'Open Invoice',
        preferredChannel: 'phone', smsConsent: false, isArchived: false,
        createdBy: 'system:test', createdAt: new Date(), updatedAt: new Date(),
      });
      const locationId = uuidv4();
      await new PgLocationRepository(pool).create({
        id: locationId, tenantId, customerId, street1: '1 Main St', city: 'Austin', state: 'TX',
        postalCode: '78701', country: 'USA', addressType: 'service', isPrimary: true, isArchived: false,
        createdAt: new Date(), updatedAt: new Date(),
      });
      const jobId = uuidv4();
      await new PgJobRepository(pool).create({
        id: jobId, tenantId, customerId, locationId, jobNumber: `J-${jobId.slice(0, 8)}`,
        summary: 'Exclusion probe job', status: 'completed', priority: 'normal',
        createdBy: 'system:test', createdAt: new Date(), updatedAt: new Date(),
      });
      const lineItems = [buildLineItem(uuidv4(), 'Labor', 1, 40000, 0, false)];
      const totals = calculateDocumentTotals(lineItems, 0, 0);
      const invoiceId = uuidv4();
      await new PgInvoiceRepository(pool).create({
        id: invoiceId, tenantId, jobId, invoiceNumber: `INV-${invoiceId.slice(0, 8)}`,
        status: 'open', lineItems, totals, amountPaidCents: 0, amountDueCents: totals.totalCents,
        dueDate: new Date('2026-01-01T00:00:00Z'), createdBy: 'system:test',
        createdAt: new Date(), updatedAt: new Date(),
      });
    }

    async function insertHidden(flag: 'demo' | 'platform'): Promise<string> {
      const id = crypto.randomUUID();
      await pool.query(
        `INSERT INTO tenants (id, owner_id, owner_email, name, demo, platform)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [id, `${flag}:probe:${id}`, `${flag}-probe-${id}@invalid.rivet.local`, `Exclusion ${flag} probe`,
         flag === 'demo', flag === 'platform'],
      );
      return id;
    }

    beforeAll(async () => {
      demoId = await insertHidden('demo');
      platformId = await insertHidden('platform');
      const control = await createTestTenant(pool);
      controlId = control.tenantId;
      for (const id of [demoId, platformId, controlId]) {
        await primeCandidate(id);
        await seedOpenInvoice(id);
      }
    });

    afterAll(async () => {
      // Best effort: the platform probe must not outlive this file (S6-x
      // reads "the" platform tenant by its fixed uuid, but a stray flagged
      // row is noise). Its children go first.
      for (const table of ['invoices', 'jobs', 'locations', 'customers', 'call_usage_settlements', 'audit_events']) {
        await pool.query(`DELETE FROM ${table} WHERE tenant_id = $1`, [platformId]).catch(() => undefined);
      }
      await pool.query(`DELETE FROM tenants WHERE id = $1`, [platformId]).catch(() => undefined);
    });

    it('the enumerator (listAllTenantIds) returns the control and never a demo or platform tenant', async () => {
      const ids = await listAllTenantIds(pool);
      expect(ids).toContain(controlId);
      expect(ids).not.toContain(demoId);
      expect(ids).not.toContain(platformId);
      expect(ids).not.toContain(DEMO_PLATFORM_TENANT_ID);
    });

    it('the overdue-invoice sweep, on the real enumerator, never reaches a hidden tenant with an open invoice', async () => {
      const visited: string[] = [];
      await runOverdueInvoiceSweep({
        jobRepo: {} as never,
        estimateRepo: {} as never,
        invoiceRepo: {
          findByTenant: async (tenantId: string) => {
            visited.push(tenantId);
            return [];
          },
        } as never,
        auditRepo: {} as never,
        listTenantIds: () => listAllTenantIds(pool),
        logger,
      });
      expect(visited).toContain(controlId);
      expect(visited).not.toContain(demoId);
      expect(visited).not.toContain(platformId);
    });

    it('the setup-reminder sweep emails the control and never a hidden tenant with unfinished setup', async () => {
      const delivery = new InMemoryDeliveryProvider();
      await runSetupReminderSweep({
        pool,
        settingsRepo: new PgSettingsRepository(pool),
        delivery,
        appBaseUrl: 'https://app.rivet.ai',
        supportEmail: 'support@rivet.ai',
        logger,
        minAgeHours: 0,
      });
      const to = delivery.sentEmails.map((e) => e.to);
      expect(to).toContain(email(controlId));
      expect(to).not.toContain(email(demoId));
      expect(to).not.toContain(email(platformId));
    });

    it('the trial-reminder sweep emails the control and never a hidden tenant whose trial is ending', async () => {
      const delivery = new InMemoryDeliveryProvider();
      await runTrialReminderSweep({
        pool,
        settingsRepo: new PgSettingsRepository(pool),
        delivery,
        appBaseUrl: 'https://app.rivet.ai',
        supportEmail: 'support@rivet.ai',
        logger,
        now: () => FAR,
      });
      const to = delivery.sentEmails.map((e) => e.to);
      expect(to).toContain(email(controlId));
      expect(to).not.toContain(email(demoId));
      expect(to).not.toContain(email(platformId));
    });

    it('the dunning sweep emails the control and never a hidden tenant that is past due', async () => {
      for (const id of [demoId, platformId, controlId]) {
        // One hour into the grace: the day-0 send window.
        await pool.query(
          `UPDATE tenants SET subscription_status = 'past_due', past_due_grace_until = $2 WHERE id = $1`,
          [id, new Date(FAR.getTime() + 167 * HOUR)],
        );
      }
      try {
        const delivery = new InMemoryDeliveryProvider();
        await runDunningSweep({
          pool,
          settingsRepo: new PgSettingsRepository(pool),
          delivery,
          appBaseUrl: 'https://app.rivet.ai',
          supportEmail: 'support@rivet.ai',
          logger,
          now: () => FAR,
        });
        const to = delivery.sentEmails.map((e) => e.to);
        expect(to).toContain(email(controlId));
        expect(to).not.toContain(email(demoId));
        expect(to).not.toContain(email(platformId));
      } finally {
        await pool.query(
          `UPDATE tenants SET subscription_status = 'trialing', past_due_grace_until = NULL WHERE id = ANY($1)`,
          [[demoId, platformId, controlId]],
        );
      }
    });

    it('the overage reconciliation re-drives and backfills the control and never a hidden tenant', async () => {
      const retried: string[] = [];
      const gapChecked: string[] = [];
      for (const id of [demoId, platformId, controlId]) {
        await pool.query(`UPDATE tenants SET subscription_status = 'active' WHERE id = $1`, [id]);
      }
      try {
        await runOverageSettlementReconciliation({
          pool,
          logger,
          billing: {
            retrySettlement: async ({ tenantId }: { tenantId: string }) => {
              retried.push(tenantId);
              return { invoiceItemId: null, alreadyCompleted: true };
            },
            settlePeriod: async () => {
              throw new Error('nothing is billable in this probe');
            },
          } as never,
          callUsage: {
            sumBillableSeconds: async (tenantId: string) => {
              gapChecked.push(tenantId);
              return 0;
            },
          },
          overageCaps: { get: async () => null } as never,
          priceIdForPlan: () => 'price_probe',
          now: () => FAR,
        });
        expect(retried).toContain(controlId);
        expect(retried).not.toContain(demoId);
        expect(retried).not.toContain(platformId);
        expect(gapChecked).toContain(controlId);
        expect(gapChecked).not.toContain(demoId);
        expect(gapChecked).not.toContain(platformId);
      } finally {
        await pool.query(`UPDATE tenants SET subscription_status = 'trialing' WHERE id = ANY($1)`, [
          [demoId, platformId, controlId],
        ]);
      }
    });

    it('the platform-admin tenant routes answer 404 for a demo or platform tenant (and serve the control)', async () => {
      const app = express();
      app.use(express.json());
      app.use((req: Request, _res: Response, next: NextFunction) => {
        (req as AuthenticatedRequest).auth = {
          userId: 'admin-1',
          sessionId: 's',
          tenantId: controlId,
          role: 'owner',
        };
        next();
      });
      const sent: string[] = [];
      app.use(
        '/api/admin/tenants',
        createAdminTenantsRouter({
          pool,
          queue: {
            send: async (_type: string, payload: { tenantId: string }) => {
              sent.push(payload.tenantId);
              return 'job-1';
            },
          } as never,
          usageRepo: new PgTenantUsageRepository(pool),
          auditRepo: new InMemoryAuditRepository(),
          requirePlatformAdmin: requirePlatformAdmin(new InMemoryPlatformAdminChecker(['admin-1'])),
        }),
      );
      for (const hidden of [demoId, platformId, DEMO_PLATFORM_TENANT_ID]) {
        const usage = await request(app).get(`/api/admin/tenants/${hidden}/usage`);
        expect(usage.status, `usage ${hidden}`).toBe(404);
        const del = await request(app).post(`/api/admin/tenants/${hidden}/deprovision`).send({ confirm: true });
        expect(del.status, `deprovision ${hidden}`).toBe(404);
      }
      expect(sent).toEqual([]);
      const usage = await request(app).get(`/api/admin/tenants/${controlId}/usage`);
      expect(usage.status).toBe(200);
      expect(usage.body.tenant.id).toBe(controlId);
    });

    it('product analytics drop a hidden tenant\'s events and forward the control\'s', async () => {
      const recorded: string[] = [];
      const repo = new ForwardingAuditRepository(new PgAuditRepository(pool), {
        isEnabled: () => true,
        record: (_name, payload) => {
          recorded.push(payload.tenantId);
        },
        isHiddenTenant: createHiddenTenantCheck(pool),
      });
      for (const tenantId of [demoId, platformId, DEMO_PLATFORM_TENANT_ID, controlId]) {
        const saved = await repo.create(
          createAuditEvent({
            tenantId,
            actorId: 'system:test',
            actorRole: 'owner',
            eventType: 'proposal.approved',
            entityType: 'proposal',
            entityId: uuidv4(),
            metadata: { proposalType: 'issue_invoice', status: 'approved' },
          }),
        );
        // The audit write itself is never dropped: only the forward is.
        expect(saved.tenantId).toBe(tenantId);
      }
      expect(recorded).toEqual([controlId]);
    });
  });

  // ── Source guard: a new FROM tenants listing cannot skip the predicate ──
  describe('source guard: every FROM tenants under workers/billing/analytics/metrics/admin filters or is allow-listed', () => {
    const SRC = join(__dirname, '../../src');
    const GUARDED_DIRS = ['workers', 'billing', 'analytics', 'metrics', 'admin'];
    /** Files that touch `tenants` only by primary key (or only in a comment). */
    const ALLOW_LIST: Record<string, string> = {
      'workers/money-reconciliation.ts': 'the string is in a comment; it lists tenants through the injected enumerator',
      'workers/provision-twilio.ts': 'reads one tenant by id (subscription_status)',
      'billing/call-usage-billing.ts': 'reads one tenant by id (stripe_customer_id)',
      'billing/subscription.ts': 'reads one tenant by id (Stripe ids, checkout session)',
      'billing/stripe-connect.ts': 'reads one tenant by id (connect account)',
      'billing/tenant-billing-state.ts': 'reads one tenant by id (billing state)',
    };
    const LISTS_TENANTS = /\b(FROM|JOIN)\s+tenants\b/i;
    const FILTERS = /\bdemo\s*=\s*false\b[\s\S]*\bplatform\s*=\s*false\b|\bplatform\s*=\s*false\b[\s\S]*\bdemo\s*=\s*false\b/i;

    function walk(dir: string): string[] {
      return readdirSync(dir).flatMap((name) => {
        const full = join(dir, name);
        if (statSync(full).isDirectory()) return walk(full);
        return name.endsWith('.ts') ? [full] : [];
      });
    }

    /** The offending files, relative to src/. Pure, so its negative control below is real. */
    function offenders(files: Array<{ path: string; text: string }>): string[] {
      return files
        .filter((f) => LISTS_TENANTS.test(f.text) && !FILTERS.test(f.text) && !(f.path in ALLOW_LIST))
        .map((f) => f.path);
    }

    it('flags a listing that neither filters nor is allow-listed (negative control)', () => {
      expect(
        offenders([
          { path: 'workers/new-sweep.ts', text: 'const SQL = `SELECT id FROM tenants WHERE plan_id = $1`;' },
          { path: 'workers/ok-sweep.ts', text: 'SELECT id FROM tenants t WHERE t.demo = false AND t.platform = false' },
          { path: 'workers/half-sweep.ts', text: 'SELECT id FROM tenants WHERE demo = false' },
        ]),
      ).toEqual(['workers/new-sweep.ts', 'workers/half-sweep.ts']);
    });

    it('finds no offender in the real source tree, and every allow-list entry still exists', () => {
      const files = GUARDED_DIRS.flatMap((d) => walk(join(SRC, d))).map((full) => ({
        path: relative(SRC, full),
        text: readFileSync(full, 'utf8'),
      }));
      expect(offenders(files)).toEqual([]);
      // The enumerator itself carries the predicate.
      expect(FILTERS.test(readFileSync(join(SRC, 'tenants/list-tenant-ids.ts'), 'utf8'))).toBe(true);
      for (const path of Object.keys(ALLOW_LIST)) {
        expect(files.some((f) => f.path === path), `${path} is allow-listed but gone`).toBe(true);
      }
    });
  });
});
