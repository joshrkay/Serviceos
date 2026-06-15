/**
 * D2-4 — Partial-refund tracking on payments.
 *
 * Refunds are NOT a status flip on the original payment: the original row
 * keeps its full `amountCents` for accounting integrity, and a cumulative
 * `refundedAmountCents` accumulates each partial refund. The tax export
 * emits a paired negative income row dated by `refundedAt` so YTD income
 * nets correctly while the original payment's magnitude is preserved.
 *
 * Invariant: `payment.refundedAmountCents + refundCents <= payment.amountCents`
 *
 * This service is the ONLY allowed mutation path for refund tracking —
 * direct `paymentRepo.update(...)` calls would bypass the over-refund
 * guard and skip the `payment.refunded` audit event.
 */
import { v4 as uuidv4 } from 'uuid';
import {
  PaymentRepository,
  Payment,
  PaymentMethod,
  PaymentReceiptNotifier,
  applySettledPayment,
} from '../invoices/payment';
import {
  Invoice,
  InvoiceRepository,
  InvoiceStatus,
  isValidInvoiceTransition,
} from '../invoices/invoice';
import { AuditRepository, createAuditEvent } from '../audit/audit';
import { NotFoundError, ValidationError } from '../shared/errors';
import { RefreshJobMoneyStateDeps, refreshJobMoneyStateSafe } from '../jobs/job-money-state';

export interface RecordRefundInput {
  tenantId: string;
  paymentId: string;
  refundCents: number;
  stripeRefundId?: string | null;
  refundedAt?: Date;
  /** Audit actor id; defaults to 'system:stripe_webhook' for webhook-driven refunds. */
  actorId?: string;
  actorRole?: string;
}

export interface RecordRefundResult {
  payment: Payment;
  refundCents: number;
  totalRefundedCents: number;
}

/**
 * Record a partial (or full) refund against an existing payment.
 *
 * - Validates `refundCents` is a positive integer.
 * - Atomically increments `refundedAmountCents` via
 *   `paymentRepo.incrementRefundAtomic`: a single UPDATE statement
 *   with the over-refund guard inside the WHERE clause. Two concurrent
 *   webhook deliveries for the same payment can therefore never both
 *   pass validation (D2-4 race fix, addresses gemini-code-assist
 *   review on PR #384).
 * - On 0-row result, a diagnostic `findById` distinguishes the two
 *   failure modes so the caller sees a meaningful error:
 *     - row exists → `ValidationError('Refund exceeds original payment: …')` (terminal)
 *     - row missing / cross-tenant → `NotFoundError('Payment', id)` (retryable)
 *   The error CLASS difference matters for the Stripe webhook handler
 *   (Codex P1 #3 follow-up): Stripe delivery ordering is not
 *   guaranteed, so `charge.refunded` can arrive BEFORE the
 *   `checkout.session.completed` that created the payment row. The
 *   webhook handler re-throws NotFoundError so Stripe gets a 5xx and
 *   retries; ValidationError is terminal and ACKed.
 *   The diagnostic read is only on the error path; the happy path is
 *   one statement.
 * - Writes a `payment.refunded` audit event with the refund delta and
 *   the new cumulative total.
 *
 * Returns the updated payment plus the refund delta and the new total.
 */
