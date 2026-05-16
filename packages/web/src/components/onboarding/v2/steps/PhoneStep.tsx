import type { OnboardingStatusResponse } from '../../../../types/onboarding';

interface PhoneStepProps {
  status: OnboardingStatusResponse;
  onAdvance: () => void;
}

export function PhoneStep(_props: PhoneStepProps) {
  return (
    <div className="text-slate-500">
      <h1 className="text-2xl font-bold text-slate-900 mb-2">Phone number</h1>
      <p>Provisioning status coming in Task 16.</p>
    </div>
  );
}
