/**
 * Docker-gated integration test — NOT run in web sessions. Requires the
 * testcontainer Postgres started by `npm run test:integration`.
 *
 * The CUSTOMER-ANCHORED ESTIMATE / INVOICE lookups, against the REAL schema.
 *
 * WHY THIS FILE EXISTS AT ALL. The unit tests for these branches mock the
 * `pg.Pool`, so they can prove the branch is TAKEN and the parameters are
 * bound, and they cannot prove a single column exists. That is the exact
 * failure mode CLAUDE.md names ("the entity resolver shipped with nonexistent
 * column names because its Pool was mocked") and that
 * docs/solutions/database-issues/mocked-pool-hides-real-schema-mismatch.md
 * catalogues repeatedly. These two queries traverse
 * `estimates.job_id → jobs.customer_id` and `invoices.job_id →
 * jobs.customer_id`, and read `estimates.deleted_at` (added late, in
 * migration 125 — `invoices` has NO such column, which is itself a real
 * asymmetry a mocked pool cannot see), `estimates.total_cents`,
 * `invoices.amount_due_cents` and `invoices.due_date`. Every one of those
 * names is pinned here by executing the real thing against the real
 * migrations.
 *
 * Register cases: est-06 ("Nudge Khan about the pending estimate") and
 * inv-08 ("Send Johnson a reminder on the overdue invoice") — the operator
 * names the PERSON, never the paperwork.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { getSharedTestDb, createTestTenant, closeSharedTestDb, TestTenant } from './shared';
import { PgEntityResolver } from '../../src/ai/resolution/pg-entity-resolver';
import { PgCustomerRepository } from '../../src/customers/pg-customer';
import { PgLocationRepository } from '../../src/locations/pg-location';
import { PgJobRepository } from '../../src/jobs/pg-job';
import { PgEstimateRepository } from '../../src/estimates/pg-estimate';
import { PgInvoiceRepository } from '../../src/invoices/pg-invoice';
import { createEstimate } from '../../src/estimates/estimate';
import { createInvoice } from '../../src/invoices/invoice';
import { buildLineItem } from '../../src/shared/billing-engine';
import type { EstimateStatus } from '../../src/estimates/estimate';
import type { InvoiceStatus } from '../../src/invoices/invoice';

describe('Postgres integration — customer-anchored estimate/invoice resolution', () => {
  let pool: Pool;
  let resolver: PgEntityResolver;
  let customerRepo: PgCustomerRepository;
  let locationRepo: PgLocationRepository;
  let jobRepo: PgJobRepository;
  let estimateRepo: PgEstimateRepository;
  let invoiceRepo: PgInvoiceRepository;
  let tenant: TestTenant;

  beforeAll(async () => {
    pool = await getSharedTestDb();
    resolver = new PgEntityResolver(pool);
    customerRepo = new PgCustomerRepository(pool);
    locationRepo = new PgLocationRepository(pool);
    jobRepo = new PgJobRepository(pool);
    estimateRepo = new PgEstimateRepository(pool);
    invoiceRepo = new PgInvoiceRepository(pool);
    tenant = await createTestTenant(pool);
  }, 60_000);

  afterAll(async () => {
    await closeSharedTestDb();
  });

  async function seedCustomer(displayName: string): Promise<string> {
    const id = crypto.randomUUID();
    await customerRepo.create({
      id,
      tenantId: tenant.tenantId,
      firstName: displayName,
      lastName: '',
      displayName,
      preferredChannel: 'phone',
      smsConsent: false,
      isArchived: false,
      createdBy: tenant.userId,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const locationId = crypto.randomUUID();
    await locationRepo.create({
      id: locationId,
      tenantId: tenant.tenantId,
      customerId: id,
      street1: '1 QA Cedar Avenue',
      city: 'Phoenix',
      state: 'AZ',
      postalCode: '85001',
      country: 'USA',
      isPrimary: true,
      addressType: 'service',
      isArchived: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    return id;
  }

  async function seedJob(customerId: string, summary: string): Promise<string> {
    const jobId = crypto.randomUUID();
    const locations = await locationRepo.findByCustomer(tenant.tenantId, customerId);
    await jobRepo.create({
      id: jobId,
      tenantId: tenant.tenantId,
      customerId,
      locationId: locations[0].id,
      jobNumber: `JOB-${jobId.slice(0, 8)}`,
      summary,
      status: 'scheduled',
      priority: 'normal',
      createdBy: tenant.userId,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    return jobId;
  }

  /**
   * Every seeded document's own text is deliberately GENERIC. The anchored
   * query must find it through `job_id → customer_id` alone — planting the
   * customer's surname in `customer_message` is exactly the illusion
   * docs/solutions/test-failures/a-fixture-arranged-to-pass-proves-nothing.md
   * describes.
   */
  async function seedEstimate(
    jobId: string,
    status: EstimateStatus,
    totalCents: number,
  ): Promise<string> {
    const estimate = await createEstimate(
      {
        tenantId: tenant.tenantId,
        jobId,
        estimateNumber: `EST-${crypto.randomUUID().slice(0, 8)}`,
        lineItems: [buildLineItem('li-1', 'Diagnostic', 1, totalCents, 0, false, 'labor')],
        customerMessage: 'Here is the quote for the work we talked through.',
        createdBy: tenant.userId,
      },
      estimateRepo,
    );
    if (status !== 'draft') {
      await estimateRepo.update(tenant.tenantId, estimate.id, { status });
    }
    return estimate.id;
  }

  async function seedInvoice(
    jobId: string,
    status: InvoiceStatus,
    amountDueCents: number,
    dueInDays = 30,
  ): Promise<string> {
    const invoice = await createInvoice(
      {
        tenantId: tenant.tenantId,
        jobId,
        invoiceNumber: `INV-${crypto.randomUUID().slice(0, 8)}`,
        lineItems: [buildLineItem('li-1', 'Labor', 1, amountDueCents, 0, false, 'labor')],
        createdBy: tenant.userId,
      },
      invoiceRepo,
    );
    await invoiceRepo.update(tenant.tenantId, invoice.id, {
      status,
      issuedAt: new Date(),
      dueDate: new Date(Date.now() + dueInDays * 24 * 3600 * 1000),
      amountDueCents,
    });
    return invoice.id;
  }

  describe('kind: estimate, anchored on a verified customerId', () => {
    it('an EMPTY reference resolves that customer’s one open estimate (est-06)', async () => {
      const customerId = await seedCustomer('Doc Khan');
      const jobId = await seedJob(customerId, 'Condenser install');
      const estimateId = await seedEstimate(jobId, 'sent', 325000);

      const result = await resolver.resolve({
        tenantId: tenant.tenantId,
        reference: '',
        kind: 'estimate',
        customerId,
      });

      expect(result.kind).toBe('resolved');
      if (result.kind === 'resolved') {
        expect(result.candidate.id).toBe(estimateId);
        expect(result.candidate.kind).toBe('estimate');
        // The amount really came back off `estimates.total_cents`, in cents,
        // rendered only for the picker hint.
        expect(result.candidate.hint).toBe('sent · $3,250.00');
      }
    });

    it('never leaks another customer’s estimate', async () => {
      const quiet = await seedCustomer('Doc Quiet');
      const noisy = await seedCustomer('Doc Noisy');
      await seedEstimate(await seedJob(noisy, 'Noisy install'), 'sent', 100000);
      await seedJob(quiet, 'Quiet install');

      const result = await resolver.resolve({
        tenantId: tenant.tenantId,
        reference: 'Doc Quiet',
        kind: 'estimate',
        customerId: quiet,
      });

      expect(result.kind).toBe('not_found');
    });

    it('two open estimates become the one-tap picker, labelled by number and amount', async () => {
      const customerId = await seedCustomer('Doc Two');
      const jobId = await seedJob(customerId, 'Two-estimate job');
      await seedEstimate(jobId, 'sent', 120000);
      await seedEstimate(jobId, 'draft', 45000);

      const result = await resolver.resolve({
        tenantId: tenant.tenantId,
        reference: 'Doc Two',
        kind: 'estimate',
        customerId,
      });

      expect(result.kind).toBe('ambiguous');
      if (result.kind === 'ambiguous') {
        expect(result.candidates).toHaveLength(2);
        expect(result.candidates.map((c) => c.hint).sort()).toEqual([
          'draft · $450.00',
          'sent · $1,200.00',
        ]);
      }
    });

    it.each<EstimateStatus>(['accepted', 'rejected', 'expired'])(
      'a closed (%s) estimate is not offered for a document nobody named',
      async (status) => {
        const customerId = await seedCustomer(`Doc Closed ${status}`);
        const jobId = await seedJob(customerId, `Closed ${status} job`);
        await seedEstimate(jobId, status, 90000);

        const result = await resolver.resolve({
          tenantId: tenant.tenantId,
          reference: '',
          kind: 'estimate',
          customerId,
        });

        expect(result.kind).toBe('not_found');
      },
    );

    it('a soft-deleted estimate is excluded — pins estimates.deleted_at, which exists only from migration 125', async () => {
      const customerId = await seedCustomer('Doc Deleted');
      const jobId = await seedJob(customerId, 'Deleted-estimate job');
      const estimateId = await seedEstimate(jobId, 'sent', 70000);
      await pool.query(`UPDATE estimates SET deleted_at = NOW() WHERE id = $1`, [estimateId]);

      const result = await resolver.resolve({
        tenantId: tenant.tenantId,
        reference: '',
        kind: 'estimate',
        customerId,
      });

      expect(result.kind).toBe('not_found');
    });
  });

  describe('kind: invoice, anchored on a verified customerId', () => {
    it('an EMPTY reference resolves that customer’s one open invoice (inv-08)', async () => {
      const customerId = await seedCustomer('Doc Johnson');
      const jobId = await seedJob(customerId, 'Water heater replacement');
      const invoiceId = await seedInvoice(jobId, 'open', 45000);

      const result = await resolver.resolve({
        tenantId: tenant.tenantId,
        reference: '',
        kind: 'invoice',
        customerId,
      });

      expect(result.kind).toBe('resolved');
      if (result.kind === 'resolved') {
        expect(result.candidate.id).toBe(invoiceId);
        expect(result.candidate.kind).toBe('invoice');
        // Off `invoices.amount_due_cents` — the balance, not the total.
        expect(result.candidate.hint).toBe('open · $450.00');
      }
    });

    it('a partially paid invoice is still chaseable', async () => {
      const customerId = await seedCustomer('Doc Partial');
      const jobId = await seedJob(customerId, 'Partial payment job');
      const invoiceId = await seedInvoice(jobId, 'partially_paid', 12500);

      const result = await resolver.resolve({
        tenantId: tenant.tenantId,
        reference: '',
        kind: 'invoice',
        customerId,
      });

      expect(result.kind).toBe('resolved');
      if (result.kind === 'resolved') expect(result.candidate.id).toBe(invoiceId);
    });

    it.each<InvoiceStatus>(['draft', 'paid', 'void', 'canceled'])(
      'a %s invoice is not offered for a document nobody named',
      async (status) => {
        const customerId = await seedCustomer(`Doc Inv ${status}`);
        const jobId = await seedJob(customerId, `Inv ${status} job`);
        await seedInvoice(jobId, status, 30000);

        const result = await resolver.resolve({
          tenantId: tenant.tenantId,
          reference: '',
          kind: 'invoice',
          customerId,
        });

        expect(result.kind).toBe('not_found');
      },
    );

    it('two open invoices come back soonest-due first, as a picker', async () => {
      const customerId = await seedCustomer('Doc Two Invoices');
      const jobId = await seedJob(customerId, 'Two-invoice job');
      const later = await seedInvoice(jobId, 'open', 19500, 45);
      const sooner = await seedInvoice(jobId, 'open', 28500, 5);

      const result = await resolver.resolve({
        tenantId: tenant.tenantId,
        reference: 'Doc Two Invoices',
        kind: 'invoice',
        customerId,
      });

      expect(result.kind).toBe('ambiguous');
      if (result.kind === 'ambiguous') {
        expect(result.candidates.map((c) => c.id)).toEqual([sooner, later]);
      }
    });
  });

  describe('the anchor never changes what a SPOKEN reference means', () => {
    it('without a customerId, an empty reference is still skipped', async () => {
      const result = await resolver.resolve({
        tenantId: tenant.tenantId,
        reference: '   ',
        kind: 'invoice',
      });
      expect(result.kind).toBe('skipped');
    });

    it('an exact document number with no anchor still resolves through the named path', async () => {
      const customerId = await seedCustomer('Doc Numbered');
      const jobId = await seedJob(customerId, 'Numbered job');
      const invoiceId = await seedInvoice(jobId, 'open', 55000);
      const { rows } = await pool.query<{ invoice_number: string }>(
        `SELECT invoice_number FROM invoices WHERE id = $1`,
        [invoiceId],
      );

      const result = await resolver.resolve({
        tenantId: tenant.tenantId,
        reference: rows[0].invoice_number,
        kind: 'invoice',
      });

      expect(result.kind).toBe('resolved');
      if (result.kind === 'resolved') expect(result.candidate.id).toBe(invoiceId);
    });
  });
});