export async function recordRefund(
  input: RecordRefundInput,
  paymentRepo: PaymentRepository,
  auditRepo?: AuditRepository,
): Promise<RecordRefundResult> {
  if (!input.tenantId) throw new ValidationError('tenantId is required');
  if (!input.paymentId) throw new ValidationError('paymentId is required');
  if (!Number.isInteger(input.refundCents) || input.refundCents <= 0) {
    throw new ValidationError('refundCents must be a positive integer');
  }

  // Codex P1 (PR #384) — per-refund idempotency. Same Stripe refund.id
  // can arrive via both charge.refunded AND charge.refund.updated; the
  // webhook-event-id dedup doesn't help because the two events have
  // different ids. Short-circuit here so we don't double-count.
  //
  // Limitation: only catches the LATEST refund on this payment. For
  // multi-partial-refunds where an earlier refund's event re-fires
  // after a later one has been recorded, we can't deduplicate without
  // the payment_refunds child table (D2-4a follow-up in TODOS.md).
  if (input.stripeRefundId) {
    const existing = await paymentRepo.findById(input.tenantId, input.paymentId);
    if (existing && existing.lastRefundStripeId === input.stripeRefundId) {
      return {
        payment: existing,
        refundCents: 0,
        totalRefundedCents: existing.refundedAmountCents ?? 0,
      };
    }
  }

  const refundedAt = input.refundedAt ?? new Date();
  const updated = await paymentRepo.incrementRefundAtomic(input.tenantId, input.paymentId, {
    refundCents: input.refundCents,
    refundedAt,
    stripeRefundId: input.stripeRefundId ?? null,
  });

  if (!updated) {
    // 0 rows came back from the atomic UPDATE. Two reasons that's
    // possible: the row doesn't exist (or belongs to another tenant),
    // or the over-refund guard rejected the write. Read once to
    // distinguish them so the caller gets a meaningful error.
    const existing = await paymentRepo.findById(input.tenantId, input.paymentId);
    if (!existing) {
      // Either missing or cross-tenant — throw NotFoundError (404) so
      // the Stripe webhook handler can re-throw and let Stripe retry
      // (webhook ordering may deliver charge.refunded before the
      // checkout.session.completed that creates this row). The error
      // surface is the same for missing vs cross-tenant so probing
      // can't distinguish them. Codex P1 #3 (PR #384).
      throw new NotFoundError('Payment', input.paymentId);
    }
    const attemptedTotal = (existing.refundedAmountCents ?? 0) + input.refundCents;
    throw new ValidationError(
      `Refund exceeds original payment: ${attemptedTotal} > ${existing.amountCents}`,
    );
  }

  const totalRefundedCents = updated.refundedAmountCents;

  if (auditRepo) {
    await auditRepo.create(
      createAuditEvent({
        tenantId: input.tenantId,
        actorId: input.actorId ?? 'system:stripe_webhook',
        actorRole: input.actorRole ?? 'system',
        eventType: 'payment.refunded',
        entityType: 'payment',
        entityId: input.paymentId,
        correlationId: input.stripeRefundId ?? undefined,
        metadata: {
          paymentId: input.paymentId,
          refundCents: input.refundCents,
          totalRefundedCents,
          stripeRefundId: input.stripeRefundId ?? null,
        },
      }),
    );
  }

  return {
    payment: updated,
    refundCents: input.refundCents,
    totalRefundedCents,
  };
}

/**
 * Invoice-to-cash failure handling — REVERSE a settled payment.
 *
 * A reversal is distinct from a refund. A refund is money we chose to
 * send back (the original payment still settled). A reversal marks money
 * that never truly cleared — an ACH/bank debit RETURNED for insufficient
 * funds (NSF), or a card CHARGEBACK — so the cash we recorded is gone.
 *
 * Effects (all-or-nothing on the happy path):
 *  - Flips the payment `completed -> failed` and stamps
 *    `reversedAt`/`reversalReason`, atomically and idempotently (a
 *    duplicate webhook delivery is a no-op). Flipping to 'failed' also
 *    drops the payment out of gross-revenue math, which filters
 *    `status === 'completed'`.
 *  - REOPENS the invoice: decrements `amountPaidCents` by the reversed
 *    amount, recomputes `amountDueCents`, and moves the status back to
 *    'partially_paid' (other payments remain) or 'open' (none left) so it
 *    re-enters normal collections. Invoices already in a terminal state
 *    (void/canceled) are left untouched — the revenue drop from the
 *    payment flip is the only correct effect there.
 *  - Emits `payment.reversed` (+ `invoice.status_changed` when the
 *    status moves) audit events.
 *
 * Error semantics mirror `recordRefund`: a missing payment row throws
 * `NotFoundError` (retryable — Stripe delivery ordering can put the
 * reversal event before the `checkout.session.completed` that creates the
 * row), so the webhook returns 5xx and Stripe retries. An already-reversed
 * / non-completed payment is a terminal no-op (`{ reversed: false }`).
 */
