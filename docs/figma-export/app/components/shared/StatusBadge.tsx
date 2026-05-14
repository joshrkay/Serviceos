import type { JobStatus, EstimateStatus, InvoiceStatus } from '../../data/mock-data';

type Status = JobStatus | EstimateStatus | InvoiceStatus | 'Urgent' | 'Normal';

const CONFIG: Record<string, { dot: string; bg: string; text: string; label?: string }> = {
  Active:        { dot: 'bg-blue-500',   bg: 'bg-blue-50',   text: 'text-blue-700' },
  'In Progress': { dot: 'bg-blue-500',   bg: 'bg-blue-50',   text: 'text-blue-700' },
  Scheduled:     { dot: 'bg-amber-500',  bg: 'bg-amber-50',  text: 'text-amber-700' },
  Unscheduled:   { dot: 'bg-slate-400',  bg: 'bg-slate-100', text: 'text-slate-600' },
  Completed:     { dot: 'bg-green-500',  bg: 'bg-green-50',  text: 'text-green-700' },
  Canceled:      { dot: 'bg-red-400',    bg: 'bg-red-50',    text: 'text-red-600' },
  'No Show':     { dot: 'bg-orange-400', bg: 'bg-orange-50', text: 'text-orange-700' },
  Draft:         { dot: 'bg-slate-400',  bg: 'bg-slate-100', text: 'text-slate-600' },
  Sent:          { dot: 'bg-blue-500',   bg: 'bg-blue-50',   text: 'text-blue-700' },
  Viewed:        { dot: 'bg-violet-500', bg: 'bg-violet-50', text: 'text-violet-700' },
  Approved:      { dot: 'bg-green-500',  bg: 'bg-green-50',  text: 'text-green-700' },
  Declined:      { dot: 'bg-red-500',    bg: 'bg-red-50',    text: 'text-red-700' },
  Unpaid:        { dot: 'bg-amber-500',  bg: 'bg-amber-50',  text: 'text-amber-700' },
  Paid:          { dot: 'bg-green-500',  bg: 'bg-green-50',  text: 'text-green-700' },
  Overdue:       { dot: 'bg-red-500',    bg: 'bg-red-50',    text: 'text-red-700' },
  Urgent:        { dot: 'bg-red-500',    bg: 'bg-red-50',    text: 'text-red-700' },
  Normal:        { dot: 'bg-slate-400',  bg: 'bg-slate-100', text: 'text-slate-600' },
};

interface Props {
  status: Status;
  size?: 'sm' | 'md';
  noBackground?: boolean;
}

export function StatusBadge({ status, size = 'md', noBackground }: Props) {
  const cfg = CONFIG[status] ?? CONFIG.Normal;
  const padding = size === 'sm' ? 'px-2 py-0.5' : 'px-2.5 py-1';
  const textSize = size === 'sm' ? 'text-xs' : 'text-xs';

  if (noBackground) {
    return (
      <span className={`inline-flex items-center gap-1.5 ${textSize} ${cfg.text}`}>
        <span className={`inline-block size-1.5 rounded-full ${cfg.dot}`} />
        {status}
      </span>
    );
  }

  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full ${padding} ${textSize} ${cfg.bg} ${cfg.text}`}>
      <span className={`inline-block size-1.5 rounded-full ${cfg.dot}`} />
      {status}
    </span>
  );
}