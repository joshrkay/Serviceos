import { describe, it, expect, beforeEach } from 'vitest';
import { convertEstimateToInvoice } from '../../src/invoices/estimate-to-invoice';
import {
  InMemoryEstimateRepository,
  Estimate,
} from '../../src/estimates/estimate';
import { InMemoryJobRepository, Job } from '../../src/jobs/job';
import { InMemoryInvoiceRepository } from '../../src/invoices/invoice';
import { InMemorySettingsRepository } from '../../src/settings/settings';
import { InMemoryAuditRepository } from '../../src/audit/audit';
import { ValidationError } from '../../src/shared/errors';

const TENANT = 'tenant-conv-1';
const USER = 'user-conv-1';

function seedSettings(repo: InMemorySettingsRepository) {
  return repo.create({
    id: `settings-${TENANT}`,
    tenantId: TENANT,
    businessName: 'Test',
    timezone: 'UTC',
    estimatePrefix: 'EST-',
    invoicePrefix: 'INV-',
    nextEstimateNumber: 1,
    nextInvoiceNumber: 1,
    defaultPaymentTermDays: 30,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
}

function buildEstimate(overrides: Partial<Estimate> = {}): Estimate {
  return {
    id: 'est-1',
    tenantId: TENANT,
    jobId: 'job-1',
    estimateNumber: 'EST-0001',
    status: 'accepted',
    lineItems: [
      {
        id: 'li-1',
        description: 'AC unit',
        category: 'equipment',
        quantity: 1,
        unitPriceCents: 250000,
        totalCents: 250000,
        sortOrder: 0,
        taxable: true,
      },
    ],
    totals: {
      subtotalCents: 250000,
      taxableSubtotalCents: 250000,
      discountCents: 0,
      taxRateBps: 825,
      taxCents: 20625,
      totalCents: 270625,
    },
    customerMessage: 'Thanks for the opportunity.',
    createdBy: USER,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function buildJob(overrides: Partial<Job> = {}): Job {
  return {
    id: 'job-1',
    tenantId: TENANT,
    customerId: 'cust-1',
    locationId: 'loc-1',
    jobNumber: 'JOB-0001',
    summary: 'AC',
    status: 'completed',
    priority: 'normal',
    originatingLeadId: 'lead-source-1',
    createdBy: USER,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

describe('convertEstimateToInvoice', () => {
  let estimateRepo: InMemoryEstimateRepository;
  let jobRepo: InMemoryJobRepository;
  let invoiceRepo: InMemoryInvoiceRepository;
  let settingsRepo: InMemorySettingsRepository;
  let auditRepo: InMemoryAuditRepository;

  beforeEach(async () => {
    estimateRepo = new InMemoryEstimateRepository();
    jobRepo = new InMemoryJobRepository();
    invoiceRepo = new InMemoryInvoiceRepository();
    settingsRepo = new InMemorySettingsRepository();
    auditRepo = new InMemoryAuditRepository();
    await seedSettings(settingsRepo);
    await jobRepo.create(buildJob());
  });

  it('creates a draft invoice mirroring the estimate line items + totals', async () => {
    await estimateRepo.create(buildEstimate());

    const invoice = await convertEstimateToInvoice(
      { tenantId: TENANT, estimateId: 'est-1', createdBy: USER },
      estimateRepo,
      jobRepo,
      invoiceRepo,
      settingsRepo,
      auditRepo,
    );

    expect(invoice.status).toBe('draft');
    expect(invoice.estimateId).toBe('est-1');
    expect(invoice.jobId).toBe('job-1');
    expect(invoice.lineItems).toHaveLength(1);
    expect(invoice.totals.totalCents).toBe(270625);
    expect(invoice.originatingLeadId).toBe('lead-source-1');
    expect(invoice.customerMessage).toBe('Thanks for the opportunity.');
  });

  it('is idempotent — second call returns the existing invoice', async () => {
    await estimateRepo.create(buildEstimate());

    const first = await convertEstimateToInvoice(
      { tenantId: TENANT, estimateId: 'est-1', createdBy: USER },
      estimateRepo, jobRepo, invoiceRepo, settingsRepo, auditRepo,
    );
    const second = await convertEstimateToInvoice(
      { tenantId: TENANT, estimateId: 'est-1', createdBy: USER },
      estimateRepo, jobRepo, invoiceRepo, settingsRepo, auditRepo,
    );
    expect(second.id).toBe(first.id);
  });

  it('rejects conversion when the estimate is not accepted', async () => {
    await estimateRepo.create(buildEstimate({ status: 'sent' }));

    await expect(
      convertEstimateToInvoice(
        { tenantId: TENANT, estimateId: 'est-1', createdBy: USER },
        estimateRepo, jobRepo, invoiceRepo, settingsRepo, auditRepo,
      )
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('emits invoice.created_from_estimate audit event', async () => {
    await estimateRepo.create(buildEstimate());
    const invoice = await convertEstimateToInvoice(
      { tenantId: TENANT, estimateId: 'est-1', createdBy: USER },
      estimateRepo, jobRepo, invoiceRepo, settingsRepo, auditRepo,
    );

    const events = await auditRepo.findByEntity(TENANT, 'invoice', invoice.id);
    const conversionEvent = events.find((e) => e.eventType === 'invoice.created_from_estimate');
    expect(conversionEvent).toBeDefined();
    expect(conversionEvent?.metadata).toMatchObject({
      estimateId: 'est-1',
      estimateNumber: 'EST-0001',
      jobId: 'job-1',
    });
  });
});
