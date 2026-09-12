/**
 * §8.12 Memberships — what `runRecurringAgreementsSweep` ACTUALLY does, at
 * real Postgres, and the clauses of the story it does not do.
 *
 * The PRD's premise for this row ("no renewal sweep") was wrong — corrected on
 * ticket #1023 by the §8.8 entry audit (#1009): `runRecurringAgreementsSweep`
 * exists (workers/recurring-agreements-worker.ts:38) and is wired at
 * app.ts:5793 on a 60s interval. What was true is that every test of it proved
 * a COLUMN, not a behaviour. This file proves the behaviour on real rows, and
 * marks — with tests that pin the current wrong value, so the gap is
 * executable rather than prose — the parts of "memberships renew and bill
 * themselves, so recurring revenue is actually recurring" that the code does
 * not deliver.
 *
 * The ports below are copied from the PRODUCTION wiring (app.ts:5658-5713) so
 * what is asserted is what ships, including its invoice-numbering choice.
 *
 * MET, and proven here on real rows:
 *   - renewal: an active auto-renew membership whose term lapsed has `ends_on`
 *     rolled forward by `renewalTermMonths` (catching up several missed terms
 *     in one pass), `renewal_count` bumped, and a `service_agreement.renewed`
 *     audit row;
 *   - billing cycle: the due membership generates a job, an invoice, and a
 *     `service_agreement_runs` row, advances `next_run_at`, and audits
 *     `service_agreement.run.generated`; a second sweep the same day skips
 *     rather than double-billing;
 *   - member pricing resolves from real agreement rows (effective term only);
 *   - AUTO-COLLECT (`autoCollectDues: true` + a saved card + a Stripe key):
 *     the dues invoice IS issued with a 30-day due date before the charge
 *     (`app.ts:5760-5766`), the payment is recorded on success, and a DECLINE
 *     leaves an open, dunnable invoice that the collections cadence really
 *     does chase. Proven end to end with only the Stripe HTTP call injected.
 *
 * NOT MET — and scoped to the DEFAULT path, which is what `createAgreement`
 * produces unless the owner opts in (`autoCollectDues` defaults to false), and
 * also to an opted-in member who never saved a card (`no_card` returns before
 * issuance, dues-collector.ts:85):
 *   - the dues invoice is left as a DRAFT with no due date, so it is invisible
 *     to the collections cadence — nothing chases it, and nothing sends it;
 *   - it is numbered `AGREEMENT-<epoch ms>` instead of off the tenant's
 *     invoice sequence (this one holds on BOTH paths).
 *
 * An earlier revision of this file stated the draft/no-due-date gap as
 * universal. It is not — caught by a review finding on PR #1053 (Codex P2),
 * and the auto-collect block below is the correction.
 *
 * Runs only under the integration harness (globalSetup starts the Postgres
 * testcontainer and sets TEST_DB_URL).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { v4 as uuidv4 } from 'uuid';
import { getSharedTestDb, createTestTenant, closeSharedTestDb } from './shared';
import { PgAgreementRepository } from '../../src/agreements/pg-agreement';
import { PgAgreementRunRepository } from '../../src/agreements/pg-agreement-run';
import { PgInvoiceRepository } from '../../src/invoices/pg-invoice';
import { PgJobRepository } from '../../src/jobs/pg-job';
import { PgCustomerRepository } from '../../src/customers/pg-customer';
import { PgLocationRepository } from '../../src/locations/pg-location';
import { PgSettingsRepository } from '../../src/settings/pg-settings';
import { PgAuditRepository } from '../../src/audit/pg-audit';
import { PgPaymentRepository } from '../../src/invoices/pg-payment';
import { PgCustomerPaymentMethodRepository } from '../../src/payments/pg-customer-payment-method';
import { PgEstimateRepository } from '../../src/estimates/pg-estimate';
import { PgProposalRepository } from '../../src/proposals/pg-proposal';
import {
  PgDunningConfigRepository,
  PgDunningEventRepository,
} from '../../src/invoices/pg-dunning-config';
import { defaultDunningConfig } from '../../src/invoices/dunning-config';
import { runOverdueInvoiceSweep } from '../../src/workers/overdue-invoice-worker';
import { StripeDuesCollector, DuesInvoiceOps } from '../../src/agreements/dues-collector';
import type { StripeFetch } from '../../src/payments/stripe-payment-intent';
import { createJob } from '../../src/jobs/job';
import { createInvoice, issueInvoice } from '../../src/invoices/invoice';
import { recordPayment } from '../../src/invoices/payment';
import { createAgreement } from '../../src/agreements/agreement-service';
import { getCustomerMemberDiscountBps } from '../../src/agreements/member-pricing';
import { runRecurringAgreementsSweep } from '../../src/workers/recurring-agreements-worker';
import { Agreement } from '../../src/agreements/agreement';
import { createLogger } from '../../src/logging/logger';

const logger = createLogger({ service: 'test', environment: 'test', level: 'error' });

/** YYYY-MM-DD, `days` from now (UTC), as the DATE columns store it. */
function ymd(offsetDays: number): string {
  return new Date(Date.now() + offsetDays * 86_400_000).toISOString().slice(0, 10);
}

