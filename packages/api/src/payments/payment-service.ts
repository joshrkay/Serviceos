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
import { ValidationError } from '../shared/errors';

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
 * - Looks up the payment under the requested tenant; rejects if not found
 *   or owned by a different tenant.
 * - Validates `refundCents` is a positive integer and that the cumulative
 *   refunded magnitude doesn't exceed the original `amountCents`.
 * - Atomically (best-effort) increments `refundedAmountCents`, sets
 *   `refundedAt` to the supplied timestamp (defaults to `new Date()`) and
 *   stamps `lastRefundStripeId` if provided.
 * - Writes a `payment.refunded` audit event with the refund delta and the
 *   new cumulative total.
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

  const payment = await paymentRepo.findById(input.tenantId, input.paymentId);
  if (!payment) {
    // Either missing or cross-tenant — surface the same error so probing
    // can't distinguish "exists in another tenant" from "doesn't exist".
    throw new ValidationError('Payment not found');
  }

  const previousRefunded = payment.refundedAmountCents ?? 0;
  const totalRefundedCents = previousRefunded + input.refundCents;
  if (totalRefundedCents > payment.amountCents) {
    throw new ValidationError(
      `Refund exceeds original payment: ${totalRefundedCents} > ${payment.amountCents}`,
    );
  }

  const refundedAt = input.refundedAt ?? new Date();
  const updated = await paymentRepo.update(input.tenantId, input.paymentId, {
    refundedAmountCents: totalRefundedCents,
    refundedAt,
    lastRefundStripeId: input.stripeRefundId ?? payment.lastRefundStripeId ?? null,
    updatedAt: new Date(),
  });

  if (!updated) {
    // Race: the row vanished between findById + update. Surface the same
    // not-found error so callers don't have to special-case it.
    throw new ValidationError('Payment not found');
  }

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
