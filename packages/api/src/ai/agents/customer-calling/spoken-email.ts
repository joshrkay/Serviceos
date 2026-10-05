/**
 * #1613 — email addresses in speech.
 *
 * Layer 2 run 37323734649 (update-customer-email-known-customer) heard
 * "ops@acme.com" as "oppeaceatacme.com" and "ope-s.acme.com", read that back
 * as one word, and drafted it. Two pure helpers, used by the `update_customer`
 * readback (intent-readback.ts) and the drafted payload (voice-payload.ts,
 * voice-extended-tasks.ts), so what the caller hears and what the operator
 * reviews are the same address:
 *
 *   - {@link normalizeSpokenEmail} — a spoken address ("ops at acme dot com",
 *     "jane dot smith at example dot com") becomes the address. A value that
 *     is not an address is left as heard, trimmed, so a mishearing is read
 *     back as heard rather than silently reshaped.
 *   - {@link spokenEmail} — an address is spelled for the caller, letter by
 *     letter in the local part and word by word in the domain ("o-p-s at
 *     acme dot com"; Spanish "arroba" / "punto"), so a wrong letter is
 *     audible and the caller's "no" at the readback catches it.
 */

export type SpokenEmailLanguage = 'en' | 'es';

const SPOKEN_WORDS: Record<SpokenEmailLanguage, { at: string; dot: string; underscore: string; dash: string }> = {
  en: { at: 'at', dot: 'dot', underscore: 'underscore', dash: 'dash' },
  es: { at: 'arroba', dot: 'punto', underscore: 'guion bajo', dash: 'guion' },
};

export function spokenEmail(address: string, lang: SpokenEmailLanguage = 'en'): string {
  const value = address.trim();
  if (!ADDRESS.test(value)) return value;
  const words = SPOKEN_WORDS[lang];
  const [local, domain] = value.split('@') as [string, string];
  const spelledLocal = local
    .split(/([._-])/)
    .filter((part) => part.length > 0)
    .map((part) =>
      part === '.' ? words.dot : part === '_' ? words.underscore : part === '-' ? words.dash : part.split('').join('-'),
    )
    .join(' ');
  return `${spelledLocal} ${words.at} ${domain.split('.').join(` ${words.dot} `)}`;
}

/** A written address: local part, "@", at least one dotted domain label. */
const ADDRESS = /^[a-z0-9._%+-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)+$/i;

/** Spoken symbols, English and Spanish, as the recogniser writes them. */
const SPOKEN_SYMBOLS: Record<string, string> = {
  at: '@',
  arroba: '@',
  dot: '.',
  punto: '.',
  underscore: '_',
  dash: '-',
  hyphen: '-',
  guion: '-',
};

export function normalizeSpokenEmail(value: string): string {
  const heard = value.trim().replace(/[.,;:!?]+$/, '');
  if (heard.length === 0) return heard;
  const written = heard.replace(/\s*@\s*/g, '@').replace(/\s*\.\s*/g, '.');
  if (ADDRESS.test(written)) return written.toLowerCase();
  const words = heard.toLowerCase().split(/\s+/);
  if (!words.some((w) => SPOKEN_SYMBOLS[w] === '@')) return heard;
  const joined = words.map((w) => SPOKEN_SYMBOLS[w] ?? w).join('');
  return ADDRESS.test(joined) ? joined : heard;
}
