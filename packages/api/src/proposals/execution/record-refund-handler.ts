import { v4 as uuidv4 } from 'uuid';
import { Proposal, ProposalType } from '../proposal';
import { ExecutionContext, ExecutionHandler, ExecutionResult } from './handlers';
import { PaymentRepository, Payment } from '../../invoices/payment';
import { recordRefund } from '../../payments/payment-service';
import { AuditRepository, createAuditEvent } from '../../audit/audit';
import { RECORD_REFUND_METHODS } from '../contracts/record-refund';

// Mirrors RecordPaymentExecutionHandler's isUuid (voice-extended-handlers.ts):
// a resolved invoiceId must be a real UUID before any repository lookup —
// an unresolved free-text reference should have gated the proposal at
// drafting time, never reached execution.
const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value);
}

/**
 * Executes an approved `record_refund` proposal: records a MANUAL refund
 * (cash / check / a card swiped outside Stripe / other) given back to a
 * customer against an existing invoice.
 *
 * ── Why this reuses `recordRefund()` rather than a new refund ledger ──────
 *
 * The plan's draft assumed a dedicated `PaymentRefundRepository` writing
 * into the `payment_refunds` table (migration `264_create_payment_refunds`,
 * db/schema.ts). Investigation of that table before writing any code found
 * it is NOT a general refund ledger — it exists SOLELY as the Stripe
 * refund-webhook idempotency claim (D2-4a / P0-4, invoices/pg-payment.ts):
 *   - `stripe_refund_id TEXT NOT NULL` with a UNIQUE (tenant_id,
 *     stripe_refund_id) index — a manual cash/check refund has no Stripe
 *     refund id, so inserting a synthetic placeholder would pollute the
 *     exact dedup key that table exists to protect.
 *   - No `invoice_id` column at all — only `payment_id`.
 *   - Every write path into it is a single atomic CTE
 *     (`PgPaymentRepository.recordRefundIdempotent`) that ALSO applies the
 *     `payments.refunded_amount_cents` increment under a row lock — writing
 *     to `payment_refunds` outside that statement would let a concurrent
 *     refund race the over-refund guard.
 *
 * `payments/payment-service.ts` already owns refund recording end to end —
 * its own doc comment calls it "the ONLY allowed mutation path for refund
 * tracking" and states the invariant this handler must not bypass:
 * `payment.refundedAmountCents + refundCents <= payment.amountCents`. This
 * handler therefore resolves the approved invoice's REFUNDABLE payments
 * (`PaymentRepository.findByInvoice`, filtered to `status === 'completed'`
 * with positive headroom) and calls `recordRefund()` per payment with
 * `stripeRefundId: null` — the SAME "no provider id" branch a webhook-less
 * manual refund would take, which uses the plain atomic increment (guarded,
 * but never touches `payment_refunds` — that table is reached only when a
 * `stripeRefundId` is supplied). This gets the existing over-refund
 * invariant, the atomic guard, and the `payment.refunded` audit event for
 * free, instead of re-implementing (and risking under-guarding) them in a
 * parallel repository. An invoice with more than one completed payment
 * (e.g. deposit + final) is refunded oldest-payment-first until the
 * requested amount is covered; if the invoice's TOTAL refundable headroom
 * is less than the requested amount, the whole execution fails before any
 * payment is touched (no partial refund is ever applied when the full
 * amount can't be satisfied).
 *
 * Stripe-AUTOMATED refunds are explicitly OUT OF SCOPE for this proposal
 * type (YAGNI, 2026-08-07 tradesperson plan) — a refund the owner wants to
 * push back through Stripe itself is a different, deliberately unbuilt
 * feature; this only ever records money the owner ALREADY gave back by hand.
 *
 * Emits a SEPARATE `refund.recorded` audit event (entityType 'invoice')
 * carrying `proposalId` for traceability from the proposal back to the
 * refund — mirrors `LogExpenseExecutionHandler`'s `expense.logged` event.
 * This is deliberately NOT added to `analytics/audit-event-mapping.ts`:
 * the money signal is already captured by `payment.refunded` (which
 * `recordRefund()` emits and which IS mapped there) — a second mapped
 * product event for the same real-world refund would double-count refund
 * volume in analytics. `refund.recorded` exists purely for operational
 * traceability, the same unmapped-by-design posture `expense.logged` has.
 *
 * Follows the house degrade-to-synthetic-id pattern
 * (`LogExpenseExecutionHandler`): no `paymentRepo` wired → reports
 * `isFullyWired() === false` and, at execute time, returns a synthetic
 * success id without touching any repository (used by in-memory unit
 * tests that don't exercise the mutation path; boot fails closed when a
 * real pool is configured and this handler is degraded — see
 * `execution/wiring-assertions.ts`).
 */
