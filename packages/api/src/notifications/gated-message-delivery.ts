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
 *
 * ── Runtime outbound kill switch (per channel) ──────────────────────────────
 *
 * `TELEPHONY_ENABLED=false` stops every outbound SMS; `EMAIL_ENABLED=false`
 * stops every outbound email. The two are independent, and BOTH are checked
 * here — the single chokepoint every product send already flows through
 * (app.ts wraps the one `rawMessageDelivery` object in this class, and every
 * consumer takes the wrapped `messageDelivery`).
 *
 * Semantics, matching the existing comparison style in shared/config.ts:
 *   - flag unset            → channel ENABLED (dev/QA/test behavior unchanged)
 *   - flag === 'false'      → channel HARD OFF
 *   - any other value       → channel ENABLED
 *
 * Unlike the consent gate, the kill switch is checked BEFORE the
 * `recipientClass: 'owner'` bypass. That is deliberate: the promise is "no
 * outbound traffic at all", not "no customer traffic". An owner digest is
 * still an outbound message on a real carrier/ESP account.
 *
 * Observability: a disabled channel must not be indistinguishable from no
 * traffic. Every suppression emits an info log with the greppable
 * `reason: 'channel_disabled'` plus tenantId, channel, recipientClass and a
 * REDACTED recipient (phone last-4 / email domain only — the same redaction
 * shapes already used by the suppression audit below and by the signup funnel
 * event in webhooks/routes.ts), and bumps an in-process counter readable via
 * `killSwitchSuppressionCounts()`.
 */
import { AuditRepository, createAuditEvent } from '../audit/audit';
import { createLogger, type Logger } from '../logging/logger';
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
  | 'revoked'
  /** Runtime kill switch — TELEPHONY_ENABLED=false. Applies to owner sends too. */
  | 'channel_disabled';

/** The two outbound channels the kill switch gates, independently. */
export type OutboundChannel = 'sms' | 'email';

/** Env var that hard-disables each channel when set to the literal 'false'. */
const KILL_SWITCH_ENV_VAR: Record<OutboundChannel, 'TELEPHONY_ENABLED' | 'EMAIL_ENABLED'> = {
  sms: 'TELEPHONY_ENABLED',
  email: 'EMAIL_ENABLED',
};

/**
 * Unset (or anything other than the literal 'false') = ENABLED, so dev/QA/test
 * behavior is byte-identical to before this switch existed. The `!== 'false'`
 * comparison mirrors `validateFeatureRequiredConfig` in shared/config.ts, so
 * the boot-time presence check and this runtime gate can never disagree about
 * what "off" means.
 */
export function isOutboundChannelEnabled(
  channel: OutboundChannel,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return env[KILL_SWITCH_ENV_VAR[channel]] !== 'false';
}

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
 * Email counterpart of `SmsSuppressedError`, thrown when the EMAIL_ENABLED
 * kill switch is off.
 *
 * Email has no pre-existing suppression path, so this is a new type — but NOT
 * a new caller contract. Every `sendEmail` call site already has to cope with
 * a thrown error, because that is exactly how a SendGrid 4xx/5xx surfaces
 * today (`DeliveryError` from TwilioDeliveryProvider). Sites either swallow it
 * (best-effort notifiers, activation email, campaign send), record a failed
 * dispatch row and re-surface it (SendService, conversation replies), or let a
 * queued job retry (lifecycle emails, whose claim is rolled back first). So a
 * suppressed email degrades exactly like an ESP outage: never a crash, never
 * an unhandled rejection, never a silent false "delivered".
 */
