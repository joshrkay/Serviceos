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
  RecordPaymentAuditContext,
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

/**
 * Crash-recovery repair for the reversal / in-flight-reversal paths.
 *
 * The payment flip (reversePaymentAtomic / reverseInFlightPaymentAtomic) and the
 * invoice decrement commit as SEPARATE statements on the webhook path. A crash
 * AFTER the flip committed but BEFORE the invoice decrement leaves the invoice
 * OVER-credited (amount_paid still includes the reversed payment); every later
 * redelivery then finds the payment already 'failed' → the atomic flip returns
 * null → the no-op branch. Without this repair the invoice is never reopened and
 * permanently under-collects. This recomputes amount_paid from the ACTIVE
 * payment ledger (completed/processing, not reversed) and reduces the invoice to
 * that truth — the reversal-path analog of `reconcileInvoiceFromPayments`.
 *
 * Reduce-only (mirrors that helper's increase-only guard, inverted): repairs
 * only when the ledger is BELOW the recorded balance — the exact
 * crash-after-reversal symptom. When the ledger is >= the balance there is
 * nothing for the reversal path to repair (a concurrent credit is the credit
 * path's own concern), so it no-ops. Idempotent: once repaired, the ledger
 * equals amount_paid and a further call is a no-op (`repaired: false`).
 *
 * Refunds are intentionally NOT subtracted from the ledger sum: `recordRefund`
 * never decrements invoice.amount_paid, so the invariant
 * `invoice.amount_paid == Σ(active payment amount_cents)` holds refund-inclusive,
 * and this repair must match it to stay consistent with the happy-path decrement.
 */
async function reconcileInvoiceAfterReversal(
  tenantId: string,
  invoice: Invoice,
  invoiceRepo: InvoiceRepository,
  paymentRepo: PaymentRepository,
): Promise<{ invoice: Invoice; repaired: boolean; previousStatus: InvoiceStatus }> {
  const REOPENABLE: InvoiceStatus[] = ['open', 'partially_paid', 'paid'];
  if (!REOPENABLE.includes(invoice.status)) {
    return { invoice, repaired: false, previousStatus: invoice.status };
  }

  const payments = await paymentRepo.findByInvoice(tenantId, invoice.id);
  const activePaidCents = payments
    .filter((p) => (p.status === 'completed' || p.status === 'processing') && !p.reversedAt)
    .reduce((sum, p) => sum + p.amountCents, 0);

  // Reduce-only: only the crash-after-reversal over-credit is ours to repair.
  if (activePaidCents >= invoice.amountPaidCents) {
    return { invoice, repaired: false, previousStatus: invoice.status };
  }

  const newAmountDue = Math.max(0, invoice.totals.totalCents - activePaidCents);
  let newStatus: InvoiceStatus;
  if (activePaidCents <= 0) newStatus = 'open';
  else if (activePaidCents >= invoice.totals.totalCents) newStatus = 'paid';
  else newStatus = 'partially_paid';

  const updated = await invoiceRepo.update(tenantId, invoice.id, {
    amountPaidCents: activePaidCents,
    amountDueCents: newAmountDue,
    status: newStatus,
    updatedAt: new Date(),
  });
  return { invoice: updated ?? invoice, repaired: true, previousStatus: invoice.status };
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
    // Self-heal: an already-reversed payment here may be a redelivery AFTER a
    // crash that flipped the payment but never decremented the invoice (separate
    // statements on the webhook path), leaving the invoice permanently
    // over-credited. Reconcile it from the active payment ledger so the reversal
    // is not lost; a genuine duplicate (invoice already consistent) is a no-op.
    if (existing.reversedAt != null) {
      const invoice = await invoiceRepo.findById(input.tenantId, existing.invoiceId);
      if (invoice) {
        const { invoice: reconciled, repaired, previousStatus } =
          await reconcileInvoiceAfterReversal(
            input.tenantId,
            invoice,
            invoiceRepo,
            paymentRepo,
          );
        if (repaired && auditRepo) {
          // Emit the audit the crashed original attempt never reached (mirrors
          // recordPayment's repaired-branch side effects).
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
                invoiceId: existing.invoiceId,
                amountCents: existing.amountCents,
                reason: input.reason,
                newInvoiceStatus: reconciled.status,
                recovered: true,
              },
            }),
          );
          if (reconciled.status !== previousStatus) {
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
                  oldStatus: previousStatus,
                  newStatus: reconciled.status,
                  paymentId: input.paymentId,
                  reason: input.reason,
                },
              }),
            );
          }
        }
        if (repaired && moneyStateDeps) {
          await refreshJobMoneyStateSafe(
            input.tenantId,
            reconciled.jobId,
            actorId,
            moneyStateDeps,
          );
        }
        return { reversed: false, payment: existing, invoice: reconciled };
      }
    }
    return { reversed: false, payment: existing };
  }

  // Recompute the invoice balance + status and reopen it — ATOMICALLY. The old
  // path read amountPaidCents into a JS snapshot and blind-set `snapshot −
  // amountCents`, so a concurrent credit (or a second reversal) clobbered it and
  // the invoice silently mis-collected. decrementAmountPaidAtomic derives the new
  // paid/due/status from the row's own current value in a single UPDATE, and
  // guards to REOPENABLE statuses in-SQL — a void/canceled/draft invoice returns
  // null and is left untouched (the payment flip already dropped it from revenue).
  const invoice = await invoiceRepo.findById(input.tenantId, reversed.invoiceId);
  let updatedInvoice: Invoice | null = invoice;
  let statusChanged = false;

  if (invoice) {
    const decremented = await invoiceRepo.decrementAmountPaidAtomic(
      input.tenantId,
      invoice.id,
      reversed.amountCents,
      new Date(),
    );
    if (decremented) {
      statusChanged = decremented.status !== invoice.status;
      if (statusChanged && !isValidInvoiceTransition(invoice.status, decremented.status)) {
        // Defensive — the transition map permits every case we generate here; a
        // miss means the map drifted. The atomic UPDATE derives the same status
        // set the map already covers, so this never fires in normal operation.
        throw new ValidationError(
          `Invalid invoice transition '${invoice.status}' -> '${decremented.status}' on reversal`,
        );
      }
      updatedInvoice = decremented;
    }
    // else: void/canceled/draft — decrement returned null; leave the invoice
    // as-is. The payment status flip already removed it from revenue.
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
 * U5 (ACH async lifecycle) — record an IN-FLIGHT bank-debit payment.
 *
 * Stripe fires `payment_intent.processing` when an ACH / us_bank_account
 * debit is initiated but funds have not cleared (settlement takes days).
 * Unlike `recordPayment` (which writes 'completed' and treats the money as
 * earned), this writes `status: 'processing'` and credits the invoice
 * balance as IN-FLIGHT so the owner / AR / digest see the money is on its
 * way, while gross-revenue math (which filters `status === 'completed'`)
 * still excludes it. The later `payment_intent.succeeded` flips the row to
 * 'completed' via `settleProcessingPayment` WITHOUT re-crediting; an ACH
 * return / `payment_intent.payment_failed` calls `reversePayment`, which
 * backs out this credit and reopens the invoice.
 *
 * Idempotency is the caller's responsibility (the webhook handler looks up
 * an existing payment by provider reference and skips before calling this);
 * the outer webhook-event-id dedup is the second line of defense.
 *
 * Amount handling mirrors `recordPayment`: integer-cents, payable-status
 * gate (open / partially_paid), and an over-amount guard. An amount that
 * exceeds the remaining due is capped to the balance (an ACH for the full
 * invoice arriving after a partial cash payment must not push the balance
 * negative) rather than rejected, so the in-flight credit is always exact.
 */
