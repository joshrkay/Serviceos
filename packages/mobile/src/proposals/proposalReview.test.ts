import { describe, expect, it } from 'vitest';
import {
  UNDO_WINDOW_MS,
  formatCents,
  humanizeKey,
  reviewRows,
  typeLabel,
  undoSecondsLeft,
} from './proposalReview';

describe('typeLabel', () => {
  it('maps known types to friendly labels and de-underscores the rest', () => {
    expect(typeLabel('draft_invoice')).toBe('Invoice');
    expect(typeLabel('record_payment')).toBe('Payment');
    expect(typeLabel('some_new_type')).toBe('some new type');
  });
});

describe('humanizeKey', () => {
  it('turns camelCase and snake_case keys into Title Case', () => {
    expect(humanizeKey('customerName')).toBe('Customer Name');
    expect(humanizeKey('total_cents')).toBe('Total Cents');
    expect(humanizeKey('amountCents')).toBe('Amount Cents');
  });
});

describe('formatCents', () => {
  it('renders integer cents as dollars (no float math)', () => {
    expect(formatCents(0)).toBe('$0.00');
    expect(formatCents(5)).toBe('$0.05');
    expect(formatCents(12345)).toBe('$123.45');
    expect(formatCents(-2000)).toBe('-$20.00');
  });
});

describe('reviewRows', () => {
  it('flattens top-level scalars, formats *Cents as dollars, skips nesting/null', () => {
    const rows = reviewRows({
      customerName: 'Acme',
      amountCents: 12345,
      sendCopy: true,
      lineItems: [{ x: 1 }], // nested → skipped
      note: null, // null → skipped
    });
    expect(rows).toEqual([
      { label: 'Customer Name', value: 'Acme' },
      { label: 'Amount Cents', value: '$123.45' },
      { label: 'Send Copy', value: 'Yes' },
    ]);
  });

  it('returns [] for an absent payload', () => {
    expect(reviewRows(undefined)).toEqual([]);
  });
});

describe('undoSecondsLeft', () => {
  const approvedAt = '2026-06-20T00:00:00.000Z';
  const t0 = Date.parse(approvedAt);

  it('counts whole seconds down from the 5s window', () => {
    expect(UNDO_WINDOW_MS).toBe(5000);
    expect(undoSecondsLeft(approvedAt, t0)).toBe(5);
    expect(undoSecondsLeft(approvedAt, t0 + 1)).toBe(5);
    expect(undoSecondsLeft(approvedAt, t0 + 1000)).toBe(4);
    expect(undoSecondsLeft(approvedAt, t0 + 4001)).toBe(1);
  });

  it('returns 0 at/after the window close and with no approval', () => {
    expect(undoSecondsLeft(approvedAt, t0 + 5000)).toBe(0);
    expect(undoSecondsLeft(approvedAt, t0 + 9999)).toBe(0);
    expect(undoSecondsLeft(null, t0)).toBe(0);
    expect(undoSecondsLeft(undefined, t0)).toBe(0);
  });
});
