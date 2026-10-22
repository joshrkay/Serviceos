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
 *   - Record. A customer text's outcome is recorded as one message record
 *     (`message_dispatches`, keyed by the dedupe key) linked to the customer,
 *     the record it is about and, when there is one, the job. That record
 *     drives the status bubble and the owner's view of blocked texts.
 *
 * The consent + DNC + kill-switch + volume-cap gate itself stays in
 * `GatedMessageDelivery`; this module is what decides the inputs that gate
 * used to take from each caller's discipline.
 */
import type { Pool } from 'pg';
import type { CustomerRepository } from '../customers/customer';
import { normalizePhone, type DncRepository } from '../compliance/dnc';
import type { Logger } from '../logging/logger';
import { UNKNOWN_PROVIDER, type DispatchEntityType, type DispatchRepository } from './dispatch-repository';
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
import { markSendClaimComplete, readSendClaimStatus, withSendClaim } from './send-claim-ledger';

/** Why a text is going out. Decides quiet hours and how strict consent is. */
export type MessagePurpose = 'transactional' | 'reply' | 'automated_nudge' | 'marketing';

export type MessageRecipient =
  | { kind: 'customer'; customerId: string }
  | { kind: 'owner'; phone: string; alertClass?: SmsAlertClass }
  | { kind: 'reply'; phone: string; customerId?: string };

/**
 * What a customer text is about, for its message record: the record it
 * concerns (an invoice, an estimate, a job's thank-you) and the job, if any.
 */
export interface MessageAbout {
  entityType: DispatchEntityType;
  entityId: string;
  jobId?: string;
}

/**
 * A reply recipient carries only the consent its inbound message gave, which
 * covers a reply and nothing else, so the type pairs it with that purpose.
 * A customer-facing text says what it is about; a text to the owner has no
 * message record.
 */
export type AddressedTo =
  | { recipient: Extract<MessageRecipient, { kind: 'reply' }>; purpose: 'reply'; about: MessageAbout }
  | { recipient: Extract<MessageRecipient, { kind: 'customer' }>; purpose: MessagePurpose; about: MessageAbout }
  | { recipient: Extract<MessageRecipient, { kind: 'owner' }>; purpose: MessagePurpose; about?: never };

export type OutboundText = AddressedTo & {
  tenantId: string;
  /**
   * Required dedupe key: the kind of message and the record it is about. The
   * send is claimed under `${messageKind}:${recordId}`, so at most one text
   * goes out per pair.
   */
  dedupe: { messageKind: string; recordId: string };
  body: string;
};

export type MessageBlockReason =
  | SmsSuppressionReason
  | 'customer_not_found'
  | 'no_phone'
  /** A marketing text to a number with no standing marketing grant. */
  | 'no_marketing_consent'
  /**
   * Another attempt holds this dedupe key and has not finished. Nothing is
   * known to have gone out; the holder may still fail, so try again later.
   */
  | 'in_flight'
  | 'send_failed';

