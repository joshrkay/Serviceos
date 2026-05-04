import { describe, expect, it } from 'vitest';
import {
  quietHours,
  requires10dlcRegistration,
  requiresRecordingDisclosure,
  smsOptInLanguage,
  unsubscribeFooter,
} from '../../src/compliance/jurisdiction';

describe('requiresRecordingDisclosure', () => {
  it('returns true for all configured US two-party/all-party states', () => {
    const states = ['CA', 'FL', 'IL', 'MD', 'MA', 'MT', 'NV', 'NH', 'PA', 'WA'];
    for (const state of states) {
      expect(requiresRecordingDisclosure(state)).toBe(true);
    }
  });

  it('returns false for states not in the disclosure matrix', () => {
    expect(requiresRecordingDisclosure('TX')).toBe(false);
    expect(requiresRecordingDisclosure('NY')).toBe(false);
  });

  it('normalizes case and whitespace', () => {
    expect(requiresRecordingDisclosure(' ca ')).toBe(true);
  });
});

describe('quietHours', () => {
  it('allows contact between 8am and 9pm recipient local time', () => {
    // 15:00 UTC = 10:00 America/Chicago
    const withinWindow = quietHours('America/Chicago', new Date('2026-04-28T15:00:00Z'));
    expect(withinWindow.isAllowedNow).toBe(true);
    expect(withinWindow.localHour).toBe(10);
  });

  it('blocks contact before 8am recipient local time', () => {
    // 11:30 UTC = 06:30 America/New_York
    const beforeWindow = quietHours('America/New_York', new Date('2026-04-28T10:30:00Z'));
    expect(beforeWindow.isAllowedNow).toBe(false);
    expect(beforeWindow.localHour).toBe(6);
  });

  it('blocks contact at/after 9pm recipient local time', () => {
    // 02:00 UTC next day = 21:00 America/New_York
    const afterWindow = quietHours('America/New_York', new Date('2026-04-29T01:00:00Z'));
    expect(afterWindow.isAllowedNow).toBe(false);
    expect(afterWindow.localHour).toBe(21);
  });
});

describe('helper output contracts', () => {
  it('returns stable US TCPA opt-in language', () => {
    const value = smsOptInLanguage();
    expect(value).toContain('recurring automated');
    expect(value).toContain('Reply STOP to unsubscribe');
  });

  it('requires 10DLC registration in US-only v1', () => {
    expect(requires10dlcRegistration()).toBe(true);
  });

  it('returns an unsubscribe footer contract for commercial email', () => {
    const value = unsubscribeFooter();
    expect(value).toContain('unsubscribe');
    expect(value).toContain('mailing address');
  });
});
