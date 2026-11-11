/**
 * On-call booking confirmation vs SMS consent — the spoken copy, in both
 * languages. The ask is a fixed question; the no-promise line interpolates the
 * readback time. Neither the English nor the Spanish line may promise a text:
 * they are spoken exactly when the customer-SMS gate would suppress one.
 *
 * Value: protects=the consent question and the no-text-promise booked line exist in English and Spanish and never promise a text;
 *   fails_when=either id is dropped, the Spanish side falls back to English, or the no-promise line gains a text/confirmation promise;
 *   why_new=the copy is new with the booking consent ask;
 *   seam=none;
 *   no_claim=when each line is chosen (inbound-booking-sms-consent.test.ts)
 */
import { describe, it, expect } from 'vitest';
import { ttsCopy } from '../../../../src/ai/agents/customer-calling/tts-copy';
import {
  spokenBookedWithoutTextPromise,
  spokenBookingConsentAsk,
} from '../../../../src/ai/voice-turn/inbound-booking-completion';

const WHEN = 'Tuesday, November 17 at 2:00 PM';

describe('booking SMS-consent copy', () => {
  it('asks in English', () => {
    expect(ttsCopy('booking_sms_consent_ask', 'en')).toBe(
      "Okay to text your confirmation to the number you're calling from?",
    );
    expect(spokenBookingConsentAsk('en')).toBe(ttsCopy('booking_sms_consent_ask', 'en'));
  });

  it('asks in Spanish', () => {
    const es = ttsCopy('booking_sms_consent_ask', 'es');
    expect(es).toBe(
      '¿Le parece bien que le enviemos la confirmación por mensaje de texto al número desde el que llama?',
    );
    expect(es).not.toBe(ttsCopy('booking_sms_consent_ask', 'en'));
    expect(spokenBookingConsentAsk('es')).toBe(es);
  });

  it('says it is booked, with no text promise, in English', () => {
    const en = ttsCopy('booking_confirmed_no_text', 'en', { time: WHEN });
    expect(en).toBe(`You're booked for ${WHEN}.`);
    expect(en).not.toMatch(/text|confirmation/i);
    expect(spokenBookedWithoutTextPromise(WHEN, 'en')).toBe(en);
  });

  it('says it is booked, with no text promise, in Spanish', () => {
    const es = ttsCopy('booking_confirmed_no_text', 'es', { time: WHEN });
    expect(es).toBe(`Su cita está reservada para ${WHEN}.`);
    expect(es).not.toMatch(/texto|mensaje|confirmaci/i);
    expect(spokenBookedWithoutTextPromise(WHEN, 'es')).toBe(es);
  });

  it('defaults to English', () => {
    expect(spokenBookingConsentAsk()).toBe(ttsCopy('booking_sms_consent_ask', 'en'));
    expect(spokenBookedWithoutTextPromise(WHEN)).toBe(`You're booked for ${WHEN}.`);
  });
});
