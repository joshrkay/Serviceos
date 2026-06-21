import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { ArrowRight, ArrowLeft } from 'lucide-react';
import { Modal } from '../ui/modal';
import { Button } from '../ui/button';
import { track } from '../../lib/analytics';

export interface WalkStep {
  /** Stable id for analytics (e.g. "answers-calls"). */
  id: string;
  icon: ReactNode;
  title: string;
  body: string;
}

export interface WalkthroughProps {
  open: boolean;
  steps: WalkStep[];
  /** Identifies the tour in analytics (e.g. "welcome", "whats_new"). */
  tourId: string;
  /** Fired when the user finishes the last step. */
  onComplete: () => void;
  /** Fired when the user closes early (X / backdrop / Escape). */
  onDismiss: () => void;
}

/**
 * Shared multi-step dialog powering both the new-account welcome tour and the
 * what's-new changelog. Presentational + analytics only — the surfaces decide
 * when it opens and persist "seen". Built on the canonical ui/Modal (portal,
 * focus-trap, Escape/backdrop dismissal); CTAs are lg buttons (≥44px).
 */
export function Walkthrough({ open, steps, tourId, onComplete, onDismiss }: WalkthroughProps) {
  const [index, setIndex] = useState(0);
  const startedRef = useRef(false);

  // Reset to the first step each time the tour (re)opens.
  useEffect(() => {
    if (open) {
      setIndex(0);
      if (!startedRef.current) {
        startedRef.current = true;
        track('tour_started', { tourId, steps: steps.length });
      }
    } else {
      startedRef.current = false;
    }
  }, [open, tourId, steps.length]);

  const step = steps[index];

  // Track each step as it becomes visible.
  useEffect(() => {
    if (open && step) {
      track('tour_step_viewed', { tourId, stepId: step.id, stepIndex: index });
    }
  }, [open, tourId, step, index]);

  if (!open || !step) return null;

  const isFirst = index === 0;
  const isLast = index === steps.length - 1;

  function next() {
    if (isLast) {
      track('tour_completed', { tourId, steps: steps.length });
      onComplete();
      return;
    }
    setIndex((i) => Math.min(i + 1, steps.length - 1));
  }

  function back() {
    setIndex((i) => Math.max(i - 1, 0));
  }

  function dismiss() {
    track('tour_dismissed', { tourId, stepIndex: index });
    onDismiss();
  }

  return (
    <Modal open={open} onClose={dismiss} size="md">
      <div className="flex flex-col items-center px-2 pb-2 pt-4 text-center">
        <div className="flex size-12 items-center justify-center rounded-2xl bg-slate-900 text-white">
          {step.icon}
        </div>
        <h2 className="mt-5 text-lg font-semibold text-slate-900">{step.title}</h2>
        <p className="mt-2 max-w-sm text-sm leading-relaxed text-slate-600">{step.body}</p>

        {/* Progress dots */}
        <div className="mt-6 flex items-center justify-center gap-2" aria-hidden="true">
          {steps.map((s, i) => (
            <span
              key={s.id}
              className={
                'h-1.5 rounded-full transition-all ' +
                (i === index ? 'w-5 bg-slate-900' : 'w-1.5 bg-slate-200')
              }
            />
          ))}
        </div>

        <div className="mt-7 flex w-full items-center justify-between gap-3">
          {isFirst ? (
            <Button variant="ghost" size="lg" onClick={dismiss}>
              Skip
            </Button>
          ) : (
            <Button variant="ghost" size="lg" onClick={back} leftIcon={<ArrowLeft size={16} />}>
              Back
            </Button>
          )}
          <Button
            variant="primary"
            size="lg"
            onClick={next}
            rightIcon={!isLast ? <ArrowRight size={16} /> : undefined}
          >
            {isLast ? 'Get started' : 'Next'}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
