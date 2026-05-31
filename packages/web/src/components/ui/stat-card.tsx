import React from 'react';
import { cn } from './utils';

export type StatTone = 'neutral' | 'success' | 'warning' | 'danger' | 'info';

const TONE_ICON_CLASSES: Record<StatTone, string> = {
  neutral: 'bg-slate-100 text-slate-500',
  success: 'bg-green-50 text-green-600',
  warning: 'bg-amber-50 text-amber-600',
  danger: 'bg-red-50 text-red-600',
  info: 'bg-blue-50 text-blue-600',
};

export interface StatCardProps extends React.HTMLAttributes<HTMLDivElement> {
  /** Short label, e.g. "Active today". */
  label: React.ReactNode;
  /** The headline number/amount. */
  value: React.ReactNode;
  /** Optional supporting detail under the value. */
  hint?: React.ReactNode;
  /** Optional leading icon. */
  icon?: React.ReactNode;
  tone?: StatTone;
}

/**
 * A single "pulse" metric tile for the attention-first Home. Calm by
 * default — tone only tints the icon chip, keeping the surface restrained
 * per the design vision.
 */
export function StatCard({
  label,
  value,
  hint,
  icon,
  tone = 'neutral',
  className,
  ...rest
}: StatCardProps) {
  return (
    <div
      className={cn(
        'flex items-start gap-3 rounded-2xl border border-slate-200 bg-white p-4',
        className,
      )}
      {...rest}
    >
      {icon && (
        <span
          className={cn(
            'flex size-9 shrink-0 items-center justify-center rounded-xl',
            TONE_ICON_CLASSES[tone],
          )}
        >
          {icon}
        </span>
      )}
      <div className="min-w-0">
        <p className="text-xs font-medium text-slate-500">{label}</p>
        <p className="mt-0.5 text-xl font-semibold tabular-nums text-slate-900">
          {value}
        </p>
        {hint && <p className="mt-0.5 text-xs text-slate-400">{hint}</p>}
      </div>
    </div>
  );
}
