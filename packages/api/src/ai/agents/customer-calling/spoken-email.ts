/**
 * #1613 — email addresses in speech.
 *
 * Layer 2 run 37323734649 (update-customer-email-known-customer) heard
 * "ops@acme.com" as "oppeaceatacme.com" and "ope-s.acme.com", read that back
 * as one word, and drafted it. Two pure helpers:
 *
 *   - {@link normalizeSpokenEmail} — a spoken address ("ops at acme dot com",
 *     "jane dot smith at example dot com") becomes the address. Used by the
 *     `update_customer` readback (intent-readback.ts) and the drafted payload
 *     (voice-payload.ts, voice-extended-tasks.ts), so what the caller
 *     confirms, what the chat shows and what the operator reviews are one
 *     address. A spoken address is strictly word, symbol, word, …: anything
 *     else — a one-word mishearing, filler around the address — is left as
 *     heard (trimmed), never reshaped into a plausible wrong address.
 *   - {@link spokenEmail} — an address is spelled for the caller, letter by
 *     letter in the local part and word by word in the domain ("o-p-s at
 *     acme dot com"; Spanish "arroba" / "punto" / "guion bajo"), so a wrong
 *     letter is audible and the caller's "no" at the readback catches it.
 *     Applied where text becomes speech (ai/tts/speakable-text.ts), as
 *     dollar amounts are, so text surfaces keep the address.
 */
import type { SessionLanguage } from './tts-copy';

/** A written address: local part, "@", at least one dotted domain label. */
const ADDRESS = /^[a-z0-9._%+-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)+$/i;

/** Spoken symbols, English and Spanish, as the recogniser writes them. */
const SPOKEN_SYMBOLS: Record<string, string> = {
  at: '@',
  arroba: '@',
  dot: '.',
  punto: '.',
  underscore: '_',
  'guion bajo': '_',
  dash: '-',
  hyphen: '-',
  guion: '-',
};

const SPOKEN_WORDS: Record<SessionLanguage, { at: string; dot: string; underscore: string; dash: string }> = {
  en: { at: 'at', dot: 'dot', underscore: 'underscore', dash: 'dash' },
  es: { at: 'arroba', dot: 'punto', underscore: 'guion bajo', dash: 'guion' },
};

export function normalizeSpokenEmail(value: string): string {
  const heard = value.trim().replace(/[.,;:!?]+$/, '');
  if (heard.length === 0) return heard;
  const written = heard.replace(/\s*@\s*/g, '@').replace(/\s*\.\s*/g, '.');
  if (ADDRESS.test(written)) return written.toLowerCase();
  // Two-word symbols first, then the strict word / symbol alternation.
  const words = heard.toLowerCase().replace(/\bguion bajo\b/g, 'guion_bajo').split(/\s+/);
  const parts = words.map((w) => SPOKEN_SYMBOLS[w.replace('_', ' ')] ?? w);
  let alternates = parts.length >= 3 && parts.length % 2 === 1;
  for (let i = 0; alternates && i < parts.length; i++) {
    const isSymbol = parts[i]!.length === 1 && /[@._-]/.test(parts[i]!);
    alternates = i % 2 === 1 ? isSymbol : !isSymbol;
  }
  if (!alternates) return heard;
  const joined = parts.join('');
  return ADDRESS.test(joined) ? joined : heard;
}

export function spokenEmail(address: string, lang: SessionLanguage = 'en'): string {
  const value = address.trim();
  if (!ADDRESS.test(value)) return value;
  const words = SPOKEN_WORDS[lang];
  const symbol = (part: string): string | undefined =>
    part === '.' ? words.dot : part === '_' ? words.underscore : part === '-' ? words.dash : undefined;
  const [local, domain] = value.split('@') as [string, string];
  const spelledLocal = local
    .split(/([._-])/)
    .filter((part) => part.length > 0)
    .map((part) => symbol(part) ?? part.split('').join('-'))
    .join(' ');
  const spokenDomain = domain
    .split(/([.-])/)
    .filter((part) => part.length > 0)
    .map((part) => symbol(part) ?? part)
    .join(' ');
  return `${spelledLocal} ${words.at} ${spokenDomain}`;
}

/** Every written address in `text`, spelled for speech. */
export function spellEmailsForSpeech(text: string, lang: SessionLanguage = 'en'): string {
  return text.replace(/[a-z0-9._%+-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)+/gi, (address) => {
    // A sentence-final "." belongs to the sentence, not the address.
    const trailing = /[.]$/.test(address) && !ADDRESS.test(address) ? '.' : '';
    const bare = trailing ? address.slice(0, -1) : address;
    return `${spokenEmail(bare, lang)}${trailing}`;
  });
}
