import { describe, it, expect } from 'vitest';
import { createJob, InMemoryJobRepository } from '../../src/jobs/job';
import { computeJobMoneyState } from '../../src/jobs/job-money-state';
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
