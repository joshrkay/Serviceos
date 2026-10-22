/**
 * D-045 — a send with no channel named goes by text first: the one rule the
 * approval check and the send share (`defaultSendChannel`).
 */
import { describe, it, expect } from 'vitest';
import { defaultSendChannel } from '../../src/notifications/send-service';

const PHONE = '+15125550100';
const EMAIL = 'riley@example.com';

describe('defaultSendChannel (D-045 text first)', () => {
  it('a customer who agreed to texts and has a phone gets a text, even with an email on file', () => {
    expect(defaultSendChannel({ primaryPhone: PHONE, email: EMAIL, smsConsent: true })).toBe('sms');
      });

  it('no text consent goes to the email on file', () => {
    expect(defaultSendChannel({ primaryPhone: PHONE, email: EMAIL, smsConsent: false })).toBe('email');
    expect(defaultSendChannel({ primaryPhone: PHONE, email: EMAIL })).toBe('email');
  });

  it('an opt-out is left to the gate, which reads the current ledger (a START after a STOP re-opts in)', () => {
    // consentStatus stays 'revoked' after START, so it is not read here; a
    // standing opt-out is refused at the gate and the send falls back to email.
    expect(defaultSendChannel({ primaryPhone: PHONE, email: EMAIL, smsConsent: true })).toBe('sms');
  });

  it('no email to fall back to: the phone on file, so the gate names why a text cannot go', () => {
    expect(defaultSendChannel({ primaryPhone: PHONE, smsConsent: false })).toBe('sms');
  });

  it('blank values count as nothing on file', () => {
    expect(defaultSendChannel({ primaryPhone: '  ', email: EMAIL, smsConsent: true })).toBe('email');
    expect(defaultSendChannel({ primaryPhone: '', email: ' ' })).toBeUndefined();
    expect(defaultSendChannel({})).toBeUndefined();
  });
});
