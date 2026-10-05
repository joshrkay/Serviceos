/**
 * #1331 — text sent to a speech engine spells dollar amounts out.
 *
 * Lookup summaries render money as "$972.00" (skills/spoken-format.ts) —
 * right for card text and the in-app chat, but on a call it leaves the
 * reading of the cents to the TTS engine: Layer 2 run 36925905917 heard
 * "$972.00" back as "$972 sellers". Synthesis gets "972 dollars" /
 * "972 dollars and 50 cents" instead, so every engine says the same words.
 *
 * English only: a Spanish session's amounts pass through unchanged (no
 * Spanish number wording is defined yet). Email addresses are spelled in both
 * languages (#1613).
 */
import { spellEmailsForSpeech } from '../agents/customer-calling/spoken-email';

const DOLLAR_AMOUNT = /\$(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{2}))?(?!\d)/g;

export function speakableText(text: string, language?: string): string {
  // #1613 — an email address is spelled ("o-p-s at acme dot com"; es
  // "arroba"/"punto") so a misheard letter is audible at the readback; the
  // text surfaces keep the address (ai/agents/customer-calling/spoken-email.ts).
  const spelled = spellEmailsForSpeech(text, language === 'es' ? 'es' : 'en');
  if (language === 'es') return spelled;
  return spelled.replace(DOLLAR_AMOUNT, (_match, whole: string, cents?: string) => {
    const dollars = Number(whole.replace(/,/g, ''));
    const c = cents ? Number(cents) : 0;
    const dollarPart = `${whole} ${dollars === 1 ? 'dollar' : 'dollars'}`;
    if (c === 0) return dollarPart;
    const centPart = `${c} ${c === 1 ? 'cent' : 'cents'}`;
    return dollars === 0 ? centPart : `${dollarPart} and ${centPart}`;
  });
}