export type SendOutcome =
  | {
      status: 'sent';
      /** The provider's receipt; absent when an earlier attempt already sent it. */
      delivery?: DeliveryResult;
      /**
       * Set when this call did not send because an earlier attempt under the
       * same dedupe key already did.
       */
      duplicate?: 'sent';
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

/** Extra attempts at the 'sent' tombstone after the provider accepted a text. */
const FINALIZE_RETRIES = 2;

const WAITS_FOR_DAYTIME: ReadonlySet<MessagePurpose> = new Set<MessagePurpose>([
  'automated_nudge',
  'marketing',
]);

export interface OutboundMessagingDeps {
  /**
   * The gated delivery object (`GatedMessageDelivery` in app.ts). It must call
   * a message's `onProviderStarting` right before the provider send; that is
   * where the dedupe claim becomes `'sending'`.
   */
  delivery: MessageDeliveryProvider;
  customerRepo: Pick<CustomerRepository, 'findById'>;
  dncRepo: Pick<DncRepository, 'isOnDnc'>;
  /** Consent ledger (newest first), read for a marketing grant. */
  consentLedger: ConsentLedgerLookup;
  /** Send-claim ledger pool. Null in dev/test without a DB: no dedupe claim. */
  pool: Pool | null;
  /** Where each customer text's outcome is recorded. */
  dispatchRepo: Pick<DispatchRepository, 'recordOutcome'>;
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
  /**
   * Resolves the recipient into a gate-ready message, or a block (with the
   * number when one was found, for the message record).
   */
  async function address(
    text: OutboundText,
  ): Promise<{ message: SmsMessage } | { outcome: SendOutcome; to: string }> {
    const { tenantId, recipient, purpose, body } = text;
    const quietHours = WAITS_FOR_DAYTIME.has(purpose) ? ({ quietHours: 'defer' } as const) : {};

    if (recipient.kind === 'owner') {
      return {
        message: {
          to: recipient.phone,
          body,
          tenantId,
          recipientClass: 'owner',
          ...(recipient.alertClass ? { alertClass: recipient.alertClass } : {}),
        },
      };
    }

    if (recipient.kind === 'reply') {
      // The customer started this thread, which is the consent for a reply —
      // and only a reply. The type forbids any other purpose; this holds for
      // a caller that got past it.
      const to = recipient.phone;
      if (purpose !== 'reply') return { outcome: blocked('no_consent'), to };
      return {
        message: {
          to,
          body,
          tenantId,
          recipientClass: 'customer',
          consent: {
            smsConsent: true,
            ...(recipient.customerId ? { customerId: recipient.customerId } : {}),
          },
          ...quietHours,
        },
      };
    }

    const customer = await deps.customerRepo.findById(tenantId, recipient.customerId);
    if (!customer) return { outcome: blocked('customer_not_found'), to: '' };
    const to = customer.primaryPhone;
    if (!to) return { outcome: blocked('no_phone'), to: '' };
    if (WAITS_FOR_DAYTIME.has(purpose)) {
      // A message nobody asked for needs the customer's own yes, whatever mode
      // the gate's enforcement is in.
      if (customer.smsConsent !== true) return { outcome: blocked('no_consent'), to };
      if (await deps.dncRepo.isOnDnc(tenantId, normalizePhone(to))) {
        return { outcome: blocked('dnc'), to };
      }
    }
    if (purpose === 'marketing' && !(await hasMarketingGrant(tenantId, to))) {
      return { outcome: blocked('no_marketing_consent'), to };
    }
    return {
      message: {
        to,
        body,
        tenantId,
        recipientClass: 'customer',
        consent: { smsConsent: customer.smsConsent === true, customerId: customer.id },
        ...quietHours,
      },
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
    const claimKey = outboundClaimKey(text.dedupe);
    let addressed: Awaited<ReturnType<typeof address>>;
    try {
      // A text that already went out is reported as sent before anything else
      // is looked up: the customer may have lost their number or opted out
      // since, and a retry by a caller that crashed before recording the
      // first send must not record a delivered text as blocked.
      if (deps.pool && (await readSendClaimStatus(deps.pool, text.tenantId, claimKey)) === 'sent') {
        return record(text, '', { status: 'sent', duplicate: 'sent' });
      }
      addressed = await address(text);
    } catch (err) {
      // A failed claim, customer, DNC or ledger read is not a verdict: nothing
      // was sent, and a later attempt may get through.
      const outcome = blocked('send_failed', err instanceof Error ? err.message : String(err));
      deps.logger.warn('Outbound text recipient lookup failed', logFields(text, outcome));
      return record(text, '', outcome);
    }
    if ('outcome' in addressed) {
      deps.logger.info('Outbound text blocked before sending', logFields(text, addressed.outcome));
      return record(text, addressed.to, addressed.outcome);
    }
    const message: SmsMessage = { ...addressed.message, idempotencyKey: claimKey };
    return record(text, message.to, await deliver(text, claimKey, message));
  }

  /** Sends an addressed text under its dedupe claim. */
  async function deliver(text: OutboundText, claimKey: string, message: SmsMessage): Promise<SendOutcome> {
    let outcome: SendOutcome;
    // Set the moment the provider accepts, so a ledger failure AFTER that
    // (finalizing the claim) is still reported as the delivery it was.
    let delivered: DeliveryResult | undefined;
    try {
      if (!deps.pool) {
        outcome = { status: 'sent', delivery: await deps.delivery.sendSms(message) };
      } else {
        // Deferred: the claim stays 'claimed' (reclaimable if the process
        // dies) through the gate's consent, DNC, window and cap reads, and
        // becomes 'sending' only when the gate is about to call the provider.
        const claim = await withSendClaim(
          deps.pool,
          text.tenantId,
          claimKey,
          async (_markProviderAccepted, markProviderStarting) => {
            delivered = await deps.delivery.sendSms({
              ...message,
              onProviderStarting: markProviderStarting,
            });
            return delivered;
          },
          undefined,
          { deferSendingUntilProviderStart: true },
        );
        outcome =
          claim.outcome === 'sent'
            ? { status: 'sent', delivery: claim.result }
            : claim.priorStatus === 'sent'
              ? { status: 'sent', duplicate: 'sent' }
              : blocked('in_flight');
      }
    } catch (err) {
      if (delivered) {
        // The text went out; only marking the claim 'sent' failed. Try the
        // tombstone again: once it lands, a caller that fails to record this
        // send gets `duplicate: 'sent'` on its retry and can reconcile.
        const sent: SendOutcome = { status: 'sent', delivery: delivered };
        if (!(await finalizeClaim(text.tenantId, claimKey))) {
          // Still 'sending', which is never reclaimed, so no retry resends
          // it; `findStuckSendClaims` surfaces the row for an operator.
          deps.logger.warn('Outbound text sent but its dedupe claim is stuck at sending', {
            ...logFields(text, sent),
            claimKey,
            error: err instanceof Error ? err.message : String(err),
          });
        }
        return sent;
      }
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

  /**
   * Records a customer text's outcome as its message record and returns the
   * outcome unchanged. Not recorded: a text to the owner, and an 'in_flight'
   * block (the attempt holding the key records its own outcome). A send an
   * earlier attempt already made is recorded too: if that attempt's write
   * failed, this backfills it ("sent", number and provider unknown); if it
   * landed, the existing sent row stands. A failed write is logged; it never
   * turns a delivered text into a failure.
   */
  async function record(text: OutboundText, to: string, outcome: SendOutcome): Promise<SendOutcome> {
    if (!text.about) return outcome;
    if (outcome.status === 'blocked' && outcome.reason === 'in_flight') return outcome;
    const { about } = text;
    try {
      await deps.dispatchRepo.recordOutcome({
        tenantId: text.tenantId,
        idempotencyKey: outboundClaimKey(text.dedupe),
        entityType: about.entityType,
        entityId: about.entityId,
        channel: 'sms',
        recipient: to,
        purpose: text.purpose,
        customerId: text.recipient.customerId,
        jobId: about.jobId,
        outcome:
          outcome.status === 'sent'
            ? {
                status: 'sent',
                provider: outcome.delivery?.provider ?? UNKNOWN_PROVIDER,
                providerMessageId: outcome.delivery?.providerMessageId,
              }
            : outcome.status === 'scheduled'
              ? { status: 'scheduled', scheduledFor: outcome.at }
              : {
                  status: 'blocked',
                  reason: outcome.reason,
                  permanent: outcome.permanent,
                  ...(outcome.detail ? { detail: outcome.detail } : {}),
                },
      });
    } catch (err) {
      deps.logger.warn('Outbound text outcome was not recorded', {
        ...logFields(text, outcome),
        error: err instanceof Error ? err.message : String(err),
      });
    }
    return outcome;
  }

  /** Retries the 'sent' tombstone after a delivered text. True once it lands. */
  async function finalizeClaim(tenantId: string, claimKey: string): Promise<boolean> {
    for (let attempt = 0; attempt < FINALIZE_RETRIES; attempt++) {
      try {
        await markSendClaimComplete(deps.pool!, tenantId, claimKey);
        return true;
      } catch {
        // Fall through to the next attempt.
      }
    }
    return false;
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
