import { Zap } from 'lucide-react';
import type { OnboardingStatusResponse, OnboardingStepId } from '../../../types/onboarding';

interface MobileProgressProps {
  status: OnboardingStatusResponse;
  activeId: OnboardingStepId;
}

const STEP_LABELS: Record<OnboardingStepId, string> = {
  signup: 'Sign up',
  identity: 'Business identity',
  pack: 'Pick your trade',
  phone: 'Phone number',
  billing: 'Start trial',
  ai_check: 'Verify AI',
  test_call: 'Test call',
};

/**
 * Compact horizontal progress strip shown above the main pane on
 * mobile (< md). The full vertical Sidebar is hidden at that
 * breakpoint to give form fields enough room to breathe.
 */
export function MobileProgress({ status, activeId }: MobileProgressProps) {
  const completedCount = status.steps.filter(
    (s) => s.status === 'done' || s.status === 'skipped',
  ).length;
  const total = status.steps.length;
  const pct = Math.round((completedCount / total) * 100);

  return (
    <div className="md:hidden border-b border-slate-200 bg-white px-5 py-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="flex size-7 items-center justify-center rounded-lg bg-slate-900">
            <Zap size={12} className="text-white" />
          </span>
          <span className="text-sm tracking-tight text-slate-900">Fieldly</span>
        </div>
        <span className="text-xs text-slate-500">
          Step {completedCount + 1} of {total} · {STEP_LABELS[activeId]}
        </span>
      </div>
      <div className="mt-3 h-1 overflow-hidden rounded-full bg-slate-200">
        <div className="h-full bg-slate-900 transition-all" style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}
