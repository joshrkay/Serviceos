import { describe, expect, it } from 'vitest';
import { initialTypedValues, isTypedAnswer, typedAnswer, typedKind } from './typed-answer';

const blank = { greeting: '', trip: '', rate: '' };

describe('typedKind', () => {
  it('knows the two turns that can be typed, and nothing else', () => {
    expect(typedKind('greeting')).toBe('greeting');
    expect(typedKind('trip_fee_and_rate')).toBe('price');
    for (const key of ['booking_posture', 'payment_collection_mode', 'booking_hours', 'emergency_target', 'after_hours_mode', 'existing_number'] as const) {
      expect(typedKind(key), key).toBeNull();
    }
  });
});

describe('typedAnswer: greeting', () => {
  it('writes only the voice greeting, labelled with the owner’s own words', () => {
    expect(typedAnswer('greeting', { ...blank, greeting: '  Walsh here, go ahead ' })).toEqual({
      override: { label: 'Walsh here, go ahead', writes: { voiceGreeting: 'Walsh here, go ahead' } },
    });
  });

  it('asks for words when there are none', () => {
    expect(typedAnswer('greeting', blank)).toEqual({ errors: { greeting: 'Type what you want me to say.' } });
    expect(typedAnswer('greeting', { ...blank, greeting: '   ' }).errors).toEqual({ greeting: 'Type what you want me to say.' });
  });

  it('refuses more than 120 characters, the longest label the draft keeps', () => {
    expect(typedAnswer('greeting', { ...blank, greeting: 'x'.repeat(120) }).override?.label).toHaveLength(120);
    expect(typedAnswer('greeting', { ...blank, greeting: 'x'.repeat(121) }).errors).toEqual({ greeting: 'Keep it to 120 characters or fewer.' });
  });
});

describe('typedAnswer: price', () => {
  it('turns two dollar amounts into integer cents and a label', () => {
    expect(typedAnswer('price', { ...blank, trip: '$120', rate: '175' })).toEqual({
      override: { label: '$120 to come out, then $175 an hour', writes: {}, prices: { tripFeeCents: 12000, hourlyRateCents: 17500 } },
    });
    expect(typedAnswer('price', { ...blank, trip: '89.50', rate: '$234.05' }).override).toEqual({
      label: '$89.50 to come out, then $234.05 an hour',
      writes: {},
      prices: { tripFeeCents: 8950, hourlyRateCents: 23405 },
    });
  });

  it('allows a free trip but not a free hour', () => {
    expect(typedAnswer('price', { ...blank, trip: '0', rate: '150' }).override?.prices).toEqual({ tripFeeCents: 0, hourlyRateCents: 15000 });
    expect(typedAnswer('price', { ...blank, trip: '89', rate: '0' }).errors).toEqual({ rate: 'Enter your hourly rate.' });
  });

  it('asks for whichever amount is missing', () => {
    expect(typedAnswer('price', blank).errors).toEqual({
      trip: 'Enter what you charge to come out.',
      rate: 'Enter your hourly rate.',
    });
    expect(typedAnswer('price', { ...blank, trip: '120' }).errors).toEqual({ rate: 'Enter your hourly rate.' });
  });

  it('points at the amount that is not dollars, and only that one', () => {
    expect(typedAnswer('price', { ...blank, trip: 'abc', rate: '150' }).errors).toEqual({ trip: 'Use dollars, like 120 or 89.50.' });
    expect(typedAnswer('price', { ...blank, trip: '120', rate: '-5' }).errors).toEqual({ rate: 'Use dollars, like 120 or 89.50.' });
    expect(typedAnswer('price', { ...blank, trip: '89.999', rate: '1,2' }).errors).toEqual({
      trip: 'Use dollars, like 120 or 89.50.',
      rate: 'Use dollars, like 120 or 89.50.',
    });
  });

  it('accepts up to $1,000 and says so inline above it, for either amount', () => {
    expect(typedAnswer('price', { ...blank, trip: '1,000', rate: '$1,000.00' }).override?.prices).toEqual({
      tripFeeCents: 100000,
      hourlyRateCents: 100000,
    });
    expect(typedAnswer('price', { ...blank, trip: '120', rate: '1,000.01' }).errors).toEqual({ rate: 'Keep it to $1,000 or less.' });
    expect(typedAnswer('price', { ...blank, trip: '1001', rate: '150' }).errors).toEqual({ trip: 'Keep it to $1,000 or less.' });
    // A 7-digit slip (the tail of a phone number) is not read back as a price.
    const slip = typedAnswer('price', { ...blank, trip: '89', rate: '5550142' });
    expect(slip.override).toBeUndefined();
    expect(slip.errors).toEqual({ rate: 'Keep it to $1,000 or less.' });
  });

  it('never returns an override and errors together', () => {
    const bad = typedAnswer('price', { ...blank, trip: 'abc', rate: '150' });
    expect(bad.override).toBeUndefined();
    const good = typedAnswer('price', { ...blank, trip: '120', rate: '150' });
    expect(good.errors).toBeUndefined();
  });
});

describe('initialTypedValues', () => {
  it('is blank when nothing typed is staged', () => {
    expect(initialTypedValues(undefined)).toEqual(blank);
    expect(initialTypedValues({ option: 'b' })).toEqual(blank);
  });

  it('reopens a typed greeting and typed prices as the owner entered them', () => {
    expect(initialTypedValues({ override: { label: 'Walsh here', writes: { voiceGreeting: 'Walsh here' } } })).toEqual({ ...blank, greeting: 'Walsh here' });
    expect(
      initialTypedValues({
        override: { label: '$120 to come out, then $175.50 an hour', writes: {}, prices: { tripFeeCents: 12000, hourlyRateCents: 17550 } },
      }),
    ).toEqual({ ...blank, trip: '$120', rate: '$175.50' });
  });

  it('round-trips: what reopens parses back to the same override', () => {
    const staged = { override: { label: '$89.50 to come out, then $950 an hour', writes: {}, prices: { tripFeeCents: 8950, hourlyRateCents: 95000 } } };
    expect(typedAnswer('price', initialTypedValues(staged)).override).toEqual(staged.override);
  });
});

describe('isTypedAnswer', () => {
  it('is true only for a staged override', () => {
    expect(isTypedAnswer(undefined)).toBe(false);
    expect(isTypedAnswer({ option: 'a' })).toBe(false);
    expect(isTypedAnswer({ override: { label: 'x', writes: {} } })).toBe(true);
  });
});
