import { describe, expect, it } from 'vitest';
import type { OnboardingStep } from '../../../types/onboarding';
import { numberView, phoneBlockerCopy, phoneRetryErrorCopy } from './phone-copy';

const step = (over: Partial<OnboardingStep> & Pick<OnboardingStep, 'status'>): OnboardingStep => ({ id: 'phone', ...over });

describe('numberView', () => {
  it('has the number once the phone step carries one', () => {
    expect(numberView(step({ status: 'current', metadata: { phoneNumber: '+12165550180', lineState: 'active' } }))).toEqual({
      kind: 'ready',
      phoneNumber: '+12165550180',
    });
  });

  it('waits for the owner to ask for a number when the line is set up and none is claimed (the API buys no number until asked)', () => {
    expect(numberView(step({ status: 'current', metadata: { lineState: 'awaiting_pick' } }))).toEqual({ kind: 'pick' });
  });

  it('is getting the number while the line is being set up or a number is being claimed', () => {
    expect(numberView(step({ status: 'current' }))).toEqual({ kind: 'getting', pendingNumber: null });
    expect(numberView(step({ status: 'current', metadata: { lineState: 'setting_up' } }))).toEqual({ kind: 'getting', pendingNumber: null });
    expect(numberView(step({ status: 'current', metadata: { lineState: 'claiming' } }))).toEqual({ kind: 'getting', pendingNumber: null });
    expect(numberView(step({ status: 'current', metadata: { lineState: 'claiming', pendingNumber: '+12165550199' } }))).toEqual({
      kind: 'getting',
      pendingNumber: '+12165550199',
    });
    expect(numberView(undefined)).toEqual({ kind: 'getting', pendingNumber: null });
  });

  it('is an error, with the first blocker in the owner\'s words, when the step failed', () => {
    expect(numberView(step({ status: 'error', blockers: ['area_code_unavailable'] }))).toEqual({
      kind: 'error',
      message: phoneBlockerCopy(['area_code_unavailable']),
    });
    // An error wins over a number left from an earlier try.
    expect(numberView(step({ status: 'error', blockers: ['twilio_provisioning_failed'], metadata: { phoneNumber: '+12165550180' } })).kind).toBe('error');
  });
});

describe('phoneBlockerCopy', () => {
  const JARGON = /twilio|provision|environment|configur|_/i;

  it('maps each blocker the API (and the original number step) knows to a line an owner can act on', () => {
    expect(phoneBlockerCopy(['twilio_provisioning_failed'])).toBe("I couldn't get you a number this time. Try again and I'll look for another.");
    expect(phoneBlockerCopy(['twilio_credentials_missing'])).toBe("I can't set up phone numbers on your account yet. Please contact support.");
    expect(phoneBlockerCopy(['area_code_unavailable'])).toBe("There were no free numbers in your area code. Try again and I'll look in the next one.");
    expect(phoneBlockerCopy(['rate_limited'])).toBe("I've tried a few times already. Give it a minute, then try again.");
  });

  it('falls back to the common failure for no blocker, and to a plain line for one it has never heard of', () => {
    expect(phoneBlockerCopy(undefined)).toBe(phoneBlockerCopy(['twilio_provisioning_failed']));
    expect(phoneBlockerCopy([])).toBe(phoneBlockerCopy(['twilio_provisioning_failed']));
    expect(phoneBlockerCopy(['twilio_something_new'])).toBe('Something went wrong getting your number. Try again.');
  });

  it('never leaks a vendor, a mechanism or a code', () => {
    for (const blocker of ['twilio_provisioning_failed', 'twilio_credentials_missing', 'area_code_unavailable', 'rate_limited', 'twilio_other']) {
      expect(phoneBlockerCopy([blocker])).not.toMatch(JARGON);
    }
  });
});

describe('phoneRetryErrorCopy', () => {
  it('says the trial comes first when the API refuses a number before checkout', () => {
    expect(phoneRetryErrorCopy(409, 'PHONE_BILLING_REQUIRED')).toBe('Your trial has to start before I can get you a number.');
  });

  it('says it is already on it when a number is already being claimed', () => {
    expect(phoneRetryErrorCopy(409, 'PHONE_RETRY_NOT_ALLOWED')).toBe("I'm already working on your number. Give me a moment.");
  });

  it('maps the rest by status', () => {
    expect(phoneRetryErrorCopy(403)).toBe('Only the owner can do that.');
    expect(phoneRetryErrorCopy(503, 'ONBOARDING_NOT_CONFIGURED')).toBe("I can't get numbers right now. Try again in a minute, or contact support.");
    expect(phoneRetryErrorCopy(500, 'PHONE_RETRY_FAILED')).toBe("I couldn't do that just now. Wait a minute and try again.");
    expect(phoneRetryErrorCopy(418)).toBe("I couldn't do that just now. Try again.");
  });
});
