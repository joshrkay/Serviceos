/**
 * Postgres integration — S5a-4 (U8): attach-time revalidation of
 * `payment_collection_mode` under the per-tenant payment-mode lock.
 *
 * A checkout reads `pay_link`, then stalls in the Stripe mint. If the owner
 * switches to "Collect on the spot" meanwhile, the guarded attach
 * (`PgInvoiceRepository.attachPaymentLink`) must not store the fresh link:
 * it takes `pg_advisory_xact_lock_shared(hashtext('payment_mode:<tenant>'))`
 * as a statement of its own, re-reads the mode, and only then runs the
 * guarded UPDATE. The settings write that names the key takes the same key
 * EXCLUSIVELY as its first statement (`PgSettingsRepository.update`), so the
 * two are ordered whether or not a `tenant_settings` row existed before.
 *
 * What is proven here, against real Postgres through the real repositories
 * and real routers (two or more real connections, a statement spy that
 * wraps `client.query` on dedicated pools, `pg_stat_activity` and
 * `pg_locks` for the lock facts):
 *  - lock order and the one shared key text (attach and settings write);
 *  - attach vs settings write, both orders, with and without a settings
 *    row, for both write sites (`updateSettings` as `PUT /api/settings`
 *    calls it, and `OnboardingVoicePolicyExecutionHandler.execute`), looped;
 *  - `afterWrite` runs inside the write's transaction: a probe row it writes
 *    on its client is gone after a throwing hook rolls the write back;
 *  - two attaches of one tenant never wait on each other; an attach waits
 *    only for an EXCLUSIVE holder and never touches the cleanup key;
 *  - the stall case at every mint site (operator route under the request
 *    transaction, public checkout provider path and direct-Stripe path, the
 *    portal list): no link stored, the fresh link deactivated under the
 *    minting scope, audited with `payment_mode_changed_during_checkout`,
 *    409 COLLECT_ON_SITE (or the in-person row on the portal), and no
 *    advisory lock held while the provider is latched or while the
 *    deactivation runs;
 *  - an attach whose mode read raises a real Postgres error fails closed
 *    (503, nothing stored, link deactivated, audited) and leaves the request
 *    transaction usable — the attach's SAVEPOINT;
 *  - unchanged mode (stored pay_link, unset key, no row) attaches as today.
 *
 * NOT proven here: Stripe itself. The provider seam is the repo's
 * `MockPaymentLinkProvider` (latched subclass) and the direct path's
 * `stripeFetch` override, exactly as the sibling payment-link suites do.
 *
 * S5a-5 (the nested "cleanup job" block): the switch's job row commits with
 * the mode or not at all, for both write sites (PUT /api/settings under the
 * request transaction, and the onboarding_voice_policy handler), including a
 * fault before COMMIT and a killed connection; the claim's statement order
 * and lock scope; the follow-up pass; a switch back while paging and between
 * a claim and its Stripe call; two cleanups of one tenant; a retry beside the
 * follow-up; the crashed-claimer lease; and the unreadable / unset / no-row
 * claims — all through the real `PgQueue`, repositories and claim, with the
 * worker driven on the job rows the writes committed.
 *
 * S5a-6 (the nested "daily reconciliation sweep" block): the production
 * enumerator (`listCollectOnSiteTenantIds`, cross-tenant role, real
 * `tenant_settings.payment_collection_mode` and `tenants` join, keyset pages
 * of 500) under `RLS_RUNTIME_ROLE=true`, the sweep enqueueing per-day
 * `:sweep:<date>` pass-1 jobs only for collect-on-site tenants with a live
 * link (`invoices.stripe_payment_link_id`), the same-day dedupe, the jobs run
 * through the real worker and claim, and a switch back after listing.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import crypto from 'crypto';
import { Pool, type PoolClient } from 'pg';
import express, { type NextFunction, type Request, type Response } from 'express';
import request from 'supertest';
import { getSharedTestDb, createTestTenant, closeSharedTestDb, type TestTenant } from './shared';
import { PgInvoiceRepository } from '../../src/invoices/pg-invoice';
import { PgCustomerRepository } from '../../src/customers/pg-customer';
import { PgLocationRepository } from '../../src/locations/pg-location';
import { PgJobRepository } from '../../src/jobs/pg-job';
import { PgAuditRepository } from '../../src/audit/pg-audit';
import { PgSettingsRepository } from '../../src/settings/pg-settings';
import { PgEstimateRepository } from '../../src/estimates/pg-estimate';
import { PgAgreementRepository } from '../../src/agreements/pg-agreement';
import { PgAppointmentRepository } from '../../src/appointments/pg-appointment';
import { PgLeadRepository } from '../../src/leads/pg-lead';
import { PgPortalSessionRepository } from '../../src/portal/pg-portal-session';
import { hashPortalToken } from '../../src/portal/portal-service';
import { updateSettings, type SettingsWriteContext } from '../../src/settings/settings';
import { paymentModeLockKey } from '../../src/invoices/payment-collection-mode';
import { PublicInvoiceService, type ConnectAccountResolver } from '../../src/invoices/public-invoice-service';
import { createPublicInvoicesRouter } from '../../src/routes/public-invoices';
import { createPublicPortalRouter } from '../../src/routes/public-portal';
import { createInvoiceRouter } from '../../src/routes/invoices';
import { withTenantTransaction } from '../../src/middleware/tenant-context';
import { permissiveTenantOwnership } from '../../src/shared/tenant-ownership';
import { OnboardingVoicePolicyExecutionHandler } from '../../src/proposals/execution/onboarding-handlers';
import type { Proposal } from '../../src/proposals/proposal';
import type { AuthenticatedRequest } from '../../src/auth/clerk';
import {
  MockPaymentLinkProvider,
  type DeactivateLinkOptions,
  type PaymentLinkRequest,
  type PaymentLinkResult,
} from '../../src/payments/payment-link-provider';
import { buildLineItem, calculateDocumentTotals } from '../../src/shared/billing-engine';
import { DEMO_PLATFORM_TENANT_ID } from '../../src/demo/platform-tenant';
import { PgQueue } from '../../src/queues/pg-queue';
import type { QueueMessage } from '../../src/queues/queue';
import { PgUserRepository } from '../../src/users/pg-user';
import { createSettingsRouter } from '../../src/routes/settings';
import { createLogger } from '../../src/logging/logger';
import {
  DEACTIVATE_PAYMENT_LINKS_JOB_TYPE,
  claimNextPaymentLink,
  createPgPaymentLinkClaimer,
  paymentCleanupLockKey,
  type DeactivatePaymentLinksPayload,
} from '../../src/invoices/payment-mode-change';
import { createDeactivatePaymentLinksWorker } from '../../src/workers/deactivate-payment-links';
import {
  listCollectOnSiteTenantIds,
  runPaymentLinkReconciliationSweep,
} from '../../src/workers/payment-link-reconciliation-sweep';

const LOOPS = 20;
const CONNECT_ACCOUNT = 'acct_s5a4_minting_scope';
const FAULT_SCHEMA = 's5a4_fault';
const FAULT_GUC = 's5a4.fail_mode_read';
const FAULT_MESSAGE = 'S5a-4 injected fault: payment mode unreadable at attach';

// ─── statement spy ──────────────────────────────────────────────────────────

interface Stmt {
  pid: number;
  text: string;
  values: unknown[];
}

/**
 * A dedicated pool whose clients record every promise-style `query` (text,
 * values, backend pid). `beforeCommit` is a one-shot latch awaited before a
 * `COMMIT` is sent; `afterBegin` statements run right after a `BEGIN`;
 * `beforeStatement` may run extra SQL on the same client before a matching
 * statement (fault injection through a real Postgres setting).
 */
class SpyPool {
  readonly pool: Pool;
  readonly log: Stmt[] = [];
  beforeCommit: (() => Promise<void>) | null = null;
  afterBegin: string[] = [];
  beforeStatement: { match: RegExp; sql: string } | null = null;

  constructor(options: { searchPath?: string } = {}) {
    this.pool = new Pool({
      connectionString: process.env.TEST_DB_URL,
      max: 6,
      ...(options.searchPath ? { options: `-c search_path=${options.searchPath}` } : {}),
    });
    this.pool.on('connect', (client) => this.wrap(client));
  }

  private wrap(client: PoolClient): void {
    // A backend the test terminates must surface as a rejected query, never
    // as an unhandled 'error' event (db/pool.ts guardClientErrors does this
    // for the app's own pools).
    client.on('error', () => undefined);
    const original = client.query.bind(client) as (...args: unknown[]) => Promise<unknown>;
    let pid = 0;
    const spy = this;
    (client as unknown as { query: unknown }).query = async function (...args: unknown[]) {
      if (typeof args[args.length - 1] === 'function') return original(...args);
      const cfg = args[0];
      const text = typeof cfg === 'string' ? cfg : String((cfg as { text?: string })?.text ?? '');
      const values = (Array.isArray(args[1]) ? args[1] : ((cfg as { values?: unknown[] })?.values ?? [])) as unknown[];
      if (!pid) {
        const r = (await original('SELECT pg_backend_pid() AS pid')) as { rows: Array<{ pid: number }> };
        pid = r.rows[0].pid;
      }
      const trimmed = text.trim();
      if (trimmed === 'COMMIT' && spy.beforeCommit) {
        const latch = spy.beforeCommit;
        spy.beforeCommit = null;
        await latch();
      }
      if (spy.beforeStatement && spy.beforeStatement.match.test(text)) {
        await original(spy.beforeStatement.sql);
      }
      spy.log.push({ pid, text: trimmed, values });
      const result = await original(...args);
      if (trimmed === 'BEGIN') {
        for (const sql of spy.afterBegin) await original(sql);
      }
      return result;
    };
  }

  /** The newest statement matching `re`, waiting for it to appear. */
  async waitFor(re: RegExp, since = 0): Promise<Stmt> {
    const deadline = Date.now() + 10_000;
    for (;;) {
      const hit = this.log.slice(since).reverse().find((s) => re.test(s.text));
      if (hit) return hit;
      if (Date.now() > deadline) throw new Error(`statement ${re} never ran`);
      await new Promise((r) => { setTimeout(r, 5); });
    }
  }

  async end(): Promise<void> {
    await this.pool.end();
  }
}

function latch(): { wait: () => Promise<void>; release: () => void; reached: Promise<void> } {
  let release!: () => void;
  let markReached!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const reached = new Promise<void>((r) => { markReached = r; });
  return {
    wait: async () => {
      markReached();
      await gate;
    },
    release,
    reached,
  };
}

