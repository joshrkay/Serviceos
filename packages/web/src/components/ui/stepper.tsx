import React from 'react';
import { Check } from 'lucide-react';
import { cn } from './utils';

export interface StepperStep {
  /** Stable identifier. */
  value: string;
  label: React.ReactNode;
}

export interface StepperProps {
  steps: StepperStep[];
  /** Value of the step currently in progress. */
  current: string;
  className?: string;
}

/**
 * Horizontal progress indicator for staged flows (estimate → invoice →
 * paid, job lifecycle). Steps before the current one render as complete;
 * the current one is highlighted; later steps are muted.
 */
export function Stepper({ steps, current, className }: StepperProps) {
  // -1 when `current` isn't among the steps (flow not started / unknown);
  // in that case nothing is marked complete or active rather than wrongly
  // highlighting the first step.
  const currentIndex = steps.findIndex((s) => s.value === current);

  return (
    <ol className={cn('flex items-center', className)}>
      {steps.map((step, index) => {
        const complete = index < currentIndex;
        const active = index === currentIndex;
        const isLast = index === steps.length - 1;
        return (
          <li
            key={step.value}
            className={cn('flex items-center', !isLast && 'flex-1')}
            aria-current={active ? 'step' : undefined}
          >
            <div className="flex items-center gap-2">
              <span
                className={cn(
                  'flex size-6 shrink-0 items-center justify-center rounded-full text-xs font-medium',
                  complete && 'bg-primary text-primary-foreground',
                  active && 'border-2 border-primary bg-card text-foreground',
                  !complete && !active && 'border border-border bg-card text-muted-foreground',
                )}
              >
                {complete ? <Check size={14} /> : index + 1}
              </span>
              <span
                className={cn(
                  'whitespace-nowrap text-sm',
                  active ? 'font-medium text-foreground' : 'text-muted-foreground',
                )}
              >
                {step.label}
              </span>
            </div>
            {!isLast && (
              <span
                aria-hidden="true"
                className={cn(
                  'mx-3 h-px flex-1',
                  complete ? 'bg-primary' : 'bg-border',
                )}
              />
            )}
          </li>
        );
      })}
    </ol>
  );
}
