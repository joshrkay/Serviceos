import { describe, it, expect } from 'vitest';
import { shouldRecoverDroppedCall, isUsableE164 } from '../../../src/voice/recovery/detect-dropped';
import { extractContextCue, CONTEXT_CUE_MAX_CHARS } from '../../../src/voice/recovery/extract-context-cue';

const E164 = '+15551234567';

describe('P8-015 dropped-call detection', () => {
  it('arms recovery for a hangup-before-booking (dropped) inbound voice call', () => {
    expect(
      shouldRecoverDroppedCall({
        outcome: 'dropped',
        callerE164: E164,
        channel: 'voice_inbound',
      }),
    ).toBe(true);
  });

  it('arms recovery for an audio/system failure mid-call (failed)', () => {
    expect(
      shouldRecoverDroppedCall({
        outcome: 'failed',
        callerE164: E164,
        channel: 'telephony',
      }),
    ).toBe(true);
  });

  it('does NOT arm recovery for a successful booking (completed)', () => {
    expect(
      shouldRecoverDroppedCall({
        outcome: 'completed',
        callerE164: E164,
        channel: 'voice_inbound',
      }),
    ).toBe(false);
  });

  it('does NOT arm recovery for an owner transfer (escalated_to_human)', () => {
    expect(
      shouldRecoverDroppedCall({
        outcome: 'escalated_to_human',
        callerE164: E164,
        channel: 'voice_inbound',
      }),
    ).toBe(false);
  });

  it('does NOT arm recovery for no_intent or callback_required', () => {
    expect(
      shouldRecoverDroppedCall({ outcome: 'no_intent', callerE164: E164, channel: 'voice_inbound' }),
    ).toBe(false);
    expect(
      shouldRecoverDroppedCall({
        outcome: 'callback_required',
        callerE164: E164,
        channel: 'voice_inbound',
      }),
    ).toBe(false);
  });

  it('does NOT arm recovery for SMS- or webchat-initiated sessions (non-goal)', () => {
    expect(
      shouldRecoverDroppedCall({ outcome: 'dropped', callerE164: E164, channel: 'sms' }),
    ).toBe(false);
    expect(
      shouldRecoverDroppedCall({ outcome: 'dropped', callerE164: E164, channel: 'webchat' }),
    ).toBe(false);
  });

  it('does NOT arm recovery without a usable caller id', () => {
    expect(
      shouldRecoverDroppedCall({ outcome: 'dropped', callerE164: undefined, channel: 'voice_inbound' }),
    ).toBe(false);
    expect(
      shouldRecoverDroppedCall({ outcome: 'dropped', callerE164: '123', channel: 'voice_inbound' }),
    ).toBe(false);
  });

  it('isUsableE164 accepts >=7 digit numbers with or without +', () => {
    expect(isUsableE164('+15551234567')).toBe(true);
    expect(isUsableE164('5551234567')).toBe(true);
    expect(isUsableE164('555')).toBe(false);
    expect(isUsableE164(undefined)).toBe(false);
  });
});

describe('P8-015 recovery context cue (PII-safe)', () => {
  it('includes a curated cue when a known top intent is present', () => {
    expect(extractContextCue('ac_repair')).toBe(
      'Sounds like you were calling about your AC',
    );
  });

  it('normalizes slug separators / casing before lookup', () => {
    expect(extractContextCue('AC-Repair')).toBe(
      'Sounds like you were calling about your AC',
    );
    expect(extractContextCue('Schedule Appointment')).toBe(
      'Sounds like you were calling to book an appointment',
    );
  });

  it('returns empty (generic message) when there is no transcript / intent', () => {
    expect(extractContextCue(undefined)).toBe('');
    expect(extractContextCue('')).toBe('');
    expect(extractContextCue('   ')).toBe('');
  });

  it('returns empty for an unknown intent — never echoes a raw classifier label (no PII leak)', () => {
    expect(extractContextCue('caller_said_my_card_is_4111111111111111')).toBe('');
    expect(extractContextCue('+15551234567')).toBe('');
    expect(extractContextCue('random_unmapped_intent')).toBe('');
  });

  it('never exceeds the cue character cap', () => {
    for (const intent of ['ac_repair', 'hvac', 'plumbing', 'estimate']) {
      expect(extractContextCue(intent).length).toBeLessThanOrEqual(CONTEXT_CUE_MAX_CHARS);
    }
  });
});
