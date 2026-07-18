import type { Pool } from 'pg';
import { DeliveryResult, MessageDeliveryProvider } from './delivery-provider';
import { SmsSuppressedError } from './gated-message-delivery';
import { DispatchRepository, DispatchEntityType } from './dispatch-repository';
import { Customer } from '../customers/customer';
import { withSendClaim } from './send-claim-ledger';
import type { Logger } from '../logging/logger';

export type CustomerMessageChannel = 'sms' | 'email';

export interface CustomerMessageDeliveryDeps {
  delivery: MessageDeliveryProvider;
  dispatchRepo: DispatchRepository;
  /**
   * T4-F01 claim ledger pool. Null in dev/test without a DB — the claim
   * wrapper no-ops and the send proceeds directly (matches the no-DB-no-op
   * posture elsewhere in notifications/).
   */
  pool: Pool | null;
  /**
   * R5 (T4-F01 adjacent) — a send failure is now logged instead of silently
   * swallowed. Still required so every call site is forced to wire
   * observability rather than silently omitting it.
   */
  logger: Logger;
}

export interface SendCustomerMessageInput {
  tenantId: string;
  customer: Customer;
  entityType: DispatchEntityType;
  entityId: string;
  channels: CustomerMessageChannel[];
  smsBody?: string;
  emailSubject?: string;
  emailText?: string;
  emailHtml?: string;
  idempotencyKeyPrefix: string;
}

/**
 * Best-effort SMS/email send with dispatch logging. The sms_consent + DNC gate
 * is applied centrally by the GatedMessageDelivery wrapper (`delivery`); this
 * function just declares the audience (customer) and forwards the stored
 * consent flag.
 *
 * T4-F01 — the send is claimed BEFORE the provider call runs, keyed
 * identically to `message_dispatches.idempotency_key`
 * (`${idempotencyKeyPrefix}:{channel}`), so a crash/restart before the
 * provider ever accepts the message can't cause a caller retry to
 * double-send.
 *
 * Codex P1 #2 follow-up — ONLY the provider call sits inside the claimed
 * critical section (`send`, below). The dispatchRepo.create bookkeeping runs
 * AFTER `withSendClaim` reports `{outcome: 'sent'}`, in its own try/catch
 * (see `recordDispatch`) that logs on failure but never releases the claim:
 * the message really was sent, so a released claim here would let a retry
 * duplicate it. A missing dispatch row from a bookkeeping failure is the
 * already-handled reconcilable case below (`hasDispatchRow` check on the
 * duplicate-'sent' branch), never grounds for a resend. The dispatchRepo
 * unique-index-on-conflict safety net (a second layer, closing a DIFFERENT
 * window — two claims both believing they'd won) stays in place unchanged.
 *
 * R5 — a send failure is no longer silently swallowed: an expected
 * consent/DNC suppression (`SmsSuppressedError`) logs at `info` (benign,
 * already audited by the gate itself); any other failure logs a `warn` with
 * the tenant/entity/error. Either way this function still resolves (never
 * throws) so the caller's business mutation is never blocked — matching this
 * function's existing "transactional comms never block business mutations"
 * contract.
 */
export async function sendCustomerMessage(
  deps: CustomerMessageDeliveryDeps,
  input: SendCustomerMessageInput,
): Promise<void> {
  const { customer, tenantId, channels } = input;

  if (channels.includes('sms') && input.smsBody && customer.primaryPhone) {
    const recipient = customer.primaryPhone;
    await sendOneChannel(deps, input, 'sms', recipient, (idempotencyKey) =>
      deps.delivery.sendSms({
        to: recipient,
        body: input.smsBody as string,
        tenantId,
        idempotencyKey,
        recipientClass: 'customer',
        consent: { smsConsent: customer.smsConsent === true, customerId: customer.id },
      }),
    );
  }

  if (channels.includes('email') && input.emailSubject && input.emailText && customer.email) {
    const recipient = customer.email;
    await sendOneChannel(deps, input, 'email', recipient, (idempotencyKey) =>
      deps.delivery.sendEmail({
        to: recipient,
        subject: input.emailSubject as string,
        text: input.emailText as string,
        html: input.emailHtml,
        tenantId,
        idempotencyKey,
      }),
    );
  }
}

