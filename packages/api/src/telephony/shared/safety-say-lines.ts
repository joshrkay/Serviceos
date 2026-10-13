/**
 * RV-142 — the safety-line `<Say>` rendering shared by the Gather transport
 * (prepended to a pending `<Dial>`) and the realtime transport (the E1
 * corrective update when a hazard lands while a hand-off is in flight). Lives
 * here, with no dependency on either adapter, for the same reason as
 * `xml-escape.ts`: the media-stream adapter cannot import the Gather adapter
 * (which imports the media-stream server) without a cycle.
 */
import type { SideEffect } from '../../ai/agents/customer-calling/types';
import { renderTtsText, type SessionLanguage } from '../../ai/agents/customer-calling/tts-copy';
import { xmlEscape } from './xml-escape';

export const GATHER_VOICE_EN = 'Polly.Joanna';
export const GATHER_VOICE_ES = 'Polly.Mia-Neural';

/**
 * RV-142 — prepend safety-marked TTS lines (payload.priority === 'safety',
 * e.g. the emergency 911 line) as `<Say>` verbs at the top of an existing
 * `<Response>` document (typically the pending `<Dial>` transfer TwiML), so
 * the safety script is spoken BEFORE the bridge. Non-safety lines are left
 * out, preserving the long-standing behavior where transfer TwiML replaces
 * ordinary turn copy. Returns the document unchanged when no safety lines
 * are present.
 */
export function injectSafetySayLines(
  twiml: string,
  sideEffects: ReadonlyArray<SideEffect>,
  opts: { language?: 'en' | 'es'; voiceOverride?: string } = {},
): string {
  const lang: SessionLanguage = opts.language === 'es' ? 'es' : 'en';
  const sayParts = sideEffects
    .filter(
      (fx) =>
        fx.type === 'tts_play' &&
        fx.payload.priority === 'safety' &&
        typeof fx.payload.text === 'string' &&
        fx.payload.text.length > 0,
    )
    .map((fx) => {
      const voice =
        opts.voiceOverride ?? (lang === 'es' ? GATHER_VOICE_ES : GATHER_VOICE_EN);
      // Localize the safety script by session language — same selector the
      // Polly voice switch above uses. renderTtsText resolves the FSM's
      // fixed English sentences back to their TTS_COPY entry (exact match;
      // the 911 + transfer lines are catalogued), and passes unknown text
      // through unchanged, so an 'en' session is a no-op.
      const text = renderTtsText(String(fx.payload.text), fx.payload, lang);
      return `<Say voice="${xmlEscape(voice)}">${xmlEscape(text)}</Say>`;
    })
    .join('');
  if (!sayParts) return twiml;
  return twiml.replace('<Response>', `<Response>${sayParts}`);
}
