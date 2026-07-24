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

/**
 * Thrown by an `eligibilityCheck` that fires inside the claimed critical
 * section (RIVET I10). Treated as a benign suppression by `sendOneChannel`
 * (info log, no dispatch row, claim released) — never a failure. Neutrally
 * named because it guards both SMS and email, unlike the consent/DNC
 * `SmsSuppressedError`.
 */
export class EligibilitySuppressedError extends Error {
  constructor(public readonly reason: string) {
    super(`send suppressed by eligibility recheck: ${reason}`);
    this.name = 'EligibilitySuppressedError';
  }
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
  /**
   * RIVET I10 — last-moment eligibility recheck. Runs INSIDE the send claim,
   * immediately before EACH channel's provider dispatch (so email is
   * re-checked after SMS, and the check reflects state live at the actual
   * send, not at caller entry). Return a suppression reason to abort that
   * channel's send (throws EligibilitySuppressedError → claim released, no
   * dispatch row, so the occurrence can still fire later if the condition
   * that justified suppression reverses), or null to proceed. The window this
   * closes: a payment webhook settling the invoice between the caller's
   * pre-send read and the provider call — a paid invoice must never be dunned.
   */
  eligibilityCheck?: () => Promise<string | null>;
}

/** Aggregate outcome of a customer-message send across its channels. */
export interface SendCustomerMessageResult {
  /** True iff the eligibilityCheck suppressed every channel that would have
   * otherwise dispatched — i.e. NOTHING went to a provider. Callers that gate
   * on live state (dunning reminders) use this to record suppression, not a
   * false "sent". */
  eligibilitySuppressed: boolean;
  eligibilityReason?: string;
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
): Promise<SendCustomerMessageResult> {
  const { customer, tenantId, channels } = input;

  // Per-channel eligibility recheck (RIVET I10), run INSIDE the claim right
  // before the provider call. Suppressing a channel throws
  // EligibilitySuppressedError, which sendOneChannel treats as benign and
  // reports back here; a channel that never attempts a send (no recipient /
  // body) is not a suppression.
  const runEligibility = input.eligibilityCheck;
  const guard = async (): Promise<void> => {
    if (!runEligibility) return;
    const reason = await runEligibility();
    if (reason) throw new EligibilitySuppressedError(reason);
  };
  let attempted = 0;
  let suppressed = 0;
  let eligibilityReason: string | undefined;

  if (channels.includes('sms') && input.smsBody && customer.primaryPhone) {
    const recipient = customer.primaryPhone;
    attempted++;
    const r = await sendOneChannel(
      deps,
      input,
      'sms',
      recipient,
      async (idempotencyKey, markProviderStarting) => {
        await guard();
        // Advance the claim to 'sending' only now — eligibility passed and the
        // provider call is next (a crash during guard() above left it
        // reclaimable).
        await markProviderStarting();
        return deps.delivery.sendSms({
          to: recipient,
          body: input.smsBody as string,
          tenantId,
          idempotencyKey,
          recipientClass: 'customer',
          consent: { smsConsent: customer.smsConsent === true, customerId: customer.id },
        });
      },
    );
    if (r?.eligibilitySuppressed) {
      suppressed++;
      eligibilityReason ??= r.eligibilityReason;
    }
  }

  if (channels.includes('email') && input.emailSubject && input.emailText && customer.email) {
    const recipient = customer.email;
    attempted++;
    const r = await sendOneChannel(
      deps,
      input,
      'email',
      recipient,
      async (idempotencyKey, markProviderStarting) => {
        await guard();
        await markProviderStarting();
        return deps.delivery.sendEmail({
          to: recipient,
          subject: input.emailSubject as string,
          text: input.emailText as string,
          html: input.emailHtml,
          tenantId,
          idempotencyKey,
        });
      },
    );
    if (r?.eligibilitySuppressed) {
      suppressed++;
      eligibilityReason ??= r.eligibilityReason;
    }
  }

  // Suppressed only when EVERY attempted channel was eligibility-suppressed
  // (nothing reached a provider). If SMS went out before payment landed and
  // only the later email was suppressed, the customer WAS contacted — not a
  // suppression from the caller's perspective.
  return {
    eligibilitySuppressed: attempted > 0 && suppressed === attempted,
    ...(eligibilityReason ? { eligibilityReason } : {}),
  };
}

async function sendOneChannel(
  deps: CustomerMessageDeliveryDeps,
  input: SendCustomerMessageInput,
  channel: CustomerMessageChannel,
  recipient: string,
  /** The eligibility recheck + provider call — no bookkeeping. See module doc
   * (Codex P1 #2). `markProviderStarting` advances the claim to the
   * never-reclaimed 'sending' state; the closure MUST call it only AFTER the
   * eligibility recheck passes and immediately before the provider dispatch,
   * so a crash during the recheck leaves a reclaimable 'claimed' row rather
   * than permanently stranding the occurrence. The recheck throws
   * EligibilitySuppressedError BEFORE that, so the claim is released. */
  send: (
    idempotencyKey: string,
    markProviderStarting: () => Promise<void>,
  ) => Promise<DeliveryResult>,
): Promise<{ eligibilitySuppressed: boolean; eligibilityReason?: string }> {
  const claimKey = `${input.idempotencyKeyPrefix}:${channel}`;
  try {
    let result: DeliveryResult | undefined;
    if (deps.pool) {
      // Deferred mode (Codex P2): keep the claim reclaimable through the
      // eligibility recheck's pre-provider prep — the CAS to 'sending' runs
      // only when the closure calls markProviderStarting(), right before the
      // provider call.
      const outcome = await withSendClaim(
        deps.pool,
        input.tenantId,
        claimKey,
        (_markProviderAccepted, markProviderStarting) => send(claimKey, markProviderStarting),
        undefined,
        { deferSendingUntilProviderStart: true },
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
        return { eligibilitySuppressed: false };
      }
      result = outcome.result;
    } else {
      // No claim ledger (dev/test without a DB) — markProviderStarting is a
      // no-op; the eligibility recheck inside `send` still runs.
      result = await send(claimKey, async () => {});
    }

    await recordDispatch(deps, input, channel, recipient, claimKey, result);
    return { eligibilitySuppressed: false };
  } catch (err) {
    // Best-effort (includes central gate suppression) — never propagate, per
    // this function's documented contract. R5: no longer silent, though.
    if (err instanceof EligibilitySuppressedError) {
      // RIVET I10 — the last-moment recheck aborted this channel's send
      // (e.g. the invoice was paid between caller entry and dispatch). The
      // claim was released (thrown before the provider call), so a later
      // legitimate occurrence can still fire. Report it so the caller records
      // suppression, not a false "sent".
      deps.logger.info('Customer message suppressed by send-time eligibility recheck', {
        tenantId: input.tenantId,
        entityType: input.entityType,
        entityId: input.entityId,
        channel,
        reason: err.reason,
      });
      return { eligibilitySuppressed: true, eligibilityReason: err.reason };
    }
    if (err instanceof SmsSuppressedError) {
      deps.logger.info('Customer SMS suppressed by the consent/DNC gate', {
        tenantId: input.tenantId,
        entityType: input.entityType,
        entityId: input.entityId,
        channel,
        reason: err.reason,
      });
      return { eligibilitySuppressed: false };
    }
    deps.logger.warn('Customer message send failed', {
      tenantId: input.tenantId,
      entityType: input.entityType,
      entityId: input.entityId,
      channel,
      error: err instanceof Error ? err.message : String(err),
    });
    return { eligibilitySuppressed: false };
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
