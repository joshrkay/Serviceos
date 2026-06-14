/**
 * P21-003 — batch_invoice voice on-ramp (task-handler level).
 *
 * The BatchInvoiceExecutionHandler already exists (fans out one draft_invoice
 * per completed-unbilled job on approval). This proves the FRONT half: the task
 * handler enumerates the SAME completed-unbilled candidates the batch sweep +
 * digest use (findJobsRequiringInvoicing) and mints ONE batch_invoice proposal.
 * Capture-class. When nothing is billable it emits a voice_clarification instead
 * of an empty batch (the schema requires jobs.length >= 1).
 *
 * The invoicing deps are stubbed to drive findJobsRequiringInvoicing, which
 * issues exactly three repo reads:
 *   jobRepo.findByTenant(tenantId, { status:'completed', limit })
 *   invoiceRepo.findByJobs(tenantId, jobIds)
 *   estimateRepo.findByJobs(tenantId, jobIds)
 */
import { describe, it, expect } from 'vitest';
import { BatchInvoiceTaskHandler } from '../../../src/ai/tasks/voice-extended-tasks';
import { TaskContext } from '../../../src/ai/tasks/task-handlers';
import { InvoicingQueueDeps } from '../../../src/invoices/invoicing-queue';
import { buildLineItem } from '../../../src/shared/billing-engine';

function ctx(overrides: Partial<TaskContext>): TaskContext {
  return { tenantId: 't-1', userId: 'u-1', message: 'invoice all my completed jobs', ...overrides };
}

/**
 * Build invoicing deps whose three repo reads return the supplied fixtures.
 * Cast through `any` because findJobsRequiringInvoicing only touches the three
 * methods below — a full repo implementation would be noise here (the
 * integration test pins the real columns).
 */
function depsFrom(rows: {
  jobs: Array<{ id: string; customerId: string; moneyState?: string }>;
  invoices?: unknown[];
  estimates?: unknown[];
}): InvoicingQueueDeps {
  return {
    jobRepo: { findByTenant: async () => rows.jobs },
    invoiceRepo: { findByJobs: async () => rows.invoices ?? [] },
    estimateRepo: { findByJobs: async () => rows.estimates ?? [] },
  } as unknown as InvoicingQueueDeps;
}

describe('BatchInvoiceTaskHandler', () => {
  it('mints one batch_invoice proposal enumerating completed-unbilled jobs', async () => {
    const deps = depsFrom({
      jobs: [{ id: 'job-1', customerId: 'cust-1', moneyState: 'estimate_accepted' }],
      invoices: [],
      estimates: [
        {
          jobId: 'job-1',
          status: 'accepted',
          acceptedSelection: undefined,
          lineItems: [buildLineItem('1', 'Labor', 1, 10000, 1, true, 'labor')],
          totals: { discountCents: 0, taxRateBps: 0, totalCents: 10000 },
        },
      ],
    });

    const res = await new BatchInvoiceTaskHandler(deps).handle(ctx({}));
    const payload = res.proposal.payload as {
      batchDate: string;
      totalCents: number;
      jobs: Array<{ jobId: string; amountCents: number }>;
    };

    expect(res.proposal.proposalType).toBe('batch_invoice');
    expect(payload.jobs).toHaveLength(1);
    expect(payload.jobs[0].jobId).toBe('job-1');
    // Integer cents only — a positive total grounded in the accepted estimate.
    expect(Number.isInteger(payload.totalCents)).toBe(true);
    expect(payload.totalCents).toBeGreaterThan(0);
    expect(payload.batchDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('clarifies (no empty batch) when nothing is waiting to be invoiced', async () => {
    const deps = depsFrom({ jobs: [] });
    const res = await new BatchInvoiceTaskHandler(deps).handle(ctx({}));
    expect(res.proposal.proposalType).toBe('voice_clarification');
  });

  it('clarifies when invoicing deps are not wired', async () => {
    const res = await new BatchInvoiceTaskHandler().handle(ctx({}));
    expect(res.proposal.proposalType).toBe('voice_clarification');
  });
});
