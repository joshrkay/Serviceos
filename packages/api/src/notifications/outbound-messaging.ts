/**
 * Outbound messaging (D-045) — the one place a text's policy is decided.
 *
 * A sender says WHO the text is for and WHY it is going out; this module
 * decides everything that follows from that, so no sender can get it wrong:
 *
 *   - Recipient. A customer is named by id and the module loads the number and
 *     the stored consent itself; the owner or team is named by role and their
 *     number; a reply goes to a number that just contacted us (the customer
 *     started the thread, so the reply carries consent, but DNC and a standing
 *     revocation still block it in the gate).
 *   - Message purpose. `transactional` and `reply` go now. `automated_nudge`
 *     and `marketing` wait for the recipient's daytime window and, whatever
 *     the gate's enforcement mode, need the customer's own SMS consent and a
 *     number off the tenant DNC list. `marketing` also needs a standing
 *     marketing grant in the consent ledger (D-017: an SMS grant is not one).
 *   - Duplicates. A dedupe key (`messageKind` + `recordId`) is required; the
 *     send is claimed in the send-claim ledger under it, so a retry or a
 *     concurrent sweep never texts the same thing twice.
 *   - Outcome. Every call returns a send outcome instead of throwing, even
 *     when a lookup fails: sent,
 *     scheduled (with the time the window opens) or blocked (with the reason,
 *     and whether it can clear on its own). Nothing fails silently.
 *
 * The consent + DNC + kill-switch + volume-cap gate itself stays in
 * `GatedMessageDelivery`; this module is what decides the inputs that gate
 * used to take from each caller's discipline.
 */
import type { Pool } from 'pg';
import type { CustomerRepository } from '../customers/customer';
import { normalizePhone, type DncRepository } from '../compliance/dnc';
import type { Logger } from '../logging/logger';
import type {
  DeliveryResult,
  MessageDeliveryProvider,
  SmsAlertClass,
  SmsMessage,
} from './delivery-provider';
import {
  SmsDeferredError,
  SmsSuppressedError,
  type ConsentLedgerLookup,
  type SmsSuppressionReason,
} from './gated-message-delivery';
import { withSendClaim } from './send-claim-ledger';

/** Why a text is going out. Decides quiet hours and how strict consent is. */
export type MessagePurpose = 'transactional' | 'reply' | 'automated_nudge' | 'marketing';

export type MessageRecipient =
  | { kind: 'customer'; customerId: string }
  | { kind: 'owner'; phone: string; alertClass?: SmsAlertClass }
  | { kind: 'reply'; phone: string; customerId?: string };

export interface OutboundText {
  tenantId: string;
  recipient: MessageRecipient;
  purpose: MessagePurpose;
  /**
   * Required dedupe key: the kind of message and the record it is about. The
   * send is claimed under `${messageKind}:${recordId}`, so at most one text
   * goes out per pair.
   */
  dedupe: { messageKind: string; recordId: string };
  body: string;
}

export type MessageBlockReason =
  | SmsSuppressionReason
  | 'customer_not_found'
  | 'no_phone'
  /** A marketing text to a number with no standing marketing grant. */
  | 'no_marketing_consent'
  | 'send_failed';

export type SendOutcome =
  | {
      status: 'sent';
      /** The provider's receipt; absent when an earlier attempt already sent it. */
      delivery?: DeliveryResult;
      /**
       * Set when this call did not send because the dedupe key was already
       * claimed: 'sent' — an earlier attempt sent it; 'in_flight' — another
       * attempt holds the claim right now and will finish it.
       */
      duplicate?: 'sent' | 'in_flight';
    }
  | { status: 'scheduled'; at: Date; reason: 'quiet_hours' }
  | {
      status: 'blocked';
      reason: MessageBlockReason;
      /**
       * True when the reason will not clear without someone acting (the
       * customer opted out, there is no number). False for a kill switch, a
       * volume cap or a provider error, which a later attempt can get past.
       */
      permanent: boolean;
      /** The underlying error message for `send_failed`. */
      detail?: string;
    };

/**
 * Block reasons that will not clear on a later attempt. An allowlist, so a
 * reason added later defaults to retryable rather than to a silent discard.
 */
const PERMANENT_BLOCK_REASONS: ReadonlySet<MessageBlockReason> = new Set<MessageBlockReason>([
  'customer_not_found',
  'no_phone',
  'no_marketing_consent',
  'no_consent',
  'dnc',
  'revoked',
]);

const WAITS_FOR_DAYTIME: ReadonlySet<MessagePurpose> = new Set<MessagePurpose>([
  'automated_nudge',
  'marketing',
]);

export interface OutboundMessagingDeps {
  /** The gated delivery object (`GatedMessageDelivery` in app.ts). */
  delivery: MessageDeliveryProvider;
  customerRepo: Pick<CustomerRepository, 'findById'>;
  dncRepo: Pick<DncRepository, 'isOnDnc'>;
  /** Consent ledger (newest first), read for a marketing grant. */
  consentLedger: ConsentLedgerLookup;
  /** Send-claim ledger pool. Null in dev/test without a DB: no dedupe claim. */
  pool: Pool | null;
  logger: Pick<Logger, 'info' | 'warn'>;
}

export interface OutboundMessaging {
  sendText(text: OutboundText): Promise<SendOutcome>;
}

