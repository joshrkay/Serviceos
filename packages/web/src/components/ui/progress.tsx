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
  neutral: 'bg-primary',
  success: 'bg-success',
  warning: 'bg-warning',
  danger: 'bg-destructive',
  info: 'bg-primary',
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
  const safeMax = max > 0 ? max : 0;
  const clampedValue = safeMax === 0 ? 0 : Math.min(safeMax, Math.max(0, value));
  const pct = safeMax === 0 ? 0 : (clampedValue / safeMax) * 100;
  return (
    <div
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={safeMax}
      // Report the clamped value so assistive tech never sees an
      // impossible state (e.g. now=150 with max=100).
      aria-valuenow={clampedValue}
      aria-label={label}
      className={cn('h-1.5 w-full overflow-hidden rounded-full bg-secondary', className)}
      {...rest}
    >
      <div
        className={cn('h-full rounded-full transition-all', TONE_CLASSES[tone])}
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}
