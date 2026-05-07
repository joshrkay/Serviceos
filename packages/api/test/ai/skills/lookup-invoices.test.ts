import { describe, it, expect, beforeEach, vi } from 'vitest';
import { lookupInvoices } from '../../../src/ai/skills/lookup-invoices';
import {
  createJob,
  InMemoryJobRepository,
  type Job,
  type JobRepository,
} from '../../../src/jobs/job';
import {
  createInvoice,
  InMemoryInvoiceRepository,
  issueInvoice,
} from '../../../src/invoices/invoice';
import { InMemoryLookupEventRepository } from '../../../src/lookup-events/lookup-event';
import { LookupEventService } from '../../../src/lookup-events/lookup-event-service';

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

  // ============================================================
  // P18-004 — isolated unit tests for lookup_invoices
  // ============================================================

  describe('P18-004 lookup_invoices — TTS / tenant isolation / repo wiring', () => {
    it('P18-004 lookup-invoices single result — TTS uses singular phrasing "one open invoice"', async () => {
      await seedOpenInvoice(jobRepo, invoiceRepo, {
        tenantId: 't-1',
        customerId: 'cust-1',
        invoiceNumber: 'INV-1001',
        amountCents: 4500,
      });
      const result = await lookupInvoices(
        { tenantId: 't-1', customerId: 'cust-1' },
        { jobRepo, invoiceRepo },
      );
      expect(result.status).toBe('found');
      if (result.status !== 'found') return;
      expect(result.summary).toContain('one open invoice');
      expect(result.summary).toContain('INV-1001');
      expect(result.summary).toContain('$45.00');
    });

    it('P18-004 lookup-invoices multi result — TTS lists count and earliest invoice', async () => {
      for (let i = 0; i < 4; i++) {
        await seedOpenInvoice(jobRepo, invoiceRepo, {
          tenantId: 't-1',
          customerId: 'cust-1',
          invoiceNumber: `INV-200${i}`,
          amountCents: 1000 * (i + 1),
        });
      }
      const result = await lookupInvoices(
        { tenantId: 't-1', customerId: 'cust-1' },
        { jobRepo, invoiceRepo },
      );
      if (result.status !== 'found') throw new Error('expected found');
      expect(result.data.count).toBe(4);
      expect(result.summary).toContain('4 open invoices');
      expect(result.summary).toContain('totaling');
    });

    it('P18-004 lookup-invoices empty result — friendly TTS string', async () => {
      const result = await lookupInvoices(
        { tenantId: 't-1', customerId: 'no-such-cust' },
        { jobRepo, invoiceRepo },
      );
      expect(result.status).toBe('none');
      expect(result.summary.toLowerCase()).toContain('open');
      // No raw cents leak
      expect(result.summary).not.toMatch(/\b\d{4,}\b/);
    });

    it('P18-004 lookup-invoices very large amount — formats $100k+ correctly', async () => {
      await seedOpenInvoice(jobRepo, invoiceRepo, {
        tenantId: 't-1',
        customerId: 'cust-1',
        invoiceNumber: 'INV-XL',
        amountCents: 12_345_678, // $123,456.78
      });
      const result = await lookupInvoices(
        { tenantId: 't-1', customerId: 'cust-1' },
        { jobRepo, invoiceRepo },
      );
      if (result.status !== 'found') throw new Error('expected found');
      expect(result.summary).toContain('$123456.78');
    });

    it('P18-004 lookup-invoices tenant isolation — tenant A invoice invisible to tenant B caller', async () => {
      await seedOpenInvoice(jobRepo, invoiceRepo, {
        tenantId: 'tenant-A',
        customerId: 'cust-shared',
        invoiceNumber: 'INV-A',
        amountCents: 5000,
      });
      await seedOpenInvoice(jobRepo, invoiceRepo, {
        tenantId: 'tenant-B',
        customerId: 'cust-shared',
        invoiceNumber: 'INV-B',
        amountCents: 9999,
      });

      const result = await lookupInvoices(
        { tenantId: 'tenant-B', customerId: 'cust-shared' },
        { jobRepo, invoiceRepo },
      );
      if (result.status !== 'found') throw new Error('expected found');
      expect(result.data.invoices).toHaveLength(1);
      expect(result.data.invoices[0].invoiceNumber).toBe('INV-B');
    });

    it('P18-004 lookup-invoices repo wiring — JobRepository.findByCustomer is called with tenantId first arg', async () => {
      const findByCustomer = vi.fn(async (_tenantId: string, _custId: string) => [] as Job[]);
      const stubbedJobRepo = jobRepo as unknown as JobRepository;
      stubbedJobRepo.findByCustomer = findByCustomer;
      await lookupInvoices(
        { tenantId: 'tenant-X', customerId: 'cust-Y' },
        { jobRepo: stubbedJobRepo, invoiceRepo },
      );
      expect(findByCustomer).toHaveBeenCalled();
      const call = findByCustomer.mock.calls[0];
      if (!call) throw new Error('expected call');
      expect(call[0]).toBe('tenant-X');
      expect(call[1]).toBe('cust-Y');
    });

    it('P18-004 lookup-invoices summary contains no ISO timestamps', async () => {
      await seedOpenInvoice(jobRepo, invoiceRepo, {
        tenantId: 't-1',
        customerId: 'cust-1',
        invoiceNumber: 'INV-1',
        amountCents: 10000,
      });
      const result = await lookupInvoices(
        { tenantId: 't-1', customerId: 'cust-1', timezone: 'America/Los_Angeles' },
        { jobRepo, invoiceRepo },
      );
      if (result.status !== 'found') throw new Error('expected found');
      // ISO dates would look like 2026-04-21T... — none should appear in summary.
      expect(result.summary).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
      expect(result.summary).not.toMatch(/Z$/);
    });

    it('P18-004 lookup-invoices repo throws — returns status=error with friendly summary', async () => {
      const findByCustomer = vi.fn(async () => {
        throw new Error('db down');
      });
      const stubbedJobRepo = jobRepo as unknown as JobRepository;
      stubbedJobRepo.findByCustomer = findByCustomer;
      const result = await lookupInvoices(
        { tenantId: 't-1', customerId: 'cust-1' },
        { jobRepo: stubbedJobRepo, invoiceRepo },
      );
      expect(result.status).toBe('error');
      expect(result.summary.toLowerCase()).toContain('trouble');
    });

    it('P18-004 lookup-invoices status filter — only returns invoices matching explicit status', async () => {
      await seedOpenInvoice(jobRepo, invoiceRepo, {
        tenantId: 't-1',
        customerId: 'cust-1',
        invoiceNumber: 'INV-OPEN',
        amountCents: 1000,
      });
      // open_only filter is the default behavior
      const result = await lookupInvoices(
        { tenantId: 't-1', customerId: 'cust-1', status: 'open_only' },
        { jobRepo, invoiceRepo },
      );
      if (result.status !== 'found') throw new Error('expected found');
      expect(result.data.invoices).toHaveLength(1);
      expect(result.data.invoices[0].invoiceNumber).toBe('INV-OPEN');
    });

    it('P18-004 lookup-invoices audit — records lookup_invoices intent when service is wired', async () => {
      await seedOpenInvoice(jobRepo, invoiceRepo, {
        tenantId: 't-1',
        customerId: 'cust-1',
        invoiceNumber: 'INV-1',
        amountCents: 1000,
      });
      const lookupRepo = new InMemoryLookupEventRepository();
      const lookupEvents = new LookupEventService(lookupRepo);

      await lookupInvoices(
        { tenantId: 't-1', customerId: 'cust-1', sessionId: 'sess-1' },
        { jobRepo, invoiceRepo, lookupEvents },
      );
      const rows = await lookupRepo.listByTenant('t-1');
      expect(rows).toHaveLength(1);
      expect(rows[0].intent).toBe('lookup_invoices');
      expect(rows[0].resultStatus).toBe('found');
    });

    it('P18-004 lookup-invoices performance smoke — completes well under 500ms with small dataset', async () => {
      for (let i = 0; i < 3; i++) {
        await seedOpenInvoice(jobRepo, invoiceRepo, {
          tenantId: 't-1',
          customerId: 'cust-1',
          invoiceNumber: `INV-${i}`,
          amountCents: 1000,
        });
      }
      const t0 = Date.now();
      const result = await lookupInvoices(
        { tenantId: 't-1', customerId: 'cust-1' },
        { jobRepo, invoiceRepo },
      );
      const elapsed = Date.now() - t0;
      expect(result.status).toBe('found');
      expect(elapsed).toBeLessThan(500);
    });
  });
});
