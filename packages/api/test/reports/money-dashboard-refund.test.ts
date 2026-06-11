/**
 * D2-4 — refund tracking in the money dashboard.
 *
 * The dashboard now distinguishes GROSS revenue (sum of payments
 * received in window) from NET revenue (gross minus refunds dated by
 * refundedAt in the same window). `revenueCents` keeps its meaning as
 * the canonical "money you actually kept" figure (now = net), and
 * `grossRevenueCents` + `refundsCents` are exposed so the UI can label
 * the gap rather than make the owner derive it.
 *
 * Critical invariant: a refund dated OUTSIDE the window does not reduce
 * THIS window's net even if the original payment is inside it — that's
 * the whole point of carrying refundedAt independently of receivedAt.
 */
import { describe, it, expect } from 'vitest';
import {
  computeMoneyDashboardSummary,
  MoneyDashboardInput,
} from '../../src/reports/money-dashboard';
import type { Payment } from '../../src/invoices/payment';

function payment(over: Partial<Payment> = {}): Payment {
  const now = new Date('2026-05-01T00:00:00Z');
  return {
    id: `pay-${Math.random().toString(36).slice(2)}`,
    tenantId: 't1',
    invoiceId: 'inv1',
    amountCents: 10000,
    method: 'credit_card',
    status: 'completed',
    receivedAt: new Date('2026-05-10T12:00:00Z'),
    processedBy: 'u1',
    createdAt: now,
    updatedAt: now,
    refundedAmountCents: 0,
    refundedAt: null,
    lastRefundStripeId: null,
    reversedAt: null,
    reversalReason: null,
    ...over,
  };
}

const MONTH = '2026-05';
const NOW = new Date('2026-05-20T12:00:00.000Z');

describe('computeMoneyDashboardSummary refund handling (D2-4)', () => {
  it('subtracts in-window refunds from net revenue, keeps gross unchanged', () => {
    const input: MoneyDashboardInput = {
      month: MONTH, now: NOW, invoices: [], expenses: [],
      payments: [
        payment({
          amountCents: 50000,
          receivedAt: new Date('2026-05-03T00:00:00Z'),
          refundedAmountCents: 5000,
          refundedAt: new Date('2026-05-12T00:00:00Z'),
        }),
        payment({
          amountCents: 20000,
          receivedAt: new Date('2026-05-18T00:00:00Z'),
        }),
      ],
    };
    const summary = computeMoneyDashboardSummary(input);
    expect(summary.grossRevenueCents).toBe(70000);
    expect(summary.refundsCents).toBe(5000);
    expect(summary.revenueCents).toBe(65000);
  });

  it('does NOT reduce this window when the refund date falls OUTSIDE the window', () => {
    // Payment received in May; refund happened in June. May's net
    // revenue should NOT be reduced — the refund is June's problem.
    const input: MoneyDashboardInput = {
      month: MONTH, now: NOW, invoices: [], expenses: [],
      payments: [
        payment({
          amountCents: 50000,
          receivedAt: new Date('2026-05-03T00:00:00Z'),
          refundedAmountCents: 5000,
          refundedAt: new Date('2026-06-15T00:00:00Z'),
        }),
      ],
    };
    const summary = computeMoneyDashboardSummary(input);
    expect(summary.grossRevenueCents).toBe(50000);
    expect(summary.refundsCents).toBe(0);
    expect(summary.revenueCents).toBe(50000);
  });

  it('reduces this window when the refund is dated in-window even if the original payment is from a prior month', () => {
    // Payment received in April (outside May window) — does NOT
    // contribute to May gross. But the refund landed in May, so it
    // DOES reduce May's net. (The May owner sees their bank account
    // shrink because of an April sale they refunded.)
    const input: MoneyDashboardInput = {
      month: MONTH, now: NOW, invoices: [], expenses: [],
      payments: [
        payment({
          amountCents: 50000,
          receivedAt: new Date('2026-04-15T00:00:00Z'),
          refundedAmountCents: 5000,
          refundedAt: new Date('2026-05-12T00:00:00Z'),
        }),
        payment({
          amountCents: 10000,
          receivedAt: new Date('2026-05-05T00:00:00Z'),
        }),
      ],
    };
    const summary = computeMoneyDashboardSummary(input);
    expect(summary.grossRevenueCents).toBe(10000);
    expect(summary.refundsCents).toBe(5000);
    expect(summary.revenueCents).toBe(5000);
  });

  it('refundsCents includes prior-month refunds in the priorMonthRevenueCents calculation', () => {
    // April (prior to May) — payment received and refunded in April.
    // April net = 20000 - 3000 = 17000. May net = 0.
    const input: MoneyDashboardInput = {
      month: MONTH, now: NOW, invoices: [], expenses: [],
      payments: [
        payment({
          amountCents: 20000,
          receivedAt: new Date('2026-04-10T00:00:00Z'),
          refundedAmountCents: 3000,
          refundedAt: new Date('2026-04-20T00:00:00Z'),
        }),
      ],
    };
    const summary = computeMoneyDashboardSummary(input);
    expect(summary.priorMonthRevenueCents).toBe(17000);
    expect(summary.grossRevenueCents).toBe(0);
    expect(summary.revenueCents).toBe(0);
    expect(summary.revenueTrendCents).toBe(-17000);
  });

  it('a fully-refunded in-window payment nets to 0 revenue', () => {
    const input: MoneyDashboardInput = {
      month: MONTH, now: NOW, invoices: [], expenses: [],
      payments: [
        payment({
          amountCents: 30000,
          receivedAt: new Date('2026-05-03T00:00:00Z'),
          refundedAmountCents: 30000,
          refundedAt: new Date('2026-05-12T00:00:00Z'),
        }),
      ],
    };
    const summary = computeMoneyDashboardSummary(input);
    expect(summary.grossRevenueCents).toBe(30000);
    expect(summary.refundsCents).toBe(30000);
    expect(summary.revenueCents).toBe(0);
  });

  it('refunds on non-completed payments are NOT subtracted (only completed payments contribute)', () => {
    // A pending or failed payment with refundedAmountCents shouldn't
    // reduce revenue — the gross never landed in the first place.
    const input: MoneyDashboardInput = {
      month: MONTH, now: NOW, invoices: [], expenses: [],
      payments: [
        payment({
          status: 'pending',
          amountCents: 50000,
          receivedAt: new Date('2026-05-03T00:00:00Z'),
          refundedAmountCents: 5000,
          refundedAt: new Date('2026-05-12T00:00:00Z'),
        }),
      ],
    };
    const summary = computeMoneyDashboardSummary(input);
    expect(summary.grossRevenueCents).toBe(0);
    expect(summary.refundsCents).toBe(0);
    expect(summary.revenueCents).toBe(0);
  });

  it('summary includes grossRevenueCents and refundsCents fields (response shape)', () => {
    const summary = computeMoneyDashboardSummary({
      month: MONTH, now: NOW, invoices: [], expenses: [], payments: [],
    });
    expect(summary).toHaveProperty('grossRevenueCents', 0);
    expect(summary).toHaveProperty('refundsCents', 0);
    expect(summary).toHaveProperty('revenueCents', 0);
  });
});