export class EmailSuppressedError extends Error {
  readonly suppressed = true;
  constructor(readonly reason: 'channel_disabled' = 'channel_disabled') {
    super(`Email suppressed: ${reason}`);
    this.name = 'EmailSuppressedError';
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
  /**
   * Sink for kill-switch suppression logs. Optional so existing construction
   * sites and tests are unchanged; defaults to a module-scoped logger.
   */
  logger?: Pick<Logger, 'info'>;
  /**
   * Environment the kill switch reads. Test seam only — defaults to
   * `process.env`, read per send so the switch is a runtime gate rather than a
   * boot-time snapshot.
   */
  env?: NodeJS.ProcessEnv;
}

let fallbackLogger: Logger | undefined;
function defaultKillSwitchLogger(): Pick<Logger, 'info'> {
  fallbackLogger ??= createLogger({
    service: 'outbound-kill-switch',
    environment: process.env.NODE_ENV || 'development',
  });
  return fallbackLogger;
}

export class GatedMessageDelivery implements MessageDeliveryProvider {
  /**
   * In-process tally of sends stopped by the kill switch, per channel. The
   * ledger (`message_dispatches`) cannot hold these — see the note on
   * `logKillSwitchSuppression` — so this counter plus the info log is the
   * "what would have been sent" signal an operator gets before enabling a
   * channel in production.
   */
  private readonly killSwitchSuppressions: Record<OutboundChannel, number> = {
    sms: 0,
    email: 0,
  };

  constructor(private readonly deps: GatedMessageDeliveryDeps) {}

  /** Snapshot of the per-channel kill-switch suppression counters. */
  killSwitchSuppressionCounts(): Record<OutboundChannel, number> {
    return { ...this.killSwitchSuppressions };
  }

  async sendSms(message: SmsMessage): Promise<DeliveryResult> {
    // Kill switch FIRST — deliberately ahead of the owner bypass below. The
    // guarantee is "no outbound SMS at all", so an owner digest is stopped
    // too; the consent gate's owner carve-out does not apply here.
    if (!isOutboundChannelEnabled('sms', this.deps.env)) {
      this.logKillSwitchSuppression('sms', message.tenantId, message.recipientClass, {
        // Same redaction shape as the suppression audit below: last 4 only.
        phoneLast4: normalizePhone(message.to).slice(-4),
      });
      throw new SmsSuppressedError('channel_disabled', message.recipientClass);
    }

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

  async sendEmail(message: EmailMessage): Promise<DeliveryResult> {
    // Independent of the SMS switch: EMAIL_ENABLED=false stops email only.
    // There is no consent gate on this channel (the TCPA gate is SMS-only),
    // so the kill switch is the whole of the check here.
    if (!isOutboundChannelEnabled('email', this.deps.env)) {
      this.logKillSwitchSuppression(
        'email',
        message.tenantId,
        // EmailMessage carries no audience tag — say so rather than guess.
        'unspecified',
        // Domain only, matching the signup funnel event in webhooks/routes.ts.
        { emailDomain: message.to.split('@')[1] ?? null },
      );
      throw new EmailSuppressedError('channel_disabled');
    }
    return this.deps.base.sendEmail(message);
  }

  /**
   * Info-level, greppable on `channel_disabled`, with the recipient reduced to
   * a non-identifying fragment (phone last-4 / email domain).
   *
   * Why not a `message_dispatches` row? Three hard blockers, all verified:
   * `status` is CHECK-constrained to ('sent','delivered','failed','bounced')
   * so a 'suppressed' value needs a DB migration; `entity_type` is likewise
   * CHECK-constrained and `entity_id` is UUID NOT NULL, and neither
   * `SmsMessage` nor `EmailMessage` carries either — the gate simply does not
   * know which estimate/invoice/appointment a send belongs to; and the dunning
   * logic plus the QA fixtures count rows in that table, so injecting
   * gate-level rows would distort them. The layers that DO know the entity
   * still record suppression there through the existing
   * `provider: 'suppressed', status: 'failed'` convention (see
   * notifications/send-service.ts) — this log is the catch-all for every other
   * send site.
   */
  private logKillSwitchSuppression(
    channel: OutboundChannel,
    tenantId: string | undefined,
    recipientClass: SmsMessage['recipientClass'] | 'unspecified',
    redactedRecipient: Record<string, string | null>,
  ): void {
    this.killSwitchSuppressions[channel] += 1;
    const logger = this.deps.logger ?? defaultKillSwitchLogger();
    logger.info('Outbound message suppressed by the channel kill switch', {
      reason: 'channel_disabled',
      channel,
      tenantId: tenantId ?? 'unknown',
      recipientClass,
      killSwitchEnvVar: KILL_SWITCH_ENV_VAR[channel],
      suppressedCount: this.killSwitchSuppressions[channel],
      ...redactedRecipient,
    });
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
