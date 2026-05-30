import React from 'react';
import { cn } from './utils';

export interface ProgressProps extends React.HTMLAttributes<HTMLDivElement> {
  /** Current value, 0–`max`. */
  value: number;
  max?: number;
  /** Bar color. Defaults to the neutral slate fill. */
  tone?: 'neutral' | 'success' | 'warning' | 'danger' | 'info';
  /** Accessible label for the progress bar. */
  label?: string;
}

const TONE_CLASSES: Record<NonNullable<ProgressProps['tone']>, string> = {
  neutral: 'bg-slate-900',
  success: 'bg-green-500',
  warning: 'bg-amber-500',
  danger: 'bg-red-500',
  info: 'bg-blue-500',
};

/**
 * Determinate progress bar — used for AI proposal confidence, status
 * progression, and quota meters. Token-driven so the fill color matches
 * the rest of the design system.
 */
export function Progress({
  value,
  max = 100,
  tone = 'neutral',
  label,
  className,
  ...rest
}: ProgressProps) {
  const pct = max <= 0 ? 0 : Math.min(100, Math.max(0, (value / max) * 100));
  return (
    <div
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={max}
      aria-valuenow={value}
      aria-label={label}
      className={cn('h-1.5 w-full overflow-hidden rounded-full bg-slate-100', className)}
      {...rest}
    >
      <div
        className={cn('h-full rounded-full transition-all', TONE_CLASSES[tone])}
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}
