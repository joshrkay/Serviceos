import type { Pool } from 'pg';
import { MessageDeliveryProvider } from './delivery-provider';
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
 * T4-F01 — the send (+ the dispatch-row write) is claimed BEFORE the provider
 * call runs, keyed identically to `message_dispatches.idempotency_key`
 * (`${idempotencyKeyPrefix}:{channel}`), so a crash/restart between a
 * successful provider send and the dispatchRepo.create write can't cause a
 * caller retry to double-send. The dispatchRepo unique-index-on-conflict
 * safety net (a second layer, closing a DIFFERENT window — two claims both
 * believing they'd won) stays in place unchanged.
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
    await sendOneChannel(deps, input, 'sms', async () => {
      const idempotencyKey = `${input.idempotencyKeyPrefix}:sms`;
      const result = await deps.delivery.sendSms({
        to: customer.primaryPhone as string,
        body: input.smsBody as string,
        tenantId,
        idempotencyKey,
        recipientClass: 'customer',
        consent: { smsConsent: customer.smsConsent === true, customerId: customer.id },
      });
      await deps.dispatchRepo.create({
        tenantId,
        entityType: input.entityType,
        entityId: input.entityId,
        channel: 'sms',
        recipient: customer.primaryPhone as string,
        provider: result.provider,
        providerMessageId: result.providerMessageId,
        status: 'sent',
        idempotencyKey,
      });
    });
  }

  if (channels.includes('email') && input.emailSubject && input.emailText && customer.email) {
    await sendOneChannel(deps, input, 'email', async () => {
      const idempotencyKey = `${input.idempotencyKeyPrefix}:email`;
      const result = await deps.delivery.sendEmail({
        to: customer.email as string,
        subject: input.emailSubject as string,
        text: input.emailText as string,
        html: input.emailHtml,
        tenantId,
        idempotencyKey,
      });
      await deps.dispatchRepo.create({
        tenantId,
        entityType: input.entityType,
        entityId: input.entityId,
        channel: 'email',
        recipient: customer.email as string,
        provider: result.provider,
        providerMessageId: result.providerMessageId,
        status: 'sent',
        idempotencyKey,
      });
    });
  }
}

async function sendOneChannel(
  deps: CustomerMessageDeliveryDeps,
  input: SendCustomerMessageInput,
  channel: CustomerMessageChannel,
  send: () => Promise<void>,
): Promise<void> {
  const claimKey = `${input.idempotencyKeyPrefix}:${channel}`;
  try {
    if (deps.pool) {
      const outcome = await withSendClaim(deps.pool, input.tenantId, claimKey, send);
      if (outcome.outcome === 'duplicate') {
        // Distinguish the ordinary case (this occasion was already fully
        // handled — a dispatch row exists) from the genuinely-inconsistent
        // one (claim tombstoned 'sent' but the dispatch row write never
        // landed — a crash between the provider call succeeding and the
        // dispatchRepo.create write). The latter is worth operator
        // visibility (R5); the former is expected/benign.
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
    } else {
      await send();
    }
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
