import type { OnboardingStatusResponse, OnboardingStep, OnboardingStepId } from '../../../types/onboarding';
import type { AfterStage } from './pacing';

/**
 * Which turn the owner is on once "That's right" has gone through and the
 * saved choices are live. Derived from the same status the API computes
 * (onboarding/derive-status.ts: trial, then the number, then the voice
 * check, then the test call), so the screen can never run ahead of the facts.
 *
 * `getting_ready` is the pre-state of the test call: the voice check has no
 * screen of its own. `save_failed` and `save_stopped` stand in for the wait when
 * the status says a saved change will not go live by waiting: it failed (a retry
 * can fix it), or it was undone or rejected (nothing here can finish it).
 */
export type AfterScreen = 'wait' | 'save_failed' | 'save_stopped' | 'trial' | 'number' | 'getting_ready' | 'test_call';

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
      if (status?.draft?.execution === 'failed') return 'save_failed';
      if (status?.draft?.execution === 'stopped') return 'save_stopped';
      return 'wait';
  }
}

/** The header and progress stage for a screen: the voice getting ready is part of the test call, and a heard call is the end. */
export function afterStage(screen: AfterScreen, saving: boolean, heard: boolean): AfterStage {
  if (saving) return 'saving';
  switch (screen) {
    case 'wait':
    case 'save_failed':
    case 'save_stopped':
      return 'wait';
    case 'trial':
      return 'trial';
    case 'number':
      return 'number';
    case 'getting_ready':
      return 'test_call';
    case 'test_call':
      return heard ? 'open' : 'test_call';
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
