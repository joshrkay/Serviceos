/**
 * `resolveMonthWindow` timezone correctness.
 *
 * Pre-fix, the helper used `Date.UTC(year, monthIndex, 1)` to anchor the
 * window. For any tenant outside UTC that's off by their offset:
 * payments received at "11 PM May 31 PST" land in the June bucket
 * (because UTC sees them as June 1 06:00). The fix routes the bounds
 * through `Intl.DateTimeFormat` to compute the UTC instant
 * corresponding to local midnight in the tenant's IANA timezone.
 */
import { describe, expect, it } from 'vitest';
import {
  resolveMonthWindow,
  computeMoneyDashboardSummary,
} from '../../src/reports/money-dashboard';
import type { Invoice } from '../../src/invoices/invoice';
import type { Payment } from '../../src/invoices/payment';
import type { Expense } from '../../src/expenses/expense';

describe('resolveMonthWindow — timezone-aware bounds', () => {
  it('defaults to America/New_York when no tz supplied', () => {
    const { start, end } = resolveMonthWindow('2026-05');
    // May 1, 2026 00:00 EDT (UTC-4) = May 1, 2026 04:00 UTC.
    expect(start.toISOString()).toBe('2026-05-01T04:00:00.000Z');
    expect(end.toISOString()).toBe('2026-06-01T04:00:00.000Z');
  });

  it('America/Los_Angeles: May 1 00:00 PDT = May 1 07:00 UTC', () => {
    const { start, end } = resolveMonthWindow('2026-05', 'America/Los_Angeles');
    expect(start.toISOString()).toBe('2026-05-01T07:00:00.000Z');
    expect(end.toISOString()).toBe('2026-06-01T07:00:00.000Z');
  });

  it('UTC tenant: bounds are at the naive UTC midnight', () => {
    const { start, end } = resolveMonthWindow('2026-05', 'UTC');
    expect(start.toISOString()).toBe('2026-05-01T00:00:00.000Z');
    expect(end.toISOString()).toBe('2026-06-01T00:00:00.000Z');
  });

  it('Europe/Berlin: May 1 00:00 CEST (UTC+2) = April 30 22:00 UTC', () => {
    const { start, end } = resolveMonthWindow('2026-05', 'Europe/Berlin');
    expect(start.toISOString()).toBe('2026-04-30T22:00:00.000Z');
    expect(end.toISOString()).toBe('2026-05-31T22:00:00.000Z');
  });

  it('priorStart is the same midnight, one calendar month earlier', () => {
    const { priorStart, start } = resolveMonthWindow('2026-05', 'America/Los_Angeles');
    expect(priorStart.toISOString()).toBe('2026-04-01T07:00:00.000Z');
    expect(start.toISOString()).toBe('2026-05-01T07:00:00.000Z');
  });
});

describe('computeMoneyDashboardSummary — bucket a payment at the month boundary', () => {
  const baseInvoices: Invoice[] = [];
  const expenses: Expense[] = [];

  // A payment received at 11 PM May 31 PST = 06:00 June 1 UTC.
  const lateMayPayment: Payment = {
    id: 'pay-late-may',
    tenantId: 't1',
    invoiceId: 'inv-1',
    amountCents: 12345,
    method: 'card',
    status: 'completed',
    receivedAt: new Date('2026-06-01T06:00:00.000Z'),
    refundedAmountCents: 0,
  } as Payment;

  it('UTC bucketing puts the late-May PST payment in JUNE (the bug)', () => {
    const summary = computeMoneyDashboardSummary({
      month: '2026-06',
      now: new Date('2026-06-15T12:00:00Z'),
      invoices: baseInvoices,
      payments: [lateMayPayment],
      expenses,
      timezone: 'UTC',
    });
    // Under UTC bucketing, June sees the payment.
    expect(summary.revenueCents).toBe(12345);
  });

  it('PST bucketing correctly attributes the same payment to MAY', () => {
    const mayPstSummary = computeMoneyDashboardSummary({
      month: '2026-05',
      now: new Date('2026-06-15T12:00:00Z'),
      invoices: baseInvoices,
      payments: [lateMayPayment],
      expenses,
      timezone: 'America/Los_Angeles',
    });
    // May owns the payment in PST tenant tz.
    expect(mayPstSummary.revenueCents).toBe(12345);

    const junePstSummary = computeMoneyDashboardSummary({
      month: '2026-06',
      now: new Date('2026-06-15T12:00:00Z'),
      invoices: baseInvoices,
      payments: [lateMayPayment],
      expenses,
      timezone: 'America/Los_Angeles',
    });
    // June sees it as priorMonth revenue (which is May), zero in current.
    expect(junePstSummary.revenueCents).toBe(0);
    expect(junePstSummary.priorMonthRevenueCents).toBe(12345);
  });
});
