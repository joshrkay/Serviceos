/**
 * R2 — the deterministic yes/no matchers the confirm turn runs on instead of
 * an LLM round-trip.
 *
 * Three predicates, three different jobs, and the difference between them is
 * load-bearing:
 *
 *  - `isAffirmation`  — answers the `intent_confirm` readback. Leading-token
 *    matching is correct HERE ("yes, that's the one") because there is a
 *    question on the table.
 *  - `isNegation`     — the symmetric explicit rejection.
 *  - `isPlainAffirmation` — the STRICT form used by the pre-classifier guard
 *    at `intent_capture` / `closing`, where a leading "yes" would otherwise
 *    swallow the request that follows it.
 */
import { describe, it, expect } from 'vitest';
import {
  isAffirmation,
  isNegation,
  isPlainAffirmation,
} from '../../../../src/ai/agents/customer-calling/inapp-adapter';

const AFFIRMATIONS: string[] = [
  // plain
  'yes', 'Yes', 'yes.', 'yeah', 'yep', 'yup', 'sure', 'ok', 'okay', 'correct',
  'confirmed', 'go ahead', 'sounds good', 'that works', "that's right",
  // R2 — noisy affirmations, the register's conf-01 shape
  'uh yeah, go ahead',
  'uh, yes',
  'um, yeah',
  'well, yes',
  'okay so, go ahead',
  'ok so yes',
  'so, yes',
  'hmm, yes',
  'yes please',
  'yes, please',
  'go ahead please',
  'go ahead, thanks',
  'go for it',
  'book it',
  'yes book it',
  'yes please book it',
  'yep go ahead',
  'yeah go ahead',
  "yes that's right",
  'right, go ahead',
  'do that',
  'do it',
  "that's correct",
  'that is correct',
  'sounds right',
  "that's it",
  "let's do it",
  // es
  'sí', 'claro', 'adelante', 'perfecto',
];

const NOT_AFFIRMATIONS: string[] = [
  '',
  '   ',
  'um',
  'uh',
  'hmm',
  'no',
  'nope',
  'no thanks',
  "no that's wrong",
  'not that one',
  'scratch that',
  'uh no',
  'well, no',
  'cancel',
  'change the time',
  'make it Thursday instead',
  'Book Garcia for Tuesday at 2 pm',
];

const NEGATIONS: string[] = [
  'no', 'No', 'no.', 'nope', 'nah', 'wrong', 'incorrect', 'cancel',
  "that's wrong", "that's not right", 'start over', 'never mind',
  // R2 — noisy negations
  'uh no',
  'um, no',
  'well, no',
  'no, Thursday',
  "no, that's wrong",
  'not that one',
  'scratch that',
  'wrong one',
  'forget it',
  // es
  'incorrecto', 'no gracias',
];

const NOT_NEGATIONS: string[] = [
  '',
  'yes',
  'yeah',
  'go ahead',
  'uh yeah, go ahead',
  'sounds good',
  'Book Garcia for Tuesday at 2 pm',
];

describe('isAffirmation', () => {
  it.each(AFFIRMATIONS)('accepts %j', (text) => {
    expect(isAffirmation(text)).toBe(true);
  });

  it.each(NOT_AFFIRMATIONS)('rejects %j', (text) => {
    expect(isAffirmation(text)).toBe(false);
  });

  it('keeps the safe default: anything unclear is NOT an affirmation', () => {
    expect(isAffirmation('maybe')).toBe(false);
    expect(isAffirmation('I think so')).toBe(false);
    expect(isAffirmation('hold on a second')).toBe(false);
  });
});

describe('isNegation', () => {
  it.each(NEGATIONS)('accepts %j', (text) => {
    expect(isNegation(text)).toBe(true);
  });

  it.each(NOT_NEGATIONS)('rejects %j', (text) => {
    expect(isNegation(text)).toBe(false);
  });

  it('"no, Thursday" is a rejection carrying a correction, not a slot-fill', () => {
    expect(isNegation('no, Thursday')).toBe(true);
    expect(isAffirmation('no, Thursday')).toBe(false);
  });
});

describe('isPlainAffirmation — the strict pre-classifier form', () => {
  const PLAIN = [
    'yes', 'yes.', 'Yes!', 'yeah', 'yep', 'ok', 'okay', 'go ahead',
    'uh yeah, go ahead', 'yes please', 'go ahead please', 'book it',
    'yes book it', "that's right", 'sure',
  ];
  const NOT_PLAIN = [
    // A request that merely OPENS with an affirmation must still be classified
    // — this is the whole reason the strict form exists.
    'yes, book Garcia for Tuesday at 2 pm',
    'yes but make it 3',
    'yes, and change the time',
    'yeah, cancel the Thursday one',
    'sure, send the estimate too',
    // and everything that was never an affirmation
    'no',
    'um',
    '',
    'Book Garcia for Tuesday at 2 pm',
  ];

  it.each(PLAIN)('accepts the bare affirmation %j', (text) => {
    expect(isPlainAffirmation(text)).toBe(true);
  });

  it.each(NOT_PLAIN)('rejects %j', (text) => {
    expect(isPlainAffirmation(text)).toBe(false);
  });

  it('"yes but make it 3" is an affirmation-shaped correction, never a plain yes', () => {
    // `isAffirmation` still matches on the leading token — that is its job at
    // the readback — but the guard predicate must not.
    expect(isAffirmation('yes but make it 3')).toBe(true);
    expect(isPlainAffirmation('yes but make it 3')).toBe(false);
  });
});
