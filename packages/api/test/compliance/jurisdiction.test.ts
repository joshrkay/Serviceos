import { describe, expect, it } from 'vitest';
import {
  quietHours,
  requires10dlcRegistration,
  requiresRecordingDisclosure,
  smsOptInLanguage,
  unsubscribeFooter,
} from '../../src/compliance/jurisdiction';

describe('requiresRecordingDisclosure', () => {
  it('returns true for all configured US two-party consent states', () => {
    const states = ['CA', 'FL', 'IL', 'MD', 'MA', 'MT', 'NV', 'NH', 'PA', 'WA'];

    for (const state of states) {
      expect(requiresRecordingDisclosure(state)).toBe(true);
    }
  });

  it('returns false for non-matching states and normalizes casing/whitespace', () => {
    expect(requiresRecordingDisclosure(' ny ')).toBe(false);
    expect(requiresRecordingDisclosure('tx')).toBe(false);
    expect(requiresRecordingDisclosure(' ca ')).toBe(true);
  });
});

describe('quietHours', () => {
  it('allows contact between 08:00 and before 21:00 in recipient local time', () => {
    const atStart = quietHours('America/Los_Angeles', new Date('2026-01-01T16:00:00Z')); // 08:00 PST
    const beforeEnd = quietHours('America/Los_Angeles', new Date('2026-01-02T04:59:00Z')); // 20:59 PST

    expect(atStart.allowedNow).toBe(true);
    expect(beforeEnd.allowedNow).toBe(true);
  });

  it('blocks contact before 08:00 and at/after 21:00 in recipient local time', () => {
    const beforeWindow = quietHours('America/New_York', new Date('2026-03-01T12:59:00Z')); // 07:59 EST
    const atWindowEnd = quietHours('America/New_York', new Date('2026-03-02T02:00:00Z')); // 21:00 EST

    expect(beforeWindow.allowedNow).toBe(false);
    expect(atWindowEnd.allowedNow).toBe(false);
    expect(atWindowEnd.quietHoursStart).toBe('21:00');
    expect(atWindowEnd.quietHoursEnd).toBe('08:00');
  });
});

describe('helper output contracts', () => {
  it('returns stable US v1 helper outputs', () => {
    expect(requires10dlcRegistration()).toBe(true);
    expect(smsOptInLanguage()).toContain('Reply STOP to unsubscribe');
    expect(unsubscribeFooter()).toContain('unsubscribe');
  });
});
