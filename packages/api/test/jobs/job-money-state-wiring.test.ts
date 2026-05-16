import { describe, it, expect } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import { createJob, InMemoryJobRepository } from '../../src/jobs/job';
import {
  InMemoryInvoiceRepository,
  issueInvoice,
  transitionInvoiceStatus,
  Invoice,
  InvoiceStatus,
} from '../../src/invoices/invoice';
import {
  InMemoryEstimateRepository,
  transitionEstimateStatus,
  Estimate,
  EstimateStatus,
} from '../../src/estimates/estimate';
import { InMemoryPaymentRepository, recordPayment } from '../../src/invoices/payment';
import { InMemoryAuditRepository } from '../../src/audit/audit';
import type { DocumentTotals } from '../../src/shared/billing-engine';
import type { RefreshJobMoneyStateDeps } from '../../src/jobs/job-money-state';
import { refreshJobMoneyStateSafe } from '../../src/jobs/job-money-state';

const ZERO_TOTALS: DocumentTotals = {
  subtotalCents: 0,
  discountCents: 0,
  taxRateBps: 0,
  taxableSubtotalCents: 0,
  taxCents: 0,
  totalCents: 0,
};

function makeEstimate(jobId: string, status: EstimateStatus): Estimate {
  return {
    id: uuidv4(),
    tenantId: 't1',
    jobId,
    estimateNumber: 'EST-0001',
    status,
    lineItems: [],
    totals: ZERO_TOTALS,
    createdBy: 'u1',
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

function makeInvoice(
  jobId: string,
  status: InvoiceStatus,
  opts: { totalCents?: number; amountDueCents?: number } = {},
): Invoice {
  const totalCents = opts.totalCents ?? 0;
  return {
    id: uuidv4(),
    tenantId: 't1',
    jobId,
    invoiceNumber: 'INV-0001',
    status,
    lineItems: [],
    totals: {
      ...ZERO_TOTALS,
      subtotalCents: totalCents,
      taxableSubtotalCents: totalCents,
      totalCents,
    },
    amountPaidCents: 0,
    amountDueCents: opts.amountDueCents ?? totalCents,
    createdBy: 'u1',
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

async function setup() {
  const jobRepo = new InMemoryJobRepository();
  const estimateRepo = new InMemoryEstimateRepository();
  const invoiceRepo = new InMemoryInvoiceRepository();
  const paymentRepo = new InMemoryPaymentRepository();
  const auditRepo = new InMemoryAuditRepository();
  const job = await createJob(
    { tenantId: 't1', customerId: 'c1', locationId: 'l1', summary: 'Job', createdBy: 'u1' },
    jobRepo,
  );
  const deps: RefreshJobMoneyStateDeps = { jobRepo, estimateRepo, invoiceRepo, auditRepo };
  return { jobRepo, estimateRepo, invoiceRepo, paymentRepo, auditRepo, job, deps };
}

describe('money-state threading through domain functions', () => {
  it('issueInvoice flips the job to invoiced when given deps', async () => {
    const { jobRepo, invoiceRepo, job, deps } = await setup();
    const invoice = await invoiceRepo.create(makeInvoice(job.id, 'draft', { totalCents: 10000 }));

    await issueInvoice('t1', invoice.id, 30, invoiceRepo, deps);

    expect((await jobRepo.findById('t1', job.id))!.moneyState).toBe('invoiced');
  });

  it('issueInvoice leaves money-state untouched when given no deps', async () => {
    const { jobRepo, invoiceRepo, job } = await setup();
    const invoice = await invoiceRepo.create(makeInvoice(job.id, 'draft', { totalCents: 10000 }));

    await issueInvoice('t1', invoice.id, 30, invoiceRepo);

    expect((await jobRepo.findById('t1', job.id))!.moneyState).toBe('no_estimate');
  });

  it('recordPayment flips the job to paid when the invoice is fully paid', async () => {
    const { jobRepo, invoiceRepo, paymentRepo, job, deps } = await setup();
    const invoice = await invoiceRepo.create(
      makeInvoice(job.id, 'open', { totalCents: 10000, amountDueCents: 10000 }),
    );

    await recordPayment(
      {
        tenantId: 't1',
        invoiceId: invoice.id,
        amountCents: 10000,
        method: 'credit_card',
        processedBy: 'u1',
      },
      invoiceRepo,
      paymentRepo,
      deps,
    );

    expect((await jobRepo.findById('t1', job.id))!.moneyState).toBe('paid');
  });

  it('transitionInvoiceStatus flips the job to paid', async () => {
    const { jobRepo, invoiceRepo, job, deps } = await setup();
    const invoice = await invoiceRepo.create(makeInvoice(job.id, 'open', { totalCents: 10000 }));

    await transitionInvoiceStatus('t1', invoice.id, 'paid', invoiceRepo, deps);

    expect((await jobRepo.findById('t1', job.id))!.moneyState).toBe('paid');
  });

  it('transitionEstimateStatus flips the job to estimate_sent', async () => {
    const { jobRepo, estimateRepo, job, deps } = await setup();
    const estimate = await estimateRepo.create(makeEstimate(job.id, 'draft'));

    await transitionEstimateStatus('t1', estimate.id, 'sent', estimateRepo, deps);

    expect((await jobRepo.findById('t1', job.id))!.moneyState).toBe('estimate_sent');
  });

  it('recordPayment leaves money-state untouched when given no deps', async () => {
    const { jobRepo, invoiceRepo, paymentRepo, job } = await setup();
    const invoice = await invoiceRepo.create(
      makeInvoice(job.id, 'open', { totalCents: 10000, amountDueCents: 10000 }),
    );

    await recordPayment(
      {
        tenantId: 't1',
        invoiceId: invoice.id,
        amountCents: 10000,
        method: 'credit_card',
        processedBy: 'u1',
      },
      invoiceRepo,
      paymentRepo,
    );

    expect((await jobRepo.findById('t1', job.id))!.moneyState).toBe('no_estimate');
  });

  it('transitionInvoiceStatus leaves money-state untouched when given no deps', async () => {
    const { jobRepo, invoiceRepo, job } = await setup();
    const invoice = await invoiceRepo.create(makeInvoice(job.id, 'open', { totalCents: 10000 }));

    await transitionInvoiceStatus('t1', invoice.id, 'paid', invoiceRepo);

    expect((await jobRepo.findById('t1', job.id))!.moneyState).toBe('no_estimate');
  });

  it('transitionEstimateStatus leaves money-state untouched when given no deps', async () => {
    const { jobRepo, estimateRepo, job } = await setup();
    const estimate = await estimateRepo.create(makeEstimate(job.id, 'draft'));

    await transitionEstimateStatus('t1', estimate.id, 'sent', estimateRepo);

    expect((await jobRepo.findById('t1', job.id))!.moneyState).toBe('no_estimate');
  });

  it('refreshJobMoneyStateSafe uses deps.logger when no explicit logger is passed', async () => {
    const { estimateRepo, invoiceRepo, auditRepo, job } = await setup();
    const throwingJobRepo = {
      findById: async () => {
        throw new Error('db down');
      },
    } as unknown as InMemoryJobRepository;

    const warnings: Array<{ msg: string; meta?: Record<string, unknown> }> = [];
    const capturingLogger = {
      debug: () => {},
      info: () => {},
      warn: (msg: string, meta?: Record<string, unknown>) => {
        warnings.push({ msg, meta });
      },
      error: () => {},
      child: () => capturingLogger,
    };

    await refreshJobMoneyStateSafe('t1', job.id, 'u1', {
      jobRepo: throwingJobRepo,
      estimateRepo,
      invoiceRepo,
      auditRepo,
      logger: capturingLogger,
    });

    expect(warnings.length).toBe(1);
    expect(warnings[0].msg).toBe('refreshJobMoneyState failed');
    expect(warnings[0].meta?.tenantId).toBe('t1');
    expect(warnings[0].meta?.jobId).toBe(job.id);
  });
});
