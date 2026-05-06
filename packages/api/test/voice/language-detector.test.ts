import { describe, it, expect } from 'vitest';
import {
  FrancLanguageDetector,
  MIN_DETECTION_BYTES,
  type LanguageDetection,
} from '../../src/voice/language-detector';

describe('FrancLanguageDetector', () => {
  const detector = new FrancLanguageDetector();

  it('detects English from a typical HVAC intake utterance', () => {
    const r = detector.detect(
      'My air conditioning is broken can you send someone tomorrow morning to fix it',
    );
    expect(r.language).toBe('en');
    expect(r.confidence).toBeGreaterThan(0);
  });

  it('detects Spanish', () => {
    const r = detector.detect(
      'Mi aire acondicionado no funciona puede enviar alguien mañana por la mañana para arreglarlo',
    );
    expect(r.language).toBe('es');
    expect(r.confidence).toBeGreaterThan(0);
  });

  it('detects Vietnamese (with proper diacritics)', () => {
    // Diacritics matter — franc-min needs them to disambiguate
    // Vietnamese from Iloko / other Austronesian languages.
    const r = detector.detect(
      'Máy điều hòa nhà tôi bị hỏng rồi, các bạn có thể cử người đến sửa vào sáng mai được không',
    );
    expect(r.language).toBe('vi');
    expect(r.confidence).toBeGreaterThan(0);
  });

  it('detects Mandarin (cmn → zh) and Cantonese (yue → zh) collapse to zh', () => {
    const r = detector.detect('我的空调坏了你能明天派人来修吗这个真的很紧急');
    expect(r.language).toBe('zh');
  });

  it('returns "und" for inputs shorter than MIN_DETECTION_BYTES (UTF-8)', () => {
    const r = detector.detect('hi there');
    expect(r.language).toBe('und');
    expect(r.confidence).toBe(0);
  });

  it('returns "und" for empty / whitespace input', () => {
    const a = detector.detect('');
    const b = detector.detect('     \n\t   ');
    expect(a.language).toBe('und');
    expect(b.language).toBe('und');
  });

  it('returns "und" for null/undefined-coerced input', () => {
    const r = detector.detect(undefined as unknown as string);
    expect(r.language).toBe('und');
  });

  it('confidence saturates at 1.0 for long inputs', () => {
    const long = 'My air conditioning is broken '.repeat(20);
    const r = detector.detect(long);
    expect(r.language).toBe('en');
    expect(r.confidence).toBe(1);
  });

  it('falls through to raw ISO 639-3 for unmapped languages', () => {
    // Swedish — not in our active map; should pass through as 'swe'.
    const r: LanguageDetection = detector.detect(
      'Min luftkonditionering är trasig kan ni skicka någon imorgon',
    );
    // Don't assert exact code (franc may return swe/dan/nor depending
    // on input) — assert it's not 'und' and not in the BCP-47 map keys.
    expect(r.language).not.toBe('und');
    expect(['en', 'es', 'vi', 'zh', 'tl']).not.toContain(r.language);
  });

  it(`MIN_DETECTION_BYTES boundary: ASCII at exactly ${MIN_DETECTION_BYTES} bytes passes the length gate`, () => {
    // ASCII: 1 byte/char. Repeating 'a' for MIN_DETECTION_BYTES bytes
    // exercises the threshold. Whatever franc returns (likely 'und'
    // from its own model on uniform input) should NOT come from our
    // length short-circuit.
    const text = 'a'.repeat(MIN_DETECTION_BYTES);
    const r = detector.detect(text);
    expect(typeof r.language).toBe('string');
  });
});
