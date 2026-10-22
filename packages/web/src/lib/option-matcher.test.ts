import { describe, it, expect } from 'vitest';
import { matchOption, type MatchableOptions } from './option-matcher';

// Real v3 registry copy (packages/api/src/onboarding/choices/registry/common.ts),
// rendered the way the API sends it to the shell.
const booking: MatchableOptions = [
  { key: 'a', label: 'Book it on the call' },
  { key: 'b', label: 'Hold it for me' },
];
const payment: MatchableOptions = [
  { key: 'a', label: 'Text them a pay link' },
  { key: 'b', label: 'Collect on the spot' },
];
const hours: MatchableOptions = [
  { key: 'a', label: 'Monday to Saturday, 7 to 5' },
  { key: 'b', label: 'Weekdays, 7 to 5' },
];
const emergency: MatchableOptions = [
  { key: 'a', label: 'Your cell, every time' },
  { key: 'b', label: "Your cell, then text you if you don't pick up" },
];
const existingNumber: MatchableOptions = [
  { key: 'a', label: 'No, just my cell' },
  { key: 'b', label: 'Yes, I have a business line' },
];
const greeting: MatchableOptions = [
  { key: 'a', label: 'Reyes Plumbing, how can I help?' },
  { key: 'b', label: "Thanks for calling Reyes Plumbing. What's going on today?" },
];
// The price turn's labels share one template and differ only in the numbers.
// Premium is standard x 1.30 rounded to the dollar (price-tiers.ts), so $89
// pairs with $116 and $99 with $129.
const price89: MatchableOptions = [
  { key: 'a', label: '$89 to come out, then $120 an hour' },
  { key: 'b', label: '$116 to come out, then $156 an hour' },
];
const price99: MatchableOptions = [
  { key: 'a', label: '$99 to come out, then $135 an hour' },
  { key: 'b', label: '$129 to come out, then $176 an hour' },
];

describe('matchOption: first or second, said out loud', () => {
  it.each([
    ['first', 'a'],
    ['the first one', 'a'],
    ['number one', 'a'],
    ['1st', 'a'],
    ['one', 'a'],
    ['the top one', 'a'],
    ['second', 'b'],
    ['the second one', 'b'],
    ['number two', 'b'],
    ['2nd', 'b'],
    ['two', 'b'],
    ['the bottom one', 'b'],
    ['the other one', 'b'],
    ['the latter', 'b'],
    ["I'll go with the second one", 'b'],
  ] as const)('%j picks option %s', (said, key) => {
    expect(matchOption(said, booking)).toMatchObject({ key, by: 'ordinal' });
  });
});

describe('matchOption: a letter on its own', () => {
  it.each([
    ['a', 'a'],
    ['b', 'b'],
    ['A.', 'a'],
    ['option a', 'a'],
    ['Option B', 'b'],
  ] as const)('%j picks option %s', (said, key) => {
    expect(matchOption(said, booking)).toMatchObject({ key, by: 'letter' });
  });
});

describe('matchOption: no guess when the answer is unclear', () => {
  it.each([
    ['not the first'],
    ["don't pick the second one"],
    ['first or second'],
    ['the first one, no, the second one'],
    [''],
    ['   '],
    ['um'],
    ['banana'],
  ])('%j matches nothing, so the owner taps', (said) => {
    expect(matchOption(said, booking)).toBeNull();
  });
});

describe('matchOption: fillers are not answers', () => {
  it('"um, the second one please" picks option b', () => {
    expect(matchOption('um, the second one please', booking)).toMatchObject({ key: 'b', by: 'ordinal' });
  });

  it('"uh first" picks option a', () => {
    expect(matchOption('uh first', booking)).toMatchObject({ key: 'a', by: 'ordinal' });
  });
});

