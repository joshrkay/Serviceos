import { describe, expect, it } from 'vitest';
import { estimateStatusBadge, invoiceStatusBadge } from './entityStatus';

describe('estimateStatusBadge', () => {
  it('maps known statuses to toned badges', () => {
    expect(estimateStatusBadge('accepted')).toEqual({ label: 'Accepted', tone: 'success' });
    expect(estimateStatusBadge('sent')).toEqual({ label: 'Sent', tone: 'info' });
    expect(estimateStatusBadge('rejected')).toEqual({ label: 'Rejected', tone: 'danger' });
    expect(estimateStatusBadge('expired')).toEqual({ label: 'Expired', tone: 'danger' });
    expect(estimateStatusBadge('draft')).toEqual({ label: 'Draft', tone: 'neutral' });
  });

  it('title-cases an unknown status and is undefined when absent', () => {
    expect(estimateStatusBadge('on_hold')).toEqual({ label: 'On Hold', tone: 'neutral' });
    expect(estimateStatusBadge(undefined)).toBeUndefined();
  });
});

describe('invoiceStatusBadge', () => {
  const NOW = Date.UTC(2026, 5, 24);
  const day = 86_400_000;

  it('derives Overdue for an open/partial invoice past its due date', () => {
    expect(invoiceStatusBadge('open', new Date(NOW - day).toISOString(), NOW)).toEqual({
      label: 'Overdue',
      tone: 'danger',
    });
    expect(invoiceStatusBadge('partially_paid', new Date(NOW - 1000).toISOString(), NOW)).toEqual({
      label: 'Overdue',
      tone: 'danger',
    });
  });

  it('does not mark a not-yet-due or already-paid invoice overdue', () => {
    expect(invoiceStatusBadge('open', new Date(NOW + day).toISOString(), NOW)).toEqual({
      label: 'Open',
      tone: 'info',
    });
    expect(invoiceStatusBadge('paid', new Date(NOW - day).toISOString(), NOW)).toEqual({
      label: 'Paid',
      tone: 'success',
    });
  });

  it('maps the remaining statuses and is undefined when absent', () => {
    expect(invoiceStatusBadge('draft')).toEqual({ label: 'Draft', tone: 'neutral' });
    expect(invoiceStatusBadge('void')).toEqual({ label: 'Void', tone: 'neutral' });
    expect(invoiceStatusBadge('canceled')).toEqual({ label: 'Canceled', tone: 'neutral' });
    expect(invoiceStatusBadge(undefined)).toBeUndefined();
  });
});
