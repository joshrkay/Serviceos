import { describe, it, expect } from 'vitest';
import { firstNameFromUser, timeOfDayGreeting, homeGreetingHeading } from './greeting';

describe('firstNameFromUser', () => {
  it('uses the first token of fullName', () => {
    expect(firstNameFromUser('Ada Lovelace')).toBe('Ada');
  });

  it('falls back to email local-part then there', () => {
    expect(firstNameFromUser(null, 'owner@acme.com')).toBe('owner');
    expect(firstNameFromUser(undefined, undefined)).toBe('there');
  });
});

describe('timeOfDayGreeting', () => {
  it('returns morning before noon in tenant tz', () => {
    const nineAmUtc = new Date('2026-06-12T14:00:00.000Z'); // 9am America/New_York (EDT)
    expect(timeOfDayGreeting(nineAmUtc, 'America/New_York')).toBe('Good morning');
  });

  it('returns afternoon in the early afternoon', () => {
    const twoPmUtc = new Date('2026-06-12T19:00:00.000Z'); // 2pm America/New_York
    expect(timeOfDayGreeting(twoPmUtc, 'America/New_York')).toBe('Good afternoon');
  });
});

describe('homeGreetingHeading', () => {
  it('includes the first name and time-of-day prefix', () => {
    const morning = new Date('2026-06-12T14:00:00.000Z');
    expect(homeGreetingHeading('Ada', morning, 'America/New_York')).toBe(
      'Good morning, Ada ☀️',
    );
  });
});
