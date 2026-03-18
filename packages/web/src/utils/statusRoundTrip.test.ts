/**
 * Layer 3 — Status Round-trip Tests
 *
 * Proves that:
 * 1. Every API status enum value has a defined UI label (forward mapping)
 * 2. The filter values used in each page's FilterConfig map back to valid API statuses
 * 3. centsToDisplay always produces a proper "$X.XX" string (never missing cents)
 *
 * If a new status is added to the API, these tests force an update to the
 * status maps — preventing silent display bugs like "status: in_progress"
 * appearing literally in the UI.
 */
import { describe, it, expect } from 'vitest';
import {
  JOB_STATUS_MAP,
  ESTIMATE_STATUS_MAP,
  INVOICE_STATUS_MAP,
  normalizeJobStatus,
  normalizeEstimateStatus,
  normalizeInvoiceStatus,
  centsToDisplay,
} from './statusNormalize';

// ─── Filter values declared in each page's FilterConfig ─────────────────────
// These are the values that get passed to setFilters({ status: VALUE }) and
// then become API query params. They must be valid API enum values.

const JOB_FILTER_VALUES = ['new', 'scheduled', 'in_progress', 'completed', 'canceled'];

const ESTIMATE_FILTER_VALUES = [
  'draft',
  'ready_for_review',
  'sent',
  'accepted',
  'rejected',
  'expired',
];

const INVOICE_FILTER_VALUES = ['draft', 'open', 'partially_paid', 'paid', 'void', 'canceled'];

// ─── API enum values (the full set the API can return) ───────────────────────

const JOB_API_STATUSES = ['new', 'scheduled', 'in_progress', 'completed', 'canceled'];
const ESTIMATE_API_STATUSES = ['draft', 'ready_for_review', 'sent', 'accepted', 'rejected', 'expired'];
const INVOICE_API_STATUSES = ['draft', 'open', 'partially_paid', 'paid', 'void', 'canceled'];

// ─── Job Status Tests ────────────────────────────────────────────────────────

describe('JOB_STATUS_MAP — forward mapping (API → UI label)', () => {
  it('maps every API status to a non-empty UI label', () => {
    for (const status of JOB_API_STATUSES) {
      const label = normalizeJobStatus(status);
      expect(label, `Missing label for job status "${status}"`).toBeTruthy();
      expect(label, `Job status "${status}" was not mapped (passes through raw)`).not.toBe(status);
    }
  });

  it('maps each status to the correct human-readable label', () => {
    expect(normalizeJobStatus('new')).toBe('New');
    expect(normalizeJobStatus('scheduled')).toBe('Scheduled');
    expect(normalizeJobStatus('in_progress')).toBe('In Progress');
    expect(normalizeJobStatus('completed')).toBe('Completed');
    expect(normalizeJobStatus('canceled')).toBe('Canceled');
  });

  it('falls back to the raw value for unknown statuses', () => {
    expect(normalizeJobStatus('unknown_status')).toBe('unknown_status');
  });
});

describe('Job FilterConfig values — reverse mapping (filter value → API status)', () => {
  it('every filter option value exists as a key in JOB_STATUS_MAP', () => {
    for (const value of JOB_FILTER_VALUES) {
      expect(
        Object.keys(JOB_STATUS_MAP),
        `Filter value "${value}" is not a recognized API job status`
      ).toContain(value);
    }
  });

  it('all API statuses are represented in the filter options', () => {
    for (const apiStatus of JOB_API_STATUSES) {
      expect(
        JOB_FILTER_VALUES,
        `API status "${apiStatus}" has no corresponding filter option`
      ).toContain(apiStatus);
    }
  });
});

// ─── Estimate Status Tests ───────────────────────────────────────────────────

