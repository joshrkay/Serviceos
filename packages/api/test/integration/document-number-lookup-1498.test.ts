/**
 * Docker-gated integration test — NOT run in web sessions. Requires the
 * testcontainer Postgres started by `npm run test:integration`.
 *
 * #1498 — `findDocumentByNumber` against the REAL repositories. The route
 * tests run it over in-memory repos, which cannot prove the Pg list queries
 * it narrows with (`search` on jobs / invoices, `documentSearch` on
 * estimates) actually reach `job_number` / `invoice_number` /
 * `estimate_number` — the mocked-pool failure CLAUDE.md names. Pinned here:
 * an exact number resolves to its record, a PREFIX of another record's
 * number ("JOB-008" vs "JOB-0081") resolves to nothing, and another tenant's
 * record with the same number is never returned.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { getSharedTestDb, createTestTenant, closeSharedTestDb, TestTenant } from './shared';
import { PgCustomerRepository } from '../../src/customers/pg-customer';
import { PgLocationRepository } from '../../src/locations/pg-location';
import { PgJobRepository } from '../../src/jobs/pg-job';
import { PgEstimateRepository } from '../../src/estimates/pg-estimate';
import { PgInvoiceRepository } from '../../src/invoices/pg-invoice';
import { createEstimate } from '../../src/estimates/estimate';
import { createInvoice } from '../../src/invoices/invoice';
import { buildLineItem } from '../../src/shared/billing-engine';
import { findDocumentByNumber } from '../../src/ai/resolution/document-number';

describe('Postgres integration — #1498 document numbers resolve by exact match', () => {
  let pool: Pool;
  let jobRepo: PgJobRepository;
  let estimateRepo: PgEstimateRepository;
  let invoiceRepo: PgInvoiceRepository;
  let tenant: TestTenant;
  let otherTenant: TestTenant;
  /** Unique per run so a reused database never collides with an old row. */
  const n = String(Math.floor(Math.random() * 90_000) + 10_000);

  async function seedJob(t: TestTenant, jobNumber: string, summary: string): Promise<string> {
    const customerRepo = new PgCustomerRepository(pool);
    const locationRepo = new PgLocationRepository(pool);
    const customerId = crypto.randomUUID();
    await customerRepo.create({
      id: customerId,
      tenantId: t.tenantId,
      firstName: 'Doc',
      lastName: 'Number',
      displayName: 'Doc Number',
      preferredChannel: 'phone',
      smsConsent: false,
      isArchived: false,
      createdBy: t.userId,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const locationId = crypto.randomUUID();
    await locationRepo.create({
      id: locationId,
      tenantId: t.tenantId,
      customerId,
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
    const jobId = crypto.randomUUID();
    await jobRepo.create({
      id: jobId,
      tenantId: t.tenantId,
      customerId,
      locationId,
      jobNumber,
      summary,
      status: 'scheduled',
      priority: 'normal',
      createdBy: t.userId,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    return jobId;
  }

  beforeAll(async () => {
    pool = await getSharedTestDb();
    jobRepo = new PgJobRepository(pool);
    estimateRepo = new PgEstimateRepository(pool);
    invoiceRepo = new PgInvoiceRepository(pool);
    tenant = await createTestTenant(pool);
    otherTenant = await createTestTenant(pool);
  }, 60_000);

  afterAll(async () => {
    await closeSharedTestDb();
  });

  it('finds a job by its exact job_number, and not by a prefix of a longer one', async () => {
    const jobId = await seedJob(tenant, `JOB-${n}1`, 'Furnace repair');
    await seedJob(tenant, `JOB-${n}12`, 'AC tune-up');

    const exact = await findDocumentByNumber({ jobRepo }, tenant.tenantId, {
      kind: 'job',
      number: `JOB-${n}1`,
    });
    const prefixOnly = await findDocumentByNumber({ jobRepo }, tenant.tenantId, {
      kind: 'job',
      number: `JOB-${n}`,
    });

    expect(exact?.kind).toBe('job');
    expect(exact?.record.id).toBe(jobId);
    expect(prefixOnly).toBeNull();
  });

  it('finds an invoice and an estimate by number, and never another tenant\'s', async () => {
    const jobId = await seedJob(tenant, `JOB-${n}5`, 'Water heater flush');
    const invoice = await createInvoice(
      {
        tenantId: tenant.tenantId,
        jobId,
        invoiceNumber: `INV-${n}5`,
        lineItems: [buildLineItem('li-1', 'Labor', 1, 18_000, 0, false, 'labor')],
        createdBy: tenant.userId,
      },
      invoiceRepo,
    );
    const estimate = await createEstimate(
      {
        tenantId: tenant.tenantId,
        jobId,
        estimateNumber: `EST-${n}5`,
        lineItems: [buildLineItem('li-1', 'Diagnostic', 1, 9_500, 0, false, 'labor')],
        createdBy: tenant.userId,
      },
      estimateRepo,
    );
    const otherJob = await seedJob(otherTenant, `JOB-${n}6`, 'Other shop');
    await createInvoice(
      {
        tenantId: otherTenant.tenantId,
        jobId: otherJob,
        invoiceNumber: `INV-${n}6`,
        lineItems: [buildLineItem('li-1', 'Labor', 1, 5_000, 0, false, 'labor')],
        createdBy: otherTenant.userId,
      },
      invoiceRepo,
    );

    const inv = await findDocumentByNumber({ invoiceRepo }, tenant.tenantId, {
      kind: 'invoice',
      number: `INV-${n}5`,
    });
    const est = await findDocumentByNumber({ estimateRepo }, tenant.tenantId, {
      kind: 'estimate',
      number: `EST-${n}5`,
    });
    const crossTenant = await findDocumentByNumber({ invoiceRepo }, tenant.tenantId, {
      kind: 'invoice',
      number: `INV-${n}6`,
    });

    expect(inv?.record.id).toBe(invoice.id);
    expect(est?.record.id).toBe(estimate.id);
    expect(crossTenant).toBeNull();
  });
});
