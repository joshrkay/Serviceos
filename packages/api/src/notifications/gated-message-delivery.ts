/**
 * WS1 safety rails — the single consent + DNC gate for outbound SMS.
 *
 * Every product SMS is constructed as the one `messageDelivery` provider in
 * app.ts. Wrapping that provider in `GatedMessageDelivery` means there is
 * exactly ONE place where customer consent and the tenant DNC list are
 * enforced, instead of four+ duplicated ad-hoc gates that each path had to
 * remember to apply (and some forgot — recovery, negotiation, digests).
 *
 * Semantics (SMS only; email delegates untouched):
 *
 *   - recipientClass 'owner'  → bypass the gate entirely. Owner / operator /
 *     on-call sends (digests, one-tap approval links, emergency pages,
 *     dispatcher patches) are NEVER blocked by customer consent or DNC — even
 *     if the owner's own number happens to be on a DNC list.
 *   - recipientClass 'customer':
 *       · enforcement 'off'   → send; audit nothing (byte-for-byte legacy).
 *       · enforcement 'warn'  → if the send WOULD block, audit
 *         `sms.suppressed-would-block` then SEND anyway (observability).
 *       · enforcement 'block' → send only when consent.smsConsent === true AND
 *         there is no standing contact-consent revocation in the consent
 *         ledger (WS12 — see below) AND the phone is not on the tenant DNC
 *         list. Otherwise audit `sms.suppressed` and throw
 *         `SmsSuppressedError`.
 *       · a 'customer' send with no `consent` context fails closed
 *         (missing_consent_context) in warn/block modes.
 *
 * WS12 (one consent model, D-017): when a `consentLedger` is wired, the gate
 * also consults the append-only `consent_events` ledger and suppresses when
 * the number carries a standing 'sms'/'marketing' revocation — a customer
 * who revoked on ANY channel (voice call, portal, manual) is never texted,
 * even while the stored sms_consent flag still reads true (reason:
 * 'revoked'). The rule is asymmetric — revocations cross channels, grants
 * never do — and 'recording' objections do NOT suppress SMS (a caller who
 * objected to being recorded still gets their appointment confirmations).
 * See compliance/resolve-outbound-consent.ts, the shared decision core.
 *
 * Suppression surfaces as a thrown `SmsSuppressedError` so existing callers
 * keep their contracts: SendService catches it to write its `suppressed`
 * dispatch row + rethrow; the best-effort notifiers swallow it; the review
 * private-message adapter maps it to `{ suppressed, reason }`.
 */
import { AuditRepository, createAuditEvent } from '../audit/audit';
import { normalizePhone } from '../compliance/dnc';
import {
  resolveOutboundConsent,
  type ConsentLedgerEventLike,
} from '../compliance/resolve-outbound-consent';
import {
  DeliveryResult,
  EmailMessage,
  MessageDeliveryProvider,
  SmsMessage,
} from './delivery-provider';

export type SmsEnforcementMode = 'off' | 'warn' | 'block';

export type SmsSuppressionReason =
  | 'no_consent'
  | 'dnc'
  | 'missing_consent_context'
  /** WS12 — standing cross-channel (sms/marketing) revocation in the ledger. */
  | 'revoked';

/** Narrow DNC seam — satisfied by DncRepository and test stubs. */
export interface DncLookup {
  isOnDnc(tenantId: string, normalizedPhone: string): Promise<boolean>;
}

/**
 * Thrown when a customer SMS is suppressed in 'block' mode. Carries a
 * machine-readable reason so callers that report suppression (SendService,
 * the review adapter) can branch on it rather than string-matching.
 */
export class SmsSuppressedError extends Error {
  readonly suppressed = true;
  constructor(
    readonly reason: SmsSuppressionReason,
    readonly recipientClass: SmsMessage['recipientClass'] = 'customer',
  ) {
    super(`SMS suppressed: ${reason}`);
    this.name = 'SmsSuppressedError';
  }
}

/**
 * Narrow consent-ledger seam — satisfied by ConsentEventRepository and test
 * stubs. Rows must be newest first (the listByPhone contract).
 */
export interface ConsentLedgerLookup {
  listByPhone(tenantId: string, phone: string): Promise<ConsentLedgerEventLike[]>;
}

