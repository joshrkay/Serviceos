import { useState } from 'react';
import type { OnboardingStepStatus } from '../../../types/onboarding';

/**
 * The test call is "heard" when the step is seen to go from waiting to done
 * while the owner is looking. A step that is already done the first time it is
 * seen is a resumed visit, not an arrival: nothing is replayed.
 */
export function callArrived(previous: OnboardingStepStatus | null, current: OnboardingStepStatus | null): boolean {
  return previous !== null && previous !== 'done' && current === 'done';
}

/**
 * True from the render that sees the test call arrive, for the rest of the
 * visit. The flip is worked out while rendering (not in an effect), so the
 * shell already knows when the same poll also says setup is complete, and it
 * keeps the owner on the call's last screen instead of handing off.
 */
export function useTestCallArrival(current: OnboardingStepStatus | null): boolean {
  const [previous, setPrevious] = useState<OnboardingStepStatus | null>(null);
  const [arrived, setArrived] = useState(false);
  if (current !== previous) {
    setPrevious(current);
    if (callArrived(previous, current)) setArrived(true);
  }
  return arrived;
}
