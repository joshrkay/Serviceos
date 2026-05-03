import { describe, it, expect, beforeEach } from 'vitest';
import { lookupInvoices } from '../../../src/ai/skills/lookup-invoices';
import { createJob, InMemoryJobRepository } from '../../../src/jobs/job';
import {
  createInvoice,
  InMemoryInvoiceRepository,
  issueInvoice,
} from '../../../src/invoices/invoice';

async function seedOpenInvoice(
  jobRepo: InMemoryJobRepository,
  invoiceRepo: InMemoryInvoiceRepository,
  opts: { tenantId: string; customerId: string; invoiceNumber: string; amountCents: number },
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
      invoiceNumber: opts.invoiceNumber,
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

describe('P11-001 — lookupInvoices skill', () => {
  let jobRepo: InMemoryJobRepository;
  let invoiceRepo: InMemoryInvoiceRepository;

  beforeEach(() => {
    jobRepo = new InMemoryJobRepository();
    invoiceRepo = new InMemoryInvoiceRepository();
  });

  it('happy path — returns count + total + per-invoice info', async () => {
    await seedOpenInvoice(jobRepo, invoiceRepo, {
      tenantId: 'tenant-1',
      customerId: 'cust-1',
      invoiceNumber: 'INV-0001',
      amountCents: 12050,
    });
    await seedOpenInvoice(jobRepo, invoiceRepo, {
      tenantId: 'tenant-1',
      customerId: 'cust-1',
      invoiceNumber: 'INV-0002',
      amountCents: 5000,
    });

    const result = await lookupInvoices(
      { tenantId: 'tenant-1', customerId: 'cust-1' },
      { jobRepo, invoiceRepo },
    );

    expect(result.status).toBe('found');
    if (result.status !== 'found') return;
    expect(result.data.count).toBe(2);
    expect(result.data.totalCents).toBe(17050);
    expect(result.summary).toContain('$170.50');
  });

  it('none — friendly message when no open invoices', async () => {
    const result = await lookupInvoices(
      { tenantId: 'tenant-1', customerId: 'cust-empty' },
      { jobRepo, invoiceRepo },
    );
    expect(result.status).toBe('none');
    expect(result.summary).toContain("don't have any open");
  });

  it('tenant isolation — invoices from other tenant never surface', async () => {
    await seedOpenInvoice(jobRepo, invoiceRepo, {
      tenantId: 'tenant-2',
      customerId: 'cust-shared',
      invoiceNumber: 'INV-9999',
      amountCents: 99999,
    });
    const result = await lookupInvoices(
      { tenantId: 'tenant-1', customerId: 'cust-shared' },
      { jobRepo, invoiceRepo },
    );
    expect(result.status).toBe('none');
  });

  it('formats single-cent fragment with $X.XX', async () => {
    await seedOpenInvoice(jobRepo, invoiceRepo, {
      tenantId: 'tenant-1',
      customerId: 'cust-1',
      invoiceNumber: 'INV-0001',
      amountCents: 12050,
    });

    const result = await lookupInvoices(
      { tenantId: 'tenant-1', customerId: 'cust-1' },
      { jobRepo, invoiceRepo },
    );
    if (result.status !== 'found') throw new Error('expected found');
    expect(result.summary).toContain('$120.50');
  });
});
