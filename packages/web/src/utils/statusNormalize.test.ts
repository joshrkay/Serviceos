import { describe, it, expect } from 'vitest';
import {
  normalizeJobStatus,
  normalizeEstimateStatus,
  normalizeInvoiceStatus,
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
    expect(normalizeEstimateStatus('expired')).toBe('Draft');
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

describe('centsToDisplay', () => {
  it('converts zero cents', () => {
    expect(centsToDisplay(0)).toBe('$0.00');
  });

  it('converts whole dollar amounts', () => {
    expect(centsToDisplay(1000)).toBe('$10.00');
    expect(centsToDisplay(15000)).toBe('$150.00');
    expect(centsToDisplay(100000)).toBe('$1000.00');
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