export interface RecordProcessingPaymentInput {
  tenantId: string;
  invoiceId: string;
  amountCents: number;
  method: PaymentMethod;
  providerReference?: string;
  note?: string;
  processedBy: string;
}

export async function recordProcessingPayment(
  input: RecordProcessingPaymentInput,
  invoiceRepo: InvoiceRepository,
  paymentRepo: PaymentRepository,
  moneyStateDeps?: RefreshJobMoneyStateDeps,
  auditRepo?: AuditRepository,
  auditContext?: RecordPaymentAuditContext,
): Promise<{ payment: Payment; invoice: Invoice }> {
  if (!input.tenantId) throw new ValidationError('tenantId is required');
  if (!input.invoiceId) throw new ValidationError('invoiceId is required');
  if (!Number.isInteger(input.amountCents) || input.amountCents <= 0) {
    throw new ValidationError('amountCents must be a positive integer');
  }
  if (!input.method) throw new ValidationError('method is required');
  if (!input.processedBy) throw new ValidationError('processedBy is required');

  const invoice = await invoiceRepo.findById(input.tenantId, input.invoiceId);
  if (!invoice) throw new ValidationError('Invoice not found');

  const PAYABLE_STATUSES: InvoiceStatus[] = ['open', 'partially_paid'];
  if (!PAYABLE_STATUSES.includes(invoice.status)) {
    throw new ValidationError(
      `Cannot record processing payment on invoice with status '${invoice.status}'`,
    );
  }

  // Cap the in-flight credit to the remaining balance (never push due
  // negative). Stripe's amount should match the balance for a full-invoice
  // ACH, but a partial cash payment may have shrunk the due first.
  const creditCents = Math.min(input.amountCents, invoice.amountDueCents);
  if (creditCents <= 0) {
    throw new ValidationError('Invoice already fully paid');
  }

  const now = new Date();
  const payment: Payment = {
    id: uuidv4(),
    tenantId: input.tenantId,
    invoiceId: input.invoiceId,
    amountCents: creditCents,
    method: input.method,
    status: 'processing',
    providerReference: input.providerReference,
    note: input.note,
    receivedAt: now,
    processedBy: input.processedBy,
    createdAt: now,
    updatedAt: now,
    refundedAmountCents: 0,
    refundedAt: null,
    lastRefundStripeId: null,
    reversedAt: null,
    reversalReason: null,
  };

  await paymentRepo.create(payment);

  // Credit the invoice ATOMICALLY (same lost-update fix as recordPayment). The
  // old path read amountPaidCents into a JS snapshot and blind-set
  // `snapshot + creditCents`, so a concurrent credit (e.g. a manual cash entry
  // racing this ACH `payment_intent.processing` event) clobbered one of them.
  // incrementAmountPaidAtomic derives the new paid/due/status from the row's own
  // current value in a single UPDATE. Its in-SQL status CASE ('paid' when due
  // hits 0, else 'partially_paid' from open/partially_paid) matches the prior
  // newStatus logic exactly, and the creditCents cap above still keeps due
  // non-negative.
  const updatedInvoice = await invoiceRepo.incrementAmountPaidAtomic(
    input.tenantId,
    input.invoiceId,
    creditCents,
    new Date(),
  );

  if (auditRepo) {
    const actorRole = auditContext?.actorRole ?? 'system';
    const correlationId = auditContext?.correlationId;
    await auditRepo.create(
      createAuditEvent({
        tenantId: input.tenantId,
        actorId: input.processedBy,
        actorRole,
        eventType: 'payment.processing',
        entityType: 'invoice',
        entityId: input.invoiceId,
        correlationId,
        metadata: {
          paymentId: payment.id,
          amountCents: payment.amountCents,
          method: payment.method,
          providerReference: payment.providerReference ?? null,
          newInvoiceStatus: (updatedInvoice ?? invoice).status,
        },
      }),
    );

    if (updatedInvoice && updatedInvoice.status !== invoice.status) {
      await auditRepo.create(
        createAuditEvent({
          tenantId: input.tenantId,
          actorId: input.processedBy,
          actorRole,
          eventType: 'invoice.status_changed',
          entityType: 'invoice',
          entityId: input.invoiceId,
          correlationId,
          metadata: {
            oldStatus: invoice.status,
            newStatus: updatedInvoice.status,
            paymentId: payment.id,
          },
        }),
      );
    }
  }

  // §6 Time-to-Cash rollup (best-effort — the writes already succeeded).
  if (updatedInvoice && moneyStateDeps) {
    await refreshJobMoneyStateSafe(
      input.tenantId,
      updatedInvoice.jobId,
      input.processedBy,
      moneyStateDeps,
    );
  }

  return { payment, invoice: updatedInvoice ?? invoice };
}