function blocked(reason: MessageBlockReason, detail?: string): SendOutcome {
  return {
    status: 'blocked',
    reason,
    permanent: PERMANENT_BLOCK_REASONS.has(reason),
    ...(detail ? { detail } : {}),
  };
}

/** The dedupe claim key a text is sent under. */
export function outboundClaimKey(dedupe: OutboundText['dedupe']): string {
  return `${dedupe.messageKind}:${dedupe.recordId}`;
}

export function createOutboundMessaging(deps: OutboundMessagingDeps): OutboundMessaging {
  /** Resolves the recipient into a gate-ready message, or a block. */
  async function address(text: OutboundText): Promise<SmsMessage | SendOutcome> {
    const { tenantId, recipient, purpose, body } = text;
    const quietHours = WAITS_FOR_DAYTIME.has(purpose) ? ({ quietHours: 'defer' } as const) : {};

    if (recipient.kind === 'owner') {
      return {
        to: recipient.phone,
        body,
        tenantId,
        recipientClass: 'owner',
        ...(recipient.alertClass ? { alertClass: recipient.alertClass } : {}),
      };
    }

    if (recipient.kind === 'reply') {
      // The customer started this thread, which is the consent for a reply.
      return {
        to: recipient.phone,
        body,
        tenantId,
        recipientClass: 'customer',
        consent: {
          smsConsent: true,
          ...(recipient.customerId ? { customerId: recipient.customerId } : {}),
        },
        ...quietHours,
      };
    }

    const customer = await deps.customerRepo.findById(tenantId, recipient.customerId);
    if (!customer) return blocked('customer_not_found');
    if (!customer.primaryPhone) return blocked('no_phone');
    if (WAITS_FOR_DAYTIME.has(purpose)) {
      // A message nobody asked for needs the customer's own yes, whatever mode
      // the gate's enforcement is in.
      if (customer.smsConsent !== true) return blocked('no_consent');
      if (await deps.dncRepo.isOnDnc(tenantId, normalizePhone(customer.primaryPhone))) {
        return blocked('dnc');
      }
    }
    if (purpose === 'marketing' && !(await hasMarketingGrant(tenantId, customer.primaryPhone))) {
      return blocked('no_marketing_consent');
    }
    return {
      to: customer.primaryPhone,
      body,
      tenantId,
      recipientClass: 'customer',
      consent: { smsConsent: customer.smsConsent === true, customerId: customer.id },
      ...quietHours,
    };
  }

  /** The newest explicit marketing event for the number is a grant. */
  async function hasMarketingGrant(tenantId: string, phone: string): Promise<boolean> {
    const events = await deps.consentLedger.listByPhone(tenantId, phone);
    const latest = events.find(
      (e) => e.kind === 'marketing' && (e.state === 'granted' || e.state === 'revoked'),
    );
    return latest?.state === 'granted';
  }

  async function sendText(text: OutboundText): Promise<SendOutcome> {
    let addressed: SmsMessage | SendOutcome;
    try {
      addressed = await address(text);
    } catch (err) {
      // A failed customer, DNC or ledger read is not a verdict: nothing was
      // sent, and a later attempt may get through.
      const outcome = blocked('send_failed', err instanceof Error ? err.message : String(err));
      deps.logger.warn('Outbound text recipient lookup failed', logFields(text, outcome));
      return outcome;
    }
    if ('status' in addressed) {
      deps.logger.info('Outbound text blocked before sending', logFields(text, addressed));
      return addressed;
    }
    const claimKey = outboundClaimKey(text.dedupe);
    const message: SmsMessage = { ...addressed, idempotencyKey: claimKey };

    let outcome: SendOutcome;
    try {
      if (!deps.pool) {
        outcome = { status: 'sent', delivery: await deps.delivery.sendSms(message) };
      } else {
        const claim = await withSendClaim(deps.pool, text.tenantId, claimKey, () =>
          deps.delivery.sendSms(message),
        );
        outcome =
          claim.outcome === 'sent'
            ? { status: 'sent', delivery: claim.result }
            : { status: 'sent', duplicate: claim.priorStatus === 'sent' ? 'sent' : 'in_flight' };
      }
    } catch (err) {
      // withSendClaim has already released the claim: nothing reached the
      // provider, so a later attempt may send.
      if (err instanceof SmsDeferredError) {
        outcome = { status: 'scheduled', at: err.nextAllowedAt, reason: 'quiet_hours' };
      } else if (err instanceof SmsSuppressedError) {
        outcome = blocked(err.reason);
      } else {
        outcome = blocked('send_failed', err instanceof Error ? err.message : String(err));
        deps.logger.warn('Outbound text failed', logFields(text, outcome));
        return outcome;
      }
    }
    if (outcome.status !== 'sent') deps.logger.info('Outbound text not sent', logFields(text, outcome));
    return outcome;
  }

  return { sendText };
}

function logFields(text: OutboundText, outcome: SendOutcome): Record<string, unknown> {
  return {
    tenantId: text.tenantId,
    recipientKind: text.recipient.kind,
    purpose: text.purpose,
    messageKind: text.dedupe.messageKind,
    recordId: text.dedupe.recordId,
    status: outcome.status,
    ...(outcome.status === 'blocked'
      ? { reason: outcome.reason, permanent: outcome.permanent, detail: outcome.detail }
      : {}),
    ...(outcome.status === 'scheduled' ? { at: outcome.at.toISOString() } : {}),
  };
}
