import { describe, it, expect } from 'vitest';
import {
  wordErrorRate,
  werFromTokens,
  normalizeForWer,
} from '../../../src/ai/voice-quality/dialect/wer';

describe('dialect WER — normalizeForWer', () => {
  it('lowercases, drops punctuation, collapses whitespace', () => {
    expect(normalizeForWer('  Schedule, an   Appointment! ')).toEqual([
      'schedule',
      'an',
      'appointment',
    ]);
  });

  it('keeps intra-word apostrophes and folds curly → straight', () => {
    expect(normalizeForWer("I'd")).toEqual(["i'd"]);
    expect(normalizeForWer('I’d')).toEqual(["i'd"]); // curly apostrophe (Whisper output)
  });

  it('folds diacritics (accent-folding)', () => {
    expect(normalizeForWer('café')).toEqual(['cafe']);
  });

  it('empty / whitespace → []', () => {
    expect(normalizeForWer('   ')).toEqual([]);
    expect(normalizeForWer('')).toEqual([]);
  });
});

describe('dialect WER — wordErrorRate', () => {
  it('identical transcripts → WER 0, all hits', () => {
    const r = wordErrorRate('schedule an appointment', 'schedule an appointment');
    expect(r.wer).toBe(0);
    expect(r).toMatchObject({
      substitutions: 0,
      deletions: 0,
      insertions: 0,
      hits: 3,
      referenceWords: 3,
    });
  });

  it('one substitution (accent mis-hear) → 1 sub, WER 1/N', () => {
    const r = wordErrorRate('schedule an appointment', 'scedool an appointment');
    expect(r.substitutions).toBe(1);
    expect(r.deletions).toBe(0);
    expect(r.insertions).toBe(0);
    expect(r.hits).toBe(2);
    expect(r.wer).toBeCloseTo(1 / 3);
  });

  it('a dropped word → 1 deletion', () => {
    const r = wordErrorRate('i would like to book', 'would like to book');
    expect(r.deletions).toBe(1);
    expect(r.substitutions).toBe(0);
    expect(r.insertions).toBe(0);
    expect(r.hits).toBe(4);
    expect(r.wer).toBeCloseTo(1 / 5);
  });

  it('spurious words → insertions (WER can exceed reference-relative 1)', () => {
    const r = wordErrorRate('book it', 'please book it now');
    expect(r.insertions).toBe(2);
    expect(r.hits).toBe(2);
    expect(r.wer).toBe(1); // 2 insertions / 2 reference words
  });

  it('case + punctuation differences are not penalized', () => {
    const r = wordErrorRate(
      "I'd like to schedule an appointment.",
      'i’d like to schedule an appointment',
    );
    expect(r.wer).toBe(0);
  });

  it('mixed S+D+I over a realistic accented utterance', () => {
    // ref 7 words; hyp substitutes "schedule"→"scedool" and drops "to".
    const r = wordErrorRate(
      'i would like to schedule an appointment',
      'i would like scedool an appointment',
    );
    expect(r.substitutions + r.deletions + r.insertions).toBe(2);
    expect(r.referenceWords).toBe(7);
    expect(r.wer).toBeCloseTo(2 / 7);
  });

  it('empty reference: empty hyp → 0, non-empty hyp → 1 (all insertions)', () => {
    expect(wordErrorRate('', '')).toMatchObject({ wer: 0, insertions: 0, referenceWords: 0 });
    const r = wordErrorRate('', 'hello there');
    expect(r.wer).toBe(1);
    expect(r.insertions).toBe(2);
    expect(r.referenceWords).toBe(0);
  });

  it('empty hypothesis → every reference word is a deletion, WER 1', () => {
    const r = wordErrorRate('book it now', '');
    expect(r.deletions).toBe(3);
    expect(r.wer).toBe(1);
  });

  it('werFromTokens matches wordErrorRate on pre-tokenized input', () => {
    const tokens = ['book', 'it', 'now'];
    expect(werFromTokens(tokens, ['book', 'it', 'now']).wer).toBe(0);
  });
});