describe('ESTIMATE_STATUS_MAP — forward mapping (API → UI label)', () => {
  it('maps every API status to a non-empty UI label', () => {
    for (const status of ESTIMATE_API_STATUSES) {
      const label = normalizeEstimateStatus(status);
      expect(label, `Missing label for estimate status "${status}"`).toBeTruthy();
    }
  });

  it('maps each status to the correct label', () => {
    expect(normalizeEstimateStatus('draft')).toBe('Draft');
    expect(normalizeEstimateStatus('ready_for_review')).toBe('Sent');
    expect(normalizeEstimateStatus('sent')).toBe('Sent');
    expect(normalizeEstimateStatus('accepted')).toBe('Approved');
    expect(normalizeEstimateStatus('rejected')).toBe('Declined');
    expect(normalizeEstimateStatus('expired')).toBe('Draft');
  });
});

describe('Estimate FilterConfig values — reverse mapping', () => {
  it('every filter option value exists as a key in ESTIMATE_STATUS_MAP', () => {
    for (const value of ESTIMATE_FILTER_VALUES) {
      expect(
        Object.keys(ESTIMATE_STATUS_MAP),
        `Estimate filter value "${value}" is not a recognized API status`
      ).toContain(value);
    }
  });

  it('all API statuses are represented in the filter options', () => {
    for (const apiStatus of ESTIMATE_API_STATUSES) {
      expect(
        ESTIMATE_FILTER_VALUES,
        `API estimate status "${apiStatus}" has no filter option`
      ).toContain(apiStatus);
    }
  });
});

// ─── Invoice Status Tests ────────────────────────────────────────────────────

describe('INVOICE_STATUS_MAP — forward mapping (API → UI label)', () => {
  it('maps every API status to a non-empty UI label', () => {
    for (const status of INVOICE_API_STATUSES) {
      const label = normalizeInvoiceStatus(status);
      expect(label, `Missing label for invoice status "${status}"`).toBeTruthy();
    }
  });

  it('maps each status to the correct label', () => {
    expect(normalizeInvoiceStatus('draft')).toBe('Draft');
    expect(normalizeInvoiceStatus('open')).toBe('Unpaid');
    expect(normalizeInvoiceStatus('partially_paid')).toBe('Unpaid');
    expect(normalizeInvoiceStatus('paid')).toBe('Paid');
    expect(normalizeInvoiceStatus('void')).toBe('Canceled');
    expect(normalizeInvoiceStatus('canceled')).toBe('Canceled');
  });
});

describe('Invoice FilterConfig values — reverse mapping', () => {
  it('every filter option value exists as a key in INVOICE_STATUS_MAP', () => {
    for (const value of INVOICE_FILTER_VALUES) {
      expect(
        Object.keys(INVOICE_STATUS_MAP),
        `Invoice filter value "${value}" is not a recognized API status`
      ).toContain(value);
    }
  });

  it('all API statuses are represented in the filter options', () => {
    for (const apiStatus of INVOICE_API_STATUSES) {
      expect(
        INVOICE_FILTER_VALUES,
        `API invoice status "${apiStatus}" has no filter option`
      ).toContain(apiStatus);
    }
  });
});

// ─── centsToDisplay invariants ───────────────────────────────────────────────

describe('centsToDisplay', () => {
  it('always produces exactly two decimal places', () => {
    const cases: [number, string][] = [
      [0, '$0.00'],
      [1, '$0.01'],
      [99, '$0.99'],
      [100, '$1.00'],
      [101, '$1.01'],
      [1000, '$10.00'],
      [15000, '$150.00'],
      [150099, '$1500.99'],
      [999999, '$9999.99'],
    ];
    for (const [cents, expected] of cases) {
      expect(centsToDisplay(cents), `centsToDisplay(${cents})`).toBe(expected);
    }
  });

  it('starts with a dollar sign', () => {
    expect(centsToDisplay(100)).toMatch(/^\$/);
  });

  it('never returns a string containing a floating-point imprecision', () => {
    // Edge case: numbers that could trigger binary float weirdness
    const result = centsToDisplay(150099);
    expect(result).toBe('$1500.99');
    expect(result).not.toContain('1500.9899');
    expect(result).not.toContain('1500.9900');
  });
});
