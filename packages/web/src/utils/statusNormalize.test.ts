import { describe, it, expect } from 'vitest';
import {
  normalizeJobStatus,
  normalizeEstimateStatus,
  normalizeInvoiceStatus,
  deriveInvoiceUiStatus,
  centsToDisplay,
  JOB_STATUS_MAP,
  ESTIMATE_STATUS_MAP,
  INVOICE_STATUS_MAP,
} from './statusNormalize';

describe('normalizeJobStatus', () => {
  it('maps all known job statuses', () => {
    expect(normalizeJobStatus('new')).toBe('New');
    expect(normalizeJobStatus('scheduled')).toBe('Scheduled');
    expect(normalizeJobStatus('in_progress')).toBe('In Progress');
    expect(normalizeJobStatus('completed')).toBe('Completed');
    expect(normalizeJobStatus('canceled')).toBe('Canceled');
  });

  it('falls back to raw string for unknown status', () => {
    expect(normalizeJobStatus('some_future_status')).toBe('some_future_status');
  });

  it('covers all entries in JOB_STATUS_MAP', () => {
    for (const [key, value] of Object.entries(JOB_STATUS_MAP)) {
      expect(normalizeJobStatus(key)).toBe(value);
    }
  });
});

describe('normalizeEstimateStatus', () => {
  it('maps all known estimate statuses', () => {
    expect(normalizeEstimateStatus('draft')).toBe('Draft');
    expect(normalizeEstimateStatus('ready_for_review')).toBe('Sent');
    expect(normalizeEstimateStatus('sent')).toBe('Sent');
    expect(normalizeEstimateStatus('accepted')).toBe('Approved');
    expect(normalizeEstimateStatus('rejected')).toBe('Declined');
    expect(normalizeEstimateStatus('expired')).toBe('Expired');
  });

  it('falls back to raw string for unknown status', () => {
    expect(normalizeEstimateStatus('unknown')).toBe('unknown');
  });

  it('covers all entries in ESTIMATE_STATUS_MAP', () => {
    for (const [key, value] of Object.entries(ESTIMATE_STATUS_MAP)) {
      expect(normalizeEstimateStatus(key)).toBe(value);
    }
  });
});

describe('normalizeInvoiceStatus', () => {
  it('maps all known invoice statuses', () => {
    expect(normalizeInvoiceStatus('draft')).toBe('Draft');
    expect(normalizeInvoiceStatus('open')).toBe('Unpaid');
    expect(normalizeInvoiceStatus('partially_paid')).toBe('Unpaid');
    expect(normalizeInvoiceStatus('paid')).toBe('Paid');
    expect(normalizeInvoiceStatus('void')).toBe('Canceled');
    expect(normalizeInvoiceStatus('canceled')).toBe('Canceled');
  });

  it('falls back to raw string for unknown status', () => {
    expect(normalizeInvoiceStatus('unknown')).toBe('unknown');
  });

  it('covers all entries in INVOICE_STATUS_MAP', () => {
    for (const [key, value] of Object.entries(INVOICE_STATUS_MAP)) {
      expect(normalizeInvoiceStatus(key)).toBe(value);
    }
  });
});

describe('deriveInvoiceUiStatus (derived overdue)', () => {
  const NOW = new Date('2026-06-24T12:00:00Z').getTime();

  it("surfaces 'Overdue' for an open invoice past its due date", () => {
    expect(deriveInvoiceUiStatus('open', '2026-06-01', NOW)).toBe('Overdue');
    expect(deriveInvoiceUiStatus('partially_paid', '2026-06-01', NOW)).toBe('Overdue');
  });

  it("falls back to the plain mapping when not overdue", () => {
    expect(deriveInvoiceUiStatus('open', '2026-07-01', NOW)).toBe('Unpaid');
    expect(deriveInvoiceUiStatus('paid', '2026-06-01', NOW)).toBe('Paid');
    expect(deriveInvoiceUiStatus('open', undefined, NOW)).toBe('Unpaid');
  });
});

describe('centsToDisplay', () => {
  it('converts zero cents', () => {
    expect(centsToDisplay(0)).toBe('$0.00');
  });

  it('converts whole dollar amounts under one thousand', () => {
    expect(centsToDisplay(1000)).toBe('$10.00');
    expect(centsToDisplay(15000)).toBe('$150.00');
  });

  // Blocker (money display): `$1000.00` (no separator) was the bug. The
  // canonical formatter routes through `Intl.NumberFormat`, which inserts
  // the locale-appropriate grouping separator and always emits two
  // decimals — matching the behavior the InvoicePaymentPage already had.
  it('uses thousands separators above 999', () => {
    expect(centsToDisplay(100000)).toBe('$1,000.00');
    expect(centsToDisplay(123450)).toBe('$1,234.50');
    expect(centsToDisplay(1000000)).toBe('$10,000.00');
    expect(centsToDisplay(1234567890)).toBe('$12,345,678.90');
  });

  it('renders negative amounts with the minus before the symbol', () => {
    expect(centsToDisplay(-500)).toBe('-$5.00');
    expect(centsToDisplay(-100000)).toBe('-$1,000.00');
  });

  it('converts fractional cents', () => {
    expect(centsToDisplay(1050)).toBe('$10.50');
    expect(centsToDisplay(199)).toBe('$1.99');
  });

  it('always includes two decimal places', () => {
    expect(centsToDisplay(500)).toMatch(/\.\d{2}$/);
    expect(centsToDisplay(550)).toMatch(/\.\d{2}$/);
  });
});
