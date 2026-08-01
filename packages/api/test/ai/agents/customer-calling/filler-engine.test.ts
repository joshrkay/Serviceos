import { describe, it, expect } from 'vitest';
import { FillerEngine } from '../../../../src/ai/agents/customer-calling/filler-engine';
import { FILLER_LIBRARY } from '../../../../src/ai/agents/customer-calling/fillers/manifest';

describe('FillerEngine.selectNext', () => {
  it('returns one of the library entries', () => {
    const engine = new FillerEngine();
    const f = engine.selectNext();
    expect(FILLER_LIBRARY.map((x) => x.id)).toContain(f?.id);
  });

  it('does not return the same filler twice in a row', () => {
    const engine = new FillerEngine();
    const first = engine.selectNext();
    const second = engine.selectNext();
    expect(second?.id).not.toBe(first?.id);
  });

  it('skips selection entirely when skipFillers is true', () => {
    const engine = new FillerEngine();
    const f = engine.selectNext({ skipFillers: true });
    expect(f).toBeUndefined();
  });
});

// ─── UB-C2 — language-keyed selection ────────────────────────────────────────

describe('FillerEngine.selectNext — language keying (UB-C2)', () => {
  it('defaults to the English pool when no language is given', () => {
    const engine = new FillerEngine();
    for (let i = 0; i < 20; i++) {
      const f = engine.selectNext();
      expect(f?.language).toBe('en');
    }
  });

  it('returns ONLY Spanish fillers for language es', () => {
    const engine = new FillerEngine();
    for (let i = 0; i < 20; i++) {
      const f = engine.selectNext({ language: 'es' });
      expect(f?.language).toBe('es');
      expect(f?.id.startsWith('es-')).toBe(true);
    }
  });

  it('the manifest carries at least 8 fillers per language', () => {
    const en = FILLER_LIBRARY.filter((f) => f.language === 'en');
    const es = FILLER_LIBRARY.filter((f) => f.language === 'es');
    expect(en.length).toBeGreaterThanOrEqual(8);
    expect(es.length).toBeGreaterThanOrEqual(8);
  });

  it('never repeats back-to-back within a language', () => {
    const engine = new FillerEngine();
    let last: string | undefined;
    for (let i = 0; i < 20; i++) {
      const f = engine.selectNext({ language: 'es' });
      expect(f?.id).not.toBe(last);
      last = f?.id;
    }
  });

  it('keeps independent rotation state per language (interleaved calls stay language-pure)', () => {
    const engine = new FillerEngine();
    const a = engine.selectNext({ language: 'en' });
    const b = engine.selectNext({ language: 'es' });
    const c = engine.selectNext({ language: 'en' });
    const d = engine.selectNext({ language: 'es' });
    expect(a?.language).toBe('en');
    expect(c?.language).toBe('en');
    expect(b?.language).toBe('es');
    expect(d?.language).toBe('es');
    expect(a?.id).not.toBe(c?.id);
    expect(b?.id).not.toBe(d?.id);
  });
});
