import type { JobStatus, EstimateStatus, InvoiceStatus } from '../data/mock-data';

export const JOB_STATUS_MAP: Record<string, string> = {
  new:          'New',
  scheduled:    'Scheduled',
  in_progress:  'In Progress',
  completed:    'Completed',
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

/** Convert integer cents to display string: 15000 → "$150.00" */
export function centsToDisplay(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
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
