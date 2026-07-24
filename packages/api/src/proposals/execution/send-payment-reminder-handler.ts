import { v4 as uuidv4 } from 'uuid';
import { Proposal, ProposalType } from '../proposal';
import { ExecutionHandler, ExecutionContext, ExecutionResult } from './handlers';
import { TransactionalCommsService } from '../../notifications/transactional-comms-service';
import { AuditRepository, createAuditEvent } from '../../audit/audit';
import {
  DunningEventRepository,
  PAYMENT_REMINDER_COOLDOWN_MS,
  manualReminderStepKey,
} from '../../invoices/dunning-config';
import { sendPaymentReminderPayloadSchema } from '../contracts/send-payment-reminder';

/**
 * Payload `stepKey` value the voice/manual on-ramp stamps
 * (SendPaymentReminderTaskHandler). It is the discriminator that selects the
 * execution-time dedup guard below: cadence-raised proposals carry a
 * `'<offsetDays>:<channel>'` key (their ledger row was already written by the
 * overdue sweep) and are never gated here; a manual send has no prior ledger
 * row, so this handler owns its cooldown check + record-first ledger write.
 */
const MANUAL_REMINDER_PAYLOAD_STEP_KEY = 'manual';

/**
 * Executes an approved `send_payment_reminder` proposal (collections cadence).
 *
 * Delivers an overdue-payment reminder to the customer through the existing
 * Layer-A transactional-comms path (the same send the overdue sweep used to
 * fire directly — now gated behind owner approval). The dunning cadence
 * controls timing/frequency (multi-step); v1 reuses the overdue-notice copy
 * for every step. The step metadata (`stepKey`, `offsetDays`, `channel`) is
 * carried on the payload for the audit trail and future per-step copy.
 *
 * Mirrors the other execution handlers: degrades to a synthetic-id
 * passthrough when no comms service is wired (unit tests that don't exercise
 * delivery), returns a failed ExecutionResult on a delivery error (never
 * throws through), and emits a failure-soft audit event.
 */
export class SendPaymentReminderExecutionHandler implements ExecutionHandler {
  proposalType: ProposalType = 'send_payment_reminder';
  // Awaits transactionalComms.notifyInvoiceOverdue → sendCustomerMessage →
  // delivery provider SMS/email — external network I/O.
  performsExternalIo = true;

  constructor(
    private readonly transactionalComms?: TransactionalCommsService,
    private readonly auditRepo?: AuditRepository,
    /**
     * Dunning-event ledger. When wired, MANUAL (voice/on-demand) reminders are
     * deduped against it: a 72h cooldown refusal + a record-first ledger write
     * that makes re-execution of the same approved proposal idempotent. Absent
     * → exact legacy behavior (no gating, no ledger write). Cadence-raised
     * reminders are never gated here regardless (their row exists already).
     */
    private readonly dunningEventRepo?: DunningEventRepository,
    /** Injectable clock for deterministic cooldown tests. */
    private readonly now: () => Date = () => new Date(),
  ) {}

