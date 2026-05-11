import { describe, it, expect } from 'vitest';
import {
  shouldImmediatelyDialOnEmergency,
  EMERGENCY_INTENTS,
} from '../../../src/ai/skills/escalate-to-human';

describe('P12-004 — shouldImmediatelyDialOnEmergency', () => {
  it('returns true for an emergency intent + unsupervised + telephony', () => {
    expect(
      shouldImmediatelyDialOnEmergency({
        intent: 'emergency_plumbing',
        supervisorPresent: false,
        channel: 'telephony',
      }),
    ).toBe(true);

    expect(
      shouldImmediatelyDialOnEmergency({
        intent: 'gas_leak',
        supervisorPresent: false,
        channel: 'telephony',
      }),
    ).toBe(true);

    expect(
      shouldImmediatelyDialOnEmergency({
        intent: 'no_heat',
        supervisorPresent: false,
        channel: 'telephony',
      }),
    ).toBe(true);
  });

  it('returns false for non-emergency intents regardless of presence/channel', () => {
    expect(
      shouldImmediatelyDialOnEmergency({
        intent: 'book_appointment',
        supervisorPresent: false,
        channel: 'telephony',
      }),
    ).toBe(false);

    expect(
      shouldImmediatelyDialOnEmergency({
        intent: 'lookup_balance',
        supervisorPresent: false,
        channel: 'telephony',
      }),
    ).toBe(false);
  });

  it('returns false when a supervisor is present (normal AI path proceeds)', () => {
    expect(
      shouldImmediatelyDialOnEmergency({
        intent: 'emergency_plumbing',
        supervisorPresent: true,
        channel: 'telephony',
      }),
    ).toBe(false);
  });

  it('returns false on in-app channel (no Twilio Dial available)', () => {
    expect(
      shouldImmediatelyDialOnEmergency({
        intent: 'emergency_plumbing',
        supervisorPresent: false,
        channel: 'inapp',
      }),
    ).toBe(false);
  });

  it('exposes the emergency intent set for callers to extend in tests', () => {
    expect(EMERGENCY_INTENTS.has('emergency_plumbing')).toBe(true);
    expect(EMERGENCY_INTENTS.has('emergency_hvac')).toBe(true);
    expect(EMERGENCY_INTENTS.has('book_appointment')).toBe(false);
  });
});
