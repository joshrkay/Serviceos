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
import { PaymentRepository, Payment } from '../invoices/payment';
import { AuditRepository, createAuditEvent } from '../audit/audit';
import { NotFoundError, ValidationError } from '../shared/errors';

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