describe('matchOption: words from the option itself', () => {
  it.each([
    ['book it on the call', 'a', booking],
    ['hold it', 'b', booking],
    ['just hold it for me', 'b', booking],
    ['a pay link', 'a', payment],
    ['text them a link', 'a', payment],
    ['collect on the spot', 'b', payment],
    ['monday to saturday', 'a', hours],
    ['weekdays', 'b', hours],
    ['every time', 'a', emergency],
    ["text me if I don't pick up", 'b', emergency],
    ['no', 'a', existingNumber],
    ['yes I have a business line', 'b', existingNumber],
    ['how can I help', 'a', greeting],
    ['thanks for calling', 'b', greeting],
    ['eighty-nine', 'a', price89],
    ['eighty nine', 'a', price89],
    ['89', 'a', price89],
    ['$89', 'a', price89],
    ['eighty nine dollars', 'a', price89],
    ['a hundred and sixteen', 'b', price89],
    ['one sixteen', 'b', price89],
    ['one twenty nine', 'b', price99],
    ['129', 'b', price99],
    ['one hundred twenty nine dollars to come out', 'b', price99],
    ['ninety nine', 'a', price99],
    ['monday to saterday', 'a', hours],
    ['colect on the spot', 'b', payment],
  ] as const)('%j picks option %s', (said, key, options) => {
    expect(matchOption(said, options)).toMatchObject({ key, by: 'label' });
  });

  it('"a pay link" is a label answer, not the letter a', () => {
    expect(matchOption('a pay link', payment)).toEqual({ key: 'a', by: 'label', confidence: 1 });
  });

  it('confidence is the winning score, at least the 0.5 floor', () => {
    const m = matchOption('just hold it for me', booking);
    expect(m?.confidence).toBeGreaterThanOrEqual(0.5);
    expect(m?.confidence).toBeLessThanOrEqual(1);
  });

  it.each([
    ['seven to five', hours],
    ['my cell', emergency],
    ['to come out', price89],
    ['an hour', price99],
    ['Reyes Plumbing', greeting],
    ['the spot link', payment],
  ] as const)('%j fits both options equally, so nothing is picked', (said, options) => {
    expect(matchOption(said, options)).toBeNull();
  });

  it('a number in neither label picks nothing', () => {
    expect(matchOption('two hundred', price89)).toBeNull();
  });

  it('numbers decide the price turn even when the rest of the sentence is shared', () => {
    expect(matchOption('one twenty nine to come out then one seventy six an hour', price99)).toMatchObject({ key: 'b', by: 'label' });
    expect(matchOption('ninety nine to come out then one thirty five an hour', price99)).toMatchObject({ key: 'a', by: 'label' });
  });

  it('answers in either order of the options: the key comes from the option, the ordinal from its position', () => {
    const swapped: MatchableOptions = [booking[1], booking[0]];
    expect(matchOption('first', swapped)).toMatchObject({ key: 'b' });
    expect(matchOption('book it on the call', swapped)).toMatchObject({ key: 'a' });
  });

  it('is deterministic: the same words always give the same answer', () => {
    const once = matchOption('um, hold it please', booking);
    for (let i = 0; i < 5; i++) expect(matchOption('um, hold it please', booking)).toEqual(once);
  });
});

// The S3-4 acceptance table, row for row.
describe('matchOption: S3-4 acceptance table', () => {
  it.each([
    ['the second one', booking, { key: 'b' }],
    ['first', booking, { key: 'a' }],
    ['number two', booking, { key: 'b' }],
    ['b', booking, { key: 'b' }],
    ['a', booking, { key: 'a' }],
    ['option a', booking, { key: 'a' }],
    ['eighty-nine', price89, { key: 'a', by: 'label' }],
    ['one twenty nine', price99, { key: 'b', by: 'label' }],
    ['129', price99, { key: 'b', by: 'label' }],
    ['book it on the call', booking, { key: 'a' }],
    ['hold it', booking, { key: 'b' }],
    ['not the first', booking, null],
    ['first or second', booking, null],
    ['', booking, null],
    ['a pay link', payment, { key: 'a', by: 'label' }],
    ['um, the second one please', booking, { key: 'b' }],
  ] as const)('%j', (said, options, expected) => {
    const got = matchOption(said, options);
    if (expected === null) expect(got).toBeNull();
    else expect(got).toMatchObject(expected);
  });

  it('"one" inside a price is the number, not the first option', () => {
    expect(matchOption('the one with one twenty nine', price99)).toMatchObject({ key: 'b', by: 'label' });
  });

  it('a negation the labels do not share turns a label answer into no guess', () => {
    expect(matchOption("don't book it", booking)).toBeNull();
  });
});

describe('matchOption: odd words are only words', () => {
  it.each([['constructor'], ['toString'], ['__proto__']])('%j is not read as a number and matches nothing', (said) => {
    expect(matchOption(said, booking)).toBeNull();
  });
});
