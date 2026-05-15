import { describe, it, expect, beforeEach } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import { createJob, InMemoryJobRepository } from '../../src/jobs/job';
import { InMemoryEstimateRepository } from '../../src/estimates/estimate';
import { InMemoryInvoiceRepository, Invoice, InvoiceStatus } from '../../src/invoices/invoice';
import { InMemoryAuditRepository } from '../../src/audit/audit';
import { createLogger } from '../../src/logging/logger';
import {
  runOverdueInvoiceSweep,
  OverdueInvoiceWorkerDeps,
} from '../../src/workers/overdue-invoice-worker';
import type { DocumentTotals } from '../../src/shared/billing-engine';

const logger = createLogger({ service: 'test', environment: 'test', level: 'error' });
const NOW = new Date('2026-05-14T12:00:00Z');
const PAST = new Date('2026-05-01T00:00:00Z');
const FUTURE = new Date('2026-06-01T00:00:00Z');

const ZERO_TOTALS: DocumentTotals = {
  subtotalCents: 0,
  discountCents: 0,
  taxRateBps: 0,
  taxableSubtotalCents: 0,
  taxCents: 0,
  totalCents: 10000,
};

function makeInvoice(jobId: string, status: InvoiceStatus, dueDate: Date): Invoice {
  return {
    id: uuidv4(),
    tenantId: 't1',
    jobId,
    invoiceNumber: 'INV-0001',
    status,
    lineItems: [],
    totals: ZERO_TOTALS,
    amountPaidCents: 0,
    amountDueCents: 10000,
    dueDate,
    createdBy: 'u1',
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

describe('runOverdueInvoiceSweep', () => {
  let jobRepo: InMemoryJobRepository;
  let estimateRepo: InMemoryEstimateRepository;
  let invoiceRepo: InMemoryInvoiceRepository;
  let auditRepo: InMemoryAuditRepository;

  beforeEach(() => {
    jobRepo = new InMemoryJobRepository();
    estimateRepo = new InMemoryEstimateRepository();
    invoiceRepo = new InMemoryInvoiceRepository();
    auditRepo = new InMemoryAuditRepository();
  });

  function deps(listTenantIds: () => Promise<string[]>): OverdueInvoiceWorkerDeps {
    return {
      jobRepo,
      estimateRepo,
      invoiceRepo,
      auditRepo,
      listTenantIds,
      logger,
      now: () => NOW,
    };
  }

  it('returns all-zero when there are no tenants', async () => {
    const result = await runOverdueInvoiceSweep(deps(async () => []));
    expect(result).toEqual({ tenants: 0, overdue: 0, failed: 0 });
  });

  it('returns zero when listTenantIds throws', async () => {
    const result = await runOverdueInvoiceSweep({
      jobRepo,
      estimateRepo,
      invoiceRepo,
      auditRepo,
      listTenantIds: async () => {
        throw new Error('registry down');
      },
      logger,
      now: () => NOW,
    });
    expect(result).toEqual({ tenants: 0, overdue: 0, failed: 0 });
  });

  it('flips a past-due open invoice job to overdue and emits invoice.overdue', async () => {
    const job = await createJob(
      { tenantId: 't1', customerId: 'c1', locationId: 'l1', summary: 'Job', createdBy: 'u1' },
      jobRepo,
    );
    const invoice = await invoiceRepo.create(makeInvoice(job.id, 'open', PAST));

    const result = await runOverdueInvoiceSweep(deps(async () => ['t1']));

    expect(result).toEqual({ tenants: 1, overdue: 1, failed: 0 });
    expect((await jobRepo.findById('t1', job.id))!.moneyState).toBe('overdue');

    const events = await auditRepo.findByEntity('t1', 'invoice', invoice.id);
    const overdueEvent = events.find((e) => e.eventType === 'invoice.overdue');
    expect(overdueEvent).toBeDefined();
    expect(overdueEvent!.metadata).toMatchObject({ jobId: job.id, amountDueCents: 10000 });
  });

  it('leaves a not-yet-due open invoice untouched', async () => {
    const job = await createJob(
      { tenantId: 't1', customerId: 'c1', locationId: 'l1', summary: 'Job', createdBy: 'u1' },
      jobRepo,
    );
    await invoiceRepo.create(makeInvoice(job.id, 'open', FUTURE));

    const result = await runOverdueInvoiceSweep(deps(async () => ['t1']));

    expect(result.overdue).toBe(0);
    expect((await jobRepo.findById('t1', job.id))!.moneyState).toBe('no_estimate');
  });

  it('is idempotent — a second sweep emits no new event', async () => {
    const job = await createJob(
      { tenantId: 't1', customerId: 'c1', locationId: 'l1', summary: 'Job', createdBy: 'u1' },
      jobRepo,
    );
    await invoiceRepo.create(makeInvoice(job.id, 'open', PAST));

    await runOverdueInvoiceSweep(deps(async () => ['t1']));
    const second = await runOverdueInvoiceSweep(deps(async () => ['t1']));

    expect(second.overdue).toBe(0);
  });

  it('isolates a tenant failure and keeps sweeping the rest', async () => {
    const job = await createJob(
      { tenantId: 't2', customerId: 'c1', locationId: 'l1', summary: 'Job', createdBy: 'u1' },
      jobRepo,
    );
    await invoiceRepo.create({ ...makeInvoice(job.id, 'open', PAST), tenantId: 't2' });

    // Repo that throws for tenant 't1' only.
    const flakyInvoiceRepo = {
      findByTenant: async (tenantId: string, options?: unknown) => {
        if (tenantId === 't1') throw new Error('db down for t1');
        return invoiceRepo.findByTenant(tenantId, options as never);
      },
      findByJob: invoiceRepo.findByJob.bind(invoiceRepo),
    } as unknown as InMemoryInvoiceRepository;

    const result = await runOverdueInvoiceSweep({
      jobRepo,
      estimateRepo,
      invoiceRepo: flakyInvoiceRepo,
      auditRepo,
      listTenantIds: async () => ['t1', 't2'],
      logger,
      now: () => NOW,
    });

    expect(result.tenants).toBe(2);
    expect(result.failed).toBe(1);
    expect(result.overdue).toBe(1);
  });
});
