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
 * The cleanup job's passes (S5a-5) are not built yet; where a scenario says
 * "pass 1 finds the link", this suite proves the precondition — the write's
 * own transaction, after the lock, sees the stored link.
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
      await new Promise((r) => setTimeout(r, 5));
    }
  }

  async end(): Promise<void> {
    await this.pool.end();
  }
}

function latch(): { wait: () => Promise<void>; release: () => void; reached: Promise<void> } {
  let release!: () => void;
  let markReached!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const reached = new Promise<void>((r) => (markReached = r));
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
      await new Promise((r) => setTimeout(r, 5));
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
      new Promise((r) => setTimeout(() => r('blocked'), 5_000)),
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
});
