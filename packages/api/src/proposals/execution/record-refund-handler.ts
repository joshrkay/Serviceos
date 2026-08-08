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
 * ── Single-payment scope, not a cross-payment split (spec review fix) ─────
 *
 * An earlier revision of this handler looped `recordRefund()` across every
 * refundable payment on the invoice (oldest-first) to satisfy a refund
 * larger than any one payment. That loop was NOT safe: the headroom
 * pre-check ran against a `findByInvoice` snapshot, so a chunk could commit
 * against payment A, then a CONCURRENT mutation (a Stripe webhook refund, or
 * another approved proposal) shrinks payment B's headroom between the
 * snapshot and the second `recordRefund()` call, which then throws. This
 * handler's own catch converts that throw into `{ success: false }` rather
 * than re-throwing — and `ProposalExecutor`'s `recordAndTransition`
 * (execution/executor.ts) commits the proposal's status transition (and
 * therefore the whole shared advisory-lock transaction, chunk A's write
 * included) on BOTH the success and the failure path, because a failed
 * execution still needs its `execution_failed` status write to land. So a
 * mid-loop failure left chunk A committed with no compensation — exactly
 * the "fails before any payment is touched" claim this doc comment used to
 * make, and it was false in that window.
 *
 * The fix considered (and rejected) making `recordRefund()`'s per-payment
 * writes join ONE ambient DB transaction across the whole loop
 * (`PgBaseRepository.withTenantTransaction` already reuses an ambient
 * `tenantContextStore` client when one exists, and `ProposalExecutor`'s
 * Path A wraps `handler.execute()` in exactly such a transaction via
 * `commands/command-runner.ts` — so the DB-level plumbing IS there).
 * That still doesn't fix it: to make a mid-loop failure roll back this
 * handler would have to THROW instead of returning `{ success: false }`,
 * which changes the shared executor's error contract for every execution
 * handler (throw-to-abort vs. return-to-report), not something this
 * money-safety fix should quietly redefine platform-wide. Per the plan's
 * own "do NOT fork a second mutation path" guidance, that's exactly the
 * kind of contorted, handler-specific transaction trick to avoid.
 *
 * Instead: a `record_refund` proposal applies to exactly ONE payment,
 * chosen deterministically (oldest-first among the payments whose OWN
 * headroom individually covers the requested amount). This makes the
 * mutation a SINGLE `recordRefund()` call — already atomic on its own, per
 * its own atomic CTE design — so there is no multi-call sequence and
 * therefore no partial-state window at all, not even in theory. An invoice
 * with more than one completed payment (e.g. deposit + final) where the
 * requested amount doesn't fit within any ONE of them (even though it fits
 * the combined total) fails BEFORE any write with a message telling the
 * operator to record it as separate smaller refunds — a real but
 * deliberately accepted limitation (see the catalog doc's Task 3 notes),
 * not a silent under-refund or a fabricated split.
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
      return {
        success: false,
        error:
          "Refund exceeds any single payment's refundable amount on this invoice — record it as separate smaller refunds",
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
