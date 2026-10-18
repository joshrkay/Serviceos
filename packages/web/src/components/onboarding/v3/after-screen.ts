import type { OnboardingStatusResponse, OnboardingStep, OnboardingStepId } from '../../../types/onboarding';

/**
 * Which turn the owner is on once "That's right" has gone through and the
 * saved choices are live. Derived from the same status the API computes
 * (onboarding/derive-status.ts: trial, then the number, then the voice
 * check, then the test call), so the screen can never run ahead of the facts.
 *
 * `getting_ready` is the pre-state of the test call: the voice check has no
 * screen of its own.
 */
export type AfterScreen = 'wait' | 'trial' | 'number' | 'getting_ready' | 'test_call';

export function afterScreen(status: OnboardingStatusResponse | null): AfterScreen {
  switch (status?.currentStep) {
    case 'billing':
      return 'trial';
    case 'phone':
      return 'number';
    case 'ai_check':
      return 'getting_ready';
    case 'test_call':
      return 'test_call';
    // signup, identity and pack are the saved choices going live; null is a finished setup (handed off).
    default:
      return 'wait';
  }
}

export function stepOf(status: OnboardingStatusResponse | null, id: OnboardingStepId): OnboardingStep | undefined {
  return status?.steps.find((s) => s.id === id);
}

/** The business number, once the API reports one on the phone step. */
export function phoneNumberOf(status: OnboardingStatusResponse | null): string | null {
  const value = stepOf(status, 'phone')?.metadata?.phoneNumber;
  return typeof value === 'string' && value.length > 0 ? value : null;
}
