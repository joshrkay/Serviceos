import { describe, it, expect, beforeEach } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import { convertEstimateToInvoice } from '../../src/invoices/convert-estimate';
import { InMemoryInvoiceRepository } from '../../src/invoices/invoice';
import { InMemoryPaymentRepository } from '../../src/invoices/payment';
import { Job, InMemoryJobRepository } from '../../src/jobs/job';
import { InMemorySettingsRepository } from '../../src/settings/settings';
import { InMemoryAuditRepository } from '../../src/audit/audit';
import {
  createEstimate,
  InMemoryEstimateRepository,
  Estimate,
} from '../../src/estimates/estimate';
import { buildLineItem, LineItem } from '../../src/shared/billing-engine';

const TENANT = 'tenant-convert';

function makeJob(id: string, overrides: Partial<Job> = {}): Job {
  return {
    id,
    tenantId: TENANT,
    customerId: uuidv4(),
    locationId: uuidv4(),
    jobNumber: 'JOB-1',
    summary: 'AC repair',
    status: 'completed',
    priority: 'normal',
    depositRequiredCents: 0,
    depositPaidCents: 0,
    depositStatus: 'not_required',
    createdBy: 'u1',
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

describe('convertEstimateToInvoice', () => {
  let estimateRepo: InMemoryEstimateRepository;
  let invoiceRepo: InMemoryInvoiceRepository;
  let paymentRepo: InMemoryPaymentRepository;
  let jobRepo: InMemoryJobRepository;
  let settingsRepo: InMemorySettingsRepository;
  let auditRepo: InMemoryAuditRepository;

  beforeEach(() => {
    estimateRepo = new InMemoryEstimateRepository();
    invoiceRepo = new InMemoryInvoiceRepository();
    paymentRepo = new InMemoryPaymentRepository();
    jobRepo = new InMemoryJobRepository();
    settingsRepo = new InMemorySettingsRepository();
    auditRepo = new InMemoryAuditRepository();
  });

  function deps(actorId = 'u1') {
    return { estimateRepo, invoiceRepo, jobRepo, settingsRepo, auditRepo, paymentRepo, actorId };
  }

  async function seedAcceptedEstimate(
    jobId: string,
    lineItems: LineItem[],
    overrides: Partial<Estimate> = {},
  ): Promise<Estimate> {
    const est = await createEstimate(
      { tenantId: TENANT, jobId, estimateNumber: 'EST-1', lineItems, createdBy: 'u1' },
      estimateRepo,
    );
    return (await estimateRepo.update(TENANT, est.id, { status: 'accepted', ...overrides }))!;
  }

  it('refuses to convert a non-accepted estimate', async () => {
    const job = await jobRepo.create(makeJob(uuidv4()));
    const est = await createEstimate(
      { tenantId: TENANT, jobId: job.id, estimateNumber: 'EST-1', lineItems: [buildLineItem('i1', 'x', 1, 1000, 0, true)], createdBy: 'u1' },
      estimateRepo,
    );
    await expect(convertEstimateToInvoice(TENANT, est.id, deps())).rejects.toThrow(/accepted/i);
  });

  it('creates a linked invoice from an accepted estimate', async () => {
    const job = await jobRepo.create(makeJob(uuidv4()));
    const est = await seedAcceptedEstimate(job.id, [buildLineItem('i1', 'Repair', 1, 20000, 0, true)]);

    const invoice = await convertEstimateToInvoice(TENANT, est.id, deps());
    expect(invoice).not.toBeNull();
    expect(invoice!.estimateId).toBe(est.id);
    expect(invoice!.jobId).toBe(job.id);
    expect(invoice!.totals.totalCents).toBe(20000);

    const events = auditRepo.getAll();
    expect(events.some((e) => e.eventType === 'estimate.converted')).toBe(true);
  });

  it('is idempotent — a second convert returns the same invoice', async () => {
    const job = await jobRepo.create(makeJob(uuidv4()));
    const est = await seedAcceptedEstimate(job.id, [buildLineItem('i1', 'Repair', 1, 20000, 0, true)]);

    const first = await convertEstimateToInvoice(TENANT, est.id, deps());
    const second = await convertEstimateToInvoice(TENANT, est.id, deps());
    expect(second!.id).toBe(first!.id);
    const all = await invoiceRepo.findByJob(TENANT, job.id);
    expect(all).toHaveLength(1);
  });

  it('bills only the accepted good-better-best selection', async () => {
    const job = await jobRepo.create(makeJob(uuidv4()));
    const tiered: LineItem[] = [
      { ...buildLineItem('base', 'Diagnostic', 1, 5000, 0, true) },
      { ...buildLineItem('good', 'Good', 1, 10000, 1, true), groupKey: 'tier', isOptional: true },
      { ...buildLineItem('better', 'Better', 1, 20000, 2, true), groupKey: 'tier', isOptional: true },
    ];
    const est = await seedAcceptedEstimate(job.id, tiered, { acceptedSelection: ['base', 'better'] });

    const invoice = await convertEstimateToInvoice(TENANT, est.id, deps());
    // base 5000 + better 20000 = 25000 (good tier excluded)
    expect(invoice!.totals.totalCents).toBe(25000);
    expect(invoice!.lineItems.map((li) => li.description).sort()).toEqual(['Better', 'Diagnostic']);
  });

  it('credits a paid deposit onto the new invoice', async () => {
    const job = await jobRepo.create(
      makeJob(uuidv4(), { depositRequiredCents: 8000, depositPaidCents: 8000, depositStatus: 'paid' }),
    );
    const est = await seedAcceptedEstimate(job.id, [buildLineItem('i1', 'Repair', 1, 20000, 0, true)]);

    const invoice = await convertEstimateToInvoice(TENANT, est.id, deps());
    expect(invoice!.amountPaidCents).toBe(8000);
    expect(invoice!.amountDueCents).toBe(12000);
  });
});
