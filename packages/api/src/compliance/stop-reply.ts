import { DncRepository, normalizePhone } from './dnc';
import type { KeywordHandler } from '../sms/inbound-dispatch';

/**
 * Twilio-required opt-out keywords (carrier-honored). When the carrier sees
 * these single-token replies it auto-suppresses; we still mirror locally so
 * the DNC list reflects carrier reality and the next outbound send is gated.
 */
export const STOP_KEYWORDS = ['STOP', 'STOPALL', 'UNSUBSCRIBE', 'CANCEL', 'END', 'QUIT'] as const;

/** Re-opt-in keywords. */
export const START_KEYWORDS = ['START', 'UNSTOP', 'YES'] as const;

/**
 * Build the STOP keyword handler. Registered against the inbound-SMS
 * dispatcher; when the first token of an inbound SMS matches any STOP
 * keyword, the sender's phone is normalised and inserted into the
 * tenant_dnc_list (idempotent at the repo level).
 */
export function buildStopKeywordHandler(deps: { dncRepo: DncRepository }): KeywordHandler {
  return {
    keywords: STOP_KEYWORDS,
    async handle(ctx) {
      await deps.dncRepo.addToDnc(ctx.tenantId, normalizePhone(ctx.fromE164), 'inbound-stop');
      return { handled: true, handler: 'stop-reply' };
    },
  };
}

/**
 * Build the START / opt-back-in keyword handler. Removes the sender's
 * phone from the tenant DNC list.
 */
export function buildStartKeywordHandler(deps: { dncRepo: DncRepository }): KeywordHandler {
  return {
    keywords: START_KEYWORDS,
    async handle(ctx) {
      await deps.dncRepo.removeFromDnc(ctx.tenantId, normalizePhone(ctx.fromE164));
      return { handled: true, handler: 'start-reply' };
    },
  };
}
