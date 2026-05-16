/**
 * D2-4 — partial-refund tracking in the tax export.
 *
 * A payment with refundedAmountCents > 0 must emit TWO rows:
 *   1. The original income row, full magnitude, dated by receivedAt.
 *   2. A NEGATIVE income row, magnitude = -refundedAmountCents, dated
 *      by refundedAt, description prefixed with "[REFUND] " and
 *      referencing the original payment id.
 *
 * The pair ensures YTD income nets correctly while preserving the
 * original payment's magnitude for audit purposes.
 */
import { describe, it, expect } from 'vitest';
import {
  buildPaymentIncomeRows,
  buildTaxExportCsv,
} from '../../src/reports/tax-export';
import type { Payment } from '../../src/invoices/payment';

function makePayment(over: Partial<Payment> = {}): Payment {
  const now = new Date('2026-05-01T00:00:00Z');
  return {
    id: 'pay-1',
    tenantId: 't1',
    invoiceId: 'inv-1',
    amountCents: 50000,
    method: 'credit_card',
    status: 'completed',
    receivedAt: new Date('2026-05-03T10:00:00Z'),
    processedBy: 'u1',
    createdAt: now,
    updatedAt: now,
    refundedAmountCents: 0,
    refundedAt: null,
    lastRefundStripeId: null,
    ...over,
  };
}

describe('buildPaymentIncomeRows (D2-4)', () => {
  it('emits a single income row for a payment with no refund', () => {
    const payment = makePayment({ amountCents: 25000 });
    const rows = buildPaymentIncomeRows(payment, {
      invoiceNumber: 'INV-1001',
      jobId: 'job-abc',
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({
      date: '2026-05-03',
      type: 'income',
      category: 'invoice',
      description: 'INV-1001',
      jobId: 'job-abc',
      amountCents: 25000,
    });
  });

  it('emits the original income row + a NEGATIVE income row dated by refundedAt for a partial refund', () => {
    const payment = makePayment({
      id: 'pay-refund-1',
      amountCents: 50000,
      receivedAt: new Date('2026-05-03T10:00:00Z'),
      refundedAmountCents: 5000,
      refundedAt: new Date('2026-05-12T18:00:00Z'),
      lastRefundStripeId: 're_test',
    });
    const rows = buildPaymentIncomeRows(payment, {
      invoiceNumber: 'INV-500',
      jobId: 'job-x',
    });
    expect(rows).toHaveLength(2);
    // Original — full magnitude, original date.
    expect(rows[0]).toEqual({
      date: '2026-05-03',
      type: 'income',
      category: 'invoice',
      description: 'INV-500',
      jobId: 'job-x',
      amountCents: 50000,
    });
    // Refund — negative magnitude, refund date, prefixed description.
    expect(rows[1]).toEqual({
      date: '2026-05-12',
      type: 'income',
      category: 'invoice',
      description: '[REFUND] INV-500 (payment pay-refund-1)',
      jobId: 'job-x',
      amountCents: -5000,
    });
    // YTD net is correctly 45000 (=50000 - 5000) when summed.
    expect(rows.reduce((s, r) => s + r.amountCents, 0)).toBe(45000);
  });

  it('handles a full refund: original keeps full magnitude, refund row is -amountCents', () => {
    const payment = makePayment({
      id: 'pay-full-refund',
      amountCents: 30000,
      receivedAt: new Date('2026-04-01T00:00:00Z'),
      refundedAmountCents: 30000,
      refundedAt: new Date('2026-05-15T00:00:00Z'),
    });
    const rows = buildPaymentIncomeRows(payment, { invoiceNumber: 'INV-9' });
    expect(rows[0].amountCents).toBe(30000);
    expect(rows[1].amountCents).toBe(-30000);
    expect(rows.reduce((s, r) => s + r.amountCents, 0)).toBe(0);
  });

  it('omits the refund row when refundedAmountCents is 0 even if refundedAt is set', () => {
    // Defensive: a zero-refund-with-timestamp should not produce a row
    // (would corrupt the YTD math with a 0 entry that has the wrong date).
    const payment = makePayment({
      refundedAmountCents: 0,
      refundedAt: new Date('2026-05-12T00:00:00Z'),
    });
    const rows = buildPaymentIncomeRows(payment, { invoiceNumber: 'INV-1' });
    expect(rows).toHaveLength(1);
  });

  it('omits the refund row when refundedAt is null even if refundedAmountCents > 0', () => {
    // Defensive: should never happen in practice (recordRefund always
    // sets refundedAt), but the report must not crash on stale data.
    const payment = makePayment({
      refundedAmountCents: 100,
      refundedAt: null,
    });
    const rows = buildPaymentIncomeRows(payment, { invoiceNumber: 'INV-1' });
    expect(rows).toHaveLength(1);
  });

  it('CSV output formats the negative amount with a leading minus sign', () => {
    const payment = makePayment({
      id: 'pay-csv',
      amountCents: 50000,
      receivedAt: new Date('2026-05-03T10:00:00Z'),
      refundedAmountCents: 5000,
      refundedAt: new Date('2026-05-12T00:00:00Z'),
    });
    const rows = buildPaymentIncomeRows(payment, {
      invoiceNumber: 'INV-CSV',
      jobId: 'job-csv',
    });
    const csv = buildTaxExportCsv(rows);
    expect(csv).toContain('2026-05-03,income,invoice,INV-CSV,job-csv,500.00');
    expect(csv).toContain(
      '2026-05-12,income,invoice,[REFUND] INV-CSV (payment pay-csv),job-csv,-50.00',
    );
  });

  it('refund row inherits jobId from context; omitted when context lacks one', () => {
    const payment = makePayment({
      amountCents: 1000,
      refundedAmountCents: 250,
      refundedAt: new Date('2026-05-12T00:00:00Z'),
    });
    const rows = buildPaymentIncomeRows(payment, { invoiceNumber: 'INV-NJ' });
    expect(rows[0].jobId).toBeUndefined();
    expect(rows[1].jobId).toBeUndefined();
  });
});
