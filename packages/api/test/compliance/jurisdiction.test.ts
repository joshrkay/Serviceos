import { describe, expect, it } from 'vitest';
import {
  recipientQuietHours,
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

describe('recipientQuietHours', () => {
  // Known non-early-close states in the tenant's own zone, so the federal
  // 08:00–21:00 window in that one zone applies.
  const IL = { serviceStates: ['IL'], areaCodeState: null };
  const NY = { serviceStates: ['NY'], areaCodeState: null };

  it('allows contact between 8am and 9pm recipient local time', () => {
    // 15:00 UTC = 10:00 America/Chicago
    const withinWindow = recipientQuietHours(
      { ...IL, tenantTimezone: 'America/Chicago' },
      new Date('2026-04-28T15:00:00Z'),
    );
    expect(withinWindow.isAllowedNow).toBe(true);
  });

  it('blocks contact before 8am recipient local time, until 8am', () => {
    // 10:30 UTC = 06:30 America/New_York (EDT)
    const beforeWindow = recipientQuietHours(
      { ...NY, tenantTimezone: 'America/New_York' },
      new Date('2026-04-28T10:30:00Z'),
    );
    expect(beforeWindow.isAllowedNow).toBe(false);
    expect(beforeWindow.nextAllowedAt.toISOString()).toBe('2026-04-28T12:00:00.000Z');
  });

  it('blocks contact at/after 9pm recipient local time', () => {
    // 01:00 UTC next day = 21:00 America/New_York (EDT)
    const afterWindow = recipientQuietHours(
      { ...NY, tenantTimezone: 'America/New_York' },
      new Date('2026-04-29T01:00:00Z'),
    );
    expect(afterWindow.isAllowedNow).toBe(false);
  });
});

describe('recipientQuietHours — multi-zone states use every zone they span', () => {
  // October 2026 (DST). The tenant sits in the state's eastern zone at 08:30;
  // the state's western zone is still at 07:30, so the text waits until 08:00
  // there. Expected instants worked by hand from the UTC offsets.
  it.each([
    ['TX', 'America/Chicago', '2026-10-13T13:30:00Z', '2026-10-13T14:00:00.000Z'],
    ['FL', 'America/New_York', '2026-10-13T12:30:00Z', '2026-10-13T13:00:00.000Z'],
    ['IN', 'America/Indiana/Indianapolis', '2026-10-13T12:30:00Z', '2026-10-13T13:00:00.000Z'],
    ['KY', 'America/New_York', '2026-10-13T12:30:00Z', '2026-10-13T13:00:00.000Z'],
    ['TN', 'America/New_York', '2026-10-13T12:30:00Z', '2026-10-13T13:00:00.000Z'],
    ['MI', 'America/Detroit', '2026-10-13T12:30:00Z', '2026-10-13T13:00:00.000Z'],
    ['ND', 'America/Chicago', '2026-10-13T13:30:00Z', '2026-10-13T14:00:00.000Z'],
    ['SD', 'America/Chicago', '2026-10-13T13:30:00Z', '2026-10-13T14:00:00.000Z'],
    ['NE', 'America/Chicago', '2026-10-13T13:30:00Z', '2026-10-13T14:00:00.000Z'],
    ['KS', 'America/Chicago', '2026-10-13T13:30:00Z', '2026-10-13T14:00:00.000Z'],
    ['OR', 'America/Boise', '2026-10-13T14:30:00Z', '2026-10-13T15:00:00.000Z'],
    ['ID', 'America/Boise', '2026-10-13T14:30:00Z', '2026-10-13T15:00:00.000Z'],
    ['NV', 'America/Denver', '2026-10-13T14:30:00Z', '2026-10-13T15:00:00.000Z'],
    ['AZ', 'America/Denver', '2026-10-13T14:30:00Z', '2026-10-13T15:00:00.000Z'],
    ['AK', 'America/Anchorage', '2026-10-13T16:30:00Z', '2026-10-13T17:00:00.000Z'],
  ])('%s: 08:30 in %s is still 07:30 in its western zone', (state, tenantTimezone, at, expectedNext) => {
    const verdict = recipientQuietHours(
      { tenantTimezone, serviceStates: [state], areaCodeState: null },
      new Date(at),
    );

    expect(verdict.isAllowedNow).toBe(false);
    expect(verdict.nextAllowedAt.toISOString()).toBe(expectedNext);
  });
});

describe('recipientQuietHours — DST transition days (America/New_York)', () => {
  const NY = { tenantTimezone: 'America/New_York', serviceStates: ['NY'], areaCodeState: null };

  it('spring-forward morning (Mar 8 2026): 01:30 EST waits until 08:00 EDT', () => {
    const verdict = recipientQuietHours(NY, new Date('2026-03-08T06:30:00Z'));
    expect(verdict.isAllowedNow).toBe(false);
    expect(verdict.nextAllowedAt.toISOString()).toBe('2026-03-08T12:00:00.000Z');
  });

  it('fall-back morning (Nov 1 2026): 06:30 EST waits until 08:00 EST', () => {
    const verdict = recipientQuietHours(NY, new Date('2026-11-01T11:30:00Z'));
    expect(verdict.isAllowedNow).toBe(false);
    expect(verdict.nextAllowedAt.toISOString()).toBe('2026-11-01T13:00:00.000Z');
  });

  it('fall-back evening: 21:00 EST closes, reopening 08:00 EST the next day', () => {
    const verdict = recipientQuietHours(NY, new Date('2026-11-02T02:00:00Z'));
    expect(verdict.isAllowedNow).toBe(false);
    expect(verdict.nextAllowedAt.toISOString()).toBe('2026-11-02T13:00:00.000Z');
  });

  it('07:59 is closed and 08:00 open on the spring-forward day', () => {
    expect(recipientQuietHours(NY, new Date('2026-03-08T11:59:00Z')).isAllowedNow).toBe(false);
    expect(recipientQuietHours(NY, new Date('2026-03-08T12:00:00Z')).isAllowedNow).toBe(true);
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
