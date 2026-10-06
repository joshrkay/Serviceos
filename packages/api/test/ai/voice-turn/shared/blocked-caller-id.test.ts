/**
 * #1601 step 2 — `isBlockedCallerId` has ONE home.
 *
 * P18-001 defined it in `telephony/twilio-adapter.ts`; #962 re-implemented it
 * verbatim inside `create-voice-turn-processor.ts` to avoid a circular
 * import. Both transports must agree on which Twilio `From` values mean "the
 * caller withheld their number" — the P18-001 list, case- and
 * whitespace-insensitive — and on the one asymmetry that matters: a MISSING
 * value is not a withheld one (the caller is prompted for a callback instead
 * of being assumed to have hidden it).
 */
import { describe, it, expect } from 'vitest';
import { isBlockedCallerId } from '../../../../src/ai/voice-turn/shared/blocked-caller-id';

describe('isBlockedCallerId (shared)', () => {
  it.each(['restricted', 'private', 'blocked', 'unknown', 'anonymous', 'unavailable'])(
    'recognises the Twilio withheld-caller literal %j',
    (literal) => {
      expect(isBlockedCallerId(literal)).toBe(true);
    },
  );

  it('is case- and whitespace-insensitive (Twilio has sent "Anonymous" and " RESTRICTED ")', () => {
    expect(isBlockedCallerId('Anonymous')).toBe(true);
    expect(isBlockedCallerId(' RESTRICTED ')).toBe(true);
  });

  it('a missing or empty value is NOT withheld — the caller gets prompted for a callback instead', () => {
    expect(isBlockedCallerId(undefined)).toBe(false);
    expect(isBlockedCallerId('')).toBe(false);
    expect(isBlockedCallerId('   ')).toBe(false);
  });

  it('a real number is never withheld', () => {
    expect(isBlockedCallerId('+15125550199')).toBe(false);
  });
});
