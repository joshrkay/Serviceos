import type { JobStatus, EstimateStatus, InvoiceStatus } from '../types/job-ui';
import { isInvoiceOverdue } from '@ai-service-os/shared';
import { formatCurrency } from './currency';

// Re-export the canonical money formatter so existing imports of this
// module (which historically owned `centsToDisplay`) can also reach
// `formatCurrency` without a new import path. New code should prefer
// importing from `utils/currency` directly.
export { formatCurrency } from './currency';

export const JOB_STATUS_MAP: Record<string, string> = {
  new:          'New',
  scheduled:    'Scheduled',
  dispatched:   'Dispatched',
  in_progress:  'In Progress',
  completed:    'Completed',
  invoiced:     'Invoiced',
  closed:       'Closed',
  canceled:     'Canceled',
};

export const ESTIMATE_STATUS_MAP: Record<string, string> = {
  draft:            'Draft',
  ready_for_review: 'Sent',
  sent:             'Sent',
  accepted:         'Approved',
  rejected:         'Declined',
  expired:          'Expired',
};

export const INVOICE_STATUS_MAP: Record<string, string> = {
  draft:           'Draft',
  open:            'Unpaid',
  partially_paid:  'Unpaid',
  paid:            'Paid',
  void:            'Canceled',
  canceled:        'Canceled',
};

export function normalizeJobStatus(apiStatus: string): JobStatus {
  return (JOB_STATUS_MAP[apiStatus] ?? apiStatus) as JobStatus;
}

export function normalizeEstimateStatus(apiStatus: string): EstimateStatus {
  return (ESTIMATE_STATUS_MAP[apiStatus] ?? apiStatus) as EstimateStatus;
}

export function normalizeInvoiceStatus(apiStatus: string): InvoiceStatus {
  return (INVOICE_STATUS_MAP[apiStatus] ?? apiStatus) as InvoiceStatus;
}

/**
 * UI invoice status including the DERIVED 'Overdue'. The canonical API has no
 * `overdue` status (see InvoiceStatus enum), so a plain `normalizeInvoiceStatus`
 * can never produce 'Overdue' — callers that have the `dueDate` use this to
 * surface it. An open / partially-paid invoice past due reads 'Overdue';
 * otherwise the direct mapping. Uses the shared `isInvoiceOverdue` rule so web
 * and mobile derive overdue identically. `now` is injectable for tests.
 */
export function deriveInvoiceUiStatus(
  apiStatus: string,
  dueDate?: string,
  now: number = Date.now(),
): InvoiceStatus {
  if (isInvoiceOverdue(apiStatus, dueDate, now)) return 'Overdue';
  return normalizeInvoiceStatus(apiStatus);
}

/**
 * Convert integer cents to a display string with thousands separator and
 * fixed two-decimal cents: 150000 → "$1,500.00".
 *
 * Delegates to the canonical `formatCurrency` in `utils/currency`. Kept
 * as a stable name for the many existing callers; new code should
 * import `formatCurrency` directly.
 */
export function centsToDisplay(cents: number): string {
  return formatCurrency(cents);
}

/** §6 Time-to-Cash — job-level money rollup for dashboard badges. */
export type JobMoneyState =
  | 'no_estimate'
  | 'estimate_sent'
  | 'estimate_accepted'
  | 'invoiced'
  | 'paid'
  | 'overdue';

export const JOB_MONEY_STATE_LABEL: Record<JobMoneyState, string> = {
  no_estimate: '',
  estimate_sent: 'Estimate sent',
  estimate_accepted: 'Estimate accepted',
  invoiced: 'Invoiced',
  paid: 'Paid',
  overdue: 'Overdue',
};

export function normalizeJobMoneyState(state?: string | null): JobMoneyState | null {
  if (!state || state === 'no_estimate') return null;
  if (state in JOB_MONEY_STATE_LABEL) {
    return state as JobMoneyState;
  }
  return null;
}
