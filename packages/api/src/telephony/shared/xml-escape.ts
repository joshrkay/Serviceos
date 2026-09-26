/**
 * #350 — canonical home for TwiML XML-escaping. Previously duplicated
 * verbatim in `telephony/twilio-adapter.ts` and
 * `ai/voice-turn/create-voice-turn-processor.ts` to avoid a circular
 * import (the processor cannot import from the adapter, which imports
 * the processor). This module has no dependency on either, so both can
 * import it directly instead of carrying their own copy — a divergence
 * here would be a silent XML-injection risk in caller-supplied text
 * (business name, dispatcher name, etc.) rendered into `<Say>` TwiML.
 */
export function xmlEscape(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}
