/**
 * §8.12 Memberships — what `runRecurringAgreementsSweep` ACTUALLY does, at
 * real Postgres, and the clauses of the story it does not do.
 *
 * The PRD's premise for this row ("no renewal sweep") was wrong — corrected on
 * ticket #1023 by the §8.8 entry audit (#1009): `runRecurringAgreementsSweep`
 * exists (workers/recurring-agreements-worker.ts:38) and is wired at
 * app.ts:5793 on a 60s interval. What was true is that every test of it proved
 * a COLUMN, not a behaviour. This file proves the behaviour on real rows, and
 * marks — with `it.fails`, so the gap is executable rather than prose — the
 * parts of "memberships renew and bill themselves, so recurring revenue is
 * actually recurring" that the code does not deliver.
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
 *   - member pricing resolves from real agreement rows (effective term only).
 *
 * NOT MET (see the `it.fails` blocks and the lane report):
 *   - the dues invoice is left as a DRAFT with no due date, so it is invisible
 *     to the collections cadence — nothing chases it, and nothing sends it;
 *   - it is numbered `AGREEMENT-<epoch ms>` instead of off the tenant's
 *     invoice sequence.
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
import { createJob } from '../../src/jobs/job';
import { createInvoice } from '../../src/invoices/invoice';
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
   * The story-not-met half. These use `it.fails`: each body asserts what "bills
   * itself" would require, and PASSES because the assertion fails today — so
   * the gap is recorded executably and flips loudly the moment it is closed.
   * Do not "fix" one by weakening it; close the gap in the worker (an owner
   * decision — parked on #1023 for the orchestrator, not taken by this lane).
   */
  describe('story-not-met: what "bills itself" does not yet do', () => {
    it.fails(
      'the dues invoice is ISSUED so the customer can pay it — today it is left a draft',
      async () => {
        const t = await seedTenant();
        const membership = await seedMembership(t, {
          nextRunAt: new Date(Date.now() - 3600_000),
        });
        await sweep([t.tenantId]);
        const run = (await runRepo.findByAgreement(t.tenantId, membership.id))[0];
        const invoice = await invoiceRepo.findById(t.tenantId, run.generatedInvoiceId!);
        // agreement-service.ts:395 calls createDraftInvoice; createInvoice
        // (invoices/invoice.ts:336) hardcodes status 'draft'. Nothing in the
        // sweep issues or sends it, so recurring revenue is not collected
        // without a human opening the invoice.
        expect(invoice!.status).toBe('open');
      },
    );

    it.fails(
      'the dues invoice carries a due date so the collections cadence can chase it — today it has none',
      async () => {
        const t = await seedTenant();
        const membership = await seedMembership(t, {
          nextRunAt: new Date(Date.now() - 3600_000),
        });
        await sweep([t.tenantId]);
        const run = (await runRepo.findByAgreement(t.tenantId, membership.id))[0];
        const invoice = await invoiceRepo.findById(t.tenantId, run.generatedInvoiceId!);
        // The production port (app.ts:5689-5710) passes no dueDate, so the
        // overdue sweep's prefilter (status open/partially_paid AND
        // due_date <= now) can never select it: an unpaid membership is never
        // chased, however long it goes unpaid.
        expect(invoice!.dueDate).toBeDefined();
      },
    );

    it.fails(
      'the dues invoice is numbered off the tenant invoice sequence — today it is AGREEMENT-<epoch ms>',
      async () => {
        const t = await seedTenant();
        const membership = await seedMembership(t, {
          nextRunAt: new Date(Date.now() - 3600_000),
        });
        await sweep([t.tenantId]);
        const run = (await runRepo.findByAgreement(t.tenantId, membership.id))[0];
        const invoice = await invoiceRepo.findById(t.tenantId, run.generatedInvoiceId!);
        // app.ts:5693 mints `AGREEMENT-${Date.now()}` instead of
        // createInvoiceWithNextNumber, so the tenant's books have a gap in
        // their numbering and two agreements billed in the same millisecond
        // would collide on idx_invoices_number (tenant_id, invoice_number).
        expect(invoice!.invoiceNumber).toMatch(/^INV\d{4}$/);
      },
    );

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
