import { describe, it, expect, beforeEach } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import { maybeAutoInvoiceOnCompletion } from '../../src/invoices/auto-invoice-on-completion';
import { InMemoryInvoiceRepository, createInvoice } from '../../src/invoices/invoice';
import { InMemoryEstimateRepository, createEstimate, Estimate } from '../../src/estimates/estimate';
import { InMemoryProposalRepository } from '../../src/proposals/proposal';
import { InMemorySettingsRepository, TenantSettings } from '../../src/settings/settings';
import { InMemoryAuditRepository } from '../../src/audit/audit';
import { buildLineItem, LineItem } from '../../src/shared/billing-engine';
import { Job, JobMoneyState } from '../../src/jobs/job';

const TENANT = 'tenant-auto-invoice';

function makeJob(overrides: Partial<Job> = {}): Job {
  return {
    id: uuidv4(),
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
    moneyState: 'estimate_accepted',
    createdBy: 'u1',
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function makeSettings(autoInvoiceOnCompletion: boolean): TenantSettings {
  return {
    id: `settings-${TENANT}`,
    tenantId: TENANT,
    businessName: 'Rivera HVAC',
    timezone: 'UTC',
    estimatePrefix: 'EST-',
    invoicePrefix: 'INV-',
    nextEstimateNumber: 1,
    nextInvoiceNumber: 1,
    defaultPaymentTermDays: 30,
    autoInvoiceOnCompletion,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

describe('maybeAutoInvoiceOnCompletion', () => {
  let estimateRepo: InMemoryEstimateRepository;
  let invoiceRepo: InMemoryInvoiceRepository;
  let proposalRepo: InMemoryProposalRepository;
  let settingsRepo: InMemorySettingsRepository;
  let auditRepo: InMemoryAuditRepository;

  beforeEach(() => {
    estimateRepo = new InMemoryEstimateRepository();
    invoiceRepo = new InMemoryInvoiceRepository();
    proposalRepo = new InMemoryProposalRepository();
    settingsRepo = new InMemorySettingsRepository();
    auditRepo = new InMemoryAuditRepository();
  });

  function deps() {
    return { estimateRepo, invoiceRepo, proposalRepo, settingsRepo, auditRepo };
  }

  async function seedAcceptedEstimate(jobId: string, lineItems: LineItem[], overrides: Partial<Estimate> = {}) {
    const est = await createEstimate(
      { tenantId: TENANT, jobId, estimateNumber: 'EST-1', lineItems, createdBy: 'u1' },
      estimateRepo,
    );
    return (await estimateRepo.update(TENANT, est.id, { status: 'accepted', ...overrides }))!;
  }

  it('drafts one invoice proposal from the accepted estimate when the toggle is on', async () => {
    await settingsRepo.create(makeSettings(true));
    const job = makeJob();
    const est = await seedAcceptedEstimate(job.id, [buildLineItem('i1', 'Repair', 1, 20000, 0, true)]);

    const proposal = await maybeAutoInvoiceOnCompletion(deps(), job);

    expect(proposal).not.toBeNull();
    expect(proposal!.proposalType).toBe('draft_invoice');
    expect(proposal!.status).toBe('draft'); // never auto-approved
    const payload = proposal!.payload as { jobId: string; customerId: string; estimateId: string; lineItems: { unitPrice: number; unitPriceCents: number }[] };
    expect(payload.jobId).toBe(job.id);
    expect(payload.customerId).toBe(job.customerId);
    expect(payload.estimateId).toBe(est.id);
    // Carries both the unitPrice alias (Zod contract) and unitPriceCents (executor).
    expect(payload.lineItems[0].unitPrice).toBe(20000);
    expect(payload.lineItems[0].unitPriceCents).toBe(20000);

    expect(await proposalRepo.findByTenant(TENANT)).toHaveLength(1);
    expect(auditRepo.getAll().some((e) => e.eventType === 'invoice.auto_drafted')).toBe(true);
  });

  it('no-ops when the tenant has not opted in', async () => {
    await settingsRepo.create(makeSettings(false));
    const job = makeJob();
    await seedAcceptedEstimate(job.id, [buildLineItem('i1', 'Repair', 1, 20000, 0, true)]);

    const proposal = await maybeAutoInvoiceOnCompletion(deps(), job);
    expect(proposal).toBeNull();
    expect(await proposalRepo.findByTenant(TENANT)).toHaveLength(0);
  });

  it('no-ops for an ineligible money-state', async () => {
    await settingsRepo.create(makeSettings(true));
    const job = makeJob({ moneyState: 'paid' as JobMoneyState });
    await seedAcceptedEstimate(job.id, [buildLineItem('i1', 'Repair', 1, 20000, 0, true)]);

    expect(await maybeAutoInvoiceOnCompletion(deps(), job)).toBeNull();
    expect(await proposalRepo.findByTenant(TENANT)).toHaveLength(0);
  });

  it('is idempotent — no second draft when the job already has a live invoice', async () => {
    await settingsRepo.create(makeSettings(true));
    const job = makeJob();
    await seedAcceptedEstimate(job.id, [buildLineItem('i1', 'Repair', 1, 20000, 0, true)]);
    await createInvoice(
      {
        tenantId: TENANT,
        jobId: job.id,
        invoiceNumber: 'INV-1',
        lineItems: [buildLineItem('i1', 'Repair', 1, 20000, 0, true)],
        createdBy: 'u1',
      },
      invoiceRepo,
    );

    expect(await maybeAutoInvoiceOnCompletion(deps(), job)).toBeNull();
    expect(await proposalRepo.findByTenant(TENANT)).toHaveLength(0);
  });

  it('carries the accepted estimate discount + tax into the draft payload', async () => {
    await settingsRepo.create(makeSettings(true));
    const job = makeJob();
    const est = await createEstimate(
      {
        tenantId: TENANT,
        jobId: job.id,
        estimateNumber: 'EST-1',
        lineItems: [buildLineItem('i1', 'Repair', 1, 20000, 0, true)],
        discountCents: 500,
        taxRateBps: 1000,
        createdBy: 'u1',
      },
      estimateRepo,
    );
    await estimateRepo.update(TENANT, est.id, { status: 'accepted' });

    const proposal = await maybeAutoInvoiceOnCompletion(deps(), job);
    const payload = proposal!.payload as { discountCents: number; taxRateBps: number };
    // So approving the draft bills the accepted amount, not 0 discount / 0 tax.
    expect(payload.discountCents).toBe(500);
    expect(payload.taxRateBps).toBe(1000);
  });

  it('no-ops when there is no accepted estimate / nothing to bill', async () => {
    await settingsRepo.create(makeSettings(true));
    const job = makeJob({ moneyState: 'no_estimate' });

    expect(await maybeAutoInvoiceOnCompletion(deps(), job)).toBeNull();
    expect(await proposalRepo.findByTenant(TENANT)).toHaveLength(0);
  });
});
