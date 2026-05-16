import { describe, it, expect } from 'vitest';
import { createJob, InMemoryJobRepository } from '../../src/jobs/job';
import { InMemoryEstimateRepository } from '../../src/estimates/estimate';
import { InMemoryInvoiceRepository } from '../../src/invoices/invoice';
import { InMemoryAuditRepository } from '../../src/audit/audit';
import {
  computeJobMoneyState,
  refreshJobMoneyState,
  refreshJobMoneyStateSafe,
} from '../../src/jobs/job-money-state';
import type { Estimate, EstimateStatus } from '../../src/estimates/estimate';
import type { Invoice, InvoiceStatus } from '../../src/invoices/invoice';
import type { DocumentTotals } from '../../src/shared/billing-engine';

describe('Job.moneyState field', () => {
  it('createJob defaults moneyState to no_estimate', async () => {
    const repo = new InMemoryJobRepository();
    const job = await createJob(
      {
        tenantId: 't1',
        customerId: 'c1',
        locationId: 'l1',
        summary: 'Fix AC',
        createdBy: 'u1',
      },
      repo,
    );
    expect(job.moneyState).toBe('no_estimate');
  });
});

const ZERO_TOTALS: DocumentTotals = {
  subtotalCents: 0,
  discountCents: 0,
  taxRateBps: 0,
  taxableSubtotalCents: 0,
  taxCents: 0,
  totalCents: 0,
};

