/**
 * P8-015 — dropped-call recovery pre-send compliance gate.
 *
 * A dropped-call recovery is CUSTOMER-INITIATED (the caller phoned in and got
 * cut off) and is threaded onto the same intake conversation (P0-037), so it
 * follows the codebase's customer-initiated SMS policy — the one
 * `conversations/reply-service.ts` uses: the tenant DNC list is the absolute
 * block, and `customers.sms_consent` is NOT required. Requiring sms_consent
 * (the BUSINESS-initiated policy used by estimate/appointment/feedback sends)
 * would block essentially every legitimate recovery: recovery targets are
 * frequently unknown callers with no customer row, whose sms_consent defaults
 * to false.
 *
 * On top of the DNC floor, this gate adds one defense-in-depth check: if the
 * caller resolves to a KNOWN customer who has EXPLICITLY revoked consent
 * (`consent_status = 'revoked'` — e.g. via a path other than STOP, which
 * already lands on the DNC list), suppress the send. It never blocks on unset
 * consent, so unknown callers are unaffected.
 */
import { normalizePhone } from '../../customers/dedup';
import type { DncRepository } from '../../compliance/dnc';
import type { Customer } from '../../customers/customer';
import type { RecoveryPreSendSuppress } from './dropped-call-handler';

export interface RecoveryComplianceDeps {
  dncRepo: Pick<DncRepository, 'isOnDnc'>;
  /**
   * Phone→customer resolver. Optional method on the repo; when absent the gate
   * degrades to DNC-only (no explicit-revoke check).
   */
  customerRepo: {
    findByPhoneNormalized?(tenantId: string, phoneNormalized: string): Promise<Customer[]>;
  };
}

export function createRecoveryComplianceGate(
  deps: RecoveryComplianceDeps,
): RecoveryPreSendSuppress {
  return async (row) => {
    const phone = normalizePhone(row.callerE164);

    // DNC is the absolute block (STOP replies land here too).
    if (await deps.dncRepo.isOnDnc(row.tenantId, phone)) {
      return 'opted_out';
    }

    // Defense-in-depth: honor an EXPLICIT revoke for a matched customer. Block
    // if ANY customer on this number revoked (a shared/household number where
    // one contact opted out should not be texted). Never block on unset —
    // unknown callers legitimately have no customer/consent record.
    if (deps.customerRepo.findByPhoneNormalized) {
      const matches = await deps.customerRepo.findByPhoneNormalized(row.tenantId, phone);
      if (matches.some((c) => c.consentStatus === 'revoked')) {
        return 'opted_out';
      }
    }

    return null;
  };
}
