/**
 * U7 (S6-3) — what the demo call says before the turn processor takes over
 * (plan "Consent, limits, handoff": consent line first).
 *
 * The demo always discloses recording, so the one-party / two-party split of
 * `ai/skills/disclose-recording.ts` is not needed here. The copy is the
 * plan's recommended default (owner decision 2 in the S6 work package): the
 * owner may replace these sentences before the landing button ships. S6-6
 * wraps the voice route's first answer with `withDemoConsent`.
 */
import { xmlEscape } from '../telephony/shared/xml-escape';

/** The spoken consent line, in plain words, naming the visitor's business. */
export function demoConsentLine(businessName: string): string {
  return `This is a demo from Rivet. This call may be recorded. You're the customer; I'm answering for ${businessName}.`;
}

/** Shown on the page when every demo line is taken, and spoken by a call that lost its line. */
export const DEMO_BUSY_MESSAGE = 'Every line is busy. Try again in a minute.';

/**
 * Put the consent `<Say>` first inside the turn processor's `<Response>`, so
 * it is heard before the greeting. A turn with no `<Response>` element gets
 * one. The business name is visitor-typed, so it is escaped.
 */
export function withDemoConsent(businessName: string, turnTwiml: string, opts: { voice?: string } = {}): string {
  const voiceAttr = opts.voice ? ` voice="${xmlEscape(opts.voice)}"` : '';
  const say = `<Say${voiceAttr}>${xmlEscape(demoConsentLine(businessName))}</Say>`;
  const open = /<Response(\s[^>]*)?>/.exec(turnTwiml);
  if (open) {
    const at = open.index + open[0].length;
    return `${turnTwiml.slice(0, at)}${say}${turnTwiml.slice(at)}`;
  }
  const selfClosed = /<Response(\s[^>]*)?\/>/.exec(turnTwiml);
  if (selfClosed) {
    return `${turnTwiml.slice(0, selfClosed.index)}<Response${selfClosed[1] ?? ''}>${say}</Response>${turnTwiml.slice(
      selfClosed.index + selfClosed[0].length,
    )}`;
  }
  return `<Response>${say}${turnTwiml}</Response>`;
}
