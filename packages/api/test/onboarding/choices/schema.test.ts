import { describe, it, expect } from 'vitest';
import {
  ALL_CHOICE_KEYS,
  ALLOWED_WRITES_BY_KEY,
  WritesNotAllowedError,
  assertOverrideAllowedFor,
  assertWritesAllowedFor,
  type ChoiceWrites,
} from '../../../src/onboarding/choices/schema';
import { CHOICE_REGISTRY, REGISTRY_TRADES } from '../../../src/onboarding/choices/registry';

describe('ALLOWED_WRITES_BY_KEY', () => {
  it('has an entry for every choice key', () => {
    expect(Object.keys(ALLOWED_WRITES_BY_KEY).sort()).toEqual([...ALL_CHOICE_KEYS].sort());
  });

  it.each(REGISTRY_TRADES)('%s: every registry option only writes keys its choice owns', (trade) => {
    for (const entry of CHOICE_REGISTRY[trade]) {
      for (const option of entry.options) {
        expect(() => assertWritesAllowedFor(entry.settingKey, option.writes)).not.toThrow();
        for (const w of Object.keys(option.writes)) {
          expect(ALLOWED_WRITES_BY_KEY[entry.settingKey]).toContain(w);
        }
      }
    }
  });
});

describe('assertWritesAllowedFor', () => {
  it('accepts the choice\'s own write and empty writes', () => {
    expect(() => assertWritesAllowedFor('greeting', { voiceGreeting: 'Hi' })).not.toThrow();
    expect(() => assertWritesAllowedFor('trip_fee_and_rate', {})).not.toThrow();
  });

  it('rejects a write that belongs to another choice, naming the offending key', () => {
    const smuggled: ChoiceWrites = { voiceGreeting: 'Hi', autonomousBookingEnabled: true };
    expect(() => assertWritesAllowedFor('greeting', smuggled)).toThrow(WritesNotAllowedError);
    expect(() => assertWritesAllowedFor('greeting', smuggled)).toThrow(/autonomousBookingEnabled/);
  });

  it('rejects any setting write on the price choice (prices only)', () => {
    expect(() => assertWritesAllowedFor('trip_fee_and_rate', { emergencyTarget: 'owner_cell' })).toThrow(/emergencyTarget/);
  });

  it('ignores explicitly-undefined keys', () => {
    expect(() => assertWritesAllowedFor('greeting', { voiceGreeting: 'Hi', paymentCollectionMode: undefined })).not.toThrow();
  });
});

describe('assertOverrideAllowedFor', () => {
  const prices = { tripFeeCents: 12000, hourlyRateCents: 17500 };

  it('requires prices on a trip_fee_and_rate override', () => {
    expect(() => assertOverrideAllowedFor('trip_fee_and_rate', { writes: {}, prices })).not.toThrow();
    expect(() => assertOverrideAllowedFor('trip_fee_and_rate', { writes: {} })).toThrow(/must carry prices/);
  });

  it('forbids prices on every other choice', () => {
    expect(() => assertOverrideAllowedFor('greeting', { writes: { voiceGreeting: 'Hi' }, prices })).toThrow(/may not carry prices/);
    expect(() => assertOverrideAllowedFor('greeting', { writes: { voiceGreeting: 'Hi' } })).not.toThrow();
  });

  it('also enforces the write allow-list', () => {
    expect(() => assertOverrideAllowedFor('booking_hours', { writes: { emergencyTarget: 'owner_cell' } })).toThrow(/emergencyTarget/);
  });
});
