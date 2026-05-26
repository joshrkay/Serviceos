import { describe, it, expect } from 'vitest';
import {
  computeMoneyDashboardSummary,
  MoneyDashboardInput,
} from '../../src/reports/money-dashboard';
import type { Invoice } from '../../src/invoices/invoice';
import type { Payment } from '../../src/invoices/payment';
import type { Expense } from '../../src/expenses/expense';

function invoice(over: Partial<Invoice>): Invoice {
  const now = new Date();
  return {
    id: `inv-${Math.random().toString(36).slice(2)}`,
    tenantId: 't1',
    jobId: 'job1',
    invoiceNumber: 'INV-1',
    status: 'open',
    lineItems: [],
    totals: {
      subtotalCents: 0,
      taxCents: 0,
      totalCents: 0,
      discountCents: 0,
      taxRateBps: 0,
      taxableSubtotalCents: 0,
    },
    amountPaidCents: 0,
    amountDueCents: 10000,
    createdBy: 'u1',
    createdAt: now,
    updatedAt: now,
    ...over,
  };
}

function payment(over: Partial<Payment>): Payment {
  const now = new Date();
  return {
    id: `pay-${Math.random().toString(36).slice(2)}`,
    tenantId: 't1',
    invoiceId: 'inv1',
    amountCents: 10000,
    method: 'cash',
    status: 'completed',
    receivedAt: new Date('2026-05-10'),
    processedBy: 'u1',
    createdAt: now,
    updatedAt: now,
    ...over,
  };
}

function expense(over: Partial<Expense>): Expense {
  const now = new Date();
  return {
    id: `exp-${Math.random().toString(36).slice(2)}`,
    tenantId: 't1',
    description: 'materials',
    amountCents: 5000,
    category: 'materials',
    spentAt: new Date('2026-05-12'),
    createdBy: 'u1',
    createdAt: now,
    updatedAt: now,
    ...over,
  };
}

const MONTH = '2026-05';
const NOW = new Date('2026-05-20T12:00:00.000Z');

describe('computeMoneyDashboardSummary', () => {
  it('sums revenue from completed payments inside the month window only', () => {
    const input: MoneyDashboardInput = {
      month: MONTH, now: NOW, invoices: [],
      payments: [
        payment({ amountCents: 30000, receivedAt: new Date('2026-05-03') }),
        payment({ amountCents: 20000, receivedAt: new Date('2026-05-18') }),
        payment({ amountCents: 99999, receivedAt: new Date('2026-04-30') }),
        payment({ amountCents: 11111, status: 'pending', receivedAt: new Date('2026-05-09') }),
      ],
      expenses: [],
    };
    const summary = computeMoneyDashboardSummary(input);
    expect(summary.revenueCents).toBe(50000);
  });

  it('computes prior-month revenue and the trend delta', () => {
    const input: MoneyDashboardInput = {
      month: MONTH, now: NOW, invoices: [],
      payments: [
        payment({ amountCents: 50000, receivedAt: new Date('2026-05-10') }),
        payment({ amountCents: 40000, receivedAt: new Date('2026-04-10') }),
      ],
      expenses: [],
    };
    const summary = computeMoneyDashboardSummary(input);
    expect(summary.revenueCents).toBe(50000);
    expect(summary.priorMonthRevenueCents).toBe(40000);
    expect(summary.revenueTrendCents).toBe(10000);
  });

  it('sums outstanding from open/partially_paid invoices as a current snapshot', () => {
    const input: MoneyDashboardInput = {
      month: MONTH, now: NOW,
      invoices: [
        invoice({ status: 'open', amountDueCents: 12000 }),
        invoice({ status: 'partially_paid', amountDueCents: 8000 }),
        invoice({ status: 'paid', amountDueCents: 0 }),
        invoice({ status: 'draft', amountDueCents: 99999 }),
        invoice({ status: 'void', amountDueCents: 99999 }),
      ],
      payments: [], expenses: [],
    };
    expect(computeMoneyDashboardSummary(input).outstandingCents).toBe(20000);
  });

  it('counts an open invoice past its due date as overdue', () => {
    const input: MoneyDashboardInput = {
      month: MONTH, now: NOW,
      invoices: [
        invoice({ status: 'open', amountDueCents: 7000, dueDate: new Date('2026-05-15') }),
        invoice({ status: 'open', amountDueCents: 3000, dueDate: new Date('2026-05-25') }),
        invoice({ status: 'open', amountDueCents: 1000 }),
      ],
      payments: [], expenses: [],
    };
    const summary = computeMoneyDashboardSummary(input);
    expect(summary.outstandingCents).toBe(11000);
    expect(summary.overdueCents).toBe(7000);
  });

  it('sums expenses inside the month window only', () => {
    const input: MoneyDashboardInput = {
      month: MONTH, now: NOW, invoices: [], payments: [],
      expenses: [
        expense({ amountCents: 5000, spentAt: new Date('2026-05-04') }),
        expense({ amountCents: 3000, spentAt: new Date('2026-05-28') }),
        expense({ amountCents: 99999, spentAt: new Date('2026-04-15') }),
      ],
    };
    expect(computeMoneyDashboardSummary(input).expensesCents).toBe(8000);
  });

  it('echoes the resolved month label and window bounds', () => {
    const summary = computeMoneyDashboardSummary({
      month: MONTH, now: NOW, invoices: [], payments: [], expenses: [],
    });
    expect(summary.month).toBe('2026-05');
    expect(summary.revenueCents).toBe(0);
    expect(summary.expensesCents).toBe(0);
    expect(summary.outstandingCents).toBe(0);
    expect(summary.overdueCents).toBe(0);
  });

  it('throws on a malformed month string', () => {
    expect(() =>
      computeMoneyDashboardSummary({
        month: 'May 2026', now: NOW, invoices: [], payments: [], expenses: [],
      }),
    ).toThrow(/month must be/);
  });

  it('buckets month-boundary payments by tenant timezone, not UTC', () => {
    // Jan 31 5pm PST is Feb 1 01:00 UTC. Under UTC bucketing this payment
    // wrongly lands in February; under tenant-tz bucketing it correctly
    // lands in January. A payment at Feb 1 9am PST belongs in February.
    const jan31_5pmPst = new Date('2026-02-01T01:00:00.000Z');
    const feb1_9amPst = new Date('2026-02-01T17:00:00.000Z');
    const payments = [
      payment({ amountCents: 30000, receivedAt: jan31_5pmPst }),
      payment({ amountCents: 20000, receivedAt: feb1_9amPst }),
    ];

    const january = computeMoneyDashboardSummary({
      month: '2026-01', now: NOW, invoices: [], payments, expenses: [],
      timezone: 'America/Los_Angeles',
    });
    expect(january.revenueCents).toBe(30000);

    const february = computeMoneyDashboardSummary({
      month: '2026-02', now: NOW, invoices: [], payments, expenses: [],
      timezone: 'America/Los_Angeles',
    });
    expect(february.revenueCents).toBe(20000);

    // Without a timezone (UTC default) both land in February — the bug the
    // tenant-tz bucketing fixes.
    const februaryUtc = computeMoneyDashboardSummary({
      month: '2026-02', now: NOW, invoices: [], payments, expenses: [],
    });
    expect(februaryUtc.revenueCents).toBe(50000);
  });
});