async function sendOneChannel(
  deps: CustomerMessageDeliveryDeps,
  input: SendCustomerMessageInput,
  channel: CustomerMessageChannel,
  recipient: string,
  /** ONLY the provider call — no bookkeeping. See module doc (Codex P1 #2). */
  send: (idempotencyKey: string) => Promise<DeliveryResult>,
): Promise<void> {
  const claimKey = `${input.idempotencyKeyPrefix}:${channel}`;
  try {
    let result: DeliveryResult | undefined;
    if (deps.pool) {
      const outcome = await withSendClaim(deps.pool, input.tenantId, claimKey, () =>
        send(claimKey),
      );
      if (outcome.outcome === 'duplicate') {
        // Only a 'sent' tombstone with NO dispatch row is inconsistent
        // (crash/failure between the provider call succeeding and the
        // dispatchRepo.create write) and worth an operator warn (R5). An
        // in-flight 'claimed' loser is this ledger working as designed —
        // the racing process hasn't written its dispatch row YET, so
        // checking for one here would false-positive the warn.
        if (outcome.priorStatus !== 'sent') {
          deps.logger.info('Customer message claim held by another in-flight send — skipping', {
            tenantId: input.tenantId,
            entityType: input.entityType,
            entityId: input.entityId,
            channel,
          });
        } else {
          const existing = await deps.dispatchRepo.findByEntity(
            input.tenantId,
            input.entityType,
            input.entityId,
          );
          const hasDispatchRow = existing.some((d) => d.idempotencyKey === claimKey);
          if (hasDispatchRow) {
            deps.logger.info('Customer message already claimed — skipping duplicate send', {
              tenantId: input.tenantId,
              entityType: input.entityType,
              entityId: input.entityId,
              channel,
            });
          } else {
            deps.logger.warn(
              'Customer message claim is "sent" but no dispatch row exists — crash between send and dispatch-row write?',
              {
                tenantId: input.tenantId,
                entityType: input.entityType,
                entityId: input.entityId,
                channel,
              },
            );
          }
        }
        return;
      }
      result = outcome.result;
    } else {
      result = await send(claimKey);
    }

    await recordDispatch(deps, input, channel, recipient, claimKey, result);
  } catch (err) {
    // Best-effort (includes central gate suppression) — never propagate, per
    // this function's documented contract. R5: no longer silent, though.
    if (err instanceof SmsSuppressedError) {
      deps.logger.info('Customer SMS suppressed by the consent/DNC gate', {
        tenantId: input.tenantId,
        entityType: input.entityType,
        entityId: input.entityId,
        channel,
        reason: err.reason,
      });
      return;
    }
    deps.logger.warn('Customer message send failed', {
      tenantId: input.tenantId,
      entityType: input.entityType,
      entityId: input.entityId,
      channel,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Codex P1 #2 follow-up — runs AFTER the provider call succeeded (and, when a
 * pool is wired, after the claim is already finalized to 'sent'). A failure
 * here is logged and swallowed, never allowed to propagate back into a
 * release: the message genuinely went out.
 */
async function recordDispatch(
  deps: CustomerMessageDeliveryDeps,
  input: SendCustomerMessageInput,
  channel: CustomerMessageChannel,
  recipient: string,
  idempotencyKey: string,
  result: DeliveryResult,
): Promise<void> {
  try {
    await deps.dispatchRepo.create({
      tenantId: input.tenantId,
      entityType: input.entityType,
      entityId: input.entityId,
      channel,
      recipient,
      provider: result.provider,
      providerMessageId: result.providerMessageId,
      status: 'sent',
      idempotencyKey,
    });
  } catch (err) {
    deps.logger.warn('Customer message sent but the dispatch-row write failed', {
      tenantId: input.tenantId,
      entityType: input.entityType,
      entityId: input.entityId,
      channel,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