  async execute(
    proposal: Proposal,
    context: ExecutionContext,
  ): Promise<ExecutionResult> {
    const parsed = sendPaymentReminderPayloadSchema.safeParse(proposal.payload);
    if (!parsed.success) {
      return {
        success: false,
        error: 'Could not determine which invoice to send a payment reminder for.',
      };
    }
    const { invoiceId, stepKey, offsetDays, channel } = parsed.data;

    if (!this.transactionalComms) {
      // Dev wiring without a comms service. Returns the invoice id.
      return { success: true, resultEntityId: invoiceId };
    }

    // ── Layer 1 (authoritative) — MANUAL-send dedup guard. Only manual/voice
    // proposals reach this: cadence reminders carry a '<offsetDays>:<channel>'
    // stepKey and their ledger row was written by the sweep at raise time, so
    // they are neither gated nor re-recorded here. No ledger wired → legacy.
    const isManual = stepKey === MANUAL_REMINDER_PAYLOAD_STEP_KEY;
    // Per-occurrence claim token for notifyInvoiceOverdue's send-claim key.
    // Manual reminders MUST use the per-proposal key ('manual:<proposalId>'),
    // never the bare 'manual' payload discriminator: 'manual' is invoice-
    // scoped, so the send-claim ledger would tombstone `invoice-overdue:
    // {invoiceId}:manual` after the first send and silently suppress every
    // later manual reminder (each a distinct approved proposal, legitimately
    // allowed after the 72h cooldown) while still reporting success. Cadence
    // steps already carry a per-step '<offsetDays>:<channel>' key.
    const occurrenceToken = isManual ? manualReminderStepKey(proposal.id) : stepKey;
    if (this.dunningEventRepo && isManual) {
      const asOf = this.now();
      const ownStepKey = occurrenceToken;
      const cooldownFloor = asOf.getTime() - PAYMENT_REMINDER_COOLDOWN_MS;

      const priorReminders = (
        await this.dunningEventRepo.findByInvoice(context.tenantId, invoiceId)
      ).filter((e) => e.kind === 'reminder' && e.sentAt.getTime() >= cooldownFloor);

      // Own-row idempotency FIRST: this exact proposal already recorded a send
      // (a retry / undo-then-re-execute). Idempotent success, never re-send —
      // even if another reminder also landed inside the window.
      if (priorReminders.some((e) => e.stepKey === ownStepKey)) {
        return { success: true, resultEntityId: invoiceId };
      }

      // Any OTHER reminder inside the 72h window blocks a manual double-send.
      const recent = priorReminders.sort(
        (a, b) => b.sentAt.getTime() - a.sentAt.getTime(),
      )[0];
      if (recent) {
        return {
          success: false,
          error:
            `Payment reminder refused: a reminder for this invoice already went out at ` +
            `${recent.sentAt.toISOString()} — manual reminders are spaced at least 72h apart.`,
        };
      }

      // Record-first: write the ledger row BEFORE the customer send so a
      // concurrent execution that loses the UNIQUE race (23505) treats it as
      // already-sent. A failed write means we cannot guarantee dedup, so we
      // refuse rather than send without a ledger row.
      try {
        await this.dunningEventRepo.create({
          id: uuidv4(),
          tenantId: context.tenantId,
          invoiceId,
          kind: 'reminder',
          stepKey: ownStepKey,
          channel,
          sentAt: asOf,
        });
      } catch (err) {
        if ((err as { code?: string }).code === '23505') {
          return { success: true, resultEntityId: invoiceId };
        }
        return {
          success: false,
          error: err instanceof Error ? err.message : 'Failed to record payment reminder',
        };
      }
    }

    let outcome;
    try {
      // occurrenceToken ('<offsetDays>:<channel>' for a cadence step, or
      // 'manual:<proposalId>' for a manual send — never the bare 'manual'
      // discriminator, see above) is the per-occurrence claim token: each
      // dunning step and each manual proposal is a legitimately distinct send,
      // so the send-claim ledger must not tombstone the invoice after the
      // first reminder.
      outcome = await this.transactionalComms.notifyInvoiceOverdue(
        context.tenantId,
        invoiceId,
        occurrenceToken,
      );
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : 'Failed to send payment reminder',
      };
    }

    // I10 send-time suppression (invoice paid/void/zero-balance at fire time).
    // Nothing was delivered, so we must NOT leave a "reminder_sent" trace: undo
    // the record-first ledger row we wrote above (else its false send-history
    // blocks a later legitimate reminder inside the 72h cooldown) and audit the
    // suppression instead of a send. Idempotent re-execution is unaffected —
    // the row is only deleted on the same run that wrote it.
    if (outcome.status === 'suppressed') {
      if (this.dunningEventRepo && isManual) {
        try {
          await this.dunningEventRepo.deleteByInvoiceStep(
            context.tenantId,
            invoiceId,
            'reminder',
            occurrenceToken,
          );
        } catch {
          // best-effort cleanup — a stray ledger row is far less harmful than
          // failing an execution that correctly sent nothing.
        }
      }
      if (this.auditRepo) {
        try {
          await this.auditRepo.create(
            createAuditEvent({
              tenantId: context.tenantId,
              actorId: context.executedBy,
              actorRole: 'system',
              eventType: 'invoice.reminder_suppressed',
              entityType: 'invoice',
              entityId: invoiceId,
              metadata: {
                proposalId: proposal.id,
                proposalType: 'send_payment_reminder',
                reason: outcome.reason,
                stepKey,
                offsetDays,
                channel,
              },
            }),
          );
        } catch {
          // swallow — audit must never fail the execution
        }
      }
      return { success: true, resultEntityId: invoiceId };
    }

    // Audit emission is failure-soft: a logging failure never unwinds a
    // successful customer send.
    if (this.auditRepo) {
      try {
        await this.auditRepo.create(
          createAuditEvent({
            tenantId: context.tenantId,
            actorId: context.executedBy,
            actorRole: 'system',
            eventType: 'invoice.reminder_sent',
            entityType: 'invoice',
            entityId: invoiceId,
            metadata: {
              proposalId: proposal.id,
              proposalType: 'send_payment_reminder',
              stepKey,
              offsetDays,
              channel,
            },
          }),
        );
      } catch {
        // swallow — audit must never fail the execution
      }
    }

    return { success: true, resultEntityId: invoiceId };
  }
}
