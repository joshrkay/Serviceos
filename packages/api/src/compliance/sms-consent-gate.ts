import type { Customer } from '../customers/customer';
import type { ConsentEventRow } from './consent-events';
import { deriveConsentStatus } from './consent-events';

export type SmsComplianceBlockReason = 'dnc' | 'consent_revoked' | 'no_consent';

export function latestSmsLedgerState(
  events: ConsentEventRow[],
): 'granted' | 'revoked' | null {
  const smsEvents = events.filter((e) => e.kind === 'sms');
  if (smsEvents.length === 0) return null;
  return deriveConsentStatus(smsEvents[0]);
}

/**
 * Single combined SMS consent decision: denormalized boolean + ledger as
 * source of truth. Does not stack independent blocks that could diverge.
 */
export function resolveSmsConsentForOutbound(
  customer: Customer,
  ledgerEvents: ConsentEventRow[],
): { allowed: true } | { allowed: false; reason: SmsComplianceBlockReason } {
  const ledger = latestSmsLedgerState(ledgerEvents);
  if (ledger === 'revoked') {
    return { allowed: false, reason: 'consent_revoked' };
  }
  if (customer.smsConsent === true || ledger === 'granted') {
    return { allowed: true };
  }
  return { allowed: false, reason: 'no_consent' };
}
