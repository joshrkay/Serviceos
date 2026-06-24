// Pure (RN-free) mappers from an estimate/invoice status to a list-row badge.
// Kept here so the branchy status→tone logic unit-tests without a renderer.
import { isInvoiceOverdue } from '@ai-service-os/shared';
import type { EntityBadge } from '../components/EntityList';

function titleCase(s: string): string {
  return s
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Estimate status → badge. Accepted reads calm; rejected/expired read loud. */
export function estimateStatusBadge(status: string | undefined): EntityBadge | undefined {
  switch (status) {
    case 'accepted':
      return { label: 'Accepted', tone: 'success' };
    case 'sent':
      return { label: 'Sent', tone: 'info' };
    case 'ready_for_review':
      return { label: 'Review', tone: 'warning' };
    case 'rejected':
      return { label: 'Rejected', tone: 'danger' };
    case 'expired':
      return { label: 'Expired', tone: 'danger' };
    case 'draft':
      return { label: 'Draft', tone: 'neutral' };
    default:
      return status ? { label: titleCase(status), tone: 'neutral' } : undefined;
  }
}

/**
 * Invoice status → badge. "Overdue" is DERIVED (there is no overdue status):
 * an open / partially-paid invoice past its due date reads loud, otherwise the
 * status maps directly. `now` is injectable for deterministic tests.
 */
export function invoiceStatusBadge(
  status: string | undefined,
  dueDate?: string,
  now: number = Date.now(),
): EntityBadge | undefined {
  // "Overdue" is derived via the shared rule (open/partially_paid + past due)
  // so web and mobile can't disagree about which invoices read overdue.
  if (isInvoiceOverdue(status, dueDate, now)) return { label: 'Overdue', tone: 'danger' };
  switch (status) {
    case 'paid':
      return { label: 'Paid', tone: 'success' };
    case 'open':
      return { label: 'Open', tone: 'info' };
    case 'partially_paid':
      return { label: 'Partial', tone: 'warning' };
    case 'draft':
      return { label: 'Draft', tone: 'neutral' };
    case 'void':
      return { label: 'Void', tone: 'neutral' };
    case 'canceled':
      return { label: 'Canceled', tone: 'neutral' };
    default:
      return status ? { label: titleCase(status), tone: 'neutral' } : undefined;
  }
}