export interface ReversePaymentInput {
  tenantId: string;
  paymentId: string;
  /** Why the payment was reversed (e.g. 'ach_return', 'dispute'). */
  reason: string;
  /** When the reversal occurred (defaults to now). */
  reversedAt?: Date;
  /** Audit actor id; defaults to 'system:stripe_webhook'. */
  actorId?: string;
  actorRole?: string;
  /** Correlation id (e.g. Stripe payment_intent / dispute id) for tracing. */
  correlationId?: string;
}

export interface ReversePaymentResult {
  reversed: boolean;
  payment: Payment;
  invoice?: Invoice;
}

export async function reversePayment(
  input: ReversePaymentInput,
  invoiceRepo: InvoiceRepository,
  paymentRepo: PaymentRepository,
  auditRepo?: AuditRepository,
  moneyStateDeps?: RefreshJobMoneyStateDeps,
): Promise<ReversePaymentResult> {
  if (!input.tenantId) throw new ValidationError('tenantId is required');
  if (!input.paymentId) throw new ValidationError('paymentId is required');
  if (!input.reason) throw new ValidationError('reason is required');

  const reversedAt = input.reversedAt ?? new Date();
  const actorId = input.actorId ?? 'system:stripe_webhook';
  const actorRole = input.actorRole ?? 'system';

  // Atomic, idempotent flip. `null` means: not found, already reversed,
  // or not in 'completed' status (the guard lives in the WHERE clause).
  let reversed = await paymentRepo.reversePaymentAtomic(input.tenantId, input.paymentId, {
    reversedAt,
    reason: input.reason,
  });

  if (!reversed) {
    // U5 (ACH async lifecycle) — the completed-only flip missed. The
    // payment may instead be IN-FLIGHT ('processing'): an ACH return that
    // arrived BEFORE the debit ever settled. Try the in-flight reversal,
    // which flips 'processing' -> 'failed' under its own guard. The
    // invoice-reopen logic below is identical (it backs out the in-flight
    // credit we applied at `payment_intent.processing`). Idempotent: a
    // duplicate delivery finds the row already 'failed' and this also
    // returns null, falling through to the no-op branch.
    reversed = await paymentRepo.reverseInFlightPaymentAtomic(input.tenantId, input.paymentId, {
      reversedAt,
      reason: input.reason,
    });
  }

  if (!reversed) {
    // Distinguish "row missing" (retryable — webhook ordering) from
    // "already reversed / not completed/processing" (terminal no-op),
    // exactly like recordRefund's 0-row diagnostic read.
    const existing = await paymentRepo.findById(input.tenantId, input.paymentId);
    if (!existing) {
      throw new NotFoundError('Payment', input.paymentId);
    }
    return { reversed: false, payment: existing };
  }

  // Recompute the invoice balance + status and reopen it.
  const invoice = await invoiceRepo.findById(input.tenantId, reversed.invoiceId);
  let updatedInvoice: Invoice | null = invoice;
  let statusChanged = false;

  if (invoice) {
    const REOPENABLE: InvoiceStatus[] = ['open', 'partially_paid', 'paid'];
    if (REOPENABLE.includes(invoice.status)) {
      const newAmountPaid = Math.max(0, invoice.amountPaidCents - reversed.amountCents);
      const newAmountDue = Math.max(0, invoice.totals.totalCents - newAmountPaid);
      let newStatus: InvoiceStatus;
      if (newAmountPaid <= 0) {
        newStatus = 'open';
      } else if (newAmountPaid >= invoice.totals.totalCents) {
        newStatus = 'paid';
      } else {
        newStatus = 'partially_paid';
      }

      statusChanged = newStatus !== invoice.status;
      if (statusChanged && !isValidInvoiceTransition(invoice.status, newStatus)) {
        // Defensive — the transition map permits every case we generate
        // here; a miss means the map drifted.
        throw new ValidationError(
          `Invalid invoice transition '${invoice.status}' -> '${newStatus}' on reversal`,
        );
      }

      updatedInvoice = await invoiceRepo.update(input.tenantId, invoice.id, {
        amountPaidCents: newAmountPaid,
        amountDueCents: newAmountDue,
        status: newStatus,
        updatedAt: new Date(),
      });
    }
    // else: void/canceled/draft — leave the invoice as-is. The payment
    // status flip already removed it from revenue.
  }

  if (auditRepo) {
    await auditRepo.create(
      createAuditEvent({
        tenantId: input.tenantId,
        actorId,
        actorRole,
        eventType: 'payment.reversed',
        entityType: 'payment',
        entityId: input.paymentId,
        correlationId: input.correlationId,
        metadata: {
          paymentId: input.paymentId,
          invoiceId: reversed.invoiceId,
          amountCents: reversed.amountCents,
          reason: input.reason,
          newInvoiceStatus: (updatedInvoice ?? invoice)?.status ?? null,
        },
      }),
    );

    if (statusChanged && updatedInvoice && invoice) {
      await auditRepo.create(
        createAuditEvent({
          tenantId: input.tenantId,
          actorId,
          actorRole,
          eventType: 'invoice.status_changed',
          entityType: 'invoice',
          entityId: invoice.id,
          correlationId: input.correlationId,
          metadata: {
            oldStatus: invoice.status,
            newStatus: updatedInvoice.status,
            paymentId: input.paymentId,
            reason: input.reason,
          },
        }),
      );
    }
  }

  // §6 Time-to-Cash rollup (best-effort — the payment + invoice writes
  // already succeeded; a rollup failure must not bounce them).
  if (updatedInvoice && moneyStateDeps) {
    await refreshJobMoneyStateSafe(input.tenantId, updatedInvoice.jobId, actorId, moneyStateDeps);
  }

  return { reversed: true, payment: reversed, invoice: updatedInvoice ?? invoice ?? undefined };
}

