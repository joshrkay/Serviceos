import { v4 as uuidv4 } from 'uuid';
import { Proposal, ProposalType } from '../proposal';
import { ExecutionContext, ExecutionHandler, ExecutionResult } from './handlers';
import { PaymentRepository, Payment } from '../../invoices/payment';
import { recordRefund } from '../../payments/payment-service';
import { AuditRepository, createAuditEvent } from '../../audit/audit';
import { RECORD_REFUND_METHODS } from '../contracts/record-refund';
import { formatUsdCentsPlain } from '@ai-service-os/shared';

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
 * handler resolves the approved invoice's REFUNDABLE payments
 * (`PaymentRepository.findByInvoice`, filtered to `status === 'completed'`
 * with positive headroom) and calls `recordRefund()` with `stripeRefundId:
 * null` — the SAME "no provider id" branch a webhook-less manual refund
 * would take, which uses the plain atomic increment (guarded, but never
 * touches `payment_refunds` — that table is reached only when a
 * `stripeRefundId` is supplied). This gets the existing over-refund
 * invariant and the `payment.refunded` audit event for free, instead of
 * re-implementing (and risking under-guarding) them in a parallel
 * repository.
 *
 * ── Single-payment scope, not a cross-payment split ───────────────────────
 *
 * Applies to exactly ONE payment — the oldest whose OWN headroom covers the
 * full amount — never split across several. One `recordRefund()` call is
 * already atomic, so there is no partial-state window. A prior revision
 * looped across payments and had one: this handler reports failure by
 * RETURNING `{ success: false }`, and `ProposalExecutor` commits a failed
 * execution's status transition — and everything already written — in the
 * SAME shared transaction regardless of success/failure, so a mid-loop
 * throw from a later chunk left an earlier chunk's write committed with no
 * compensation. Full investigation (incl. why an ambient shared transaction
 * doesn't rescue a loop without redefining the executor's throw-vs-return
 * error contract for every handler): commit `a12d6f59` and this type's
 * Task 3 notes in `docs/reference/voice-action-catalog.md`. An amount that
 * fits the invoice's combined refundable total but not any ONE payment
 * fails before any write, telling the operator to record it as separate
 * smaller refunds instead of silently splitting or partially applying.
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
    // Oldest-first is a deterministic tie-break when an invoice has more
    // than one completed payment (e.g. a deposit + a final payment).
    const refundable = payments
      .filter((p) => p.status === 'completed' && p.amountCents - p.refundedAmountCents > 0)
      .sort((a, b) => a.receivedAt.getTime() - b.receivedAt.getTime());

    // No refundable payment at all — either nothing ever settled on this
    // invoice, or every completed payment is already fully refunded (e.g.
    // a double-submitted/redelivered proposal executing after the first
    // one already drained it). This is NOT a "split it up" situation —
    // there is nothing left to split, and telling the operator to record
    // smaller refunds would be actively misleading since every retry fails
    // identically.
    if (refundable.length === 0) {
      return {
        success: false,
        error: 'This invoice has no completed payments with refundable amount remaining.',
      };
    }

    // Single-payment scope (see class doc comment "Single-payment scope,
    // not a cross-payment split"): the target is the OLDEST refundable
    // payment whose OWN headroom covers the full requested amount — never
    // a payment picked because it happens to be biggest, and never a sum
    // across several. If none qualifies (even though the combined total
    // across all refundable payments might), this fails with NO write at
    // all — there is exactly one `recordRefund()` call in this method, and
    // it either happens once or not at all.
    const target = refundable.find((p) => p.amountCents - p.refundedAmountCents >= amountCents);
    if (!target) {
      // Operators can't see per-payment headrooms — give them the number
      // so they know how to split it, rather than guessing.
      const largestSingleRefundableCents = Math.max(
        ...refundable.map((p) => p.amountCents - p.refundedAmountCents),
      );
      return {
        success: false,
        error:
          `Refund exceeds any single payment's refundable amount on this invoice — ` +
          `the largest single refund possible is ${formatUsdCentsPlain(largestSingleRefundableCents)} — ` +
          `record it as separate smaller refunds`,
      };
    }

    try {
      await recordRefund(
        {
          tenantId: context.tenantId,
          paymentId: target.id,
          refundCents: amountCents,
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
              // Which payment absorbed the refund is the one fact the
              // selection logic decides — worth carrying on the
              // proposal-level event, not just implicit in payment.refunded.
              paymentId: target.id,
              ...(typeof payload.reason === 'string' ? { reason: payload.reason } : {}),
              ...(typeof payload.checkNumber === 'string'
                ? { checkNumber: payload.checkNumber }
                : {}),
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
