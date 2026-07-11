/**
 * WS1 safety rails — the single consent + DNC gate for outbound SMS.
 *
 * Every product SMS is constructed as the one `messageDelivery` provider in
 * app.ts. Wrapping that provider in `GatedMessageDelivery` means there is
 * exactly ONE place where customer consent and the tenant DNC list are
 * enforced, instead of four+ duplicated ad-hoc gates that each path had to
 * remember to apply (and some forgot — recovery, negotiation, digests).
 *
 * The decision itself lives in the pure `evaluateCustomerSms` helper below so
 * the gate and any pre-send precheck (e.g. the feedback_send worker, which
 * must decide BEFORE minting a request row) share ONE implementation.
 *
 * Semantics (SMS only; email delegates untouched):
 *
 *   - recipientClass 'owner'  → bypass the gate entirely. Owner / operator /
 *     on-call sends (digests, one-tap approval links, emergency pages,
 *     dispatcher patches) are NEVER blocked by customer consent or DNC — even
 *     if the owner's own number happens to be on a DNC list.
 *   - recipientClass 'customer':
 *       · the tenant DNC list is a HARD FLOOR in EVERY mode (off/warn/block):
 *         a send to a number on the tenant DNC list is ALWAYS suppressed
 *         (audit `sms.suppressed` reason 'dnc' + throw `SmsSuppressedError`).
 *         This restores the legacy unconditional DNC block the four inline
 *         gates applied before this wrapper — enforcement 'off' must NOT drop
 *         DNC protection. Only checkable when the send carries a `tenantId`
 *         (the DNC list is per-tenant); a customer send with no tenant scope
 *         cannot be DNC-checked.
 *       · consent (smsConsent) is governed by the enforcement mode:
 *           - 'off'   → consent NOT enforced; send (byte-for-byte legacy for
 *             non-DNC sends). A missing tenantId or missing consent context
 *             does NOT fail in 'off' — previously-ungated paths never checked
 *             consent, so 'off' must not newly fail them.
 *           - 'warn'  → if consent is absent/false (or the tenant scope is
 *             missing), audit `sms.suppressed-would-block` then SEND anyway
 *             (observability only). DNC still hard-blocks.
 *           - 'block' → send only when consent.smsConsent === true AND a
 *             `tenantId` is present AND the number is not on DNC; otherwise
 *             audit `sms.suppressed` and throw `SmsSuppressedError`.
 *       · a 'customer' send with no `consent` context fails closed
 *         (missing_consent_context) in warn/block; in 'off' it sends.
 *
 * Suppression surfaces as a thrown `SmsSuppressedError` so existing callers
 * keep their contracts: SendService catches it to write its `suppressed`
 * dispatch row + rethrow; the best-effort notifiers swallow it; the review
 * private-message adapter maps it to `{ suppressed, reason }`.
 */
import { AuditRepository, createAuditEvent } from '../audit/audit';
import { normalizePhone } from '../compliance/dnc';
import {
  DeliveryResult,
  EmailMessage,
  MessageDeliveryProvider,
  SmsMessage,
} from './delivery-provider';

export type SmsEnforcementMode = 'off' | 'warn' | 'block';

export type SmsSuppressionReason = 'no_consent' | 'dnc' | 'missing_consent_context';

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

/** Outcome of evaluating a customer SMS against consent + DNC in a given mode. */
export type SmsGateOutcome = 'send' | 'would_block' | 'suppress';

export interface SmsGateDecision {
  outcome: SmsGateOutcome;
  /** Present when outcome is 'would_block' or 'suppress'. */
  reason?: SmsSuppressionReason;
}

export interface CustomerSmsEvaluatorDeps {
  dnc: DncLookup;
  /** Enforcement mode — the SAME value that drives the voice consent gate. */
  enforcement: SmsEnforcementMode;
}

/**
 * The single source of the consent + DNC decision. Returns whether a message
 * should send, would-block-but-send (warn), or suppress — WITHOUT performing
 * the send or any audit write. Used by `GatedMessageDelivery` (which then
 * audits + dispatches) and by pre-send prechecks that must decide before doing
 * side effects (feedback_send mints a request row only when this says send).
 *
 * DNC is a hard floor applied in EVERY mode; consent is mode-governed. See the
 * module doc comment for the full semantics table.
 */
export function evaluateCustomerSms(
  deps: CustomerSmsEvaluatorDeps,
): (message: SmsMessage) => Promise<SmsGateDecision> {
  return async (message: SmsMessage): Promise<SmsGateDecision> => {
    // Owner / operator sends are never gated.
    if (message.recipientClass === 'owner') return { outcome: 'send' };

    // DNC hard floor — applies in off/warn/block alike. Only checkable with a
    // tenant scope (the list is per-tenant). A DNC hit ALWAYS suppresses,
    // restoring the legacy unconditional block that enforcement 'off' otherwise
    // would have dropped.
    if (message.tenantId) {
      const onDnc = await deps.dnc.isOnDnc(message.tenantId, normalizePhone(message.to));
      if (onDnc) return { outcome: 'suppress', reason: 'dnc' };
    }

    // 'off' — consent is not enforced and a missing tenant scope / consent
    // context does not fail (byte-for-byte legacy for non-DNC sends).
    if (deps.enforcement === 'off') return { outcome: 'send' };

    // 'warn' / 'block' — enforce a consent context, a true consent flag, and a
    // tenant scope. Order is informative-first (missing context vs. explicit no).
    let reason: SmsSuppressionReason | null = null;
    if (!message.consent) reason = 'missing_consent_context';
    else if (message.consent.smsConsent !== true) reason = 'no_consent';
    else if (!message.tenantId) reason = 'missing_consent_context';

    if (!reason) return { outcome: 'send' };
    return deps.enforcement === 'warn'
      ? { outcome: 'would_block', reason }
      : { outcome: 'suppress', reason };
  };
}

export interface GatedMessageDeliveryDeps {
  base: MessageDeliveryProvider;
  dnc: DncLookup;
  auditRepo: AuditRepository;
  /** Enforcement mode — the SAME value that drives the voice consent gate. */
  enforcement: SmsEnforcementMode;
}

export class GatedMessageDelivery implements MessageDeliveryProvider {
  private readonly evaluate: (message: SmsMessage) => Promise<SmsGateDecision>;

  constructor(private readonly deps: GatedMessageDeliveryDeps) {
    // Share the exact decision logic used by pre-send prechecks (single source).
    this.evaluate = evaluateCustomerSms({ dnc: deps.dnc, enforcement: deps.enforcement });
  }

  async sendSms(message: SmsMessage): Promise<DeliveryResult> {
    const decision = await this.evaluate(message);

    if (decision.outcome === 'would_block') {
      // Warn mode observes — audit then send anyway.
      await this.audit('sms.suppressed-would-block', decision.reason!, message);
      return this.deps.base.sendSms(message);
    }
    if (decision.outcome === 'suppress') {
      await this.audit('sms.suppressed', decision.reason!, message);
      throw new SmsSuppressedError(decision.reason!, message.recipientClass);
    }

    return this.deps.base.sendSms(message);
  }

  sendEmail(message: EmailMessage): Promise<DeliveryResult> {
    return this.deps.base.sendEmail(message);
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
            // Real enforcement mode — a DNC hard-floor suppression can fire in
            // 'off'/'warn', so don't infer the mode from the event type.
            mode: this.deps.enforcement,
          },
        }),
      );
    } catch {
      /* best-effort audit */
    }
  }
}