export class RecordRefundExecutionHandler implements ExecutionHandler {
  proposalType: ProposalType = 'record_refund';

  constructor(
    private readonly paymentRepo?: PaymentRepository,
    private readonly auditRepo?: AuditRepository,
  ) {}

  isFullyWired(): boolean {
    return Boolean(this.paymentRepo);
  }

  async execute(proposal: Proposal, context: ExecutionContext): Promise<ExecutionResult> {
    const { payload } = proposal;

    if (!isUuid(payload.invoiceId)) {
      return {
        success: false,
        error: 'Payload must include a valid invoiceId UUID (resolve the invoice reference at review time first)',
      };
    }
    const invoiceId = payload.invoiceId;
    const amountCents = payload.amountCents;
    if (typeof amountCents !== 'number' || !Number.isInteger(amountCents) || amountCents <= 0) {
      return { success: false, error: 'Payload must include a positive integer amountCents' };
    }
    const method = payload.method;
    if (
      typeof method !== 'string' ||
      !(RECORD_REFUND_METHODS as readonly string[]).includes(method)
    ) {
      return {
        success: false,
        error: `Payload must specify method (one of: ${RECORD_REFUND_METHODS.join(', ')})`,
      };
    }

    if (!this.paymentRepo) {
      // Dev/test wiring without a repo — degrade to synthetic passthrough.
      return { success: true, resultEntityId: uuidv4() };
    }

    let payments: Payment[];
    try {
      payments = await this.paymentRepo.findByInvoice(context.tenantId, invoiceId);
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : 'Failed to look up payments for invoice',
      };
    }

    // Only settled payments still carrying refundable headroom are
    // candidates — a payment that never cleared (pending/processing) or
    // was reversed (failed) was never real collected cash to give back.
    // Oldest-first is an arbitrary but deterministic tie-break when an
    // invoice has more than one completed payment (e.g. a deposit + a
    // final payment) — the voice utterance carries no signal about which
    // specific payment to draw down first.
    const refundable = payments
      .filter((p) => p.status === 'completed' && p.amountCents - p.refundedAmountCents > 0)
      .sort((a, b) => a.receivedAt.getTime() - b.receivedAt.getTime());

    const totalHeadroomCents = refundable.reduce(
      (sum, p) => sum + (p.amountCents - p.refundedAmountCents),
      0,
    );
    if (totalHeadroomCents < amountCents) {
      return {
        success: false,
        error: `Refund exceeds amount paid on invoice: ${amountCents} > ${totalHeadroomCents} available to refund`,
      };
    }

    let remaining = amountCents;
    try {
      for (const payment of refundable) {
        if (remaining <= 0) break;
        const headroom = payment.amountCents - payment.refundedAmountCents;
        const chunk = Math.min(headroom, remaining);
        await recordRefund(
          {
            tenantId: context.tenantId,
            paymentId: payment.id,
            refundCents: chunk,
            // Manual refund — no Stripe refund id to key an idempotency
            // claim on, so this takes recordRefund's plain atomic-increment
            // path (still guarded against over-refund) rather than the
            // payment_refunds claim ledger, which exists solely to dedupe
            // STRIPE webhook redelivery (see class doc comment above).
            stripeRefundId: null,
            actorId: context.executedBy,
            actorRole: 'voice_agent',
          },
          this.paymentRepo,
          this.auditRepo,
        );
        remaining -= chunk;
      }
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : 'Refund recording failed',
      };
    }

    if (this.auditRepo) {
      try {
        await this.auditRepo.create(
          createAuditEvent({
            tenantId: context.tenantId,
            actorId: context.executedBy,
            actorRole: 'voice_agent',
            eventType: 'refund.recorded',
            entityType: 'invoice',
            entityId: invoiceId,
            metadata: {
              proposalId: proposal.id,
              proposalType: 'record_refund',
              amountCents,
              method,
            },
          }),
        );
      } catch (auditErr) {
        // Audit failures must not unwind a successful refund — but they
        // MUST be diagnosable. Mirrors LogExpenseExecutionHandler.
        const msg = auditErr instanceof Error ? auditErr.message : String(auditErr);
        console.warn(
          `Failed to emit refund.recorded audit event for invoice ${invoiceId} (proposal ${proposal.id}): ${msg}`,
        );
      }
    }

    return { success: true, resultEntityId: invoiceId };
  }
}
