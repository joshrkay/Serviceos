import { describe, it, expect, beforeEach } from 'vitest';
import { lookupBalance } from '../../../src/ai/skills/lookup-balance';
import { createJob, InMemoryJobRepository } from '../../../src/jobs/job';
import {
  createInvoice,
  InMemoryInvoiceRepository,
  issueInvoice,
} from '../../../src/invoices/invoice';

async function seedOpenInvoice(
  jobRepo: InMemoryJobRepository,
  invoiceRepo: InMemoryInvoiceRepository,
  opts: { tenantId: string; customerId: string; amountCents: number },
) {
  const job = await createJob(
    {
      tenantId: opts.tenantId,
      customerId: opts.customerId,
      locationId: 'loc-1',
      summary: 'work',
      createdBy: 'u-1',
    },
    jobRepo,
  );
  const inv = await createInvoice(
    {
      tenantId: opts.tenantId,
      jobId: job.id,
      invoiceNumber: `INV-${Math.random().toString(36).slice(2, 6)}`,
      lineItems: [
        {
          id: 'li-1',
          description: 'service',
          quantity: 1,
          unitPriceCents: opts.amountCents,
          totalCents: opts.amountCents,
          sortOrder: 0,
          taxable: false,
        },
      ],
      createdBy: 'u-1',
    },
    invoiceRepo,
  );
  await issueInvoice(opts.tenantId, inv.id, 30, invoiceRepo);
  return inv;
}

describe('P11-001 — lookupBalance skill', () => {
  let jobRepo: InMemoryJobRepository;
  let invoiceRepo: InMemoryInvoiceRepository;

  beforeEach(() => {
    jobRepo = new InMemoryJobRepository();
    invoiceRepo = new InMemoryInvoiceRepository();
  });

  it('happy path — sums unpaid invoices and returns oldest due date', async () => {
    await seedOpenInvoice(jobRepo, invoiceRepo, {
      tenantId: 'tenant-1',
      customerId: 'cust-1',
      amountCents: 5000,
    });
    await seedOpenInvoice(jobRepo, invoiceRepo, {
      tenantId: 'tenant-1',
      customerId: 'cust-1',
      amountCents: 7050,
    });

    const result = await lookupBalance(
      { tenantId: 'tenant-1', customerId: 'cust-1' },
      { jobRepo, invoiceRepo },
    );

    expect(result.status).toBe('found');
    if (result.status !== 'found') return;
    expect(result.data.balanceCents).toBe(12050);
    expect(result.data.openCount).toBe(2);
    expect(result.summary).toContain('$120.50');
  });

  it('none — paid in full when no open balance', async () => {
    const result = await lookupBalance(
      { tenantId: 'tenant-1', customerId: 'cust-empty' },
      { jobRepo, invoiceRepo },
    );
    expect(result.status).toBe('none');
    expect(result.summary.toLowerCase()).toContain('paid in full');
  });

  it('tenant isolation — never sums another tenant balance', async () => {
    await seedOpenInvoice(jobRepo, invoiceRepo, {
      tenantId: 'tenant-2',
      customerId: 'cust-shared',
      amountCents: 99999,
    });
    const result = await lookupBalance(
      { tenantId: 'tenant-1', customerId: 'cust-shared' },
      { jobRepo, invoiceRepo },
    );
    expect(result.status).toBe('none');
  });
});