export interface GatedMessageDeliveryDeps {
  base: MessageDeliveryProvider;
  dnc: DncLookup;
  auditRepo: AuditRepository;
  /** Enforcement mode — the SAME value that drives the voice consent gate. */
  enforcement: SmsEnforcementMode;
  /**
   * WS12 — consent ledger for cross-channel revocation. Optional so tests
   * and legacy construction sites keep byte-identical behavior; when absent
   * the gate enforces only the per-channel flag + DNC (pre-WS12 semantics).
   */
  consentLedger?: ConsentLedgerLookup;
}

export class GatedMessageDelivery implements MessageDeliveryProvider {
  constructor(private readonly deps: GatedMessageDeliveryDeps) {}

  async sendSms(message: SmsMessage): Promise<DeliveryResult> {
    // Owner / operator sends bypass the gate entirely.
    if (message.recipientClass === 'owner') {
      return this.deps.base.sendSms(message);
    }

    // Customer send. 'off' preserves legacy behavior exactly — no gate, no audit.
    if (this.deps.enforcement === 'off') {
      return this.deps.base.sendSms(message);
    }

    const reason = await this.evaluate(message);
    if (reason) {
      if (this.deps.enforcement === 'warn') {
        // Would block, but warn mode only observes — audit then send.
        await this.audit('sms.suppressed-would-block', reason, message);
        return this.deps.base.sendSms(message);
      }
      // block mode — suppress.
      await this.audit('sms.suppressed', reason, message);
      throw new SmsSuppressedError(reason, message.recipientClass);
    }

    return this.deps.base.sendSms(message);
  }

  sendEmail(message: EmailMessage): Promise<DeliveryResult> {
    return this.deps.base.sendEmail(message);
  }

  /**
   * Returns the block reason for a customer send, or null when allowed.
   * Legacy checks keep their pre-WS12 label priority (consent context →
   * per-channel flag → tenant scope); the ledger + DNC lookups then feed the
   * shared resolver (compliance/resolve-outbound-consent.ts) so the
   * cross-channel revocation rule lives in exactly one place.
   */
  private async evaluate(message: SmsMessage): Promise<SmsSuppressionReason | null> {
    if (!message.consent) return 'missing_consent_context';
    if (message.consent.smsConsent !== true) return 'no_consent';
    // The DNC list and consent ledger are per-tenant; a customer send with no
    // tenant scope can't be checked, so fail closed rather than send to a
    // possibly-opted-out number.
    if (!message.tenantId) return 'missing_consent_context';
    const ledgerEvents = this.deps.consentLedger
      ? await this.deps.consentLedger.listByPhone(message.tenantId, message.to)
      : [];
    const dncListed = await this.deps.dnc.isOnDnc(
      message.tenantId,
      normalizePhone(message.to),
    );
    const decision = resolveOutboundConsent({
      channel: 'sms',
      dncListed,
      ledgerEvents,
      // Both already verified above; passing them re-asserts the invariant
      // inside the shared resolver.
      sms: { hasConsentContext: true, smsConsent: true },
    });
    if (decision.allowed) return null;
    return decision.reason === 'cross_channel_revoked' ? 'revoked' : 'dnc';
  }

  private async audit(
    eventType: 'sms.suppressed' | 'sms.suppressed-would-block',
    reason: SmsSuppressionReason,
    message: SmsMessage,
  ): Promise<void> {
    // Best-effort: never let an audit-write failure mask (or unmask) a
    // suppression decision. PII-minimizing — only the phone's last 4 digits.
    const last4 = normalizePhone(message.to).slice(-4);
    const tenantId = message.tenantId ?? 'unknown';
    try {
      await this.deps.auditRepo.create(
        createAuditEvent({
          tenantId,
          actorId: 'system:sms-gate',
          actorRole: 'system',
          eventType,
          entityType: 'sms_message',
          entityId: message.consent?.customerId ?? `sms-${last4}`,
          metadata: {
            reason,
            recipientClass: message.recipientClass,
            phoneLast4: last4,
            tenantId,
            mode: eventType === 'sms.suppressed-would-block' ? 'warn' : 'block',
          },
        }),
      );
    } catch {
      /* best-effort audit */
    }
  }
}