/**
 * U5 (ACH async lifecycle) — SETTLE an in-flight payment.
 *
 * Stripe fires `payment_intent.succeeded` when a processing ACH debit
 * clears. We flip the existing 'processing' row to 'completed' atomically
 * (so a duplicate `succeeded`, or one that races the already-completed card
 * path, is a no-op) WITHOUT touching the invoice balance — the credit was
 * already applied at `payment_intent.processing`. Flipping to 'completed'
 * is what finally moves the money into gross revenue.
 *
 * Emits a `payment.recorded` audit event (settled=true) so the settlement
 * is on the timeline distinct from the earlier `payment.processing`. No
 * `invoice.status_changed` is emitted — the invoice status was already set
 * at processing time and does not change on settle.
 *
 * Returns `{ settled:false }` when the row is missing or no longer
 * 'processing' (already settled, reversed, etc.) — a terminal no-op the
 * caller treats as idempotent success.
 */
export interface SettleProcessingPaymentInput {
  tenantId: string;
  paymentId: string;
  actorId?: string;
  actorRole?: string;
  correlationId?: string;
}

export interface SettleProcessingPaymentResult {
  settled: boolean;
  payment: Payment | null;
}

export async function settleProcessingPayment(
  input: SettleProcessingPaymentInput,
  paymentRepo: PaymentRepository,
  auditRepo?: AuditRepository,
): Promise<SettleProcessingPaymentResult> {
  if (!input.tenantId) throw new ValidationError('tenantId is required');
  if (!input.paymentId) throw new ValidationError('paymentId is required');

  const settled = await paymentRepo.settleProcessingPaymentAtomic(
    input.tenantId,
    input.paymentId,
  );

  if (!settled) {
    // Not found OR not 'processing' (already completed/reversed). Either
    // way a terminal no-op; the caller already deduped on provider ref.
    const existing = await paymentRepo.findById(input.tenantId, input.paymentId);
    return { settled: false, payment: existing };
  }

  if (auditRepo) {
    await auditRepo.create(
      createAuditEvent({
        tenantId: input.tenantId,
        actorId: input.actorId ?? 'system:stripe_webhook',
        actorRole: input.actorRole ?? 'system',
        eventType: 'payment.recorded',
        entityType: 'invoice',
        entityId: settled.invoiceId,
        correlationId: input.correlationId,
        metadata: {
          paymentId: settled.id,
          amountCents: settled.amountCents,
          method: settled.method,
          providerReference: settled.providerReference ?? null,
          settled: true,
        },
      }),
    );
  }

  return { settled: true, payment: settled };
}
