import { describe, expect, it } from 'vitest';
import type { OnboardingDraftExecution, OnboardingStatusResponse, OnboardingStep, OnboardingStepId } from '../../../types/onboarding';
import { afterScreen, afterStage, phoneNumberOf, stepOf } from './after-screen';

function status(currentStep: OnboardingStepId | null, steps: OnboardingStep[] = []): OnboardingStatusResponse {
  return { steps, currentStep, isComplete: currentStep === null, voiceAgentLive: false, tenantId: 't', subscriptionStatus: null };
}

describe('afterScreen', () => {
  it('waits while the saved choices go live, and before the first status has arrived', () => {
    expect(afterScreen(null)).toBe('wait');
    expect(afterScreen(status('signup'))).toBe('wait');
    expect(afterScreen(status('identity'))).toBe('wait');
    expect(afterScreen(status('pack'))).toBe('wait');
  });

  it('follows the order the API derives once the choices are live: trial, number, getting ready, test call', () => {
    expect(afterScreen(status('billing'))).toBe('trial');
    expect(afterScreen(status('phone'))).toBe('number');
    expect(afterScreen(status('ai_check'))).toBe('getting_ready');
    expect(afterScreen(status('test_call'))).toBe('test_call');
  });

  it('has nothing to show for a finished setup, which the shell hands off', () => {
    expect(afterScreen(status(null))).toBe('wait');
  });

  describe('when a saved change did not go live', () => {
    const withExecution = (currentStep: OnboardingStepId | null, execution: OnboardingDraftExecution | null | undefined): OnboardingStatusResponse => ({
      ...status(currentStep),
      draft: { status: 'approved', choicesAnswered: 7, version: 2, ...(execution === undefined ? {} : { execution }) },
    });

    it('says so instead of waiting when the save failed, and when it can never finish', () => {
      expect(afterScreen(withExecution('identity', 'failed'))).toBe('save_failed');
      expect(afterScreen(withExecution('pack', 'stopped'))).toBe('save_stopped');
    });

    it('keeps waiting while the changes are queued or running, or the status says nothing about them', () => {
      for (const execution of ['pending', 'executing', 'executed', null, undefined] as const) {
        expect(afterScreen(withExecution('identity', execution)), String(execution)).toBe('wait');
      }
      expect(afterScreen({ ...status('identity') })).toBe('wait');
    });

    it('only replaces the wait: once the setup has moved past the saved choices, its own screen wins', () => {
      expect(afterScreen(withExecution('billing', 'failed'))).toBe('trial');
      expect(afterScreen(withExecution('phone', 'stopped'))).toBe('number');
    });
  });
});

describe('stepOf and phoneNumberOf', () => {
  const steps: OnboardingStep[] = [
    { id: 'phone', status: 'current', metadata: { phoneNumber: '+12165550180', lineState: 'active' } },
    { id: 'test_call', status: 'pending' },
  ];

  it('finds a step by id', () => {
    expect(stepOf(status('phone', steps), 'phone')?.status).toBe('current');
    expect(stepOf(status('phone', steps), 'billing')).toBeUndefined();
    expect(stepOf(null, 'phone')).toBeUndefined();
  });

  it('reads the number from the phone step, only when it is a non-empty string', () => {
    expect(phoneNumberOf(status('phone', steps))).toBe('+12165550180');
    expect(phoneNumberOf(status('phone', [{ id: 'phone', status: 'current' }]))).toBeNull();
    expect(phoneNumberOf(status('phone', [{ id: 'phone', status: 'current', metadata: { phoneNumber: '' } }]))).toBeNull();
    expect(phoneNumberOf(status('phone', [{ id: 'phone', status: 'current', metadata: { phoneNumber: 5551234 } }]))).toBeNull();
    expect(phoneNumberOf(null)).toBeNull();
  });
});

describe('afterStage', () => {
  it('is saving for as long as the undo window is open, whichever screen the status would show', () => {
    for (const screen of ['wait', 'trial', 'number', 'getting_ready', 'test_call'] as const) {
      expect(afterStage(screen, true, false)).toBe('saving');
    }
  });

  it('gives each screen its place in the header, with the voice getting ready counted as the test call', () => {
    expect(afterStage('wait', false, false)).toBe('wait');
    expect(afterStage('save_failed', false, false)).toBe('wait');
    expect(afterStage('save_stopped', false, false)).toBe('wait');
    expect(afterStage('trial', false, false)).toBe('trial');
    expect(afterStage('number', false, false)).toBe('number');
    expect(afterStage('getting_ready', false, false)).toBe('test_call');
    expect(afterStage('test_call', false, false)).toBe('test_call');
  });

  it('is open once the call was heard', () => {
    expect(afterStage('test_call', false, true)).toBe('open');
  });
});
