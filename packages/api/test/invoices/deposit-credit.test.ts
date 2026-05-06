import { describe, it, expect, beforeEach } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import { applyDepositCreditToInvoice } from '../../src/invoices/deposit-credit';
import {
  Invoice,
  InMemoryInvoiceRepository,
} from '../../src/invoices/invoice';
import { InMemoryPaymentRepository } from '../../src/invoices/payment';
import { Job, InMemoryJobRepository } from '../../src/jobs/job';

const TENANT = 'tenant-deposit-credit';

function makeJob(overrides: Partial<Job> = {}): Job {
  return {
    id: uuidv4(),
    tenantId: TENANT,
    customerId: uuidv4(),
    locationId: uuidv4(),
    jobNumber: 'JOB-0042',
    summary: 'AC repair',
    status: 'completed',
    priority: 'normal',
    depositRequiredCents: 25000,
    depositPaidCents: 25000,
    depositStatus: 'paid',
    createdBy: 'user-1',
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function makeInvoice(jobId: string, totalCents: number, overrides: Partial<Invoice> = {}): Invoice {
  return {
    id: uuidv4(),
    tenantId: TENANT,
    jobId,
    invoiceNumber: 'INV-0001',
    status: 'draft',
    lineItems: [
      {
        id: uuidv4(),
        description: 'Service',
        quantity: 1,
        unitPriceCents: totalCents,
        totalCents,
        sortOrder: 0,
        taxable: true,
      },
    ],
    totals: {
      subtotalCents: totalCents,
      taxableSubtotalCents: totalCents,
      discountCents: 0,
      taxRateBps: 0,
      taxCents: 0,
      totalCents,
    },
    amountPaidCents: 0,
    amountDueCents: totalCents,
    createdBy: 'user-1',
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

describe('applyDepositCreditToInvoice — Tier 4 deposit (PR 3c)', () => {
  let invoiceRepo: InMemoryInvoiceRepository;
  let paymentRepo: InMemoryPaymentRepository;
  let jobRepo: InMemoryJobRepository;

  beforeEach(() => {
    invoiceRepo = new InMemoryInvoiceRepository();
    paymentRepo = new InMemoryPaymentRepository();
    jobRepo = new InMemoryJobRepository();
  });

  it('credits the paid deposit, reduces amount due, and marks the job consumed', async () => {
    const job = makeJob();
    await jobRepo.create(job);
    const invoice = makeInvoice(job.id, 100000); // $1,000
    await invoiceRepo.create(invoice);

    const result = await applyDepositCreditToInvoice(
      invoice,
      job,
      invoiceRepo,
      paymentRepo,
      jobRepo,
    );

    expect(result?.creditCents).toBe(25000);
    expect(result?.invoice.amountPaidCents).toBe(25000);
    expect(result?.invoice.amountDueCents).toBe(75000);

    const payments = await paymentRepo.findByInvoice(TENANT, invoice.id);
    expect(payments).toHaveLength(1);
    expect(payments[0].providerReference).toBe('deposit_credit');
    expect(payments[0].method).toBe('other');
    expect(payments[0].amountCents).toBe(25000);

    const after = await jobRepo.findById(TENANT, job.id);
    expect(after?.depositCreditedToInvoiceId).toBe(invoice.id);
  });

  it('caps the credit at the invoice total (deposit > total)', async () => {
    const job = makeJob({ depositPaidCents: 200000, depositRequiredCents: 200000 });
    await jobRepo.create(job);
    const invoice = makeInvoice(job.id, 50000);
    await invoiceRepo.create(invoice);

    const result = await applyDepositCreditToInvoice(
      invoice,
      job,
      invoiceRepo,
      paymentRepo,
      jobRepo,
    );

    expect(result?.creditCents).toBe(50000);
    expect(result?.invoice.amountDueCents).toBe(0);
  });

  it('is a no-op when the job has no paid deposit', async () => {
    const job = makeJob({ depositPaidCents: 0, depositStatus: 'not_required' });
    await jobRepo.create(job);
    const invoice = makeInvoice(job.id, 100000);
    await invoiceRepo.create(invoice);

    const result = await applyDepositCreditToInvoice(
      invoice,
      job,
      invoiceRepo,
      paymentRepo,
      jobRepo,
    );

    expect(result).toBeNull();
    expect(await paymentRepo.findByInvoice(TENANT, invoice.id)).toHaveLength(0);
  });

  it('is a no-op when the deposit has already been credited to another invoice', async () => {
    const previousInvoiceId = uuidv4();
    const job = makeJob({ depositCreditedToInvoiceId: previousInvoiceId });
    await jobRepo.create(job);
    const invoice = makeInvoice(job.id, 100000);
    await invoiceRepo.create(invoice);

    const result = await applyDepositCreditToInvoice(
      invoice,
      job,
      invoiceRepo,
      paymentRepo,
      jobRepo,
    );

    expect(result).toBeNull();
    expect(await paymentRepo.findByInvoice(TENANT, invoice.id)).toHaveLength(0);
    // Marker is unchanged.
    const after = await jobRepo.findById(TENANT, job.id);
    expect(after?.depositCreditedToInvoiceId).toBe(previousInvoiceId);
  });

  it('is a no-op when the invoice total is 0', async () => {
    const job = makeJob();
    await jobRepo.create(job);
    const invoice = makeInvoice(job.id, 0);
    await invoiceRepo.create(invoice);

    const result = await applyDepositCreditToInvoice(
      invoice,
      job,
      invoiceRepo,
      paymentRepo,
      jobRepo,
    );

    expect(result).toBeNull();
  });

  it('preserves draft status when the credit is partial', async () => {
    const job = makeJob();
    await jobRepo.create(job);
    const invoice = makeInvoice(job.id, 100000);
    await invoiceRepo.create(invoice);

    const result = await applyDepositCreditToInvoice(
      invoice,
      job,
      invoiceRepo,
      paymentRepo,
      jobRepo,
    );

    expect(result?.invoice.status).toBe('draft');
  });
});
