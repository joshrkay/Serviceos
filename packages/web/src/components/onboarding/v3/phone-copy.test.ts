import { describe, expect, it } from 'vitest';
import type { OnboardingStep } from '../../../types/onboarding';
import { emptyAreaCodeLine, failureAction, numberSearchErrorCopy, numberView, phoneBlockerCopy, phoneRetryErrorCopy, TAKEN_OFFER } from './phone-copy';

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

  it('is an error carrying the failure code and that code\'s line when the step failed', () => {
    expect(numberView(step({ status: 'error', failureCode: 'area_code_unavailable', blockers: ['area_code_unavailable', 'twilio_provisioning_failed'] }))).toEqual({
      kind: 'error',
      code: 'area_code_unavailable',
      message: "There were no free numbers where I looked. Pick a different area code and I'll look there.",
    });
    // An error wins over a number left from an earlier try.
    expect(numberView(step({ status: 'error', failureCode: 'unknown', blockers: ['twilio_provisioning_failed'], metadata: { phoneNumber: '+12165550180' } })).kind).toBe('error');
  });

  it('has no code for an older server that sends only blockers, and says the first blocker\'s line', () => {
    expect(numberView(step({ status: 'error', blockers: ['area_code_unavailable'] }))).toEqual({
      kind: 'error',
      code: null,
      message: "There were no free numbers in your area code. Try again and I'll look in the next one.",
    });
  });
});

describe('phoneBlockerCopy', () => {
  const JARGON = /twilio|provision|environment|configur|credential|_/i;

  it('says each failure code in the owner\'s words, whatever the blockers say', () => {
    const blockers = ['twilio_provisioning_failed'];
    expect(phoneBlockerCopy('area_code_unavailable', blockers)).toBe(
      "There were no free numbers where I looked. Pick a different area code and I'll look there.",
    );
    expect(phoneBlockerCopy('credentials_missing', blockers)).toBe("That's on our side, not yours. Please contact support and we'll sort it out.");
    expect(phoneBlockerCopy('provider_error', blockers)).toBe("I couldn't reach the phone company just now. Try again in a minute.");
    expect(phoneBlockerCopy('unknown', blockers)).toBe('Something went wrong getting your number. Try again.');
  });

  it('falls back to the first blocker when an older server sends no code', () => {
    expect(phoneBlockerCopy(undefined, ['twilio_provisioning_failed'])).toBe("I couldn't get you a number this time. Try again and I'll look for another.");
    expect(phoneBlockerCopy(undefined, ['twilio_credentials_missing'])).toBe("I can't set up phone numbers on your account yet. Please contact support.");
    expect(phoneBlockerCopy(undefined, ['area_code_unavailable'])).toBe("There were no free numbers in your area code. Try again and I'll look in the next one.");
    expect(phoneBlockerCopy(undefined, ['rate_limited'])).toBe("I've tried a few times already. Give it a minute, then try again.");
  });

  it('falls back to the common failure for no blocker, and to a plain line for one it has never heard of', () => {
    expect(phoneBlockerCopy(undefined, undefined)).toBe(phoneBlockerCopy(undefined, ['twilio_provisioning_failed']));
    expect(phoneBlockerCopy(undefined, [])).toBe(phoneBlockerCopy(undefined, ['twilio_provisioning_failed']));
    expect(phoneBlockerCopy(undefined, ['twilio_something_new'])).toBe('Something went wrong getting your number. Try again.');
  });

  it('never leaks a vendor, a mechanism or a code', () => {
    for (const code of ['area_code_unavailable', 'credentials_missing', 'provider_error', 'unknown'] as const) {
      expect(phoneBlockerCopy(code, undefined)).not.toMatch(JARGON);
    }
    for (const blocker of ['twilio_provisioning_failed', 'twilio_credentials_missing', 'area_code_unavailable', 'rate_limited', 'twilio_other']) {
      expect(phoneBlockerCopy(undefined, [blocker])).not.toMatch(JARGON);
    }
  });

  it('promises no message to anyone: the owner is pointed at support', () => {
    expect(phoneBlockerCopy('credentials_missing', undefined)).not.toMatch(/been told|we know|notified/i);
  });
});

describe('failureAction', () => {
  it('re-searches only for a taken number or an area with nothing free', () => {
    expect(failureAction('area_code_unavailable')).toBe('area_code');
  });

  it('offers nothing to tap for a problem on our side', () => {
    expect(failureAction('credentials_missing')).toBe('none');
  });

  it('offers one Try again for the rest, and for an older server with no code', () => {
    expect(failureAction('provider_error')).toBe('try_again');
    expect(failureAction('unknown')).toBe('try_again');
    expect(failureAction(null)).toBe('try_again');
  });
});

describe('the area-code search lines', () => {
  it('says the next number is a replacement when the last one was taken', () => {
    expect(TAKEN_OFFER).toBe("That one just went. Here's another.");
  });

  it('names the area code that came back empty', () => {
    expect(emptyAreaCodeLine('216')).toBe('There are no free numbers in 216 right now. Try one nearby.');
  });

  it('says why a search did not work, without the vendor or the status code', () => {
    expect(numberSearchErrorCopy(503, 'TWILIO_NOT_CONFIGURED')).toBe("I can't look up numbers right now. Try again in a minute, or contact support.");
    expect(numberSearchErrorCopy(400, 'INVALID_AREA_CODE')).toBe('An area code is three digits, like 216.');
    expect(numberSearchErrorCopy(502, 'PHONE_SEARCH_FAILED')).toBe("I couldn't look up numbers just now. Try again.");
    expect(numberSearchErrorCopy(500)).toBe("I couldn't look up numbers just now. Try again.");
    for (const [status, code] of [[503, 'TWILIO_NOT_CONFIGURED'], [502, 'PHONE_SEARCH_FAILED']] as const) {
      expect(numberSearchErrorCopy(status, code)).not.toMatch(/twilio|_|\d{3}/i);
    }
  });
});

describe('phoneRetryErrorCopy', () => {
  it('says the trial comes first when the API refuses a number before checkout', () => {
    expect(phoneRetryErrorCopy(409, 'PHONE_BILLING_REQUIRED')).toBe('Your trial has to start before I can get you a number.');
  });

  it('says it is already on it when a number is already being claimed', () => {
    expect(phoneRetryErrorCopy(409, 'PHONE_RETRY_NOT_ALLOWED')).toBe("I'm already working on your number. Give me a moment.");
    // The claim route's own word for the same thing.
    expect(phoneRetryErrorCopy(409, 'PHONE_CLAIM_NOT_ALLOWED')).toBe("I'm already working on your number. Give me a moment.");
  });

  it('maps the rest by status', () => {
    expect(phoneRetryErrorCopy(403)).toBe('Only the owner can do that.');
    expect(phoneRetryErrorCopy(503, 'ONBOARDING_NOT_CONFIGURED')).toBe("I can't get numbers right now. Try again in a minute, or contact support.");
    expect(phoneRetryErrorCopy(500, 'PHONE_RETRY_FAILED')).toBe("I couldn't do that just now. Wait a minute and try again.");
    expect(phoneRetryErrorCopy(418)).toBe("I couldn't do that just now. Try again.");
  });
});
