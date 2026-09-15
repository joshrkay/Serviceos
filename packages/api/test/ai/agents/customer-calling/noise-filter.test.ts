/**
 * R2 — the deterministic filler / mic-check detector. Table-driven on
 * purpose: the whole value of this function is that its FALSE cases are
 * exhaustive enough to trust, because a false positive here swallows a real
 * operator request without ever reaching the classifier.
 */
import { describe, it, expect } from 'vitest';
import { isNoiseUtterance } from '../../../../src/ai/agents/customer-calling/noise-filter';

const NOISE: string[] = [
  'um... hello?',
  'um',
  'uh',
  'uhh...',
  'hmm',
  'hello?',
  'Hello?',
  'hello hello',
  'hi',
  'hey',
  'hey there',
  'so...',
  'well...',
  'uh, um',
  'testing',
  'testing, testing',
  'test',
  'mic check',
  'check check',
  'one two three',
  'testing one two three',
  'can you hear me?',
  'Can you hear me?',
  'um, can you hear me?',
  'can you hear me now',
  'is this on?',
  'is this thing on?',
  'are you there?',
  'anyone there?',
  'okay',
  'ok',
  '...',
  '?',
  '',
  '   ',
  'a',
];

const NOT_NOISE: string[] = [
  // real requests — the shapes the register books with
  'Book Garcia for Tuesday at 2 pm for the HVAC install',
  'book garcia for tuesday at 2 pm for the hvac install',
  'Book Garcia',
  'um, book Garcia',
  'uh, can you book the Garcia install',
  // a proper noun is a name, however short the sentence
  'Garcia?',
  'hello Sarah',
  'Hello Sarah',
  // digits are references — times, amounts, invoice and phone numbers
  'invoice 1042',
  'check 480-555-0199',
  'one two 3',
  '2 pm',
  // short but real
  'cancel',
  'cancel that',
  'next appointment',
  'what is on today',
  'send the estimate',
  // yes/no must never be swallowed as filler — they are answers
  'yes',
  'no',
  'yeah',
  'nope',
];

describe('isNoiseUtterance — noise', () => {
  it.each(NOISE)('treats %j as noise', (text) => {
    expect(isNoiseUtterance(text)).toBe(true);
  });
});

describe('isNoiseUtterance — never noise', () => {
  it.each(NOT_NOISE)('treats %j as a real utterance', (text) => {
    expect(isNoiseUtterance(text)).toBe(false);
  });
});

describe('isNoiseUtterance — invariants', () => {
  it('anything containing a digit is never noise', () => {
    expect(isNoiseUtterance('testing 1 2 3')).toBe(false);
    expect(isNoiseUtterance('um... 4')).toBe(false);
  });

  it('three or more non-filler tokens are never noise', () => {
    expect(isNoiseUtterance('move the job later')).toBe(false);
  });

  it('is total — a non-string never throws', () => {
    expect(isNoiseUtterance(undefined as unknown as string)).toBe(false);
  });
});