interface SeededTenant {
  tenantId: string;
  userId: string;
  customerId: string;
  locationId: string;
}

describe('Postgres integration — membership renewal + dues sweep (§8.12)', () => {
  let pool: Pool;
  let agreementRepo: PgAgreementRepository;
  let runRepo: PgAgreementRunRepository;
  let invoiceRepo: PgInvoiceRepository;
  let jobRepo: PgJobRepository;
  let customerRepo: PgCustomerRepository;
  let locationRepo: PgLocationRepository;
  let settingsRepo: PgSettingsRepository;
  let auditRepo: PgAuditRepository;
  let paymentRepo: PgPaymentRepository;

  /**
   * The production ports (app.ts:5658-5713), verbatim in shape: a real job via
   * the job domain, and a draft invoice whose number is `AGREEMENT-<epoch ms>`
   * with a single non-taxable line at the agreement price.
   */
  const jobsService = {
    async createJob(input: {
      tenantId: string;
      customerId: string;
      locationId: string;
      summary: string;
      createdBy: string;
    }) {
      const job = await createJob(
        { ...input, actorRole: 'system' },
        jobRepo,
        auditRepo,
      );
      return { id: job.id };
    },
  };
  const invoicesService = {
    async createDraftInvoice(input: {
      tenantId: string;
      jobId: string;
      priceCents: number;
      description: string;
      createdBy: string;
    }) {
      const invoice = await createInvoice(
        {
          tenantId: input.tenantId,
          jobId: input.jobId,
          invoiceNumber: `AGREEMENT-${Date.now()}`,
          lineItems: [
            {
              id: `agreement-${Date.now()}`,
              description: input.description,
              quantity: 1,
              unitPriceCents: input.priceCents,
              totalCents: input.priceCents,
              sortOrder: 0,
              taxable: false,
            },
          ],
          customerMessage: undefined,
          createdBy: input.createdBy,
        },
        invoiceRepo,
        auditRepo,
      );
      return { id: invoice.id };
    },
  };

  async function seedTenant(): Promise<SeededTenant> {
    const { tenantId, userId } = await createTestTenant(pool);
    const now = new Date();
    await settingsRepo.create({
      id: uuidv4(),
      tenantId,
      businessName: 'Membership Co',
      timezone: 'America/Chicago',
      estimatePrefix: 'EST',
      invoicePrefix: 'INV',
      nextEstimateNumber: 1,
      nextInvoiceNumber: 1,
      defaultPaymentTermDays: 30,
      createdAt: now,
      updatedAt: now,
    });
    const customerId = uuidv4();
    await customerRepo.create({
      id: customerId,
      tenantId,
      firstName: 'Mem',
      lastName: 'Bership',
      displayName: 'Mem Bership',
      preferredChannel: 'phone',
      smsConsent: false,
      isArchived: false,
      createdBy: userId,
      createdAt: now,
      updatedAt: now,
    });
    const locationId = uuidv4();
    await locationRepo.create({
      id: locationId,
      tenantId,
      customerId,
      street1: '1 Member Way',
      city: 'Austin',
      state: 'TX',
      postalCode: '78701',
      country: 'USA',
      addressType: 'service',
      isPrimary: true,
      isArchived: false,
      createdAt: now,
      updatedAt: now,
    });
    return { tenantId, userId, customerId, locationId };
  }

  /** A real membership row through the production `createAgreement`. */
  async function seedMembership(
    t: SeededTenant,
    overrides: Partial<Agreement> = {},
  ): Promise<Agreement> {
    const created = await createAgreement(
      {
        tenantId: t.tenantId,
        customerId: t.customerId,
        locationId: t.locationId,
        name: 'Comfort Club membership',
        recurrenceRule: 'FREQ=MONTHLY;INTERVAL=1',
        priceCents: 19_900,
        startsOn: ymd(-400),
        createdBy: t.userId,
      },
      agreementRepo,
      auditRepo,
    );
    if (Object.keys(overrides).length === 0) return created;
    return (await agreementRepo.update(t.tenantId, created.id, overrides))!;
  }

  const sweep = (tenantIds: string[]) =>
    runRecurringAgreementsSweep({
      agreementRepo,
      runRepo,
      jobsService,
      invoicesService,
      listTenantIds: async () => tenantIds,
      auditRepo,
      logger,
    });

  /**
   * Raw agreement row — the DATE columns as Postgres holds them, read under
   * the requested tenant.
   *
   * The tenant GUC is set with `set_config(..., true)` inside an explicit
   * transaction, NOT a bare `SET LOCAL`: outside a transaction block Postgres
   * warns "SET LOCAL can only be used in transaction blocks" and DISCARDS the
   * setting, so the RLS predicate would see an empty tenant. The `tenant_id`
   * predicate is belt-and-braces on top of that, because the integration
   * harness connects as a superuser, which bypasses RLS entirely — without it
   * this helper reads by global id and a cross-tenant assertion written
   * against it would pass no matter which tenant was asked for.
   */
  async function rawAgreement(
    tenantId: string,
    id: string,
  ): Promise<Record<string, unknown> | undefined> {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.current_tenant_id', $1, true)`, [tenantId]);
      const { rows } = await client.query(
        `SELECT ends_on::text AS ends_on, renewal_count, next_run_at, last_run_at
           FROM service_agreements WHERE id = $1 AND tenant_id = $2`,
        [id, tenantId],
      );
      await client.query('COMMIT');
      return rows[0];
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  beforeAll(async () => {
    pool = await getSharedTestDb();
    agreementRepo = new PgAgreementRepository(pool);
    runRepo = new PgAgreementRunRepository(pool);
    invoiceRepo = new PgInvoiceRepository(pool);
    jobRepo = new PgJobRepository(pool);
    customerRepo = new PgCustomerRepository(pool);
    locationRepo = new PgLocationRepository(pool);
    settingsRepo = new PgSettingsRepository(pool);
    auditRepo = new PgAuditRepository(pool);
    paymentRepo = new PgPaymentRepository(pool);
  });

  afterAll(async () => {
    await closeSharedTestDb();
  });

  describe('what the sweep does do', () => {
    it('renews a lapsed auto-renew membership: ends_on rolls forward, renewal_count bumps, and it is audited', async () => {
      const t = await seedTenant();
      // Term ended yesterday; the membership should not be left lapsed.
      const membership = await seedMembership(t, {
        endsOn: ymd(-1),
        autoRenew: true,
        renewalTermMonths: 12,
        nextRunAt: new Date(Date.now() + 30 * 86_400_000), // not due to bill yet
      });

      const result = await sweep([t.tenantId]);
      expect(result.renewed).toBeGreaterThanOrEqual(1);

      const row = (await rawAgreement(t.tenantId, membership.id))!;
      // Rolled forward a whole 12-month term, into the future.
      expect(String(row.ends_on) > ymd(0)).toBe(true);
      expect(String(row.ends_on)).toBe(
        new Date(
          Date.UTC(
            new Date(`${membership.endsOn}T00:00:00Z`).getUTCFullYear() + 1,
            new Date(`${membership.endsOn}T00:00:00Z`).getUTCMonth(),
            new Date(`${membership.endsOn}T00:00:00Z`).getUTCDate(),
          ),
        )
          .toISOString()
          .slice(0, 10),
      );
      expect(Number(row.renewal_count)).toBe(1);

      const audits = await auditRepo.findByEntity(
        t.tenantId,
        'service_agreement',
        membership.id,
      );
      const renewed = audits.filter((a) => a.eventType === 'service_agreement.renewed');
      expect(renewed).toHaveLength(1);
      expect(renewed[0].metadata).toMatchObject({ termsAdded: 1, renewalCount: 1 });
    });

    it('catches up several missed terms in ONE pass rather than leaving the member lapsed', async () => {
      const t = await seedTenant();
      // Three annual terms missed (the worker was down ~3 years).
      const membership = await seedMembership(t, {
        endsOn: ymd(-800),
        autoRenew: true,
        renewalTermMonths: 12,
        nextRunAt: new Date(Date.now() + 30 * 86_400_000),
      });

      await sweep([t.tenantId]);

      const row = (await rawAgreement(t.tenantId, membership.id))!;
      expect(String(row.ends_on) > ymd(0)).toBe(true);
      expect(Number(row.renewal_count)).toBe(3);
    });

    it('bills the due cycle: a job, an invoice and a run row land, next_run_at advances, and a re-sweep does not double-bill', async () => {
      const t = await seedTenant();
      const membership = await seedMembership(t, {
        nextRunAt: new Date(Date.now() - 3600_000), // due an hour ago
      });

      const result = await sweep([t.tenantId]);
      expect(result.generated).toBeGreaterThanOrEqual(1);

      const runs = await runRepo.findByAgreement(t.tenantId, membership.id);
      expect(runs).toHaveLength(1);
      expect(runs[0].status).toBe('generated');
      expect(runs[0].generatedJobId).toBeDefined();
      expect(runs[0].generatedInvoiceId).toBeDefined();

      // The invoice really exists, at the membership price, in cents.
      const invoice = await invoiceRepo.findById(t.tenantId, runs[0].generatedInvoiceId!);
      expect(invoice).not.toBeNull();
      expect(invoice!.totals.totalCents).toBe(19_900);
      expect(invoice!.jobId).toBe(runs[0].generatedJobId);

      // The pointer moved forward, so the next sweep is not due again today.
      const row = (await rawAgreement(t.tenantId, membership.id))!;
      expect(new Date(row.next_run_at as string).getTime()).toBeGreaterThan(Date.now());
      expect(row.last_run_at).not.toBeNull();

      const audits = await auditRepo.findByEntity(
        t.tenantId,
        'service_agreement',
        membership.id,
      );
      expect(audits.map((a) => a.eventType)).toContain('service_agreement.run.generated');

      // A second sweep the same day bills nothing more.
      await sweep([t.tenantId]);
      expect(await runRepo.findByAgreement(t.tenantId, membership.id)).toHaveLength(1);
      expect(
        (await invoiceRepo.findByJob(t.tenantId, runs[0].generatedJobId!)),
      ).toHaveLength(1);
    });

    it('member pricing resolves from real agreement rows — the best EFFECTIVE discount, never a lapsed one', async () => {
      const t = await seedTenant();
      await seedMembership(t, { memberDiscountBps: 500, endsOn: ymd(365) });
      await seedMembership(t, { memberDiscountBps: 1500, endsOn: ymd(365) });
      // A richer discount that has already lapsed must NOT be honoured.
      await seedMembership(t, { memberDiscountBps: 4000, endsOn: ymd(-2) });

      const bps = await getCustomerMemberDiscountBps(t.tenantId, t.customerId, agreementRepo);
      expect(bps).toBe(1500);

      // Another tenant's customer id resolves to no discount here.
      const other = await seedTenant();
      expect(
        await getCustomerMemberDiscountBps(other.tenantId, t.customerId, agreementRepo),
      ).toBe(0);
    });

    it('T1 — two tenants are renewed and billed on their own memberships in one pass, with no cross-tenant reach', async () => {
      const tenantA = await seedTenant();
      const tenantB = await seedTenant();
      const a = await seedMembership(tenantA, {
        endsOn: ymd(-1),
        autoRenew: true,
        renewalTermMonths: 12,
        nextRunAt: new Date(Date.now() - 3600_000),
      });
      const b = await seedMembership(tenantB, {
        priceCents: 4_900,
        nextRunAt: new Date(Date.now() - 3600_000),
      });

      await sweep([tenantA.tenantId, tenantB.tenantId]);

      const aRuns = await runRepo.findByAgreement(tenantA.tenantId, a.id);
      const bRuns = await runRepo.findByAgreement(tenantB.tenantId, b.id);
      expect(aRuns).toHaveLength(1);
      expect(bRuns).toHaveLength(1);
      // Each tenant billed ITS own price.
      expect(
        (await invoiceRepo.findById(tenantA.tenantId, aRuns[0].generatedInvoiceId!))!.totals.totalCents,
      ).toBe(19_900);
      expect(
        (await invoiceRepo.findById(tenantB.tenantId, bRuns[0].generatedInvoiceId!))!.totals.totalCents,
      ).toBe(4_900);
      // Only tenant A's membership was renewable; tenant B's has no term.
      expect(Number((await rawAgreement(tenantA.tenantId, a.id))!.renewal_count)).toBe(1);
      expect(Number((await rawAgreement(tenantB.tenantId, b.id))!.renewal_count)).toBe(0);

      // Cross-tenant: neither tenant's scoped repo can read the other's rows.
      expect(await agreementRepo.findById(tenantB.tenantId, a.id)).toBeNull();
      expect(await runRepo.findByAgreement(tenantB.tenantId, a.id)).toEqual([]);
      expect(
        await invoiceRepo.findById(tenantB.tenantId, aRuns[0].generatedInvoiceId!),
      ).toBeNull();

      // …and the raw helper this file reads DATE columns with is itself
      // tenant-scoped, so a cross-tenant assertion written against it cannot
      // pass by reading the row globally. (Review finding, PR #1053: the
      // helper used a bare `SET LOCAL` outside a transaction — Postgres warns
      // "SET LOCAL can only be used in transaction blocks" and discards the
      // GUC — and had no tenant_id predicate, so it read by global id on the
      // privileged test connection.)
      expect(await rawAgreement(tenantB.tenantId, a.id)).toBeUndefined();
    });
  });

  /**
   * The AUTO-COLLECT branch — the other half of "bills itself".
   *
   * Everything here is production code and real rows except the Stripe HTTP
   * call itself, which is injected at the `stripeFetch` seam
   * (`StripeDuesCollectorDeps.stripeFetch`, the same seam the deposit-checkout
   * path uses). The collector, the invoice ops, `issueInvoice`, `recordPayment`
   * and every repository are the real ones; only api.stripe.com is replaced,
   * because it is unreachable in CI (that is the blocked-on-#1000 item).
   *
   * Added after a review finding on PR #1053 (Codex P2): the story-not-met
   * tests below cover ONLY the default `autoCollectDues: false` path, and
   * stating their conclusion as universal was wrong. On this branch the dues
   * invoice IS issued with a 30-day term before the charge
   * (`app.ts:5760-5766`), so a decline leaves an open, dunnable invoice.
   */
  describe('the auto-collect branch — dues that DO collect themselves', () => {
    /** The production `duesInvoiceOps` (app.ts:5759-5788), real repos throughout. */
    function productionDuesInvoiceOps(): DuesInvoiceOps {
      return {
        ensureIssuedAmountDue: async (tenantId, invoiceId) => {
          let inv = await invoiceRepo.findById(tenantId, invoiceId);
          if (inv && inv.status === 'draft') {
            inv = (await issueInvoice(tenantId, invoiceId, 30, invoiceRepo)) ?? inv;
          }
          return inv?.amountDueCents ?? 0;
        },
        recordPayment: async ({ tenantId, invoiceId, amountCents, providerReference, createdBy }) => {
          await recordPayment(
            {
              tenantId,
              invoiceId,
              amountCents,
              method: 'credit_card',
              providerReference,
              processedBy: createdBy,
              note: 'Membership dues (auto-collected)',
            },
            invoiceRepo,
            paymentRepo,
            undefined,
            undefined,
            auditRepo,
          );
        },
      };
    }

    /**
     * Only the Stripe HTTP boundary is stubbed — and it must answer with the
     * PRODUCTION-SHAPED status code, not just a production-shaped body.
     * `chargeOffSession` parses card errors exclusively inside its `!res.ok`
     * branch (`stripe-saved-card.ts:225-235`): a 200 carrying an `error`
     * object falls through to the success branch, yields a bare `'failed'`
     * with no `declineCode` or `paymentIntentId`, and would keep a
     * "declined card" test green even if the real decline parsing regressed.
     * (Review finding, PR #1053 — the first version of this stub did exactly
     * that.)
     */
    interface CapturedCharge {
      url: string;
      headers: Record<string, string>;
      params: URLSearchParams;
    }

    /**
     * Returns the stub plus the request it was handed. Capturing the outgoing
     * call is the point: without it the stub answers the same success no
     * matter what `chargeOffSession` serialized, and every downstream
     * assertion uses the locally computed amount — so charging the wrong card,
     * the wrong amount, or reusing a cycle's idempotency key would all stay
     * green (review finding, PR #1053).
     */
    function stripeFetchReturning(
      body: Record<string, unknown>,
      status = 200,
    ): { fetch: StripeFetch; calls: CapturedCharge[] } {
      const calls: CapturedCharge[] = [];
      const fetch = (async (
        url: string,
        init: { method: string; headers: Record<string, string>; body: string },
      ) => {
        calls.push({ url, headers: init.headers, params: new URLSearchParams(init.body) });
        return new Response(JSON.stringify(body), {
          status,
          headers: { 'content-type': 'application/json' },
        });
      }) as unknown as StripeFetch;
      return { fetch, calls };
    }

    async function seedAutoCollectMembership(stripeFetch: StripeFetch) {
      const t = await seedTenant();
      const membership = await seedMembership(t, {
        nextRunAt: new Date(Date.now() - 3600_000),
        autoCollectDues: true,
      });
      const card = {
        id: uuidv4(),
        tenantId: t.tenantId,
        customerId: t.customerId,
        stripeCustomerId: `cus_${uuidv4().slice(0, 8)}`,
        stripePaymentMethodId: `pm_${uuidv4().slice(0, 8)}`,
        brand: 'visa',
        last4: '4242',
        isDefault: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      await new PgCustomerPaymentMethodRepository(pool).create(card);
      const duesCollector = new StripeDuesCollector({
        customerPaymentMethodRepo: new PgCustomerPaymentMethodRepository(pool),
        stripeConfig: { apiKey: 'sk_test_not_a_real_key' },
        invoiceOps: productionDuesInvoiceOps(),
        stripeFetch,
      });
      await runRecurringAgreementsSweep({
        agreementRepo,
        runRepo,
        jobsService,
        invoicesService,
        listTenantIds: async () => [t.tenantId],
        auditRepo,
        duesCollector,
        logger,
      });
      const run = (await runRepo.findByAgreement(t.tenantId, membership.id))[0];
      return { t, membership, run, card };
    }

    it('issues the dues invoice with a due date and records the payment when the card succeeds', async () => {
      const stripe = stripeFetchReturning({ id: 'pi_dues_ok', status: 'succeeded' });
      const { t, membership, run, card } = await seedAutoCollectMembership(stripe.fetch);

      // What we actually ASKED Stripe to do. Without this the stub answers the
      // same success regardless of what was serialized, and every assertion
      // below uses our own locally computed amount — so a charge against the
      // wrong card or for the wrong amount would read exactly the same.
      expect(stripe.calls).toHaveLength(1);
      const charge = stripe.calls[0];
      expect(charge.url).toBe('https://api.stripe.com/v1/payment_intents');
      expect(charge.params.get('amount')).toBe('19900');
      expect(charge.params.get('currency')).toBe('usd');
      expect(charge.params.get('customer')).toBe(card.stripeCustomerId);
      expect(charge.params.get('payment_method')).toBe(card.stripePaymentMethodId);
      expect(charge.params.get('off_session')).toBe('true');
      expect(charge.params.get('confirm')).toBe('true');
      expect(charge.params.get('metadata[invoice_id]')).toBe(run.generatedInvoiceId);
      expect(charge.params.get('metadata[tenant_id]')).toBe(t.tenantId);
      expect(charge.params.get('metadata[agreement_id]')).toBe(membership.id);
      // The cycle idempotency key is the double-charge guard: if it ever stops
      // being stable per (agreement, scheduled date), a re-run charges the
      // member twice and nothing else in this file would notice.
      expect(charge.headers['Idempotency-Key']).toBe(
        `agreement_${membership.id}_${run.scheduledFor}`,
      );

      const invoice = await invoiceRepo.findById(t.tenantId, run.generatedInvoiceId!);
      // Issued before the charge — NOT left a draft.
      expect(invoice!.status).toBe('paid');
      expect(invoice!.dueDate).toBeDefined();
      expect(invoice!.amountPaidCents).toBe(19_900);
      expect(invoice!.amountDueCents).toBe(0);

      // The PAYMENT ROW itself, not just the invoice projection it feeds
      // (review finding, PR #1053). `providerReference` is what reconciliation
      // and refunds look the charge up by, so a collector that stopped passing
      // `result.paymentIntentId` would leave money moved and unfindable — the
      // exact shape `collected_unrecorded` exists to make loud — while every
      // invoice-level assertion above still passed.
      const payments = await paymentRepo.findByInvoice(t.tenantId, invoice!.id);
      expect(payments).toHaveLength(1);
      expect(payments[0]).toMatchObject({
        amountCents: 19_900,
        method: 'credit_card',
        status: 'completed',
        providerReference: 'pi_dues_ok',
      });

      const audits = await auditRepo.findByEntity(t.tenantId, 'service_agreement', membership.id);
      expect(audits.map((a) => a.eventType)).toContain('service_agreement.dues_collected');
    });

    it('leaves a DECLINED dues invoice open WITH a due date, so the collections cadence can chase it', async () => {
      const { t, membership, run } = await seedAutoCollectMembership(
        // 402 + Stripe's card_error body — the shape the real API returns, so
        // the `!res.ok` decline branch is what actually runs.
        stripeFetchReturning(
          {
            error: {
              code: 'card_declined',
              decline_code: 'insufficient_funds',
              message: 'Your card has insufficient funds.',
              payment_intent: { id: 'pi_dues_declined', status: 'requires_payment_method' },
            },
          },
          402,
        ).fetch,
      );

      const invoice = await invoiceRepo.findById(t.tenantId, run.generatedInvoiceId!);
      // This is the point of issuing first: a decline is dunnable, not hidden.
      expect(invoice!.status).toBe('open');
      expect(invoice!.dueDate).toBeDefined();
      expect(invoice!.amountDueCents).toBe(19_900);

      const audits = await auditRepo.findByEntity(t.tenantId, 'service_agreement', membership.id);
      const failedAudit = audits.find(
        (a) => a.eventType === 'service_agreement.auto_collect_failed',
      );
      expect(failedAudit).toBeDefined();
      // The decline METADATA survives the whole path — proof the real
      // card-error branch ran, not the generic no-status fallthrough.
      expect(failedAudit!.metadata).toMatchObject({
        collectionStatus: 'failed',
        declineCode: 'insufficient_funds',
        paymentIntentId: 'pi_dues_declined',
      });
      // The other direction of the same claim: a decline records NO payment.
      // A phantom row here would overstate collected revenue and mark the
      // invoice partly paid, taking it back out of the cadence's reach.
      expect(await paymentRepo.findByInvoice(t.tenantId, invoice!.id)).toEqual([]);

      // And the collections cadence really can select it now — the overdue
      // sweep's own prefilter, run against this invoice 40 days on.
      const asOf = new Date(invoice!.dueDate!.getTime() + 10 * 86_400_000);
      const dunningEventRepo = new PgDunningEventRepository(pool);
      const dunningConfigRepo = new PgDunningConfigRepository(pool);
      await dunningConfigRepo.upsert({
        ...defaultDunningConfig(t.tenantId),
        reminderSteps: [{ offsetDays: 3, channel: 'sms' }],
      });
      await runOverdueInvoiceSweep({
        jobRepo,
        estimateRepo: new PgEstimateRepository(pool),
        invoiceRepo,
        auditRepo,
        proposalRepo: new PgProposalRepository(pool),
        dunningEventRepo,
        dunningConfigRepo,
        listTenantIds: async () => [t.tenantId],
        now: () => asOf,
        logger,
      });
      expect(
        (await dunningEventRepo.findByInvoice(t.tenantId, invoice!.id)).map((e) => e.stepKey),
      ).toEqual(['3:sms']);
    });

    it('leaves the invoice an undunnable draft when auto-collect is on but no card is saved', async () => {
      // The collector returns `no_card` BEFORE ensureIssuedAmountDue
      // (dues-collector.ts:85), so the issuance never happens — the default
      // path's gap reappears for a member who never completed card setup.
      const t = await seedTenant();
      const membership = await seedMembership(t, {
        nextRunAt: new Date(Date.now() - 3600_000),
        autoCollectDues: true,
      });
      const duesCollector = new StripeDuesCollector({
        customerPaymentMethodRepo: new PgCustomerPaymentMethodRepository(pool),
        stripeConfig: { apiKey: 'sk_test_not_a_real_key' },
        invoiceOps: productionDuesInvoiceOps(),
        stripeFetch: stripeFetchReturning({ id: 'pi_unused', status: 'succeeded' }).fetch,
      });
      await runRecurringAgreementsSweep({
        agreementRepo,
        runRepo,
        jobsService,
        invoicesService,
        listTenantIds: async () => [t.tenantId],
        auditRepo,
        duesCollector,
        logger,
      });

      const run = (await runRepo.findByAgreement(t.tenantId, membership.id))[0];
      const invoice = await invoiceRepo.findById(t.tenantId, run.generatedInvoiceId!);
      expect(invoice!.status).toBe('draft');
      expect(invoice!.dueDate).toBeUndefined();
      const audits = await auditRepo.findByEntity(t.tenantId, 'service_agreement', membership.id);
      expect(audits.map((a) => a.eventType)).toContain('service_agreement.auto_collect_skipped');
    });
  });

  /**
   * The story-not-met half — scoped to the DEFAULT path.
   *
   * Each test pins the CURRENT (wrong) value positively rather than using
   * `it.fails`. Two reviewers flagged the same hazard on PR #1053: `it.fails`
   * passes when the body throws for ANY reason, so a regression in the sweep
   * — no run generated, `run.generatedInvoiceId` undefined, a TypeError before
   * the intended assertion — reads as "expected fail" and the gap silently
   * stops being tested. Asserting the wrong value directly keeps the property
   * that matters (these go RED the moment the gap is closed, which is the
   * signal to update the row) while failing honestly on a setup regression.
   * Each begins with a setup assertion so a broken seed is unmistakable.
   *
   * IMPORTANT: this is the `autoCollectDues: false` default, which is what a
   * membership created through `createAgreement` gets unless the owner opts
   * in. The auto-collect branch above DOES issue with a due date — do not read
   * these as universal.
   *
   * Do not "fix" one by weakening it; close the gap in the worker (an owner
   * decision — parked on #1023 for the orchestrator, not taken by this lane).
   */
  describe('story-not-met: what "bills itself" does not do on the DEFAULT (no auto-collect) path', () => {
    /** Run one default-path cycle and return its invoice. Throws loudly if the
     *  sweep did not actually bill, so a setup regression can never read as
     *  the gap under test. */
    async function billedDefaultPathInvoice() {
      const t = await seedTenant();
      const membership = await seedMembership(t, {
        nextRunAt: new Date(Date.now() - 3600_000),
      });
      await sweep([t.tenantId]);
      const runs = await runRepo.findByAgreement(t.tenantId, membership.id);
      // Setup assertions — these must HOLD for the gap assertions to mean
      // anything.
      expect(runs).toHaveLength(1);
      expect(runs[0].status).toBe('generated');
      expect(runs[0].generatedInvoiceId).toBeDefined();
      const invoice = await invoiceRepo.findById(t.tenantId, runs[0].generatedInvoiceId!);
      expect(invoice).not.toBeNull();
      return { t, invoice: invoice! };
    }

    it('leaves the dues invoice a DRAFT — nothing issues or sends it, so a human must open it', async () => {
      const { invoice } = await billedDefaultPathInvoice();
      // agreement-service.ts:402 calls createDraftInvoice; createInvoice
      // (invoices/invoice.ts:336) hardcodes status 'draft'. GAP: this should
      // be 'open' for the story to be met — when it is, this line goes RED.
      expect(invoice.status).toBe('draft');
    });

    it('leaves the dues invoice with NO due date, so the collections cadence can never select it', async () => {
      const { invoice } = await billedDefaultPathInvoice();
      // The production port (app.ts:5689-5710) passes no dueDate, so the
      // overdue sweep's prefilter (status open/partially_paid AND
      // due_date <= now) can never match. GAP: this should be defined.
      expect(invoice.dueDate).toBeUndefined();
    });

    it('numbers the dues invoice AGREEMENT-<epoch ms>, outside the tenant sequence', async () => {
      const { invoice } = await billedDefaultPathInvoice();
      // app.ts:5693 mints `AGREEMENT-${Date.now()}` instead of
      // createInvoiceWithNextNumber, so the tenant's books have a gap and two
      // agreements billed in the same millisecond would collide on
      // idx_invoices_number. GAP: this should match /^INV\d{4}$/.
      expect(invoice.invoiceNumber).toMatch(/^AGREEMENT-\d+$/);
      expect(invoice.invoiceNumber).not.toMatch(/^INV\d{4}$/);
    });

    it('the tenant invoice sequence is NOT advanced by a membership cycle (the numbering gap, asserted positively)', async () => {
      const t = await seedTenant();
      const membership = await seedMembership(t, {
        nextRunAt: new Date(Date.now() - 3600_000),
      });
      await sweep([t.tenantId]);
      const run = (await runRepo.findByAgreement(t.tenantId, membership.id))[0];
      const invoice = await invoiceRepo.findById(t.tenantId, run.generatedInvoiceId!);

      expect(invoice!.invoiceNumber.startsWith('AGREEMENT-')).toBe(true);
      const settings = await settingsRepo.findByTenant(t.tenantId);
      expect(settings!.nextInvoiceNumber).toBe(1);
    });
  });
});
