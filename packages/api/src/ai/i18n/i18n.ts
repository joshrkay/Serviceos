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

/** Source-of-truth key set: anything the EN catalog defines. */
export type TranslationKey = keyof typeof en;

const CATALOGS: Record<Language, Record<TranslationKey, string>> = {
  en,
  es,
};

/**
 * Resolve a key to a localized string, interpolating `{{name}}`
 * placeholders from `vars`. Numeric vars are coerced via `String()`.
 *
 * Falls back to English when the key is missing in the requested
 * language (defense-in-depth — the type system already guarantees
 * completeness, but a future cast/mistake should never produce an
 * undefined-becomes-"" silent failure on a customer call).
 */
export function t<K extends TranslationKey>(
  key: K,
  lang: Language,
  vars?: Record<string, string | number>,
): string {
  const catalog = CATALOGS[lang] ?? CATALOGS.en;
  const template = catalog[key] ?? CATALOGS.en[key] ?? '';
  if (!vars) return template;
  return template.replace(/\{\{(\w+)\}\}/g, (_match, name: string) => {
    const value = vars[name];
    if (value === undefined || value === null) return '';
    return String(value);
  });
}
