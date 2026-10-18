import { describe, expect, it } from 'vitest';
import type { OnboardingStatusResponse, OnboardingStep, OnboardingStepId } from '../../../types/onboarding';
import { afterScreen, phoneNumberOf, stepOf } from './after-screen';

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
