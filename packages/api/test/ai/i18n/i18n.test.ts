/**
 * P11-002 — Catalog completeness + interpolation tests.
 *
 * Hard requirements:
 *  - Every key in EN must exist in ES (and vice-versa). The TS layer
 *    enforces this at compile time via `Record<keyof EnglishCatalog, string>`,
 *    but a runtime check guards against `as` casts and accidental
 *    `Object.assign` merges that bypass the type wall.
 *  - All placeholder tokens (`{{name}}`) used in EN must also appear
 *    in ES. Mistranslated placeholders mean a Spanish call hears the
 *    raw `{{amount}}` literal — loud bug, easy regression test.
 */
import { describe, it, expect } from 'vitest';
import { en } from '../../../src/ai/i18n/en';
import { es } from '../../../src/ai/i18n/es';
import { t } from '../../../src/ai/i18n/i18n';

function placeholders(s: string): string[] {
  const matches = s.match(/\{\{(\w+)\}\}/g) ?? [];
  return Array.from(new Set(matches)).sort();
}

describe('P11-002 i18n catalog completeness', () => {
  it('multilingual catalog: ES defines every EN key', () => {
    const enKeys = Object.keys(en).sort();
    const esKeys = Object.keys(es).sort();
    expect(esKeys).toEqual(enKeys);
  });

  it('multilingual catalog: every value is a non-empty string', () => {
    for (const [k, v] of Object.entries(en)) {
      expect(typeof v).toBe('string');
      expect(v.length, `en.${k} is empty`).toBeGreaterThan(0);
    }
    for (const [k, v] of Object.entries(es)) {
      expect(typeof v).toBe('string');
      expect(v.length, `es.${k} is empty`).toBeGreaterThan(0);
    }
  });

  it('multilingual catalog: placeholder tokens match across languages', () => {
    for (const key of Object.keys(en) as Array<keyof typeof en>) {
      const enPh = placeholders(en[key]);
      const esPh = placeholders(es[key]);
      expect(esPh, `placeholders mismatch for ${key}`).toEqual(enPh);
    }
  });
});

describe('P11-002 i18n t() helper', () => {
  it('language: returns English copy for en', () => {
    expect(t('lookup.balance.none', 'en')).toContain('paid in full');
  });

  it('language: returns Spanish copy for es', () => {
    expect(t('lookup.balance.none', 'es')).toContain('pagada');
  });

  it('language: interpolates numeric variables', () => {
    const out = t('lookup.balance.summary', 'en', { amount: '$50.00', count: 2 });
    expect(out).toContain('$50.00');
    expect(out).toContain('2');
  });

  it('language: missing variables render as empty strings without throwing', () => {
    const out = t('confirm.readback', 'es', {});
    expect(out).toContain('Solo para confirmar');
    expect(out).not.toContain('{{summary}}');
  });
});