/**
 * Invoice-to-cash failure handling — record a FAILED payment attempt
 * (e.g. a declined card) for visibility, WITHOUT touching the invoice
 * balance. The row is written with `status: 'failed'`, so it is excluded
 * from gross-revenue math and from "amount paid" — it exists purely so the
 * declined attempt shows up in the payment history / audit timeline rather
 * than vanishing. Use `reversePayment(...)` instead when a previously
 * SETTLED payment fails (NSF/chargeback).
 */
export interface RecordFailedAttemptInput {
  tenantId: string;
  invoiceId: string;
  amountCents: number;
  method: PaymentMethod;
  providerReference?: string;
  /** Decline code / message from the provider, for the note + audit. */
  reason?: string;
  failedAt?: Date;
  actorId?: string;
  actorRole?: string;
}

export async function recordFailedPaymentAttempt(
  input: RecordFailedAttemptInput,
  paymentRepo: PaymentRepository,
  auditRepo?: AuditRepository,
): Promise<Payment> {
  if (!input.tenantId) throw new ValidationError('tenantId is required');
  if (!input.invoiceId) throw new ValidationError('invoiceId is required');

  const now = input.failedAt ?? new Date();
  const payment: Payment = {
    id: uuidv4(),
    tenantId: input.tenantId,
    invoiceId: input.invoiceId,
    amountCents: input.amountCents,
    method: input.method,
    status: 'failed',
    providerReference: input.providerReference,
    note: input.reason ? `Payment failed: ${input.reason}` : undefined,
    receivedAt: now,
    processedBy: input.actorId ?? 'system:stripe_webhook',
    createdAt: now,
    updatedAt: now,
    refundedAmountCents: 0,
    refundedAt: null,
    lastRefundStripeId: null,
    reversedAt: null,
    reversalReason: null,
  };

  await paymentRepo.create(payment);

  if (auditRepo) {
    await auditRepo.create(
      createAuditEvent({
        tenantId: input.tenantId,
        actorId: input.actorId ?? 'system:stripe_webhook',
        actorRole: input.actorRole ?? 'system',
        eventType: 'payment.failed',
        entityType: 'invoice',
        entityId: input.invoiceId,
        correlationId: input.providerReference,
        metadata: {
          paymentId: payment.id,
          amountCents: input.amountCents,
          method: input.method,
          providerReference: input.providerReference ?? null,
          reason: input.reason ?? null,
        },
      }),
    );
  }

  return payment;
}

