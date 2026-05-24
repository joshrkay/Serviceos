import { useNavigate } from 'react-router';
import type { OnboardingStatusResponse, OnboardingStepId } from '../../../types/onboarding';

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

const ICON: Record<string, string> = {
  done: '✓',
  current: '→',
  pending: '○',
  error: '⚠',
  skipped: '✓',
};

export function Sidebar({ status, activeId, onSelect }: SidebarProps) {
  const navigate = useNavigate();
  const completedCount = status.steps.filter(
    (s) => s.status === 'done' || s.status === 'skipped',
  ).length;

  return (
    <nav className="w-72 shrink-0 border-r border-slate-200 bg-slate-50 p-6">
      <div className="text-xs uppercase tracking-wide text-slate-500 mb-4">
        Setup
      </div>
      <ul className="space-y-1">
        {status.steps.map((step) => {
          const isActive = step.id === activeId;
          const isDone = step.status === 'done' || step.status === 'skipped';
          const isError = step.status === 'error';
          const tone = isActive
            ? 'bg-blue-50 text-blue-700 font-semibold'
            : isDone
              ? 'text-emerald-700 hover:bg-slate-100'
              : isError
                ? 'text-red-700 hover:bg-slate-100'
                : 'text-slate-400 hover:bg-slate-100';
          return (
            <li key={step.id}>
              <button
                type="button"
                onClick={() => onSelect(step.id)}
                className={`w-full text-left px-3 py-2 rounded text-sm flex items-center gap-2 ${tone}`}
              >
                <span aria-hidden>{ICON[step.status] ?? '○'}</span>
                <span>{STEP_LABELS[step.id]}</span>
              </button>
            </li>
          );
        })}
      </ul>
      <div className="mt-6 pt-4 border-t border-slate-200 text-xs text-slate-500">
        {completedCount} of {status.steps.length} · keep going
      </div>

      {/* §10 Task 19 — optional polish steps. Only interactive once the
          mandatory checklist is complete. Both link to /settings rather
          than embedding the full forms here; a follow-up PR may relocate
          the existing 9-step wizard's terminology + automation-rules
          sub-flows into dedicated step components. */}
      <div className="mt-8 pt-4 border-t border-slate-200">
        <div className="text-xs uppercase tracking-wide text-slate-500 mb-2">
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
                  className={`w-full text-left px-3 py-2 rounded text-sm flex items-center gap-2 ${
                    enabled
                      ? 'text-slate-600 hover:bg-slate-100'
                      : 'text-slate-300 cursor-not-allowed'
                  }`}
                >
                  <span aria-hidden>○</span>
                  <span>{label}</span>
                </button>
              </li>
            );
          })}
        </ul>
      </div>
    </nav>
  );
}
