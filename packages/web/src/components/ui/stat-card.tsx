import React from 'react';
import { cn } from './utils';

export type StatTone = 'neutral' | 'success' | 'warning' | 'danger' | 'info';

const TONE_ICON_CLASSES: Record<StatTone, string> = {
  neutral: 'bg-secondary text-muted-foreground',
  success: 'bg-success/10 text-success',
  warning: 'bg-warning/10 text-warning',
  danger: 'bg-destructive/10 text-destructive',
  info: 'bg-primary/10 text-primary',
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
        'flex items-start gap-3 rounded-2xl border border-border bg-card p-4',
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
        <p className="text-xs font-medium text-muted-foreground">{label}</p>
        <p className="mt-0.5 text-xl font-semibold tabular-nums text-foreground">
          {value}
        </p>
        {hint && <p className="mt-0.5 text-xs text-muted-foreground">{hint}</p>}
      </div>
    </div>
  );
}
