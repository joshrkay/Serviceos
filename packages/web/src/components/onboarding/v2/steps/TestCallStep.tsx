import type { OnboardingStatusResponse } from '../../../../types/onboarding';

interface TestCallStepProps {
  status: OnboardingStatusResponse;
  onSkipped: () => void;
}

export function TestCallStep(_props: TestCallStepProps) {
  return (
    <div className="text-slate-500">
      <h1 className="text-2xl font-bold text-slate-900 mb-2">Test call</h1>
      <p>Go-live moment coming in Task 17.</p>
    </div>
  );
}
