import { useNavigate } from 'react-router';
import { Zap, Check } from 'lucide-react';
import type { OnboardingStatusResponse, OnboardingStepId, OnboardingStepStatus } from '../../../types/onboarding';

interface SidebarProps {
  status: OnboardingStatusResponse;
  activeId: OnboardingStepId;
  onSelect: (id: OnboardingStepId) => void;
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

function statusGlyph(status: OnboardingStepStatus, isActive: boolean): React.ReactNode {
  if (status === 'done' || status === 'skipped') {
    return (
      <span className="flex size-5 items-center justify-center rounded-full bg-emerald-100 text-emerald-700">
        <Check size={12} />
      </span>
    );
  }
  if (status === 'error') {
    return (
      <span className="flex size-5 items-center justify-center rounded-full bg-red-100 text-red-700 text-xs">
        !
      </span>
    );
  }
  if (isActive || status === 'current') {
    return <span className="size-2 rounded-full bg-slate-900" />;
  }
  return <span className="size-2 rounded-full border border-slate-300" />;
}

export function Sidebar({ status, activeId, onSelect }: SidebarProps) {
  const navigate = useNavigate();
  const completedCount = status.steps.filter(
    (s) => s.status === 'done' || s.status === 'skipped',
  ).length;
  const totalCount = status.steps.length;
  const pctComplete = Math.round((completedCount / totalCount) * 100);

  return (
    <nav
      aria-label="Onboarding steps"
      className="hidden md:flex w-72 shrink-0 flex-col border-r border-slate-200 bg-slate-50 p-6"
    >
      <div className="mb-8 flex items-center gap-2.5">
        <span className="flex size-8 items-center justify-center rounded-xl bg-slate-900">
          <Zap size={14} className="text-white" />
        </span>
        <span className="text-base tracking-tight text-slate-900">Rivet</span>
      </div>

      <div className="mb-4 text-xs uppercase tracking-widest text-slate-500">Setup</div>

      <ul className="space-y-1">
        {status.steps.map((step) => {
          const isActive = step.id === activeId;
          const isDone = step.status === 'done' || step.status === 'skipped';
          const isError = step.status === 'error';
          const tone = isActive
            ? 'bg-white text-slate-900 font-medium border-slate-200 shadow-sm'
            : isDone
              ? 'text-slate-700 hover:bg-slate-100 border-transparent'
              : isError
                ? 'text-red-700 hover:bg-slate-100 border-transparent'
                : 'text-slate-500 hover:bg-slate-100 border-transparent';
          // Identity and Pack determine downstream behavior (timezone,
          // hourly rate, AI prompts, job-type seed). Re-editing a
          // completed Identity / Pack step doesn't roll back the
          // Phone / Billing / AI-check artifacts the wizard already
          // produced, so a casual back-click can silently overwrite
          // saved values. A confirm() before navigating warns the
          // operator that we won't reset downstream setup for them.
          const requiresInvalidationWarning =
            isDone && !isActive && (step.id === 'identity' || step.id === 'pack');
          const handleClick = () => {
            if (
              requiresInvalidationWarning &&
              !window.confirm(
                step.id === 'identity'
                  ? 'Re-editing business identity will overwrite saved values when you save. Downstream setup (phone, billing, AI check) is not reset. Continue?'
                  : 'Re-picking your trade may add another pack to your tenant but will not reset the job types and templates the previous pack seeded. Continue?',
              )
            ) {
              return;
            }
            onSelect(step.id);
          };
          return (
            <li key={step.id}>
              <button
                type="button"
                onClick={handleClick}
                aria-current={isActive ? 'step' : undefined}
                className={`flex w-full items-center gap-3 rounded-xl border px-3 py-2 text-left text-sm transition ${tone}`}
              >
                <span className="flex w-5 justify-center">{statusGlyph(step.status, isActive)}</span>
                <span className="flex-1">{STEP_LABELS[step.id]}</span>
              </button>
            </li>
          );
        })}
      </ul>

      <div className="mt-6 border-t border-slate-200 pt-4">
        <div className="flex items-center justify-between text-xs text-slate-500">
          <span>{completedCount} of {totalCount} complete</span>
          <span>{pctComplete}%</span>
        </div>
        <div className="mt-2 h-1 rounded-full bg-slate-200 overflow-hidden">
          <div
            className="h-full bg-slate-900 transition-all"
            style={{ width: `${pctComplete}%` }}
          />
        </div>
      </div>

      {/* §10 Task 19 — optional polish steps. Only interactive once the
          mandatory checklist is complete. Both link to /settings rather
          than embedding the full forms here. */}
      <div className="mt-8 border-t border-slate-200 pt-4">
        <div className="mb-2 text-xs uppercase tracking-widest text-slate-500">
          Optional polish
        </div>
        <ul className="space-y-1">
          {(['terminology', 'automation'] as const).map((id) => {
            const enabled = status.isComplete;
            const label = id === 'terminology' ? 'Tune terminology' : 'Set automation rules';
            return (
              <li key={id}>
                <button
                  type="button"
                  disabled={!enabled}
                  onClick={() => navigate('/settings')}
                  className={`flex w-full items-center gap-3 rounded-xl px-3 py-2 text-left text-sm transition ${
                    enabled
                      ? 'text-slate-700 hover:bg-slate-100'
                      : 'text-slate-300 cursor-not-allowed'
                  }`}
                >
                  <span className="flex w-5 justify-center">
                    <span className="size-2 rounded-full border border-slate-300" />
                  </span>
                  <span className="flex-1">{label}</span>
                </button>
              </li>
            );
          })}
        </ul>
      </div>
    </nav>
  );
}
