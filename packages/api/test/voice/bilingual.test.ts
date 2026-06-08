/**
 * Bilingual parity (competitive bar: English + Spanish at parity).
 *
 * Two guarantees:
 *  1. Language detection never *crosses* languages — a Spanish utterance is
 *     never read as English and vice-versa (the "no English bleeding into a
 *     Spanish call" demo-killer). Detection on short phrases is imperfect
 *     (franc may return a neighbouring Romance/Germanic language), so we
 *     assert directional accuracy >= 0.7 plus the hard no-cross rule.
 *  2. Generated copy stays fully in the detected language (i18n catalog).
 */
import { describe, it, expect } from 'vitest';
import { loadIntents } from './_fixtures';
import { FrancLanguageDetector, MIN_DETECTION_BYTES } from '../../src/voice/language-detector';
import { buildReturningCustomerGreeting } from '../../src/voice/parity/returning-greeting';

const detector = new FrancLanguageDetector();
const fixtures = loadIntents().filter(
  (f) => Buffer.byteLength(f.utterance, 'utf8') >= MIN_DETECTION_BYTES,
);

function accuracy(language: 'en' | 'es') {
  const subset = fixtures.filter((f) => f.language === language);
  const correct = subset.filter((f) => detector.detect(f.utterance).language === language).length;
  return { total: subset.length, correct, rate: correct / subset.length };
}

describe('Bilingual parity — EN + ES', () => {
  it('Spanish utterances are never detected as English', () => {
    for (const f of fixtures.filter((x) => x.language === 'es')) {
      expect(detector.detect(f.utterance).language).not.toBe('en');
    }
  });

  it('English utterances are never detected as Spanish', () => {
    for (const f of fixtures.filter((x) => x.language === 'en')) {
      expect(detector.detect(f.utterance).language).not.toBe('es');
    }
  });

  it('directional detection accuracy is >= 0.7 each way', () => {
    expect(accuracy('es').rate).toBeGreaterThanOrEqual(0.7);
    expect(accuracy('en').rate).toBeGreaterThanOrEqual(0.7);
  });

  it('returning greeting stays fully in language', () => {
    const es = buildReturningCustomerGreeting({
      customerName: 'María',
      language: 'es',
      timezone: 'America/New_York',
      lastService: { date: new Date('2026-03-12T15:00:00.000Z'), type: 'revisión' },
    });
    const en = buildReturningCustomerGreeting({
      customerName: 'John',
      language: 'en',
      timezone: 'America/New_York',
      lastService: { date: new Date('2026-03-12T15:00:00.000Z'), type: 'AC tune-up' },
    });
    expect(es).toContain('¿Llama por su');
    expect(es).not.toContain('calling about');
    expect(en).toContain('Are you calling about');
    expect(en).not.toContain('¿Llama por su');
  });
});
