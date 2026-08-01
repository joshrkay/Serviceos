import { Zap, Mic } from 'lucide-react';
import type { OnboardingStatusResponse, OnboardingStepId } from '../../../types/onboarding';

interface MobileProgressProps {
  status: OnboardingStatusResponse;
  activeId: OnboardingStepId;
  /** B1.19 — see Sidebar.tsx. The full Sidebar toggle is hidden at this
   *  breakpoint, so a compact icon-only equivalent lives here. */
  voiceAvailable?: boolean;
  voiceMode?: boolean;
  onToggleVoice?: () => void;
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
export function MobileProgress({
  status,
  activeId,
  voiceAvailable,
  voiceMode,
  onToggleVoice,
}: MobileProgressProps) {
  const completedCount = status.steps.filter(
    (s) => s.status === 'done' || s.status === 'skipped',
  ).length;
  const total = status.steps.length;
  const pct = Math.round((completedCount / total) * 100);

  return (
    <div className="md:hidden border-b border-slate-200 bg-white px-5 py-4">
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <span className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-slate-900">
            <Zap size={12} className="text-white" />
          </span>
          <span className="shrink-0 text-sm tracking-tight text-slate-900">Rivet</span>
        </div>
        <span className="min-w-0 truncate text-xs text-slate-500">
          Step {completedCount + 1} of {total} · {STEP_LABELS[activeId]}
        </span>
        {voiceAvailable && onToggleVoice && (
          <button
            type="button"
            onClick={onToggleVoice}
            aria-pressed={!!voiceMode}
            // Distinct wording from the Sidebar toggle's label (same
            // feature, different breakpoint) so tests targeting a role/name
            // aren't ambiguous when both are momentarily in the DOM.
            aria-label={voiceMode ? 'Talking it through (mic)' : 'Talk it through (mic)'}
            className={`flex size-11 shrink-0 items-center justify-center rounded-lg border transition ${
              voiceMode
                ? 'border-green-300 bg-green-50 text-green-700'
                : 'border-slate-200 bg-white text-slate-500'
            }`}
          >
            <Mic size={14} />
          </button>
        )}
      </div>
      <div className="mt-3 h-1 overflow-hidden rounded-full bg-slate-200">
        <div className="h-full bg-slate-900 transition-all" style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}
