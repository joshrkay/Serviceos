import { describe, it, expect } from 'vitest';
import { isInvoiceOverdue } from './invoice-status.js';

// Fixed reference time so the boundary cases are deterministic.
const NOW = new Date('2026-06-24T12:00:00Z').getTime();
const PAST = '2026-06-01';
const FUTURE = '2026-07-01';

describe('isInvoiceOverdue', () => {
  it('an open invoice past its due date is overdue', () => {
    expect(isInvoiceOverdue('open', PAST, NOW)).toBe(true);
  });

  it('a partially-paid invoice past its due date is overdue', () => {
    expect(isInvoiceOverdue('partially_paid', PAST, NOW)).toBe(true);
  });

  it('an open invoice due in the future is NOT overdue', () => {
    expect(isInvoiceOverdue('open', FUTURE, NOW)).toBe(false);
  });

  it('a paid / draft / void / canceled invoice is never overdue, even past due', () => {
    for (const status of ['paid', 'draft', 'void', 'canceled']) {
      expect(isInvoiceOverdue(status, PAST, NOW)).toBe(false);
    }
  });

  it('missing or unparseable due date is not overdue', () => {
    expect(isInvoiceOverdue('open', undefined, NOW)).toBe(false);
    expect(isInvoiceOverdue('open', 'not-a-date', NOW)).toBe(false);
  });

  it('undefined / unknown status is not overdue', () => {
    expect(isInvoiceOverdue(undefined, PAST, NOW)).toBe(false);
    expect(isInvoiceOverdue('sent', PAST, NOW)).toBe(false);
  });
});
