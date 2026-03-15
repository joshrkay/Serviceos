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
  expired:          'Draft',
};

export const INVOICE_STATUS_MAP: Record<string, string> = {
  draft:           'Draft',
  open:            'Unpaid',
  partially_paid:  'Unpaid',
  paid:            'Paid',
  void:            'Canceled',
  canceled:        'Canceled',
};

export function normalizeJobStatus(apiStatus: string): string {
  return JOB_STATUS_MAP[apiStatus] ?? apiStatus;
}

export function normalizeEstimateStatus(apiStatus: string): string {
  return ESTIMATE_STATUS_MAP[apiStatus] ?? apiStatus;
}

export function normalizeInvoiceStatus(apiStatus: string): string {
  return INVOICE_STATUS_MAP[apiStatus] ?? apiStatus;
}

/** Convert integer cents to display string: 15000 → "$150.00" */
export function centsToDisplay(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}
