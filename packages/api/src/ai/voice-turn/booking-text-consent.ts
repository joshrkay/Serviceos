/**
 * Would the booking-confirmation text reach this caller — and if not, may we
 * ask for consent on the call?
 *
 * The autonomous booking line promises "I'll text you a confirmation". The
 * customer-SMS gate (`GatedMessageDelivery`, block mode in production) only
 * lets a customer text through when `customers.sms_consent` is true, the
 * number is not on the tenant DNC list, and the consent ledger carries no
 * standing revocation. This asks the SAME decision core the gate uses
 * (`resolveOutboundConsent`), so the spoken promise cannot drift from what the
 * gate then does.
 *
 *   promise     — the gate will allow the text: speak the existing line, no
 *                 extra turn.
 *   ask         — the only thing missing is the caller's consent: ask once on
 *                 the call (pendingConsentCapture + strict confirmIntent).
 *   no_promise  — DNC, a standing revocation, a transport that cannot take the
 *                 answer, or anything we cannot verify: book without promising
 *                 a text. Never throws — a lookup failure withholds the
 *                 promise, it never blocks or undoes the booking.
 */
import type { CustomerRepository } from '../../customers/customer';
import type { ConsentEventRepository } from '../../compliance/consent-events';
import { normalizePhone, type DncRepository } from '../../compliance/dnc';
import { resolveOutboundConsent } from '../../compliance/resolve-outbound-consent';
import { createLogger } from '../../logging/logger';

const logger = createLogger({
  service: 'ai.voice-turn.booking-text-consent',
  environment: process.env.NODE_ENV || 'development',
});

export interface BookingTextConsentDeps {
  customerRepo?: Pick<CustomerRepository, 'findById'>;
  consentEventRepo?: Pick<ConsentEventRepository, 'listByPhone'>;
  dncRepo?: Pick<DncRepository, 'isOnDnc'>;
}

export interface BookingTextConsentInput {
  tenantId: string;
  /** The identified caller. Absent → nothing to verify. */
  customerId: string | undefined;
  /** The number the caller is calling from (E.164). */
  phone: string | undefined;
  /** Whether this transport can consume the caller's yes/no on the next turn. */
  canAsk: boolean;
}

export type BookingTextConsentDecision =
  | { action: 'promise'; reason: 'on_file' }
  | { action: 'ask'; reason: 'needs_consent' }
  | { action: 'no_promise'; reason: 'dnc' | 'revoked' | 'cannot_ask' | 'unverifiable' };

const UNVERIFIABLE: BookingTextConsentDecision = {
  action: 'no_promise',
  reason: 'unverifiable',
};

export async function decideBookingTextConsent(
  deps: BookingTextConsentDeps,
  input: BookingTextConsentInput,
): Promise<BookingTextConsentDecision> {
  const { customerRepo, consentEventRepo, dncRepo } = deps;
  const { tenantId, customerId, phone } = input;
  if (!customerRepo || !consentEventRepo || !dncRepo || !customerId || !phone) {
    return UNVERIFIABLE;
  }

  let customer: Awaited<ReturnType<typeof customerRepo.findById>>;
  let ledgerEvents: Awaited<ReturnType<typeof consentEventRepo.listByPhone>>;
  let dncListed: boolean;
  try {
    [customer, ledgerEvents, dncListed] = await Promise.all([
      customerRepo.findById(tenantId, customerId),
      consentEventRepo.listByPhone(tenantId, phone),
      dncRepo.isOnDnc(tenantId, normalizePhone(phone)),
    ]);
  } catch (err) {
    logger.warn('booking text consent: lookup failed — no text promise', {
      tenantId,
      error: err instanceof Error ? err.message : String(err),
    });
    return UNVERIFIABLE;
  }
  if (!customer) return UNVERIFIABLE;

  const decision = resolveOutboundConsent({
    channel: 'sms',
    dncListed,
    ledgerEvents,
    sms: { hasConsentContext: true, smsConsent: customer.smsConsent === true },
  });
  if (decision.allowed) return { action: 'promise', reason: 'on_file' };

  switch (decision.reason) {
    case 'dnc':
      return { action: 'no_promise', reason: 'dnc' };
    case 'cross_channel_revoked':
      return { action: 'no_promise', reason: 'revoked' };
    case 'no_channel_consent':
      return input.canAsk
        ? { action: 'ask', reason: 'needs_consent' }
        : { action: 'no_promise', reason: 'cannot_ask' };
    default:
      return UNVERIFIABLE;
  }
}
