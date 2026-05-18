/**
 * Twilio-required opt-out keywords (carrier-honored). When the carrier sees
 * these single-token replies it auto-suppresses; we still process locally so
 * our DNC list mirrors carrier reality and the next outbound send is gated.
 */
export const STOP_KEYWORDS = ['STOP', 'STOPALL', 'UNSUBSCRIBE', 'CANCEL', 'END', 'QUIT'] as const;

/** Re-opt-in keywords. */
export const START_KEYWORDS = ['START', 'UNSTOP', 'YES'] as const;

export type InboundSmsClass = 'stop' | 'start' | 'other';

/**
 * Strict single-token match after trim + trailing-punctuation strip.
 * Embedded "stop" inside a sentence is not an opt-out per carrier conventions.
 */
export function classifyInboundSms(body: string): InboundSmsClass {
  const token = body.trim().replace(/[!.?,;]+$/, '').toUpperCase();
  if ((STOP_KEYWORDS as readonly string[]).includes(token)) return 'stop';
  if ((START_KEYWORDS as readonly string[]).includes(token)) return 'start';
  return 'other';
}
