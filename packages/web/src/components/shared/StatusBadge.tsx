import type { JobStatus, EstimateStatus, InvoiceStatus } from '../../data/mock-data';

type Status = JobStatus | EstimateStatus | InvoiceStatus | 'Urgent' | 'Normal';

export type StatusTone = 'info' | 'success' | 'warning' | 'destructive' | 'neutral';

// Branded status vocabulary: the per-status rainbow collapses to the design's
// calm tone set (info = in-flight, success = done, warning = needs-attention,
// destructive = bad, neutral = inert), driven by semantic tokens so every list
// that renders a StatusBadge adopts Path A at once.
const TONE_CLASSES: Record<StatusTone, { dot: string; bg: string; text: string }> = {
  info: { dot: 'bg-primary', bg: 'bg-primary/10', text: 'text-primary' },
  success: { dot: 'bg-success', bg: 'bg-success/10', text: 'text-success' },
  warning: { dot: 'bg-warning', bg: 'bg-warning/10', text: 'text-warning' },
  destructive: { dot: 'bg-destructive', bg: 'bg-destructive/10', text: 'text-destructive' },
  neutral: { dot: 'bg-muted-foreground', bg: 'bg-secondary', text: 'text-muted-foreground' },
};

const STATUS_TONE: Record<string, StatusTone> = {
  Active: 'info',
  'In Progress': 'info',
  Scheduled: 'warning',
  Unscheduled: 'neutral',
  Dispatched: 'info',
  Completed: 'success',
  Invoiced: 'success',
  Closed: 'neutral',
  Canceled: 'destructive',
  'No Show': 'warning',
  Draft: 'neutral',
  Sent: 'info',
  Viewed: 'info',
  Approved: 'success',
  Declined: 'destructive',
  Expired: 'neutral',
  Unpaid: 'warning',
  Paid: 'success',
  Overdue: 'destructive',
  'Estimate sent': 'info',
  'Estimate approved': 'success',
  Urgent: 'destructive',
  Normal: 'neutral',
};

/** Tone for a status label; unknown → neutral. */
export function toneForStatus(status: string): StatusTone {
  return STATUS_TONE[status] ?? 'neutral';
}

interface Props {
  status: Status;
  size?: 'sm' | 'md';
  noBackground?: boolean;
}

export function StatusBadge({ status, size = 'md', noBackground }: Props) {
  const cfg = TONE_CLASSES[toneForStatus(status)];
  const padding = size === 'sm' ? 'px-2 py-0.5' : 'px-2.5 py-1';
  const textSize = 'text-xs';

  if (noBackground) {
    return (
      <span className={`inline-flex items-center gap-1.5 ${textSize} ${cfg.text}`}>
        <span className={`inline-block size-1.5 rounded-full ${cfg.dot}`} />
        {status}
      </span>
    );
  }

  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full ${padding} ${textSize} ${cfg.bg} ${cfg.text}`}
    >
      <span className={`inline-block size-1.5 rounded-full ${cfg.dot}`} />
      {status}
    </span>
  );
}
