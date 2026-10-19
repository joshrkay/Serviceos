/**
 * PRIV-3 — the one card-number scrubber every store and provider path uses.
 *
 * Expected values are written out by hand from the card networks' published
 * test numbers (Luhn-valid by construction) and from the audit's probe
 * samples — never recomputed the way the scrubber computes them.
 */
import { describe, expect, it } from 'vitest';
import {
  CARD_NUMBER_PLACEHOLDER,
  containsCardNumber,
  redactCardNumbers,
} from '../../../src/ai/privacy/pan-redact';

describe('redactCardNumbers', () => {
  it('replaces a space-grouped 16-digit Visa test number (the audit trigger)', () => {
    expect(
      redactCardNumbers('can I just pay now — my card is 4111 1111 1111 1111, expires 09/27'),
    ).toBe('can I just pay now — my card is [card number], expires 09/27');
  });

  it('replaces an unspaced 16-digit number', () => {
    expect(redactCardNumbers('card 4111111111111111 thanks')).toBe('card [card number] thanks');
  });

  it('replaces a dash-grouped Mastercard test number', () => {
    expect(redactCardNumbers('it is 5555-5555-5555-4444')).toBe('it is [card number]');
  });

  it('replaces a 15-digit Amex test number grouped 4-6-5', () => {
    expect(redactCardNumbers('amex 3782 822463 10005 ok')).toBe('amex [card number] ok');
  });

  it('replaces a 13-digit Visa test number', () => {
    expect(redactCardNumbers('old card 4222222222222')).toBe('old card [card number]');
  });

  it('keeps the CVV that follows a grouped card number', () => {
    expect(redactCardNumbers('4111 1111 1111 1111 123')).toBe('[card number] 123');
  });

  it('replaces two cards in one utterance', () => {
    expect(redactCardNumbers('either 4111111111111111 or 5555 5555 5555 4444')).toBe(
      'either [card number] or [card number]',
    );
  });

  it('leaves a 16-digit run that fails the Luhn check untouched', () => {
    expect(redactCardNumbers('ref 4111 1111 1111 1112')).toBe('ref 4111 1111 1111 1112');
  });

  it('leaves phone numbers untouched', () => {
    expect(redactCardNumbers('call me at 6025550199 or +1 (602) 555-0199')).toBe(
      'call me at 6025550199 or +1 (602) 555-0199',
    );
  });

  // A phone number said straight before another number (a zip, a unit, a
  // second phone) is a 13–19 digit grouped run, and about one in ten of those
  // happens to pass the Luhn check. Without the phone-shape guard the stored
  // turn lost the callback number and the call's audio was deleted early.
  it('leaves a grouped phone number followed by a zip code untouched', () => {
    // 602 555 0199 85006 → 602555019985006 passes the Luhn check.
    expect(redactCardNumbers('call me at 602 555 0199 85006')).toBe('call me at 602 555 0199 85006');
    expect(redactCardNumbers('texted from 602-555-0199 85006')).toBe('texted from 602-555-0199 85006');
  });

  it('leaves an unspaced or country-coded phone number followed by more digits untouched', () => {
    expect(redactCardNumbers('my cell 6025550199 85006')).toBe('my cell 6025550199 85006');
    expect(redactCardNumbers('call 1 602 555 0199 85004')).toBe('call 1 602 555 0199 85004');
  });

  it('still replaces a card number said straight after a phone number', () => {
    expect(redactCardNumbers('602 555 0199 4111 1111 1111 1111')).toBe('602 555 0199 [card number]');
  });

  it('leaves integer cents and short codes untouched', () => {
    expect(redactCardNumbers('you owe 1234500 cents, gate code 4821')).toBe(
      'you owe 1234500 cents, gate code 4821',
    );
  });

  // Speech-to-text punctuates the pause between spoken digit groups: Twilio
  // Gather returns "4111, 1111, 1111, 1111." and there is no upstream
  // redaction on that path, so these must be caught here.
  it('replaces a card whose groups STT separated with commas', () => {
    expect(redactCardNumbers('my card is 4111, 1111, 1111, 1111.')).toBe('my card is [card number].');
  });

  it('replaces a card whose groups STT separated with periods', () => {
    expect(redactCardNumbers('4111. 1111. 1111. 1111')).toBe('[card number]');
  });

  it('replaces a card whose groups are separated by double spaces or spaced dashes', () => {
    expect(redactCardNumbers('card 4111  1111  1111  1111 ok')).toBe('card [card number] ok');
    expect(redactCardNumbers('card 5555 - 5555 - 5555 - 4444 ok')).toBe('card [card number] ok');
  });

  it('keeps the CVV and its comma after a comma-grouped card', () => {
    expect(redactCardNumbers('4111, 1111, 1111, 1111, 123')).toBe('[card number], 123');
  });

  it('leaves a comma-grouped run that fails the Luhn check untouched', () => {
    expect(redactCardNumbers('ref 4111, 1111, 1111, 1112.')).toBe('ref 4111, 1111, 1111, 1112.');
  });

  it('leaves a period-separated phone number followed by a zip untouched', () => {
    expect(redactCardNumbers('call 602.555.0199, 85006')).toBe('call 602.555.0199, 85006');
  });

  it('leaves digits that are part of a longer token untouched', () => {
    expect(redactCardNumbers('id ab4111111111111111cd')).toBe('id ab4111111111111111cd');
  });

  it("maps Deepgram's redaction tag for a card to the same marker", () => {
    expect(redactCardNumbers('my card is [CREDIT_CARD_1] expiring [CREDIT_CARD_EXPIRATION_1]')).toBe(
      'my card is [card number] expiring [CREDIT_CARD_EXPIRATION_1]',
    );
  });

  it('accepts a custom placeholder', () => {
    expect(redactCardNumbers('4111 1111 1111 1111', '[CARD_NUMBER]')).toBe('[CARD_NUMBER]');
  });
});

describe('containsCardNumber', () => {
  it('is true for text that carries the marker and false otherwise', () => {
    expect(CARD_NUMBER_PLACEHOLDER).toBe('[card number]');
    expect(containsCardNumber('caller: my card is [card number]')).toBe(true);
    expect(containsCardNumber('caller: what is my card number on file')).toBe(false);
  });
});