const LOCK_SHARED = /pg_advisory_xact_lock_shared\(hashtext\(\$1\)\)/;
const LOCK_EXCLUSIVE = /pg_advisory_xact_lock\(hashtext\(\$1\)\)/;
const MODE_READ = /^SELECT COALESCE\(\s*\(SELECT payment_collection_mode FROM tenant_settings/;
const ATTACH_UPDATE = /^UPDATE invoices\s+SET stripe_payment_link_id = \$3/;

describe('Postgres integration — attach-time revalidation under the payment-mode lock (S5a-4 / U8)', () => {
  let pool: Pool;
  let attachSpy: SpyPool;
  let writeSpy: SpyPool;
  let routeSpy: SpyPool;
  let faultSpy: SpyPool;
  let auditRepo: PgAuditRepository;

  async function waitForLockWait(pid: number): Promise<void> {
    const deadline = Date.now() + 10_000;
    for (;;) {
      const { rows } = await pool.query<{ wait_event_type: string | null }>(
        'SELECT wait_event_type FROM pg_stat_activity WHERE pid = $1',
        [pid],
      );
      if (rows[0]?.wait_event_type === 'Lock') return;
      if (Date.now() > deadline) throw new Error(`backend ${pid} never waited on a lock`);
      await new Promise((r) => { setTimeout(r, 5); });
    }
  }

  /** Advisory locks currently granted on the tenant's payment-mode key, from any backend. */
  async function heldModeLocks(tenantId: string): Promise<number> {
    const { rows } = await pool.query<{ n: string }>(
      `SELECT count(*) AS n FROM pg_locks
        WHERE locktype = 'advisory' AND granted
          AND objsubid = 1
          AND objid = ((hashtext($1)::bigint) & 4294967295)::oid
          AND classid = (((hashtext($1)::bigint) >> 32) & 4294967295)::oid`,
      [paymentModeLockKey(tenantId)],
    );
    return Number(rows[0].n);
  }

  async function seedTenant(opts: { settingsRow: boolean }): Promise<TestTenant & { jobId: string }> {
    const t = await createTestTenant(pool);
    if (opts.settingsRow) {
      await new PgSettingsRepository(pool).create({
        id: crypto.randomUUID(),
        tenantId: t.tenantId,
        businessName: 'Lock Test HVAC',
        estimatePrefix: 'EST',
        invoicePrefix: 'INV',
        nextEstimateNumber: 1,
        nextInvoiceNumber: 1,
        defaultPaymentTermDays: 30,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
    }
    const customerId = crypto.randomUUID();
    await new PgCustomerRepository(pool).create({
      id: customerId,
      tenantId: t.tenantId,
      firstName: 'Lock',
      lastName: 'Case',
      displayName: 'Lock Case',
      primaryPhone: '+15555550142',
      email: 'lock-case@example.com',
      preferredChannel: 'sms',
      smsConsent: true,
      isArchived: false,
      createdBy: t.userId,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const locationId = crypto.randomUUID();
    await new PgLocationRepository(pool).create({
      id: locationId,
      tenantId: t.tenantId,
      customerId,
      street1: '4 Lock Lane',
      city: 'Austin',
      state: 'TX',
      postalCode: '78701',
      country: 'USA',
      isPrimary: true,
      addressType: 'service',
      isArchived: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const jobId = crypto.randomUUID();
    await new PgJobRepository(pool).create({
      id: jobId,
      tenantId: t.tenantId,
      customerId,
      locationId,
      jobNumber: `JOB-${jobId.slice(0, 6)}`,
      summary: 'Lock test job',
      status: 'completed',
      priority: 'normal',
      createdBy: t.userId,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    return { ...t, jobId };
  }

  async function seedInvoice(t: TestTenant & { jobId: string }): Promise<{ id: string; viewToken: string; amountDueCents: number }> {
    const repo = new PgInvoiceRepository(pool);
    const id = crypto.randomUUID();
    const viewToken = crypto.randomBytes(24).toString('base64url');
    const lineItems = [buildLineItem(crypto.randomUUID(), 'Service', 1, 32500, 0, true, 'labor')];
    const totals = calculateDocumentTotals(lineItems, 0, 0);
    await repo.create({
      id,
      tenantId: t.tenantId,
      jobId: t.jobId,
      invoiceNumber: `INV-${id.slice(0, 8)}`,
      status: 'open',
      lineItems,
      totals,
      amountPaidCents: 0,
      amountDueCents: totals.totalCents,
      createdBy: t.userId,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await repo.update(t.tenantId, id, {
      viewToken,
      viewTokenExpiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      updatedAt: new Date(),
    });
    return { id, viewToken, amountDueCents: totals.totalCents };
  }

  async function linkColumns(tenantId: string, invoiceId: string) {
    const { rows } = await pool.query<{ stripe_payment_link_id: string | null; stripe_payment_link_url: string | null }>(
      'SELECT stripe_payment_link_id, stripe_payment_link_url FROM invoices WHERE tenant_id = $1 AND id = $2',
      [tenantId, invoiceId],
    );
    return rows[0];
  }

  async function storedMode(tenantId: string): Promise<string | null | undefined> {
    const { rows } = await pool.query<{ payment_collection_mode: string | null }>(
      'SELECT payment_collection_mode FROM tenant_settings WHERE tenant_id = $1',
      [tenantId],
    );
    return rows.length === 0 ? undefined : rows[0].payment_collection_mode;
  }

  async function auditRows(tenantId: string, invoiceId: string, eventType: string) {
    const { rows } = await pool.query<{ metadata: Record<string, unknown> }>(
      `SELECT metadata FROM audit_events
        WHERE tenant_id = $1 AND entity_id = $2 AND event_type = $3
        ORDER BY created_at`,
      [tenantId, invoiceId, eventType],
    );
    return rows.map((r) => r.metadata);
  }

  const link = (tag: string) => ({ linkId: `plink_${tag}`, linkUrl: `https://pay.stripe.com/${tag}` });

  beforeAll(async () => {
    pool = await getSharedTestDb();
    auditRepo = new PgAuditRepository(pool);
    attachSpy = new SpyPool();
    writeSpy = new SpyPool();
    routeSpy = new SpyPool();

    // A `tenant_settings` that raises a REAL Postgres error only while
    // FAULT_GUC is on in the transaction; otherwise it reads through to the
    // real table (as the invoker, so RLS still applies). Pool-local via
    // search_path; dropped in afterAll.
    await pool.query(`DROP SCHEMA IF EXISTS ${FAULT_SCHEMA} CASCADE`);
    await pool.query(`CREATE SCHEMA ${FAULT_SCHEMA}`);
    await pool.query(`
      CREATE FUNCTION ${FAULT_SCHEMA}.tenant_settings_or_fault()
      RETURNS SETOF public.tenant_settings LANGUAGE plpgsql AS $$
      BEGIN
        IF current_setting('${FAULT_GUC}', true) = 'on' THEN
          RAISE EXCEPTION '${FAULT_MESSAGE}';
        END IF;
        RETURN QUERY SELECT * FROM public.tenant_settings;
      END $$;
      CREATE VIEW ${FAULT_SCHEMA}.tenant_settings AS
        SELECT * FROM ${FAULT_SCHEMA}.tenant_settings_or_fault();
      GRANT USAGE ON SCHEMA ${FAULT_SCHEMA} TO rls_app_runtime;
      GRANT SELECT ON ${FAULT_SCHEMA}.tenant_settings TO rls_app_runtime;
      GRANT EXECUTE ON FUNCTION ${FAULT_SCHEMA}.tenant_settings_or_fault() TO rls_app_runtime;
    `);
    faultSpy = new SpyPool({ searchPath: `${FAULT_SCHEMA},public` });
  });

  afterAll(async () => {
    await Promise.all([attachSpy?.end(), writeSpy?.end(), routeSpy?.end(), faultSpy?.end()]);
    await pool.query(`DROP SCHEMA IF EXISTS ${FAULT_SCHEMA} CASCADE`);
    await closeSharedTestDb();
  });

  // ── (a) lock order and the one key ────────────────────────────────────────

  it('(a) the attach takes the shared key as its own statement before the mode read and the UPDATE; the settings write takes the same key exclusively first', async () => {
    const t = await seedTenant({ settingsRow: true });
    const inv = await seedInvoice(t);
    const repo = new PgInvoiceRepository(attachSpy.pool);
    const from = attachSpy.log.length;
    const result = await repo.attachPaymentLink(t.tenantId, inv.id, link('order'), inv.amountDueCents, new Date());
    expect(result.ok).toBe(true);

    const mine = attachSpy.log.slice(from);
    const iLock = mine.findIndex((s) => LOCK_SHARED.test(s.text));
    const iMode = mine.findIndex((s) => MODE_READ.test(s.text));
    const iUpdate = mine.findIndex((s) => ATTACH_UPDATE.test(s.text));
    expect(iLock).toBeGreaterThanOrEqual(0);
    expect(iLock).toBeLessThan(iMode);
    expect(iMode).toBeLessThan(iUpdate);
    expect(mine[iLock].values).toEqual([paymentModeLockKey(t.tenantId)]);
    expect(mine[iLock].values).toEqual([`payment_mode:${t.tenantId}`]);
    // The UPDATE repeats the mode predicate (belt and braces).
    expect(mine[iUpdate].text).toMatch(/payment_collection_mode FROM tenant_settings/);

    const settings = new PgSettingsRepository(writeSpy.pool);
    const wFrom = writeSpy.log.length;
    await settings.update(t.tenantId, { paymentCollectionMode: 'collect_on_site' });
    const writes = writeSpy.log.slice(wFrom);
    const wLock = writes.findIndex((s) => LOCK_EXCLUSIVE.test(s.text));
    const wFirstSettings = writes.findIndex((s) => /tenant_settings/.test(s.text));
    expect(wLock).toBeGreaterThanOrEqual(0);
    expect(wLock).toBeLessThan(wFirstSettings);
    expect(writes[wLock].values).toEqual([paymentModeLockKey(t.tenantId)]);
    expect(writes.some((s) => LOCK_SHARED.test(s.text))).toBe(false);

    // A patch without the key takes no lock at all.
    const nFrom = writeSpy.log.length;
    await settings.update(t.tenantId, { businessName: 'Renamed HVAC' });
    expect(writeSpy.log.slice(nFrom).some((s) => /pg_advisory/.test(s.text))).toBe(false);
  });

  // ── (b) attach vs the settings write, both orders, both sites, ±row ───────

  type WriteSite = 'updateSettings' | 'voicePolicyHandler';

  async function runWrite(
    site: WriteSite,
    tenantId: string,
    userId: string,
    hook?: (ctx: SettingsWriteContext) => Promise<void>,
  ): Promise<void> {
    const settings = new PgSettingsRepository(writeSpy.pool);
    if (site === 'updateSettings') {
      // Exactly as PUT /api/settings calls it, plus the hook S5a-5 wires.
      await updateSettings(tenantId, { paymentCollectionMode: 'collect_on_site' }, settings, {
        preserveVoiceApprovalPin: true,
        ...(hook ? { afterWrite: hook } : {}),
      });
      return;
    }
    const handler = new OnboardingVoicePolicyExecutionHandler(settings, auditRepo);
    const result = await handler.execute(
      {
        id: crypto.randomUUID(),
        tenantId,
        proposalType: 'onboarding_voice_policy',
        status: 'approved',
        payload: { paymentCollectionMode: 'collect_on_site' },
        summary: 'voice policy',
      } as unknown as Proposal,
      { tenantId, executedBy: userId, executedByRole: 'owner' },
    );
    expect(result.success).toBe(true);
  }

  for (const site of ['updateSettings', 'voicePolicyHandler'] as const) {
    for (const settingsRow of [true, false]) {
      const rowLabel = settingsRow ? 'with a settings row' : 'FIRST write, no settings row';

      it(`(b) attach past its check, then the write (${site}, ${rowLabel}): the write waits for the attach's commit and then sees the stored link — looped ×${LOOPS}`, async () => {
        for (let i = 0; i < LOOPS; i++) {
          const t = await seedTenant({ settingsRow });
          const inv = await seedInvoice(t);
          const repo = new PgInvoiceRepository(attachSpy.pool);
          const hold = latch();
          attachSpy.beforeCommit = hold.wait;
          const attaching = repo.attachPaymentLink(t.tenantId, inv.id, link(`a${i}`), inv.amountDueCents, new Date());
          await hold.reached; // lock taken, mode read, UPDATE done; COMMIT held

          const seenByWrite: Array<string | null> = [];
          const wFrom = writeSpy.log.length;
          const writing = runWrite(site, t.tenantId, t.userId, async ({ client, tenantId }) => {
            const { rows } = await client!.query<{ stripe_payment_link_id: string | null }>(
              'SELECT stripe_payment_link_id FROM invoices WHERE tenant_id = $1 AND id = $2',
              [tenantId, inv.id],
            );
            seenByWrite.push(rows[0]?.stripe_payment_link_id ?? null);
          });
          const lockStmt = await writeSpy.waitFor(LOCK_EXCLUSIVE, wFrom);
          await waitForLockWait(lockStmt.pid); // the write is blocked on the key
          expect(await storedMode(t.tenantId)).not.toBe('collect_on_site');

          hold.release();
          const attached = await attaching;
          await writing;
          expect(attached.ok).toBe(true);
          expect(await storedMode(t.tenantId)).toBe('collect_on_site');
          // The write's own transaction, after the lock, sees the link — the
          // precondition for its pass 1 (S5a-5) to deactivate it.
          if (site === 'updateSettings') expect(seenByWrite).toEqual([`plink_a${i}`]);
          expect((await linkColumns(t.tenantId, inv.id)).stripe_payment_link_id).toBe(`plink_a${i}`);
        }
      });

      it(`(b) the write first, holding the key mid-${settingsRow ? 'update' : 'insert'} (${site}, ${rowLabel}): the attach waits, reads collect_on_site and stores nothing — looped ×${LOOPS}`, async () => {
        for (let i = 0; i < LOOPS; i++) {
          const t = await seedTenant({ settingsRow });
          const inv = await seedInvoice(t);
          const hold = latch();
          writeSpy.beforeCommit = hold.wait;
          const writing = runWrite(site, t.tenantId, t.userId);
          await hold.reached; // lock held, row seeded/written; COMMIT held

          const repo = new PgInvoiceRepository(attachSpy.pool);
          const aFrom = attachSpy.log.length;
          const attaching = repo.attachPaymentLink(t.tenantId, inv.id, link(`w${i}`), inv.amountDueCents, new Date());
          const lockStmt = await attachSpy.waitFor(LOCK_SHARED, aFrom);
          await waitForLockWait(lockStmt.pid);

          hold.release();
          await writing;
          expect(await attaching).toEqual({ ok: false, reason: 'mode_not_pay_link' });
          expect(await linkColumns(t.tenantId, inv.id)).toEqual({
            stripe_payment_link_id: null,
            stripe_payment_link_url: null,
          });
          // The refused attach never ran its UPDATE.
          expect(attachSpy.log.slice(aFrom).some((s) => ATTACH_UPDATE.test(s.text))).toBe(false);
        }
      });
    }
  }

  it('(b) afterWrite runs inside the write transaction: its probe row and the mode roll back together when the hook throws', async () => {
    const t = await seedTenant({ settingsRow: true });
    const settings = new PgSettingsRepository(writeSpy.pool);
    const probeId = crypto.randomUUID();
    let seen: { before?: string | null; after?: string | null } = {};
    await expect(
      settings.update(
        t.tenantId,
        { paymentCollectionMode: 'collect_on_site' },
        {
          afterWrite: async ({ client, tenantId, before, after }) => {
            seen = { before: before?.paymentCollectionMode ?? null, after: after.paymentCollectionMode ?? null };
            await client!.query(
              `INSERT INTO audit_events (id, tenant_id, actor_id, actor_role, event_type, entity_type, entity_id, metadata, created_at)
               VALUES ($1, $2, 'system', 'system', 's5a4.probe', 'tenant_settings', $3, '{}'::jsonb, NOW())`,
              [probeId, tenantId, tenantId],
            );
            const { rows } = await client!.query('SELECT 1 FROM audit_events WHERE id = $1', [probeId]);
            expect(rows).toHaveLength(1); // visible inside the transaction
            throw new Error('hook failed after its probe write');
          },
        },
      ),
    ).rejects.toThrow('hook failed after its probe write');
    expect(seen).toEqual({ before: null, after: 'collect_on_site' });
    expect((await pool.query('SELECT 1 FROM audit_events WHERE id = $1', [probeId])).rows).toHaveLength(0);
    expect(await storedMode(t.tenantId)).toBeNull();

    // And a hook that returns lets the write and its probe commit together.
    await settings.update(
      t.tenantId,
      { paymentCollectionMode: 'collect_on_site' },
      {
        afterWrite: async ({ client, tenantId }) => {
          await client!.query(
            `INSERT INTO audit_events (id, tenant_id, actor_id, actor_role, event_type, entity_type, entity_id, metadata, created_at)
             VALUES ($1, $2, 'system', 'system', 's5a4.probe', 'tenant_settings', $3, '{}'::jsonb, NOW())`,
            [probeId, tenantId, tenantId],
          );
        },
      },
    );
    expect((await pool.query('SELECT 1 FROM audit_events WHERE id = $1', [probeId])).rows).toHaveLength(1);
    expect(await storedMode(t.tenantId)).toBe('collect_on_site');
  });

  // ── (c) two attaches, (d) shared vs exclusive holders, the cleanup key ────

  it(`(c) two attaches for one tenant do not block each other (the second runs under lock_timeout 500ms) — looped ×${LOOPS}`, async () => {
    const second = new SpyPool();
    second.afterBegin = ["SET LOCAL lock_timeout = '500ms'"];
    try {
      for (let i = 0; i < LOOPS; i++) {
        const t = await seedTenant({ settingsRow: i % 2 === 0 });
        const first = await seedInvoice(t);
        const other = await seedInvoice(t);
        const hold = latch();
        attachSpy.beforeCommit = hold.wait;
        const attaching = new PgInvoiceRepository(attachSpy.pool).attachPaymentLink(
          t.tenantId, first.id, link(`c1-${i}`), first.amountDueCents, new Date(),
        );
        await hold.reached; // the first attach holds the key SHARED
        const result = await new PgInvoiceRepository(second.pool).attachPaymentLink(
          t.tenantId, other.id, link(`c2-${i}`), other.amountDueCents, new Date(),
        );
        expect(result.ok).toBe(true);
        hold.release();
        expect((await attaching).ok).toBe(true);
      }
    } finally {
      await second.end();
    }
  });

  it('(d) an attach completes while another transaction holds the key SHARED (the cleanup claim) and waits while one holds it EXCLUSIVE; it never touches payment_cleanup', async () => {
    const t = await seedTenant({ settingsRow: true });
    const holder = await pool.connect();
    const quick = new SpyPool();
    quick.afterBegin = ["SET LOCAL lock_timeout = '500ms'"];
    try {
      // A running claim: its own exclusive cleanup key + the mode key shared.
      await holder.query('BEGIN');
      await holder.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`payment_cleanup:${t.tenantId}`]);
      await holder.query('SELECT pg_advisory_xact_lock_shared(hashtext($1))', [paymentModeLockKey(t.tenantId)]);
      const d = await seedInvoice(t);
      const qFrom = quick.log.length;
      const result = await new PgInvoiceRepository(quick.pool).attachPaymentLink(
        t.tenantId, d.id, link('d-shared'), d.amountDueCents, new Date(),
      );
      expect(result.ok).toBe(true);
      const attachStmts = quick.log.slice(qFrom);
      expect(attachStmts.some((s) => s.values.some((v) => String(v).startsWith('payment_cleanup:')))).toBe(false);
      expect(attachStmts.some((s) => /payment_cleanup/.test(s.text))).toBe(false);
      await holder.query('COMMIT');

      // A link cleared elsewhere with the claim marker still set: a fresh
      // attach takes it and the marker reads NULL afterwards.
      await pool.query(
        `UPDATE invoices SET stripe_payment_link_id = NULL, stripe_payment_link_url = NULL, cleanup_claimed_at = NOW()
          WHERE tenant_id = $1 AND id = $2`,
        [t.tenantId, d.id],
      );
      const again = await new PgInvoiceRepository(quick.pool).attachPaymentLink(
        t.tenantId, d.id, link('d-again'), d.amountDueCents, new Date(),
      );
      expect(again.ok).toBe(true);
      const { rows } = await pool.query<{ cleanup_claimed_at: Date | null }>(
        'SELECT cleanup_claimed_at FROM invoices WHERE id = $1',
        [d.id],
      );
      expect(rows[0].cleanup_claimed_at).toBeNull();

      // An EXCLUSIVE holder (the settings write) makes the attach wait.
      const e = await seedInvoice(t);
      await holder.query('BEGIN');
      await holder.query('SELECT pg_advisory_xact_lock(hashtext($1))', [paymentModeLockKey(t.tenantId)]);
      const aFrom = attachSpy.log.length;
      const waiting = new PgInvoiceRepository(attachSpy.pool).attachPaymentLink(
        t.tenantId, e.id, link('d-excl'), e.amountDueCents, new Date(),
      );
      const lockStmt = await attachSpy.waitFor(LOCK_SHARED, aFrom);
      await waitForLockWait(lockStmt.pid);
      await holder.query('COMMIT');
      expect((await waiting).ok).toBe(true);
    } finally {
      await holder.query('ROLLBACK').catch(() => undefined);
      holder.release();
      await quick.end();
    }
  });

  // ── unchanged mode attaches as today ──────────────────────────────────────

  it('stored pay_link, an unset key and no settings row each attach as today; a void during the mint still loses as not_payable', async () => {
    const stored = await seedTenant({ settingsRow: true });
    await new PgSettingsRepository(pool).update(stored.tenantId, { paymentCollectionMode: 'pay_link' });
    const unset = await seedTenant({ settingsRow: true });
    const noRow = await seedTenant({ settingsRow: false });
    const repo = new PgInvoiceRepository(pool);
    for (const [t, tag] of [[stored, 'stored'], [unset, 'unset'], [noRow, 'norow']] as const) {
      const inv = await seedInvoice(t);
      const result = await repo.attachPaymentLink(t.tenantId, inv.id, link(tag), inv.amountDueCents, new Date());
      expect(result.ok && result.invoice.stripePaymentLinkId).toBe(`plink_${tag}`);
      expect((await linkColumns(t.tenantId, inv.id)).stripe_payment_link_url).toBe(`https://pay.stripe.com/${tag}`);
      expect(await heldModeLocks(t.tenantId)).toBe(0);
    }
    const voided = await seedInvoice(unset);
    await repo.update(unset.tenantId, voided.id, { status: 'void', updatedAt: new Date() });
    expect(await repo.attachPaymentLink(unset.tenantId, voided.id, link('void'), voided.amountDueCents, new Date())).toEqual({
      ok: false,
      reason: 'not_payable',
    });
  });

  // ── (e) the stall case at every mint site ─────────────────────────────────

  /** A provider "stuck in Stripe": generateLink waits on a latch after minting. */
  class LatchedProvider extends MockPaymentLinkProvider {
    gate = latch();
    mintScopes: Array<string | undefined> = [];
    locksAtDeactivation: number[] = [];
    failDeactivation = false;
    constructor(private readonly tenantId: string) {
      super();
    }
    override async generateLink(request: PaymentLinkRequest): Promise<PaymentLinkResult> {
      const result = await super.generateLink(request);
      this.mintScopes.push(request.stripeAccountId);
      await this.gate.wait();
      return result;
    }
    override async deactivateLink(linkId: string, stripeAccountId?: string, options?: DeactivateLinkOptions): Promise<void> {
      // No Stripe call under a Postgres lock: the attach's savepoint
      // released the shared key before the refusal reached the mint site.
      this.locksAtDeactivation.push(await heldModeLocks(this.tenantId));
      await super.deactivateLink(linkId, stripeAccountId, options);
      if (this.failDeactivation) throw new Error('stripe deactivate unavailable');
    }
  }

  const connectResolver: ConnectAccountResolver = {
    resolveTenantConnectAccount: async () => ({ accountId: CONNECT_ACCOUNT, chargesEnabled: true }),
  } as unknown as ConnectAccountResolver;

  /** While the provider is latched: no advisory lock held, and the owner's switch commits without waiting. */
  async function switchDuringMint(t: TestTenant, provider: { gate: { reached: Promise<void>; release: () => void } }) {
    await provider.gate.reached;
    expect(await heldModeLocks(t.tenantId)).toBe(0);
    const switched = updateSettings(t.tenantId, { paymentCollectionMode: 'collect_on_site' }, new PgSettingsRepository(pool), {
      preserveVoiceApprovalPin: true,
    });
    const outcome = await Promise.race([
      switched.then(() => 'committed'),
      new Promise((r) => { setTimeout(() => r('blocked'), 5_000); }),
    ]);
    expect(outcome).toBe('committed');
    expect(await storedMode(t.tenantId)).toBe('collect_on_site');
    provider.gate.release();
  }

  async function expectRefusedAttach(t: TestTenant, invoiceId: string, linkId: string, spy: SpyPool, from: number) {
    expect(await linkColumns(t.tenantId, invoiceId)).toEqual({ stripe_payment_link_id: null, stripe_payment_link_url: null });
    // A statement spy sees no write of the link columns.
    expect(spy.log.slice(from).some((s) => ATTACH_UPDATE.test(s.text))).toBe(false);
    expect(spy.log.slice(from).some((s) => s.values.includes(linkId) && /^UPDATE invoices\s+SET stripe_payment_link_id = \$3/.test(s.text))).toBe(false);
    // Nothing for a later cleanup or the sweep to find.
    expect(await new PgInvoiceRepository(pool).findOpenWithPaymentLink(t.tenantId, null, 50)).toEqual([]);
  }

  function operatorApp(t: TestTenant, provider: MockPaymentLinkProvider, spy: SpyPool) {
    const app = express();
    app.use(express.json());
    app.use((req: Request, _res: Response, next: NextFunction) => {
      (req as AuthenticatedRequest).auth = { userId: t.userId, sessionId: 'sess-s5a4', tenantId: t.tenantId, role: 'owner' };
      next();
    });
    app.use('/api', withTenantTransaction(spy.pool));
    const audit = new PgAuditRepository(spy.pool);
    app.use(
      '/api/invoices',
      createInvoiceRouter(
        new PgInvoiceRepository(spy.pool),
        new PgSettingsRepository(spy.pool),
        audit,
        permissiveTenantOwnership(),
        undefined,
        undefined,
        undefined,
        undefined,
        provider,
        undefined,
        undefined,
        connectResolver,
      ),
    );
    return app;
  }

  it('(e) operator route, under the request transaction: the stalled checkout stores nothing, deactivates under the minting scope, audits, answers 409 COLLECT_ON_SITE', async () => {
    const t = await seedTenant({ settingsRow: true });
    const inv = await seedInvoice(t);
    const provider = new LatchedProvider(t.tenantId);
    const from = routeSpy.log.length;
    const pending = request(operatorApp(t, provider, routeSpy)).post(`/api/invoices/${inv.id}/payment-link`).send({}).then((r) => r);
    await switchDuringMint(t, provider);
    const res = await pending;

    expect(res.status).toBe(409);
    expect(res.body.error).toBe('COLLECT_ON_SITE');
    expect(String(res.body.message)).not.toMatch(/Invoice changed/i);
    const minted = provider.deactivations[0].linkId;
    expect(provider.mintScopes).toEqual([CONNECT_ACCOUNT]);
    expect(provider.deactivations).toEqual([{ linkId: minted, stripeAccountId: CONNECT_ACCOUNT, inactiveMessage: undefined }]);
    expect(provider.locksAtDeactivation).toEqual([0]);
    await expectRefusedAttach(t, inv.id, minted, routeSpy, from);
    // The audit row survives the 409: the refusal commits what it wrote.
    expect(await auditRows(t.tenantId, inv.id, 'invoice.payment_link_deactivated')).toEqual([
      { stripePaymentLinkId: minted, reason: 'payment_mode_changed_during_checkout' },
    ]);
  });

  it('(e) operator route: a failing Stripe deactivation of the stalled link is audited with the link id', async () => {
    const t = await seedTenant({ settingsRow: false });
    const inv = await seedInvoice(t);
    const provider = new LatchedProvider(t.tenantId);
    provider.failDeactivation = true;
    const pending = request(operatorApp(t, provider, routeSpy)).post(`/api/invoices/${inv.id}/payment-link`).send({}).then((r) => r);
    await switchDuringMint(t, provider);
    const res = await pending;
    expect(res.status).toBe(409);
    const failed = await auditRows(t.tenantId, inv.id, 'invoice.payment_link_deactivation_failed');
    expect(failed).toHaveLength(1);
    expect(failed[0]).toMatchObject({
      stripePaymentLinkId: provider.deactivations[0].linkId,
      reason: 'payment_mode_changed_during_checkout',
    });
    expect(await linkColumns(t.tenantId, inv.id)).toEqual({ stripe_payment_link_id: null, stripe_payment_link_url: null });
  });

  it('(e) operator route: the attach\'s mode read raises a real Postgres error → 503, nothing stored, link deactivated, both audits committed (the savepoint keeps the request transaction usable)', async () => {
    const t = await seedTenant({ settingsRow: true });
    await new PgSettingsRepository(pool).update(t.tenantId, { paymentCollectionMode: 'pay_link' });
    const inv = await seedInvoice(t);
    const provider = new MockPaymentLinkProvider();
    faultSpy.beforeStatement = { match: LOCK_SHARED, sql: `SELECT set_config('${FAULT_GUC}', 'on', true)` };
    try {
      const res = await request(operatorApp(t, provider, faultSpy)).post(`/api/invoices/${inv.id}/payment-link`).send({});
      expect(res.status).toBe(503);
      expect(res.body.error).toBe('PAYMENT_MODE_UNAVAILABLE');
    } finally {
      faultSpy.beforeStatement = null;
    }
    expect(provider.deactivations).toHaveLength(1);
    const minted = provider.deactivations[0].linkId;
    expect(provider.isActive(minted)).toBe(false);
    expect(await linkColumns(t.tenantId, inv.id)).toEqual({ stripe_payment_link_id: null, stripe_payment_link_url: null });
    expect(await auditRows(t.tenantId, inv.id, 'invoice.payment_link_deactivated')).toEqual([
      { stripePaymentLinkId: minted, reason: 'payment_mode_changed_during_checkout' },
    ]);
    const unavailable = await auditRows(t.tenantId, inv.id, 'invoice.payment_mode_unavailable');
    expect(unavailable).toHaveLength(1);
    expect(unavailable[0]).toMatchObject({ surface: 'checkout' });
    expect(String(unavailable[0].error)).toContain(FAULT_MESSAGE);
  });

  function publicService(provider: MockPaymentLinkProvider | undefined, spy: SpyPool, stripeFetch?: typeof fetch) {
    return new PublicInvoiceService({
      invoiceRepo: new PgInvoiceRepository(spy.pool),
      jobRepo: new PgJobRepository(pool),
      customerRepo: new PgCustomerRepository(pool),
      settingsRepo: new PgSettingsRepository(pool),
      auditRepo,
      connectAccountResolver: connectResolver,
      ...(provider ? { paymentLinkProvider: provider } : {}),
      ...(stripeFetch ? { stripeConfig: { apiKey: 'sk_test_s5a4' }, stripeFetch } : {}),
    });
  }

  it('(e) public checkout, provider path: the stalled checkout stores nothing, deactivates, audits, answers 409 (not "invoice changed")', async () => {
    const t = await seedTenant({ settingsRow: false });
    const inv = await seedInvoice(t);
    const provider = new LatchedProvider(t.tenantId);
    const app = express();
    app.use(express.json());
    app.use('/public/invoices', createPublicInvoicesRouter(publicService(provider, attachSpy)));
    const from = attachSpy.log.length;
    const pending = request(app).post(`/public/invoices/${inv.viewToken}/checkout`).send({}).then((r) => r);
    await switchDuringMint(t, provider);
    const res = await pending;

    expect(res.status).toBe(409);
    expect(res.body.error).toBe('COLLECT_ON_SITE');
    expect(String(res.body.message)).not.toMatch(/Invoice changed/i);
    const minted = provider.deactivations[0].linkId;
    expect(provider.deactivations).toHaveLength(1);
    expect(provider.locksAtDeactivation).toEqual([0]);
    await expectRefusedAttach(t, inv.id, minted, attachSpy, from);
    expect(await auditRows(t.tenantId, inv.id, 'invoice.payment_link_deactivated')).toEqual([
      { stripePaymentLinkId: minted, reason: 'payment_mode_changed_during_checkout' },
    ]);
  });

  it('(e) public checkout, direct-Stripe path: the stalled mint is deactivated with the minting Stripe-Account, audited, 409', async () => {
    const t = await seedTenant({ settingsRow: true });
    const inv = await seedInvoice(t);
    const gate = latch();
    const calls: Array<{ url: string; account?: string; body: string; locks: number }> = [];
    const stripeFetch = (async (url: string, init?: { headers?: Record<string, string>; body?: URLSearchParams }) => {
      calls.push({
        url: String(url),
        account: init?.headers?.['Stripe-Account'],
        body: String(init?.body ?? ''),
        locks: await heldModeLocks(t.tenantId),
      });
      if (String(url).endsWith('/v1/payment_links')) {
        await gate.wait();
        return { ok: true, status: 200, text: async () => '', json: async () => ({ id: 'plink_direct_s5a4', url: 'https://buy.stripe.com/test_s5a4' }) };
      }
      return { ok: true, status: 200, text: async () => '', json: async () => ({}) };
    }) as unknown as typeof fetch;
    const app = express();
    app.use(express.json());
    app.use('/public/invoices', createPublicInvoicesRouter(publicService(undefined, attachSpy, stripeFetch)));
    const from = attachSpy.log.length;
    const pending = request(app).post(`/public/invoices/${inv.viewToken}/checkout`).send({}).then((r) => r);
    await switchDuringMint(t, { gate });
    const res = await pending;

    expect(res.status).toBe(409);
    expect(res.body.error).toBe('COLLECT_ON_SITE');
    expect(calls.map((c) => [c.url, c.account, c.locks])).toEqual([
      ['https://api.stripe.com/v1/payment_links', CONNECT_ACCOUNT, 0],
      ['https://api.stripe.com/v1/payment_links/plink_direct_s5a4', CONNECT_ACCOUNT, 0],
    ]);
    expect(calls[1].body).toBe('active=false');
    await expectRefusedAttach(t, inv.id, 'plink_direct_s5a4', attachSpy, from);
    expect(await auditRows(t.tenantId, inv.id, 'invoice.payment_link_deactivated')).toEqual([
      { stripePaymentLinkId: 'plink_direct_s5a4', reason: 'payment_mode_changed_during_checkout' },
    ]);
  });

  it('(e) portal invoice list: the stalled mint stores nothing, is deactivated and audited, and the row shows pay in person', async () => {
    const t = await seedTenant({ settingsRow: true });
    const inv = await seedInvoice(t);
    const { rows } = await pool.query<{ customer_id: string }>('SELECT customer_id FROM jobs WHERE id = $1', [t.jobId]);
    const token = crypto.randomBytes(32).toString('hex');
    await new PgPortalSessionRepository(pool).create({
      id: crypto.randomUUID(),
      tenantId: t.tenantId,
      customerId: rows[0].customer_id,
      tokenHash: hashPortalToken(token),
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      createdBy: t.userId,
      createdAt: new Date(),
    });
    const provider = new LatchedProvider(t.tenantId);
    const app = express();
    app.use(express.json());
    app.use(
      '/api/public/portal',
      createPublicPortalRouter({
        portalRepo: new PgPortalSessionRepository(pool),
        customerRepo: new PgCustomerRepository(pool),
        estimateRepo: new PgEstimateRepository(pool),
        invoiceRepo: new PgInvoiceRepository(attachSpy.pool),
        jobRepo: new PgJobRepository(pool),
        agreementRepo: new PgAgreementRepository(pool),
        appointmentRepo: new PgAppointmentRepository(pool),
        leadRepo: new PgLeadRepository(pool),
        auditRepo,
        settingsRepo: new PgSettingsRepository(pool),
        paymentLinkProvider: provider,
      }),
    );
    const from = attachSpy.log.length;
    const pending = request(app).get(`/api/public/portal/${token}/invoices`).then((r) => r);
    await switchDuringMint(t, provider);
    const res = await pending;

    expect(res.status).toBe(200);
    expect(res.body.invoices).toHaveLength(1);
    expect(res.body.invoices[0]).toMatchObject({ id: inv.id, payNowUrl: null, collectOnSite: true });
    const minted = provider.deactivations[0].linkId;
    expect(provider.deactivations).toHaveLength(1);
    expect(provider.locksAtDeactivation).toEqual([0]);
    await expectRefusedAttach(t, inv.id, minted, attachSpy, from);
    expect(await auditRows(t.tenantId, inv.id, 'invoice.payment_link_deactivated')).toEqual([
      { stripePaymentLinkId: minted, reason: 'payment_mode_changed_during_checkout' },
    ]);
  });
  // ══ S5a-5 — the mode-change enqueue and the deactivate_payment_links job ══

  describe('the cleanup job (S5a-5): atomic enqueue, claim, act, superseded, unreadable, pass 2', () => {
    const JOB = DEACTIVATE_PAYMENT_LINKS_JOB_TYPE;
    let queue: PgQueue;
    let claimSpy: SpyPool;

    beforeAll(async () => {
      queue = new PgQueue(pool);
      // PgQueue creates `_queue_messages` lazily, and the first legs read it
      // before anything is enqueued: bootstrap it so the block also passes on
      // a fresh database where no earlier file has used the queue.
      await queue.depth();
      claimSpy = new SpyPool();
    });

    afterAll(async () => {
      await claimSpy?.end();
      await pool.query(`DELETE FROM _queue_messages WHERE type = $1`, [JOB]);
    });

    interface JobRow {
      id: string;
      payload: DeactivatePaymentLinksPayload;
      idempotency_key: string;
      visible_in_seconds: number;
      created_at: Date;
    }

    async function jobRows(tenantId: string): Promise<JobRow[]> {
      const { rows } = await pool.query<JobRow>(
        `SELECT id, payload, idempotency_key, created_at,
                EXTRACT(EPOCH FROM (visible_at - NOW()))::float AS visible_in_seconds
           FROM _queue_messages
          WHERE type = $1 AND payload->>'tenantId' = $2
          ORDER BY created_at, idempotency_key`,
        [JOB, tenantId],
      );
      return rows;
    }

    function asMessage(row: Pick<JobRow, 'id' | 'payload' | 'idempotency_key'>): QueueMessage<DeactivatePaymentLinksPayload> {
      return {
        id: row.id,
        type: JOB,
        payload: row.payload,
        attempts: 1,
        maxAttempts: 3,
        idempotencyKey: row.idempotency_key,
        createdAt: new Date().toISOString(),
      };
    }

    async function settingsUpdatedAt(tenantId: string): Promise<Date> {
      const { rows } = await pool.query<{ updated_at: Date }>(
        'SELECT updated_at FROM tenant_settings WHERE tenant_id = $1',
        [tenantId],
      );
      return rows[0].updated_at;
    }

    /** Advisory locks granted on a key, from any backend. */
    async function heldLocks(key: string): Promise<number> {
      const { rows } = await pool.query<{ n: string }>(
        `SELECT count(*) AS n FROM pg_locks
          WHERE locktype = 'advisory' AND granted AND objsubid = 1
            AND objid = ((hashtext($1)::bigint) & 4294967295)::oid
            AND classid = (((hashtext($1)::bigint) >> 32) & 4294967295)::oid`,
        [key],
      );
      return Number(rows[0].n);
    }

    /** The provider fake: per-link latches, a per-link failure switch, and the lock facts at each call. */
    class JobProvider extends MockPaymentLinkProvider {
      readonly gates = new Map<string, ReturnType<typeof latch>>();
      readonly failing = new Set<string>();
      readonly locksDuringCall: number[] = [];
      constructor(private readonly tenantId: string) {
        super();
      }
      override async deactivateLink(linkId: string, stripeAccountId?: string, options?: DeactivateLinkOptions): Promise<void> {
        this.locksDuringCall.push(
          (await heldLocks(paymentModeLockKey(this.tenantId))) + (await heldLocks(paymentCleanupLockKey(this.tenantId))),
        );
        const gate = this.gates.get(linkId);
        if (gate) {
          this.gates.delete(linkId);
          await gate.wait();
        }
        if (this.failing.has(linkId)) throw new Error(`stripe deactivate unavailable for ${linkId}`);
        await super.deactivateLink(linkId, stripeAccountId, options);
      }
      deactivatedIds(): string[] {
        return this.deactivations.map((d) => d.linkId);
      }
    }

    function jobWorker(provider: MockPaymentLinkProvider, claimPool: Pool = pool) {
      return createDeactivatePaymentLinksWorker({
        claimNext: createPgPaymentLinkClaimer(claimPool, queue),
        invoiceRepo: new PgInvoiceRepository(pool),
        provider,
        connectAccountResolver: connectResolver,
        settingsRepo: new PgSettingsRepository(pool),
        userRepo: new PgUserRepository(pool),
        auditRepo,
      });
    }

    const quiet = createLogger({ service: 's5a5-int', environment: 'test' });

    /** A tenant with invoices that each hold a link stored through the real attach (mode pay_link then). */
    async function seedLinked(opts: { settingsRow: boolean; links: number; plain?: number; ownerFirstName?: string }) {
      const t = await seedTenant({ settingsRow: opts.settingsRow });
      if (opts.ownerFirstName) {
        await pool.query('UPDATE users SET first_name = $1 WHERE id = $2', [opts.ownerFirstName, t.userId]);
      }
      const repo = new PgInvoiceRepository(pool);
      const linked: Array<{ id: string; linkId: string }> = [];
      for (let i = 0; i < opts.links; i++) {
        const inv = await seedInvoice(t);
        const l = link(`${t.tenantId.slice(0, 8)}_${i}_${crypto.randomUUID().slice(0, 6)}`);
        const attached = await repo.attachPaymentLink(t.tenantId, inv.id, l, inv.amountDueCents, new Date());
        expect(attached.ok).toBe(true);
        linked.push({ id: inv.id, linkId: l.linkId });
      }
      const plain: Array<{ id: string; viewToken: string; amountDueCents: number }> = [];
      for (let i = 0; i < (opts.plain ?? 0); i++) plain.push(await seedInvoice(t));
      // Keyset order is by id: the claims walk them in this order.
      linked.sort((a, b) => (a.id < b.id ? -1 : 1));
      return { t, linked, plain };
    }

    async function switchTo(tenantId: string, mode: 'pay_link' | 'collect_on_site', spyPool: Pool = pool) {
      await updateSettings(tenantId, { paymentCollectionMode: mode }, new PgSettingsRepository(spyPool), {
        preserveVoiceApprovalPin: true,
        paymentModeQueue: queue,
      });
    }

    async function tenantEvents(tenantId: string, eventType: string) {
      const { rows } = await pool.query<{ entity_type: string; metadata: Record<string, unknown> }>(
        `SELECT entity_type, metadata FROM audit_events
          WHERE tenant_id = $1 AND entity_id = $3 AND event_type = $2 ORDER BY created_at`,
        [tenantId, eventType, tenantId],
      );
      return rows;
    }

    async function claimedAt(tenantId: string, invoiceId: string): Promise<Date | null> {
      const { rows } = await pool.query<{ cleanup_claimed_at: Date | null }>(
        'SELECT cleanup_claimed_at FROM invoices WHERE tenant_id = $1 AND id = $2',
        [tenantId, invoiceId],
      );
      return rows[0].cleanup_claimed_at;
    }

    async function pass1(tenantId: string): Promise<JobRow> {
      const rows = (await jobRows(tenantId)).filter((r) => r.payload.pass === 1);
      expect(rows).toHaveLength(1);
      return rows[0];
    }

    // ── links deactivated on a switch, both write sites ─────────────────────

    function settingsApp(t: TestTenant, spyPool: Pool) {
      const app = express();
      app.use(express.json());
      app.use((req: Request, _res: Response, next: NextFunction) => {
        (req as AuthenticatedRequest).auth = { userId: t.userId, sessionId: 'sess-s5a5', tenantId: t.tenantId, role: 'owner' };
        next();
      });
      app.use('/api', withTenantTransaction(spyPool));
      app.use(
        '/api/settings',
        createSettingsRouter(new PgSettingsRepository(spyPool), undefined, new PgAuditRepository(spyPool), undefined, undefined, undefined, { queue }),
      );
      return app;
    }

    async function writeVia(site: 'PUT /api/settings' | 'voicePolicyHandler', t: TestTenant, mode: 'pay_link' | 'collect_on_site', spyPool: Pool) {
      if (site === 'PUT /api/settings') {
        const res = await request(settingsApp(t, spyPool)).put('/api/settings').send({ paymentCollectionMode: mode });
        return res.status;
      }
      const handler = new OnboardingVoicePolicyExecutionHandler(new PgSettingsRepository(spyPool), auditRepo, queue);
      const result = await handler.execute(
        {
          id: crypto.randomUUID(),
          tenantId: t.tenantId,
          proposalType: 'onboarding_voice_policy',
          status: 'approved',
          payload: { paymentCollectionMode: mode },
          summary: 'voice policy',
        } as unknown as Proposal,
        { tenantId: t.tenantId, executedBy: t.userId, executedByRole: 'owner' },
      );
      return result.success ? 200 : 500;
    }

    for (const site of ['PUT /api/settings', 'voicePolicyHandler'] as const) {
      for (const legacy of [false, true]) {
        it(`${site}: a switch to collect on site over ${legacy ? 'an UNSET key (no settings row: a legacy tenant)' : 'pay_link'} commits one job row with the mode; running it retires exactly the open and partially paid links under the minting scope with the in-person message`, async () => {
          const { t, linked, plain } = await seedLinked({ settingsRow: !legacy, links: 2, plain: 1, ownerFirstName: 'Dana' });
          if (!legacy) await switchTo(t.tenantId, 'pay_link');
          // One link sits on a partially paid invoice; the plain one is paid with cleared columns.
          await pool.query(
            `UPDATE invoices SET status = 'partially_paid', amount_paid_cents = 10000, amount_due_cents = amount_due_cents - 10000
              WHERE tenant_id = $1 AND id = $2`,
            [t.tenantId, linked[1].id],
          );
          await pool.query(
            `UPDATE invoices SET status = 'paid', amount_paid_cents = total_cents, amount_due_cents = 0 WHERE tenant_id = $1 AND id = $2`,
            [t.tenantId, plain[0].id],
          );
          expect(await jobRows(t.tenantId)).toEqual([]);

          expect(await writeVia(site, t, 'collect_on_site', pool)).toBe(200);
          const job = await pass1(t.tenantId);
          expect(job.payload).toEqual({ tenantId: t.tenantId, pass: 1 });
          expect(job.idempotency_key).toBe(
            `deactivate-payment-links:${t.tenantId}:${(await settingsUpdatedAt(t.tenantId)).toISOString()}`,
          );

          const provider = new JobProvider(t.tenantId);
          await jobWorker(provider).handle(asMessage(job), quiet);

          expect(provider.deactivatedIds().sort()).toEqual(linked.map((l) => l.linkId).sort());
          for (const d of provider.deactivations) {
            expect(d.stripeAccountId).toBe(CONNECT_ACCOUNT);
            expect(d.inactiveMessage).toBe(
              'Lock Test HVAC collects payment in person. Please settle up with Dana when the work is done.'.replace(
                'Lock Test HVAC',
                legacy ? 'Your service team' : 'Lock Test HVAC',
              ),
            );
          }
          for (const l of linked) {
            expect(await linkColumns(t.tenantId, l.id)).toEqual({ stripe_payment_link_id: null, stripe_payment_link_url: null });
            expect(await claimedAt(t.tenantId, l.id)).toBeNull();
            expect(await auditRows(t.tenantId, l.id, 'invoice.payment_link_deactivated')).toEqual([
              { stripePaymentLinkId: l.linkId, reason: 'payment_mode_changed' },
            ]);
          }
          expect(await auditRows(t.tenantId, plain[0].id, 'invoice.payment_link_deactivated')).toEqual([]);
          expect(provider.locksDuringCall.every((n) => n === 0)).toBe(true);
          expect((await tenantEvents(t.tenantId, 'payment_links.cleanup_completed')).map((r) => r.metadata)).toEqual([
            { pass: 1, deactivated: 2, failed: 0 },
          ]);
        });
      }
    }

    // ── atomic enqueue (two connections), rollback, a killed connection ─────

    for (const site of ['PUT /api/settings', 'voicePolicyHandler'] as const) {
      it(`${site}: the job row is invisible while the settings transaction is open, visible after commit, and its handler then reads collect_on_site`, async () => {
        const { t, linked } = await seedLinked({ settingsRow: true, links: 1 });
        const hold = latch();
        writeSpy.beforeCommit = hold.wait;
        const writing = writeVia(site, t, 'collect_on_site', writeSpy.pool);
        await hold.reached;
        // A second connection (the worker's) sees neither the job nor the mode.
        expect(await jobRows(t.tenantId)).toEqual([]);
        expect(await storedMode(t.tenantId)).toBeNull();
        hold.release();
        expect(await writing).toBe(200);
        const job = await pass1(t.tenantId);
        const provider = new JobProvider(t.tenantId);
        await jobWorker(provider).handle(asMessage(job), quiet);
        expect(provider.deactivatedIds()).toEqual([linked[0].linkId]);
      });

      it(`${site}: a fault after the hook (before COMMIT) and a hook that throws each leave the old mode and no job row`, async () => {
        const { t } = await seedLinked({ settingsRow: true, links: 1 });
        await switchTo(t.tenantId, 'pay_link');
        await pool.query(`DELETE FROM _queue_messages WHERE type = $1 AND payload->>'tenantId' = $2`, [JOB, t.tenantId]);

        // Fault after the hook ran: the COMMIT never happens.
        const from = writeSpy.log.length;
        writeSpy.beforeCommit = async () => {
          throw new Error('fault injected after the hook, before COMMIT');
        };
        expect(await writeVia(site, t, 'collect_on_site', writeSpy.pool).catch(() => 500)).not.toBe(200);
        writeSpy.beforeCommit = null;
        expect(writeSpy.log.slice(from).some((s) => /INSERT INTO _queue_messages/.test(s.text))).toBe(true);
        expect(await storedMode(t.tenantId)).toBe('pay_link');
        expect(await jobRows(t.tenantId)).toEqual([]);

        // A hook that throws: the enqueue itself fails.
        const brokenQueue = new PgQueue(pool);
        brokenQueue.sendOn = async () => {
          throw new Error('enqueue failed');
        };
        if (site === 'PUT /api/settings') {
          const app = express();
          app.use(express.json());
          app.use((req: Request, _res: Response, next: NextFunction) => {
            (req as AuthenticatedRequest).auth = { userId: t.userId, sessionId: 's', tenantId: t.tenantId, role: 'owner' };
            next();
          });
          app.use('/api', withTenantTransaction(pool));
          app.use(
            '/api/settings',
            createSettingsRouter(new PgSettingsRepository(pool), undefined, auditRepo, undefined, undefined, undefined, { queue: brokenQueue }),
          );
          const res = await request(app).put('/api/settings').send({ paymentCollectionMode: 'collect_on_site' });
          expect(res.status).toBeGreaterThanOrEqual(500);
        } else {
          const handler = new OnboardingVoicePolicyExecutionHandler(new PgSettingsRepository(pool), auditRepo, brokenQueue);
          const result = await handler.execute(
            {
              id: crypto.randomUUID(),
              tenantId: t.tenantId,
              proposalType: 'onboarding_voice_policy',
              status: 'approved',
              payload: { paymentCollectionMode: 'collect_on_site' },
              summary: 'voice policy',
            } as unknown as Proposal,
            { tenantId: t.tenantId, executedBy: t.userId, executedByRole: 'owner' },
          );
          expect(result).toEqual({ success: false, error: 'enqueue failed' });
        }
        expect(await storedMode(t.tenantId)).toBe('pay_link');
        expect(await jobRows(t.tenantId)).toEqual([]);
      });

      it(`${site}: a connection killed between the row write and the commit leaves neither the mode nor a job`, async () => {
        const { t } = await seedLinked({ settingsRow: true, links: 1 });
        const hold = latch();
        writeSpy.beforeCommit = hold.wait;
        const from = writeSpy.log.length;
        const writing = writeVia(site, t, 'collect_on_site', writeSpy.pool).catch(() => 500);
        await hold.reached;
        const enqueue = writeSpy.log.slice(from).find((s) => /INSERT INTO _queue_messages/.test(s.text));
        expect(enqueue).toBeDefined();
        await pool.query('SELECT pg_terminate_backend($1)', [enqueue!.pid]);
        hold.release();
        expect(await writing).not.toBe(200);
        expect(await storedMode(t.tenantId)).toBeNull();
        expect(await jobRows(t.tenantId)).toEqual([]);
      });
    }

    // ── the follow-up pass ──────────────────────────────────────────────────

    it('pass 1 inserts exactly one pass 2 under its key plus :pass2, 120 s out; a retry of pass 1 adds none; pass 2 retires a racing link and enqueues nothing', async () => {
      const { t, linked } = await seedLinked({ settingsRow: true, links: 1, plain: 1 });
      await switchTo(t.tenantId, 'collect_on_site');
      const job = await pass1(t.tenantId);
      const provider = new JobProvider(t.tenantId);
      const worker = jobWorker(provider);
      await worker.handle(asMessage(job), quiet);

      const followUps = (await jobRows(t.tenantId)).filter((r) => r.payload.pass === 2);
      expect(followUps).toHaveLength(1);
      expect(followUps[0].idempotency_key).toBe(`${job.idempotency_key}:pass2`);
      expect(followUps[0].idempotency_key).not.toBe(job.idempotency_key);
      expect(followUps[0].visible_in_seconds).toBeGreaterThan(100);
      expect(followUps[0].visible_in_seconds).toBeLessThanOrEqual(120);

      await worker.handle(asMessage(job), quiet); // a retry of pass 1
      expect((await jobRows(t.tenantId)).filter((r) => r.payload.pass === 2)).toHaveLength(1);

      // A link stored by a racing request just after pass 1 (written directly:
      // the attach would refuse it under collect_on_site, which is the point
      // of the attach fence; pass 2 is defence in depth behind it).
      await pool.query(
        `UPDATE invoices SET stripe_payment_link_id = 'plink_racer', stripe_payment_link_url = 'https://pay.stripe.com/racer'
          WHERE tenant_id = $1 AND id <> $2 AND status = 'open'`,
        [t.tenantId, linked[0].id],
      );
      const rowsBefore = (await jobRows(t.tenantId)).length;
      await pool.query(`DELETE FROM _queue_messages WHERE id = $1`, [job.id]);
      await worker.handle(asMessage(followUps[0]), quiet);
      expect(provider.deactivatedIds()).toEqual([linked[0].linkId, 'plink_racer']);
      expect((await jobRows(t.tenantId)).length).toBe(rowsBefore - 1);
    });

    // ── claim statement order and lock scope ────────────────────────────────

    it('the claim takes the cleanup key exclusively first, the payment-mode key shared second, then reads the mode, then selects; the three holders share one mode-key text', async () => {
      const { t } = await seedLinked({ settingsRow: true, links: 1 });
      await switchTo(t.tenantId, 'collect_on_site');
      const from = claimSpy.log.length;
      const claim = await claimNextPaymentLink(claimSpy.pool, queue, { tenantId: t.tenantId, afterId: null, followUpKey: null });
      expect(claim.kind).toBe('claimed');
      const mine = claimSpy.log.slice(from).filter((s) => s.text !== 'BEGIN' && !/^SET|set_config|^SELECT set_config/i.test(s.text));
      const iCleanup = mine.findIndex((s) => LOCK_EXCLUSIVE.test(s.text));
      const iMode = mine.findIndex((s) => LOCK_SHARED.test(s.text));
      const iRead = mine.findIndex((s) => MODE_READ.test(s.text));
      const iSelect = mine.findIndex((s) => /^SELECT id, stripe_payment_link_id FROM invoices/.test(s.text));
      expect(iCleanup).toBeGreaterThanOrEqual(0);
      expect([iCleanup < iMode, iMode < iRead, iRead < iSelect]).toEqual([true, true, true]);
      expect(mine[iCleanup].values).toEqual([`payment_cleanup:${t.tenantId}`]);
      expect(mine[iCleanup].values).toEqual([paymentCleanupLockKey(t.tenantId)]);
      expect(mine[iMode].values).toEqual([paymentModeLockKey(t.tenantId)]);
      // The same mode-key text the attach and the settings write use (leg (a)).
      expect(mine[iMode].values).toEqual([`payment_mode:${t.tenantId}`]);
    });

    it(`a claim and an attach do not block each other; two claims take turns at the cleanup key; a settings write waits for an open claim, and a claim after it reads the new mode — looped ×${LOOPS}`, async () => {
      const attacher = new SpyPool();
      attacher.afterBegin = ["SET LOCAL lock_timeout = '500ms'"];
      const second = new SpyPool();
      try {
        for (let i = 0; i < LOOPS; i++) {
          const { t, linked, plain } = await seedLinked({ settingsRow: true, links: 2, plain: 1 });
          await switchTo(t.tenantId, 'collect_on_site');
          // Claim 1 holds both of its locks (COMMIT latched).
          const hold = latch();
          claimSpy.beforeCommit = hold.wait;
          const first = claimNextPaymentLink(claimSpy.pool, queue, { tenantId: t.tenantId, afterId: null, followUpKey: null });
          await hold.reached;

          // An attach on the plain invoice: payment-mode key shared by both → no wait,
          // and refused only because the mode is collect_on_site (no lock timeout).
          const attached = await new PgInvoiceRepository(attacher.pool).attachPaymentLink(
            t.tenantId, plain[0].id, link(`d${i}_${crypto.randomUUID().slice(0, 4)}`), plain[0].amountDueCents, new Date(),
          );
          expect(attached).toEqual({ ok: false, reason: 'mode_not_pay_link' });

          // A second claim waits on the cleanup key.
          const sFrom = second.log.length;
          const secondClaim = claimNextPaymentLink(second.pool, queue, { tenantId: t.tenantId, afterId: null, followUpKey: null });
          const secondLock = await second.waitFor(LOCK_EXCLUSIVE, sFrom);
          await waitForLockWait(secondLock.pid);

          // A settings write waits for the open claim (exclusive vs shared).
          const wFrom = writeSpy.log.length;
          const writing = switchTo(t.tenantId, 'pay_link', writeSpy.pool);
          const writeLock = await writeSpy.waitFor(LOCK_EXCLUSIVE, wFrom);
          await waitForLockWait(writeLock.pid);

          hold.release();
          const c1 = await first;
          const c2 = await secondClaim;
          await writing;
          expect(c1).toMatchObject({ kind: 'claimed', invoiceId: linked[0].id });
          // The second claim ran before or after the write: claimed the OTHER link, or superseded — never the same link.
          if (c2.kind === 'claimed') expect(c2.invoiceId).toBe(linked[1].id);
          else expect(c2).toEqual({ kind: 'superseded', modeRead: 'pay_link' });
          // A claim that starts after the write reads the new mode.
          expect(await claimNextPaymentLink(pool, queue, { tenantId: t.tenantId, afterId: null, followUpKey: null })).toEqual({
            kind: 'superseded',
            modeRead: 'pay_link',
          });
        }
      } finally {
        claimSpy.beforeCommit = null;
        await Promise.all([attacher.end(), second.end()]);
      }
    });

    // ── a switch back while the cleanup is paging ───────────────────────────

    it(`a switch back while paging (and between a claim and its Stripe call): only the claimed link A is retired, the write commits without waiting, D's new link survives, A re-mints through the attach, pass 2 is superseded — looped ×${LOOPS}`, async () => {
      for (let i = 0; i < LOOPS; i++) {
        const { t, linked, plain } = await seedLinked({ settingsRow: true, links: 3, plain: 1 });
        const [A, B, C] = linked;
        const D = plain[0];
        await switchTo(t.tenantId, 'collect_on_site');
        const job = await pass1(t.tenantId);
        const provider = new JobProvider(t.tenantId);
        const gate = latch();
        provider.gates.set(A.linkId, gate);
        const running = jobWorker(provider).handle(asMessage(job), quiet);
        await gate.reached;

        // Latched in A's Stripe call: no lock and no open claim transaction.
        expect(await heldLocks(paymentModeLockKey(t.tenantId))).toBe(0);
        expect(await heldLocks(paymentCleanupLockKey(t.tenantId))).toBe(0);
        const probe = await pool.connect();
        try {
          await probe.query('BEGIN');
          const { rows } = await probe.query<{ a: boolean; b: boolean }>(
            'SELECT pg_try_advisory_xact_lock(hashtext($1)) AS a, pg_try_advisory_xact_lock(hashtext($2)) AS b',
            [paymentModeLockKey(t.tenantId), paymentCleanupLockKey(t.tenantId)],
          );
          expect(rows[0]).toEqual({ a: true, b: true });
        } finally {
          await probe.query('ROLLBACK');
          probe.release();
        }
        const outcome = await Promise.race([
          switchTo(t.tenantId, 'pay_link').then(() => 'committed'),
          new Promise((r) => { setTimeout(() => r('blocked'), 5_000); }),
        ]);
        expect(outcome).toBe('committed');
        const dLink = link(`D${i}_${crypto.randomUUID().slice(0, 6)}`);
        expect((await new PgInvoiceRepository(pool).attachPaymentLink(t.tenantId, D.id, dLink, D.amountDueCents, new Date())).ok).toBe(true);

        gate.release();
        await running;

        expect(provider.deactivatedIds()).toEqual([A.linkId]);
        expect(await linkColumns(t.tenantId, A.id)).toEqual({ stripe_payment_link_id: null, stripe_payment_link_url: null });
        expect((await linkColumns(t.tenantId, B.id)).stripe_payment_link_id).toBe(B.linkId);
        expect((await linkColumns(t.tenantId, C.id)).stripe_payment_link_id).toBe(C.linkId);
        expect((await linkColumns(t.tenantId, D.id)).stripe_payment_link_id).toBe(dLink.linkId);
        expect((await tenantEvents(t.tenantId, 'payment_links.cleanup_superseded')).map((r) => r.metadata)).toEqual([
          { pass: 1, modeRead: 'pay_link', deactivated: 1, failed: 0 },
        ]);

        // The next checkout on A mints and stores a fresh link (columns empty).
        const aRow = await new PgInvoiceRepository(pool).findById(t.tenantId, A.id);
        const fresh = link(`A${i}_${crypto.randomUUID().slice(0, 6)}`);
        expect((await new PgInvoiceRepository(pool).attachPaymentLink(t.tenantId, A.id, fresh, aRow!.amountDueCents, new Date())).ok).toBe(true);

        // Pass 2 runs later and is superseded at its first claim.
        const followUp = (await jobRows(t.tenantId)).find((r) => r.payload.pass === 2)!;
        await jobWorker(provider).handle(asMessage(followUp), quiet);
        expect(provider.deactivatedIds()).toEqual([A.linkId]);
        expect(await tenantEvents(t.tenantId, 'payment_links.cleanup_superseded')).toHaveLength(2);
      }
    });

    // ── concurrent cleanups of one tenant ───────────────────────────────────

    it(`two cleanups of one tenant, both interleavings: disjoint claims, one deactivateLink and one audit per link, every marker cleared — looped ×${LOOPS}`, async () => {
      for (let i = 0; i < LOOPS; i++) {
        for (const interleaving of ['one in Stripe while the other claims', 'one holds the cleanup mutex while the other starts'] as const) {
          const { t, linked } = await seedLinked({ settingsRow: true, links: 3 });
          await switchTo(t.tenantId, 'collect_on_site');
          const job = await pass1(t.tenantId);
          const provider = new JobProvider(t.tenantId);
          // The second job: the other transition's pass 1 beside this one's pass 2.
          const other = { id: crypto.randomUUID(), payload: { tenantId: t.tenantId, pass: 2 as const }, idempotency_key: `${job.idempotency_key}:pass2` };

          if (interleaving === 'one in Stripe while the other claims') {
            const gate = latch();
            provider.gates.set(linked[0].linkId, gate);
            const first = jobWorker(provider).handle(asMessage(job), quiet);
            await gate.reached;
            await jobWorker(provider).handle(asMessage(other), quiet);
            gate.release();
            await first;
          } else {
            const hold = latch();
            claimSpy.beforeCommit = hold.wait;
            const first = jobWorker(provider, claimSpy.pool).handle(asMessage(job), quiet);
            await hold.reached;
            const second = jobWorker(provider).handle(asMessage(other), quiet);
            hold.release();
            await Promise.all([first, second]);
          }

          const ids = provider.deactivatedIds();
          expect(ids.sort()).toEqual(linked.map((l) => l.linkId).sort());
          for (const l of linked) {
            expect(await auditRows(t.tenantId, l.id, 'invoice.payment_link_deactivated')).toHaveLength(1);
            expect(await auditRows(t.tenantId, l.id, 'invoice.payment_link_deactivation_failed')).toEqual([]);
            expect(await claimedAt(t.tenantId, l.id)).toBeNull();
          }
          // (No global "no lock during a Stripe call" check here: the OTHER
          // job's claim may legitimately hold its locks at that moment. The
          // single-job legs pin that a job never calls Stripe under its own.)
        }
      }
    });

    it(`a retry beside the follow-up pass, in each order: B (failed once, claim released) is retired exactly once; A and C never twice — looped ×${LOOPS}`, async () => {
      for (let i = 0; i < LOOPS; i++) {
        const { t, linked } = await seedLinked({ settingsRow: true, links: 3 });
        const [A, B, C] = linked;
        await switchTo(t.tenantId, 'collect_on_site');
        const job = await pass1(t.tenantId);
        const provider = new JobProvider(t.tenantId);
        provider.failing.add(B.linkId);
        await expect(jobWorker(provider).handle(asMessage(job), quiet)).rejects.toThrow(/1 pay link\(s\) failed/);
        expect(await claimedAt(t.tenantId, B.id)).toBeNull();
        expect((await linkColumns(t.tenantId, B.id)).stripe_payment_link_id).toBe(B.linkId);
        provider.failing.clear();

        const followUp = (await jobRows(t.tenantId)).find((r) => r.payload.pass === 2)!;
        const runs = [jobWorker(provider).handle(asMessage(job), quiet), jobWorker(provider).handle(asMessage(followUp), quiet)];
        if (i % 2 === 1) runs.reverse();
        await Promise.all(runs);

        const counts = provider.deactivatedIds().reduce<Record<string, number>>((m, id) => ({ ...m, [id]: (m[id] ?? 0) + 1 }), {});
        expect(counts).toEqual({ [A.linkId]: 1, [B.linkId]: 1, [C.linkId]: 1 });
        for (const l of [A, B, C]) {
          expect(await auditRows(t.tenantId, l.id, 'invoice.payment_link_deactivated')).toHaveLength(1);
        }
        expect(await auditRows(t.tenantId, B.id, 'invoice.payment_link_deactivation_failed')).toHaveLength(1);
        expect(await auditRows(t.tenantId, A.id, 'invoice.payment_link_deactivation_failed')).toEqual([]);
      }
    });

    // ── a crashed claimer and the lease ─────────────────────────────────────

    it('a crashed claimer: A stays claimed; a job inside the lease retires B and C and skips A; aged 9 minutes A is still skipped; aged 11 minutes it is reclaimed, retired once and its marker cleared', async () => {
      const { t, linked } = await seedLinked({ settingsRow: true, links: 3 });
      const [A, B, C] = linked;
      await switchTo(t.tenantId, 'collect_on_site');
      // The worker claims A, the claim commits, and it dies before Stripe.
      expect(await claimNextPaymentLink(pool, queue, { tenantId: t.tenantId, afterId: null, followUpKey: null })).toEqual({
        kind: 'claimed',
        invoiceId: A.id,
        linkId: A.linkId,
      });
      expect(await claimedAt(t.tenantId, A.id)).not.toBeNull();

      const job = await pass1(t.tenantId);
      const provider = new JobProvider(t.tenantId);
      await jobWorker(provider).handle(asMessage(job), quiet);
      expect(provider.deactivatedIds()).toEqual([B.linkId, C.linkId]);

      await pool.query(`UPDATE invoices SET cleanup_claimed_at = now() - interval '9 minutes' WHERE id = $1`, [A.id]);
      await jobWorker(provider).handle(asMessage(job), quiet);
      expect(provider.deactivatedIds()).toEqual([B.linkId, C.linkId]);

      await pool.query(`UPDATE invoices SET cleanup_claimed_at = now() - interval '11 minutes' WHERE id = $1`, [A.id]);
      await jobWorker(provider).handle(asMessage(job), quiet);
      expect(provider.deactivatedIds()).toEqual([B.linkId, C.linkId, A.linkId]);
      expect(await claimedAt(t.tenantId, A.id)).toBeNull();
      expect(await auditRows(t.tenantId, A.id, 'invoice.payment_link_deactivated')).toHaveLength(1);
    });

    // ── unreadable, unset, no row ───────────────────────────────────────────

    it('the mode read raises a real Postgres error in the claim: rolled back, nothing retired, no pass-2 row, a tenant-level payment_mode_unavailable (surface cleanup), the job throws; the retry after recovery retires the links', async () => {
      const { t, linked } = await seedLinked({ settingsRow: true, links: 2 });
      await switchTo(t.tenantId, 'collect_on_site');
      const job = await pass1(t.tenantId);
      const provider = new JobProvider(t.tenantId);
      faultSpy.afterBegin = [`SET LOCAL ${FAULT_GUC} = 'on'`];
      try {
        await expect(jobWorker(provider, faultSpy.pool).handle(asMessage(job), quiet)).rejects.toThrow(FAULT_MESSAGE);
      } finally {
        faultSpy.afterBegin = [];
      }
      expect(provider.deactivations).toEqual([]);
      expect((await jobRows(t.tenantId)).filter((r) => r.payload.pass === 2)).toEqual([]);
      expect(await tenantEvents(t.tenantId, 'invoice.payment_mode_unavailable')).toEqual([
        { entity_type: 'tenant', metadata: { reason: 'payment_mode_unavailable', surface: 'cleanup', error: FAULT_MESSAGE } },
      ]);
      for (const l of linked) expect(await claimedAt(t.tenantId, l.id)).toBeNull();

      await jobWorker(provider).handle(asMessage(job), quiet);
      expect(provider.deactivatedIds().sort()).toEqual(linked.map((l) => l.linkId).sort());
    });

    it('a failure AFTER the follow-up insert in the first claim rolls the pass-2 row back with the claim (one transaction); a lock that cannot be taken is unreadable too', async () => {
      const { t } = await seedLinked({ settingsRow: true, links: 1 });
      await switchTo(t.tenantId, 'collect_on_site');
      const job = await pass1(t.tenantId);
      const provider = new JobProvider(t.tenantId);
      const from = claimSpy.log.length;
      claimSpy.beforeStatement = { match: /^SELECT id, stripe_payment_link_id FROM invoices/, sql: 'SELECT 1/0' };
      try {
        await expect(jobWorker(provider, claimSpy.pool).handle(asMessage(job), quiet)).rejects.toThrow(/division by zero/);
      } finally {
        claimSpy.beforeStatement = null;
      }
      expect(claimSpy.log.slice(from).some((s) => /INSERT INTO _queue_messages/.test(s.text))).toBe(true);
      expect((await jobRows(t.tenantId)).filter((r) => r.payload.pass === 2)).toEqual([]);
      expect(provider.deactivations).toEqual([]);

      // The cleanup key held elsewhere + a short lock_timeout: the lock throws.
      const holder = await pool.connect();
      const impatient = new SpyPool();
      impatient.afterBegin = ["SET LOCAL lock_timeout = '200ms'"];
      try {
        await holder.query('BEGIN');
        await holder.query('SELECT pg_advisory_xact_lock(hashtext($1))', [paymentCleanupLockKey(t.tenantId)]);
        await expect(jobWorker(provider, impatient.pool).handle(asMessage(job), quiet)).rejects.toThrow(/lock timeout/);
      } finally {
        await holder.query('ROLLBACK');
        holder.release();
        await impatient.end();
      }
      expect(provider.deactivations).toEqual([]);
      expect((await tenantEvents(t.tenantId, 'invoice.payment_mode_unavailable')).map((r) => r.metadata.surface)).toEqual([
        'cleanup',
        'cleanup',
      ]);
    });

    for (const settingsRow of [true, false]) {
      it(`${settingsRow ? 'an unset key' : 'no settings row at all'}: the claim reads the pay_link default and the job is superseded — an absent key is never read as collect_on_site`, async () => {
        const { t, linked } = await seedLinked({ settingsRow, links: 1 });
        if (!settingsRow) {
          await pool.query('DELETE FROM tenant_settings WHERE tenant_id = $1', [t.tenantId]);
        }
        const provider = new JobProvider(t.tenantId);
        const message = asMessage({ id: crypto.randomUUID(), payload: { tenantId: t.tenantId, pass: 1 }, idempotency_key: `manual:${t.tenantId}` });
        await jobWorker(provider).handle(message, quiet);
        expect(provider.deactivations).toEqual([]);
        expect((await linkColumns(t.tenantId, linked[0].id)).stripe_payment_link_id).toBe(linked[0].linkId);
        expect((await tenantEvents(t.tenantId, 'payment_links.cleanup_superseded')).map((r) => r.metadata)).toEqual([
          { pass: 1, modeRead: 'pay_link', deactivated: 0, failed: 0 },
        ]);
        expect(await jobRows(t.tenantId)).toEqual([]);
      });
    }

    // ── S5a-6: the daily reconciliation sweep ───────────────────────────────

    describe('the daily reconciliation sweep (S5a-6): the real enumerator over real tenant_settings and invoices', () => {
      /** The sweep exactly as app.ts runs it: the production enumerator, the real repository, the real queue. */
      async function sweep(at: Date) {
        return runPaymentLinkReconciliationSweep({
          listCollectOnSiteTenantIds: () => listCollectOnSiteTenantIds(pool),
          invoiceRepo: new PgInvoiceRepository(pool),
          queue,
          logger: quiet,
          now: () => at,
        });
      }

      /** Drop the switch's own job rows: the "lost or dead-lettered job" the sweep is the backstop for. */
      async function loseJobs(tenantId: string): Promise<void> {
        await pool.query(`DELETE FROM _queue_messages WHERE type = $1 AND payload->>'tenantId' = $2`, [JOB, tenantId]);
      }

      it('enqueues one pass-1 job per collect-on-site tenant still holding a live link (lost job; link that predates the policy) and none for a tenant with no live link or on pay_link; a second sweep the same day adds nothing; running the jobs retires both links; a tenant that switched back after being listed keeps its link', async () => {
        const previous = process.env.RLS_RUNTIME_ROLE;
        // The enumerator runs with the RLS runtime role in place (the named
        // cross-tenant role for the listing, the tenant role per repository read).
        process.env.RLS_RUNTIME_ROLE = 'true';
        try {
          // A: collect on site, its switch's job lost.
          const lost = await seedLinked({ settingsRow: true, links: 1 });
          await switchTo(lost.t.tenantId, 'collect_on_site');
          await loseJobs(lost.t.tenantId);
          // B: a link that predates the policy (the mode was stored by a path with no cleanup hook).
          const predates = await seedLinked({ settingsRow: true, links: 1 });
          await pool.query(`UPDATE tenant_settings SET payment_collection_mode = 'collect_on_site' WHERE tenant_id = $1`, [
            predates.t.tenantId,
          ]);
          // C: pay_link, holding a link — allowed.
          const payLink = await seedLinked({ settingsRow: true, links: 1 });
          await switchTo(payLink.t.tenantId, 'pay_link');
          // D: collect on site with no live link (one plain invoice).
          const none = await seedLinked({ settingsRow: true, links: 0, plain: 1 });
          await switchTo(none.t.tenantId, 'collect_on_site');
          await loseJobs(none.t.tenantId);
          // E: collect on site with a live link; switches back after the sweep lists it.
          const back = await seedLinked({ settingsRow: true, links: 1 });
          await switchTo(back.t.tenantId, 'collect_on_site');
          await loseJobs(back.t.tenantId);

          // The production enumerator, against real columns, in tenant-id order.
          const listed = await listCollectOnSiteTenantIds(pool);
          expect([...listed].sort()).toEqual(listed);
          for (const t of [lost, predates, none, back]) expect(listed).toContain(t.t.tenantId);
          expect(listed).not.toContain(payLink.t.tenantId);

          const at = new Date();
          const day = at.toISOString().slice(0, 10);
          const first = await sweep(at);
          expect(first.candidates).toBe(listed.length);
          expect(first.failed).toBe(0);

          const sweepRows = async (tenantId: string) =>
            (await jobRows(tenantId)).map((r) => ({ payload: r.payload, key: r.idempotency_key }));
          for (const t of [lost, predates, back]) {
            expect(await sweepRows(t.t.tenantId)).toEqual([
              { payload: { tenantId: t.t.tenantId, pass: 1 }, key: `deactivate-payment-links:${t.t.tenantId}:sweep:${day}` },
            ]);
          }
          expect(await jobRows(payLink.t.tenantId)).toEqual([]);
          expect(await jobRows(none.t.tenantId)).toEqual([]);

          // A second sweep the same day enqueues nothing new (same key).
          const idsBefore = (await Promise.all([lost, predates, back].map((t) => jobRows(t.t.tenantId)))).flat().map((r) => r.id);
          await sweep(new Date(at.getTime() + 1000));
          const idsAfter = (await Promise.all([lost, predates, back].map((t) => jobRows(t.t.tenantId)))).flat().map((r) => r.id);
          expect(idsAfter).toEqual(idsBefore);
          expect(await jobRows(payLink.t.tenantId)).toEqual([]);
          expect(await jobRows(none.t.tenantId)).toEqual([]);

          // E's owner switches back before E's job runs.
          await switchTo(back.t.tenantId, 'pay_link');

          // Run each sweep job through the real worker and the real claim.
          for (const t of [lost, predates]) {
            const provider = new JobProvider(t.t.tenantId);
            await jobWorker(provider).handle(asMessage(await pass1(t.t.tenantId)), quiet);
            expect(provider.deactivatedIds()).toEqual([t.linked[0].linkId]);
            expect(provider.locksDuringCall).toEqual([0]);
            expect(await linkColumns(t.t.tenantId, t.linked[0].id)).toEqual({
              stripe_payment_link_id: null,
              stripe_payment_link_url: null,
            });
            expect(
              (await auditRows(t.t.tenantId, t.linked[0].id, 'invoice.payment_link_deactivated')).map((m) => m.reason),
            ).toEqual(['payment_mode_changed']);
            // Its follow-up pass has a key of its own: the sweep key plus :pass2.
            expect((await jobRows(t.t.tenantId)).filter((r) => r.payload.pass === 2).map((r) => r.idempotency_key)).toEqual([
              `deactivate-payment-links:${t.t.tenantId}:sweep:${day}:pass2`,
            ]);
          }

          const backProvider = new JobProvider(back.t.tenantId);
          await jobWorker(backProvider).handle(asMessage(await pass1(back.t.tenantId)), quiet);
          expect(backProvider.deactivations).toEqual([]);
          expect((await linkColumns(back.t.tenantId, back.linked[0].id)).stripe_payment_link_id).toBe(back.linked[0].linkId);
          expect((await tenantEvents(back.t.tenantId, 'payment_links.cleanup_superseded')).map((r) => r.metadata)).toEqual([
            { pass: 1, modeRead: 'pay_link', deactivated: 0, failed: 0 },
          ]);
          expect((await jobRows(back.t.tenantId)).filter((r) => r.payload.pass === 2)).toEqual([]);

          // C's allowed link was never touched.
          expect((await linkColumns(payLink.t.tenantId, payLink.linked[0].id)).stripe_payment_link_id).toBe(
            payLink.linked[0].linkId,
          );

          // The next day's sweep finds nothing left to retire for A and B.
          const nextDay = new Date(at.getTime() + 24 * 60 * 60_000);
          await pool.query(`DELETE FROM _queue_messages WHERE type = $1 AND payload->>'tenantId' = ANY($2::text[])`, [
            JOB,
            [lost.t.tenantId, predates.t.tenantId],
          ]);
          await sweep(nextDay);
          expect(await jobRows(lost.t.tenantId)).toEqual([]);
          expect(await jobRows(predates.t.tenantId)).toEqual([]);
        } finally {
          if (previous === undefined) delete process.env.RLS_RUNTIME_ROLE;
          else process.env.RLS_RUNTIME_ROLE = previous;
        }
      });

      it('the enumerator visits every collect-on-site tenant past one 500-tenant page', async () => {
        // 501+ collect-on-site rows exist only for this check; each is a real tenant + settings row.
        const before = await listCollectOnSiteTenantIds(pool);
        const need = Math.max(0, 501 - before.length);
        const created: string[] = [];
        for (let i = 0; i < need; i++) {
          const t = await createTestTenant(pool);
          await pool.query(
            `INSERT INTO tenant_settings (id, tenant_id, business_name, payment_collection_mode)
             VALUES ($1, $2, 'Page HVAC', 'collect_on_site')`,
            [crypto.randomUUID(), t.tenantId],
          );
          created.push(t.tenantId);
        }
        try {
          const listed = await listCollectOnSiteTenantIds(pool);
          expect(listed.length).toBeGreaterThan(500);
          expect(new Set(listed).size).toBe(listed.length);
          for (const id of created) expect(listed).toContain(id);
          expect([...listed].sort()).toEqual(listed);
        } finally {
          await pool.query(`UPDATE tenant_settings SET payment_collection_mode = NULL WHERE tenant_id = ANY($1::uuid[])`, [created]);
        }
      });

      it('S6-1: a demo tenant and the platform tenant on collect_on_site are not listed; an ordinary one is', async () => {
        const ordinary = await createTestTenant(pool);
        const demo = await createTestTenant(pool);
        await pool.query(`UPDATE tenants SET demo = true WHERE id = $1`, [demo.tenantId]);
        for (const id of [ordinary.tenantId, demo.tenantId]) {
          await pool.query(
            `INSERT INTO tenant_settings (id, tenant_id, business_name, payment_collection_mode)
             VALUES ($1, $2, 'S6 HVAC', 'collect_on_site')`,
            [crypto.randomUUID(), id],
          );
        }
        const platformUpdated = await pool.query(
          `UPDATE tenant_settings SET payment_collection_mode = 'collect_on_site' WHERE tenant_id = $1`,
          [DEMO_PLATFORM_TENANT_ID],
        );
        if (platformUpdated.rowCount === 0) {
          await pool.query(
            `INSERT INTO tenant_settings (id, tenant_id, business_name, payment_collection_mode)
             VALUES ($1, $2, 'Platform', 'collect_on_site')`,
            [crypto.randomUUID(), DEMO_PLATFORM_TENANT_ID],
          );
        }
        try {
          const listed = await listCollectOnSiteTenantIds(pool);
          expect(listed).toContain(ordinary.tenantId);
          expect(listed).not.toContain(demo.tenantId);
          expect(listed).not.toContain(DEMO_PLATFORM_TENANT_ID);
        } finally {
          await pool.query(
            `UPDATE tenant_settings SET payment_collection_mode = NULL WHERE tenant_id = ANY($1::uuid[])`,
            [[ordinary.tenantId, demo.tenantId, DEMO_PLATFORM_TENANT_ID]],
          );
        }
      });
    });
  });
});
