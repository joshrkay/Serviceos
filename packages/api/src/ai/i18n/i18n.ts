/**
 * P11-002 — Lightweight i18n helper for voice-stack TTS strings.
 *
 * Goals:
 *  - Statically-typed catalogs: the EN catalog defines the universe of
 *    keys; the ES catalog must satisfy `Record<TranslationKey, string>`
 *    so a missing key is a TypeScript compile error, not a runtime
 *    "lookup.balance.error" leaking into a Spanish call.
 *  - `t(key, lang, vars?)` interpolates `{{name}}` placeholders. Missing
 *    variables render as empty strings (loud-but-non-blocking — the
 *    catalog test catches malformed templates at PR time).
 *
 * Resolution order is owned by the caller (see language-detector.ts).
 * This module is pure data + interpolation; no side effects.
 */

import { en } from './en';
import { es } from './es';

/** Supported voice-stack languages. */
export type Language = 'en' | 'es';

/**
 * Build a typed translator over an EN/ES catalog pair. The EN catalog
 * is the source of truth for the key set; the ES catalog must satisfy
 * `Record<keyof EN, string>` so a missing key is a compile error.
 *
 * Interpolates `{{name}}` placeholders from `vars` (numeric vars coerced
 * via `String()`; missing vars render ''). Falls back to English when a
 * key is missing in the requested language (defense-in-depth — a future
 * cast/mistake should never leak an undefined-becomes-"" on a customer
 * channel).
 *
 * Reused by both the voice catalog (below) and the notifications catalog
 * (packages/api/src/notifications/i18n) so the interpolation/fallback
 * logic lives once.
 */
export function makeTranslator<EN extends Record<string, string>>(catalogs: {
  en: EN;
  es: Record<keyof EN, string>;
}) {
  const byLang: Record<Language, Record<keyof EN, string>> = {
    en: catalogs.en,
    es: catalogs.es,
  };
  return function t<K extends keyof EN>(
    key: K,
    lang: Language,
    vars?: Record<string, string | number>,
  ): string {
    const catalog = byLang[lang] ?? byLang.en;
    const template = catalog[key] ?? byLang.en[key] ?? '';
    if (!vars) return template;
    return template.replace(/\{\{(\w+)\}\}/g, (_match, name: string) => {
      const value = vars[name];
      if (value === undefined || value === null) return '';
      return String(value);
    });
  };
}

/** Source-of-truth key set: anything the EN catalog defines. */
export type TranslationKey = keyof typeof en;

/** Voice-stack translator. Signature unchanged for existing callers. */
export const t = makeTranslator({ en, es });