/**
 * E2a (one-time ACH) — SETTLE an in-flight `processing` payment when its
 * funds clear (`payment_intent.succeeded`).
 *
 * Drives the load-bearing money-safe upgrade:
 *  1. Atomic CAS `processing -> completed` via
 *     `paymentRepo.transitionFromProcessing` (the guard lives in the WHERE
 *     clause). `null` ⇒ the row already left `processing` (a concurrent
 *     fail won, or a duplicate succeeded already settled it) ⇒ idempotent
 *     no-op, NOT a throw. Invoice/money-state/receipt effects therefore
 *     run ONLY after a winning CAS — a lost race can never phantom-pay.
 *  2. The CAS reconciles the row's `amountCents` to Stripe's authoritative
 *     `amount_received` (`settledAmountCents`), which can drift from the
 *     amount announced on the `processing` event, and stamps `paid_at` to
 *     the settlement time.
 *  3. Re-read the invoice. A non-payable invoice (already paid / void /
 *     canceled, or vanished) is an idempotent no-op — the row is settled
 *     for accounting, but no further invoice effect is correct.
 *  4. CAP the applied amount to the invoice's CURRENT `amountDueCents`
 *     (R7 over-collection guard: ACH processing $500 → owner records $200
 *     cash → ACH settles → apply only the remaining $300, never $500), then
 *     run the SHARED `applySettledPayment` — the SAME effect set the card
 *     path runs: invoice balance/status, `payment.recorded` (+ conditional
 *     `invoice.status_changed`) audit, `refreshJobMoneyStateSafe` rollup,
 *     and the receipt.
 *
 * Mirrors `reversePayment`'s atomic-CAS + re-read-invoice structure.
 */
export interface SettleProcessingPaymentInput {
  tenantId: string;
  /** Stripe `payment_intent` id stamped into provider_reference. */
  providerReference: string;
  /** Stripe `amount_received` — the authoritative settled figure (cents). */
  settledAmountCents: number;
  /** Audit actor id; defaults to 'system:stripe_webhook'. */
  actorId?: string;
  actorRole?: string;
  /** Correlation id (Stripe payment_intent / event id) for tracing. */
  correlationId?: string;
  /** Settlement time (defaults to now). */
  settledAt?: Date;
}

export interface SettleProcessingPaymentResult {
  settled: boolean;
  payment?: Payment;
  invoice?: Invoice;
}

export async function settleProcessingPayment(
  input: SettleProcessingPaymentInput,
  invoiceRepo: InvoiceRepository,
  paymentRepo: PaymentRepository,
  auditRepo?: AuditRepository,
  moneyStateDeps?: RefreshJobMoneyStateDeps,
  paymentReceiptNotifier?: PaymentReceiptNotifier,
): Promise<SettleProcessingPaymentResult> {
  if (!input.tenantId) throw new ValidationError('tenantId is required');
  if (!input.providerReference) throw new ValidationError('providerReference is required');
  if (!Number.isInteger(input.settledAmountCents) || input.settledAmountCents <= 0) {
    throw new ValidationError('settledAmountCents must be a positive integer');
  }

  const settledAt = input.settledAt ?? new Date();
  const actorId = input.actorId ?? 'system:stripe_webhook';

  // Resolve the in-flight row by provider_reference, then CAS by id. The
  // status guard inside `transitionFromProcessing`'s WHERE makes the flip
  // idempotent + mutually exclusive with `failProcessingPayment`.
  const existing = await paymentRepo.findByProviderReference(
    input.tenantId,
    input.providerReference,
  );
  if (!existing) {
    // No row to settle. The webhook layer decides whether to fall back to
    // the card path (`recordPayment`); here it is simply a no-op.
    return { settled: false };
  }

  const settled = await paymentRepo.transitionFromProcessing(
    input.tenantId,
    existing.id,
    'completed',
    {
      // Reconcile to Stripe's authoritative settled figure + stamp the
      // settlement time onto the row.
      amountCents: input.settledAmountCents,
      receivedAt: settledAt,
    },
  );

  if (!settled) {
    // Lost CAS: the row already left `processing` (concurrent fail, or a
    // duplicate succeeded already settled it). Idempotent no-op.
    return { settled: false, payment: existing };
  }

  // Re-read the invoice AFTER the winning CAS so the cap reflects current
  // balances (an external payment may have landed during the ACH window).
  const invoice = await invoiceRepo.findById(input.tenantId, settled.invoiceId);
  if (!invoice) {
    return { settled: true, payment: settled };
  }

  const PAYABLE_STATUSES = ['open', 'partially_paid'];
  if (!PAYABLE_STATUSES.includes(invoice.status)) {
    // Already paid / void / canceled — settling the row is correct for
    // accounting, but no further invoice effect (or receipt) is. R7.
    return { settled: true, payment: settled, invoice };
  }

  // R7 over-collection guard: never apply more than is currently due.
  const appliedAmountCents = Math.min(input.settledAmountCents, invoice.amountDueCents);

  const { invoice: updatedInvoice } = await applySettledPayment(
    invoice,
    settled,
    appliedAmountCents,
    invoiceRepo,
    {
      actorId,
      actorRole: input.actorRole,
      correlationId: input.correlationId ?? input.providerReference,
    },
    moneyStateDeps,
    paymentReceiptNotifier,
    auditRepo,
  );

  return { settled: true, payment: settled, invoice: updatedInvoice };
}

