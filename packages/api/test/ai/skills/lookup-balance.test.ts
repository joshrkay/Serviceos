import { describe, it, expect, beforeEach, vi } from 'vitest';
import { lookupBalance } from '../../../src/ai/skills/lookup-balance';
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
  opts: { tenantId: string; customerId: string; amountCents: number; invoiceNumber?: string },
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
      invoiceNumber: opts.invoiceNumber ?? `INV-${Math.random().toString(36).slice(2, 6)}`,
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

  // ============================================================
  // P18-004 — isolated unit tests for lookup_balance
  // ============================================================

  describe('P18-004 lookup_balance — TTS / tenant isolation / repo wiring', () => {
    it('P18-004 lookup-balance single open invoice — singular phrasing', async () => {
      await seedOpenInvoice(jobRepo, invoiceRepo, {
        tenantId: 't-1',
        customerId: 'cust-1',
        amountCents: 12050,
      });
      const result = await lookupBalance(
        { tenantId: 't-1', customerId: 'cust-1' },
        { jobRepo, invoiceRepo },
      );
      if (result.status !== 'found') throw new Error('expected found');
      expect(result.summary).toContain('$120.50');
      expect(result.summary).not.toContain('open invoices'); // plural form should not appear
      expect(result.summary).toContain('Your current balance');
    });

    it('P18-004 lookup-balance multi result — uses plural phrasing with count', async () => {
      for (let i = 0; i < 3; i++) {
        await seedOpenInvoice(jobRepo, invoiceRepo, {
          tenantId: 't-1',
          customerId: 'cust-1',
          amountCents: 1000 * (i + 1),
        });
      }
      const result = await lookupBalance(
        { tenantId: 't-1', customerId: 'cust-1' },
        { jobRepo, invoiceRepo },
      );
      if (result.status !== 'found') throw new Error('expected found');
      expect(result.data.balanceCents).toBe(6000);
      expect(result.summary).toContain('3 open invoices');
      expect(result.summary).toContain('$60.00');
    });

    it('P18-004 lookup-balance empty result — friendly TTS string ("paid in full")', async () => {
      const result = await lookupBalance(
        { tenantId: 't-1', customerId: 'no-such' },
        { jobRepo, invoiceRepo },
      );
      expect(result.status).toBe('none');
      expect(result.summary.toLowerCase()).toContain('paid in full');
    });

    it('P18-004 lookup-balance very large amount — formats $100k+ correctly', async () => {
      await seedOpenInvoice(jobRepo, invoiceRepo, {
        tenantId: 't-1',
        customerId: 'cust-1',
        amountCents: 12_345_678,
      });
      const result = await lookupBalance(
        { tenantId: 't-1', customerId: 'cust-1' },
        { jobRepo, invoiceRepo },
      );
      if (result.status !== 'found') throw new Error('expected found');
      expect(result.data.balanceCents).toBe(12_345_678);
      expect(result.summary).toContain('$123456.78');
    });

    it('P18-004 lookup-balance tenant isolation — tenant A balance invisible to tenant B caller', async () => {
      await seedOpenInvoice(jobRepo, invoiceRepo, {
        tenantId: 'tenant-A',
        customerId: 'cust-shared',
        amountCents: 5000,
      });
      await seedOpenInvoice(jobRepo, invoiceRepo, {
        tenantId: 'tenant-B',
        customerId: 'cust-shared',
        amountCents: 9999,
      });

      const result = await lookupBalance(
        { tenantId: 'tenant-A', customerId: 'cust-shared' },
        { jobRepo, invoiceRepo },
      );
      if (result.status !== 'found') throw new Error('expected found');
      expect(result.data.balanceCents).toBe(5000);
    });

    it('P18-004 lookup-balance repo wiring — JobRepository.findByCustomer is called with tenantId first arg', async () => {
      const findByCustomer = vi.fn(async (_tenantId: string, _customerId: string) => [] as Job[]);
      const stubbed = jobRepo as unknown as JobRepository;
      stubbed.findByCustomer = findByCustomer;
      await lookupBalance(
        { tenantId: 'tenant-Z', customerId: 'cust-Q' },
        { jobRepo: stubbed, invoiceRepo },
      );
      expect(findByCustomer).toHaveBeenCalled();
      const call = findByCustomer.mock.calls[0];
      if (!call) throw new Error('expected call');
      expect(call[0]).toBe('tenant-Z');
      expect(call[1]).toBe('cust-Q');
    });

    it('P18-004 lookup-balance summary contains no ISO timestamps', async () => {
      await seedOpenInvoice(jobRepo, invoiceRepo, {
        tenantId: 't-1',
        customerId: 'cust-1',
        amountCents: 5000,
      });
      const result = await lookupBalance(
        { tenantId: 't-1', customerId: 'cust-1', timezone: 'America/Los_Angeles' },
        { jobRepo, invoiceRepo },
      );
      if (result.status !== 'found') throw new Error('expected found');
      expect(result.summary).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
      expect(result.summary).not.toMatch(/Z\b/);
    });

    it('P18-004 lookup-balance repo throws — returns status=error with friendly summary', async () => {
      const findByCustomer = vi.fn(async () => {
        throw new Error('db down');
      });
      const stubbed = jobRepo as unknown as JobRepository;
      stubbed.findByCustomer = findByCustomer;
      const result = await lookupBalance(
        { tenantId: 't-1', customerId: 'cust-1' },
        { jobRepo: stubbed, invoiceRepo },
      );
      expect(result.status).toBe('error');
      expect(result.summary.toLowerCase()).toContain('trouble');
    });

    it('P18-004 lookup-balance missing findByCustomer — returns status=error', async () => {
      const stubbed = jobRepo as unknown as JobRepository;
      stubbed.findByCustomer = undefined;
      const result = await lookupBalance(
        { tenantId: 't-1', customerId: 'cust-1' },
        { jobRepo: stubbed, invoiceRepo },
      );
      expect(result.status).toBe('error');
    });

    it('P18-004 lookup-balance audit row — records lookup_balance intent', async () => {
      await seedOpenInvoice(jobRepo, invoiceRepo, {
        tenantId: 't-1',
        customerId: 'cust-1',
        amountCents: 5000,
      });
      const lookupRepo = new InMemoryLookupEventRepository();
      const lookupEvents = new LookupEventService(lookupRepo);
      await lookupBalance(
        { tenantId: 't-1', customerId: 'cust-1', sessionId: 'sess-1' },
        { jobRepo, invoiceRepo, lookupEvents },
      );
      const rows = await lookupRepo.listByTenant('t-1');
      expect(rows).toHaveLength(1);
      expect(rows[0].intent).toBe('lookup_balance');
    });

    it('P18-004 lookup-balance performance smoke — completes well under 500ms', async () => {
      for (let i = 0; i < 3; i++) {
        await seedOpenInvoice(jobRepo, invoiceRepo, {
          tenantId: 't-1',
          customerId: 'cust-1',
          amountCents: 1000,
        });
      }
      const t0 = Date.now();
      const result = await lookupBalance(
        { tenantId: 't-1', customerId: 'cust-1' },
        { jobRepo, invoiceRepo },
      );
      const elapsed = Date.now() - t0;
      expect(result.status).toBe('found');
      expect(elapsed).toBeLessThan(500);
    });
  });
});