function makeEstimate(status: EstimateStatus, jobId = 'job-1'): Estimate {
  return {
    id: `est-${status}-${Math.random()}`,
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
  status: InvoiceStatus,
  opts: { jobId?: string; dueDate?: Date } = {},
): Invoice {
  return {
    id: `inv-${status}-${Math.random()}`,
    tenantId: 't1',
    jobId: opts.jobId ?? 'job-1',
    invoiceNumber: 'INV-0001',
    status,
    lineItems: [],
    totals: ZERO_TOTALS,
    amountPaidCents: 0,
    amountDueCents: 0,
    dueDate: opts.dueDate,
    createdBy: 'u1',
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

describe('computeJobMoneyState', () => {
  const now = new Date('2026-05-14T12:00:00Z');
  const past = new Date('2026-05-01T00:00:00Z');
  const future = new Date('2026-06-01T00:00:00Z');

  it('returns no_estimate for a job with nothing', () => {
    expect(computeJobMoneyState([], [], now)).toBe('no_estimate');
  });

  it('ignores draft estimates', () => {
    expect(computeJobMoneyState([makeEstimate('draft')], [], now)).toBe('no_estimate');
  });

  it('ignores rejected and expired estimates', () => {
    expect(
      computeJobMoneyState([makeEstimate('rejected'), makeEstimate('expired')], [], now),
    ).toBe('no_estimate');
  });

  it('ignores ready_for_review estimates', () => {
    expect(computeJobMoneyState([makeEstimate('ready_for_review')], [], now)).toBe(
      'no_estimate',
    );
  });

  it('returns estimate_sent for a sent estimate', () => {
    expect(computeJobMoneyState([makeEstimate('sent')], [], now)).toBe('estimate_sent');
  });

  it('returns estimate_accepted for an accepted estimate', () => {
    expect(computeJobMoneyState([makeEstimate('accepted')], [], now)).toBe(
      'estimate_accepted',
    );
  });

  it('accepted outranks sent', () => {
    expect(
      computeJobMoneyState([makeEstimate('sent'), makeEstimate('accepted')], [], now),
    ).toBe('estimate_accepted');
  });

  it('ignores draft, void and canceled invoices', () => {
    expect(
      computeJobMoneyState(
        [],
        [makeInvoice('draft'), makeInvoice('void'), makeInvoice('canceled')],
        now,
      ),
    ).toBe('no_estimate');
  });

  it('returns invoiced for an open invoice with no due date', () => {
    expect(computeJobMoneyState([], [makeInvoice('open')], now)).toBe('invoiced');
  });

  it('returns invoiced for an open invoice not yet due', () => {
    expect(
      computeJobMoneyState([], [makeInvoice('open', { dueDate: future })], now),
    ).toBe('invoiced');
  });

  it('returns overdue for an open invoice past its due date', () => {
    expect(
      computeJobMoneyState([], [makeInvoice('open', { dueDate: past })], now),
    ).toBe('overdue');
  });

  it('returns overdue for a partially_paid invoice past its due date', () => {
    expect(
      computeJobMoneyState([], [makeInvoice('partially_paid', { dueDate: past })], now),
    ).toBe('overdue');
  });

  it('returns paid when the only invoice is paid', () => {
    expect(computeJobMoneyState([], [makeInvoice('paid')], now)).toBe('paid');
  });

  it('a paid invoice plus an open one is still invoiced (money outstanding)', () => {
    expect(
      computeJobMoneyState([], [makeInvoice('paid'), makeInvoice('open')], now),
    ).toBe('invoiced');
  });

  it('a paid invoice plus an overdue one is overdue', () => {
    expect(
      computeJobMoneyState(
        [],
        [makeInvoice('paid'), makeInvoice('open', { dueDate: past })],
        now,
      ),
    ).toBe('overdue');
  });

  it('invoice states outrank estimate states', () => {
    expect(
      computeJobMoneyState([makeEstimate('accepted')], [makeInvoice('open')], now),
    ).toBe('invoiced');
  });

  it('returns invoiced when dueDate is exactly now (boundary — strict <)', () => {
    expect(
      computeJobMoneyState([], [makeInvoice('open', { dueDate: now })], now),
    ).toBe('invoiced');
  });
});

describe('refreshJobMoneyState', () => {
  async function setup() {
    const jobRepo = new InMemoryJobRepository();
    const estimateRepo = new InMemoryEstimateRepository();
    const invoiceRepo = new InMemoryInvoiceRepository();
    const auditRepo = new InMemoryAuditRepository();
    const job = await createJob(
      { tenantId: 't1', customerId: 'c1', locationId: 'l1', summary: 'Job', createdBy: 'u1' },
      jobRepo,
    );
    return { jobRepo, estimateRepo, invoiceRepo, auditRepo, job };
  }

  it('no-ops when the recomputed state equals the stored state', async () => {
    const { jobRepo, estimateRepo, invoiceRepo, auditRepo, job } = await setup();
    const result = await refreshJobMoneyState('t1', job.id, 'u1', {
      jobRepo,
      estimateRepo,
      invoiceRepo,
      auditRepo,
    });
    expect(result.changed).toBe(false);
    expect(result.current).toBe('no_estimate');
  });

  it('persists the new state and emits an audit event on a transition', async () => {
    const { jobRepo, estimateRepo, invoiceRepo, auditRepo, job } = await setup();
    await estimateRepo.create(makeEstimate('sent', job.id));

    const result = await refreshJobMoneyState('t1', job.id, 'u1', {
      jobRepo,
      estimateRepo,
      invoiceRepo,
      auditRepo,
    });

    expect(result.changed).toBe(true);
    expect(result.previous).toBe('no_estimate');
    expect(result.current).toBe('estimate_sent');

    const reloaded = await jobRepo.findById('t1', job.id);
    expect(reloaded!.moneyState).toBe('estimate_sent');

    const events = await auditRepo.findByEntity('t1', 'job', job.id);
    const moneyEvent = events.find((e) => e.eventType === 'job.money_state_changed');
    expect(moneyEvent).toBeDefined();
    expect(moneyEvent!.metadata).toMatchObject({ from: 'no_estimate', to: 'estimate_sent' });
  });

  it('a second refresh after the transition is a no-op', async () => {
    const { jobRepo, estimateRepo, invoiceRepo, auditRepo, job } = await setup();
    await estimateRepo.create(makeEstimate('sent', job.id));
    await refreshJobMoneyState('t1', job.id, 'u1', { jobRepo, estimateRepo, invoiceRepo, auditRepo });

    const second = await refreshJobMoneyState('t1', job.id, 'u1', {
      jobRepo,
      estimateRepo,
      invoiceRepo,
      auditRepo,
    });
    expect(second.changed).toBe(false);
    expect(second.current).toBe('estimate_sent');
  });

  it('returns a null no-op result for a missing job', async () => {
    const { jobRepo, estimateRepo, invoiceRepo, auditRepo } = await setup();
    const result = await refreshJobMoneyState('t1', 'does-not-exist', 'u1', {
      jobRepo,
      estimateRepo,
      invoiceRepo,
      auditRepo,
    });
    expect(result.job).toBeNull();
    expect(result.changed).toBe(false);
  });

  it('returns a no-op result when the job is deleted between find and update', async () => {
    const { jobRepo, estimateRepo, invoiceRepo, auditRepo, job } = await setup();
    await estimateRepo.create(makeEstimate('sent', job.id));

    // Simulate the race: findById succeeds, then update is called for an
    // id that no longer exists. The in-memory repo's update returns null
    // when id is unknown, mirroring what would happen if the job was
    // deleted concurrently.
    const originalUpdate = jobRepo.update.bind(jobRepo);
    jobRepo.update = async () => null;

    const result = await refreshJobMoneyState('t1', job.id, 'u1', {
      jobRepo,
      estimateRepo,
      invoiceRepo,
      auditRepo,
    });

    // Restore for cleanliness (vitest isolates per-test anyway, but be tidy).
    jobRepo.update = originalUpdate;

    expect(result.job).toBeNull();
    expect(result.changed).toBe(false);
    expect(result.previous).toBe('no_estimate');
    expect(result.current).toBe('estimate_sent');

    // CRITICAL: audit event must NOT fire in the race case.
    const events = await auditRepo.findByEntity('t1', 'job', job.id);
    expect(events.some((e) => e.eventType === 'job.money_state_changed')).toBe(false);
  });

  it('refreshJobMoneyStateSafe swallows errors and returns a no-op result', async () => {
    const { estimateRepo, invoiceRepo, auditRepo, job } = await setup();
    const throwingJobRepo = {
      findById: async () => {
        throw new Error('db down');
      },
    } as unknown as InMemoryJobRepository;

    const result = await refreshJobMoneyStateSafe('t1', job.id, 'u1', {
      jobRepo: throwingJobRepo,
      estimateRepo,
      invoiceRepo,
      auditRepo,
    });
    expect(result.changed).toBe(false);
    expect(result.job).toBeNull();
  });
});