/**
 * E2a (one-time ACH) — FAIL an in-flight `processing` payment when the ACH
 * debit is returned BEFORE settlement (`payment_intent.payment_failed`
 * while still processing). The invoice was never marked paid, so there is
 * NOTHING to reopen — this is distinct from `reversePayment`, which claws
 * back an ALREADY-settled payment and reopens the invoice.
 *
 * Atomic CAS `processing -> failed` via `transitionFromProcessing` (guard
 * in the WHERE). `null` ⇒ the row already left `processing` (a concurrent
 * settle won, or it already failed) ⇒ idempotent no-op, not a throw. The
 * invoice is untouched on every path. Emits `payment.failed`. Mirrors
 * `reversePayment`'s atomic-CAS structure.
 */
export interface FailProcessingPaymentInput {
  tenantId: string;
  /** Stripe `payment_intent` id stamped into provider_reference. */
  providerReference: string;
  /** Why the ACH debit failed (e.g. 'ach_failed', decline code). */
  reason: string;
  failedAt?: Date;
  actorId?: string;
  actorRole?: string;
  correlationId?: string;
}

export interface FailProcessingPaymentResult {
  failed: boolean;
  payment?: Payment;
}

export async function failProcessingPayment(
  input: FailProcessingPaymentInput,
  paymentRepo: PaymentRepository,
  auditRepo?: AuditRepository,
): Promise<FailProcessingPaymentResult> {
  if (!input.tenantId) throw new ValidationError('tenantId is required');
  if (!input.providerReference) throw new ValidationError('providerReference is required');
  if (!input.reason) throw new ValidationError('reason is required');

  const failedAt = input.failedAt ?? new Date();
  const actorId = input.actorId ?? 'system:stripe_webhook';

  const existing = await paymentRepo.findByProviderReference(
    input.tenantId,
    input.providerReference,
  );
  if (!existing) {
    return { failed: false };
  }

  const failed = await paymentRepo.transitionFromProcessing(
    input.tenantId,
    existing.id,
    'failed',
    {
      reversedAt: failedAt,
      reversalReason: input.reason,
    },
  );

  if (!failed) {
    // Lost CAS / already terminal — idempotent no-op. Invoice untouched.
    return { failed: false, payment: existing };
  }

  if (auditRepo) {
    await auditRepo.create(
      createAuditEvent({
        tenantId: input.tenantId,
        actorId,
        actorRole: input.actorRole ?? 'system',
        eventType: 'payment.failed',
        entityType: 'invoice',
        entityId: failed.invoiceId,
        correlationId: input.correlationId ?? input.providerReference,
        metadata: {
          paymentId: failed.id,
          amountCents: failed.amountCents,
          method: failed.method,
          providerReference: failed.providerReference ?? null,
          reason: input.reason,
        },
      }),
    );
  }

  return { failed: true, payment: failed };
}
