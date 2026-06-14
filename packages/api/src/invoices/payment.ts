import { v4 as uuidv4 } from 'uuid';
import { Invoice, InvoiceRepository } from './invoice';
import { ValidationError } from '../shared/errors';
import { RefreshJobMoneyStateDeps, refreshJobMoneyStateSafe } from '../jobs/job-money-state';
import { AuditRepository, createAuditEvent } from '../audit/audit';

/**
 * Optional audit context for `recordPayment`. When `auditRepo` is wired,
 * recording a payment emits a `payment.recorded` event (plus an
 * `invoice.status_changed` event when the invoice status flips). Emitted
 * after the invoice update so it participates in the caller's
 * request-scoped transaction (authenticated /api routes) and commits or
 * rolls back atomically with the payment + invoice writes.
 */
export interface RecordPaymentAuditContext {
  /** Actor role to stamp (defaults to 'system' for webhook/automation paths). */
  actorRole?: string;
  /** Correlation id (e.g. Stripe payment_intent / event id) for traceability. */
  correlationId?: string;
}

export interface PaymentReceiptNotifier {
  notifyPaymentReceived(
    tenantId: string,
    invoiceId: string,
    amountCents: number,
  ): Promise<void>;
}

/**
 * U5 (ACH async lifecycle) — `'processing'` is a durable IN-FLIGHT state for
 * bank-debit (ACH / us_bank_account) payments. Stripe fires
 * `payment_intent.processing` when the debit is initiated but funds have not
 * yet cleared (settlement takes days). We record the payment as 'processing'
 * and credit the invoice balance as in-flight so the owner / AR / digest see
 * the money is on its way; `payment_intent.succeeded` later flips it
 * 'processing' -> 'completed' (no second credit), and an ACH return /
 * `payment_intent.payment_failed` reverses the in-flight credit and reopens
 * the invoice. A 'processing' row is excluded from gross-revenue math (which
 * filters `status === 'completed'`) — it is visible-but-not-yet-earned.
 */
export type PaymentStatus = 'pending' | 'processing' | 'completed' | 'failed' | 'refunded';
export type PaymentMethod = 'cash' | 'check' | 'credit_card' | 'bank_transfer' | 'other';

export interface Payment {
  id: string;
  tenantId: string;
  invoiceId: string;
  amountCents: number;
  method: PaymentMethod;
  status: PaymentStatus;
  providerReference?: string;
  note?: string;
  receivedAt: Date;
  processedBy: string;
  createdAt: Date;
  updatedAt: Date;
  /**
   * D2-4 — cumulative refunded magnitude on this payment. A refund is
   * NOT a status flip; the original row keeps its full `amountCents`
   * and this column accumulates each partial. Invariant enforced by
   * `recordRefund`: `refundedAmountCents <= amountCents`.
   *
   * Default 0 (no refund). Use `recordRefund(...)` in
   * `packages/api/src/payments/payment-service.ts` to mutate this
   * field — direct writes bypass the over-refund guard and the
   * audit-event emission.
   */
  refundedAmountCents: number;
  /** Timestamp of the most recent partial refund, or null if none. */
  refundedAt: Date | null;
  /** Stripe `re_*` id of the most recent refund, or null. */
  lastRefundStripeId: string | null;
  /**
   * Invoice-to-cash failure handling — timestamp this payment was
   * REVERSED, or null if it still stands. A reversal is distinct from a
   * refund: it marks money that never truly settled (ACH/bank NSF return)
   * or was clawed back (card chargeback). When set, `status` is flipped
   * to 'failed' so the payment drops out of gross revenue, and the linked
   * invoice has been reopened. Mutate ONLY via `reversePayment(...)` in
   * `packages/api/src/payments/payment-service.ts`.
   */
  reversedAt: Date | null;
  /** Why the payment was reversed (e.g. 'ach_return', 'dispute'), or null. */
  reversalReason: string | null;
}

export interface RecordPaymentInput {
  tenantId: string;
  invoiceId: string;
  amountCents: number;
  method: PaymentMethod;
  providerReference?: string;
  note?: string;
  processedBy: string;
}

export interface PaymentListOptions {
  status?: PaymentStatus;
  /** Inclusive lower bound on `receivedAt`. */
  from?: Date;
  /** Exclusive upper bound on `receivedAt`. */
  to?: Date;
}

/**
 * D2-4 — options for the atomic refund increment.
 *
 * Used by `incrementRefundAtomic` to apply a refund as a single
 * compare-and-swap, closing the concurrent-webhook race where two
 * read-validate-write callers could both pass the over-refund check
 * against the same `refundedAmountCents` snapshot.
 */
export interface IncrementRefundOptions {
  /** Positive integer cents delta to add to `refundedAmountCents`. */
  refundCents: number;
  /** Timestamp to stamp onto `refundedAt`. */
  refundedAt: Date;
  /** Stripe `re_*` id of this refund (preserved if null/undefined). */
  stripeRefundId?: string | null;
}

/**
 * Options for the atomic payment reversal. Used by `reversePaymentAtomic`
 * to flip a `completed` payment to `failed` as a single compare-and-swap,
 * so a redelivered NSF/chargeback webhook (or two concurrent deliveries)
 * cannot reverse the same payment twice or double-decrement the invoice.
 */
export interface ReversePaymentOptions {
  /** Timestamp to stamp onto `reversedAt`. */
  reversedAt: Date;
  /** Why the payment was reversed (e.g. 'ach_return', 'dispute'). */
  reason: string;
}

export interface PaymentRepository {
  create(payment: Payment): Promise<Payment>;
  findById(tenantId: string, id: string): Promise<Payment | null>;
  findByInvoice(tenantId: string, invoiceId: string): Promise<Payment[]>;
  findByTenant(tenantId: string, options?: PaymentListOptions): Promise<Payment[]>;
  /**
   * D2-4 (Codex P1 #2 follow-up) — resolve a payment by the value we
   * stamped into `provider_reference` at creation time. The Stripe
   * webhook handler uses this to look up the local payment row from
   * a `charge.refunded` event's `payment_intent` field, because our
   * creation paths attach `tenant_id` / `invoice_id` metadata to the
   * Stripe object but NOT a `payment_id` — so refund metadata alone is
   * not enough to find the originating payment.
   *
   * Returns the most recently received matching payment, or `null` when
   * none exists. `tenant_id` is required (the unique index on
   * `provider_reference` is per-tenant; without it cross-tenant
   * collisions could resolve incorrectly).
   */
  findByProviderReference(tenantId: string, providerReference: string): Promise<Payment | null>;
  /**
   * System-level lookup by Stripe payment_intent (the value we stamp into
   * provider_reference at checkout.session.completed). Used by webhook
   * handlers that receive payment events lacking explicit tenant metadata
   * (e.g. charge.refund.updated). Bypasses tenant-scoped RLS via withClient
   * — only call from server-internal trusted paths.
   */
  findByProviderReferenceCrossTenant(providerReference: string): Promise<Payment | null>;
  update(tenantId: string, id: string, updates: Partial<Payment>): Promise<Payment | null>;
  /**
   * D2-4 — atomically increment `refundedAmountCents` by `opts.refundCents`,
   * but only if the result stays `<= amountCents`. Returns the updated
   * payment on success, or `null` if the row does not exist OR the
   * over-refund guard rejected the write. Callers must distinguish the
   * two via a follow-up `findById` (see `recordRefund`).
   *
   * This is the only safe path under concurrent webhook delivery: a
   * naive read-then-write lets two callers both pass validation against
   * the same snapshot and then both UPDATE, over-refunding by up to 2x.
   */
  incrementRefundAtomic(
    tenantId: string,
    id: string,
    opts: IncrementRefundOptions,
  ): Promise<Payment | null>;
  /**
   * Invoice-to-cash failure handling — atomically flip a `completed`
   * payment to `failed`, stamping `reversedAt`/`reversalReason`, but ONLY
   * if it has not already been reversed. Returns the updated payment on
   * success, or `null` when the row does not exist OR was already reversed
   * / is not in 'completed' status (the guard lives in the WHERE clause,
   * mirroring `incrementRefundAtomic`). This makes a duplicate NSF /
   * chargeback webhook delivery a clean no-op rather than a double
   * invoice-balance decrement.
   */
  reversePaymentAtomic(
    tenantId: string,
    id: string,
    opts: ReversePaymentOptions,
  ): Promise<Payment | null>;
  /**
   * U5 (ACH async lifecycle) — atomically flip an IN-FLIGHT payment
   * 'processing' -> 'completed' when the bank debit settles
   * (`payment_intent.succeeded`). Guarded on `status = 'processing'` so a
   * duplicate `succeeded` delivery (or a `succeeded` that races the
   * already-completed card path) is a clean no-op. The invoice balance is
   * NOT touched here — it was already credited in-flight at
   * `payment_intent.processing`. Returns the updated payment, or `null`
   * when the row does not exist OR is not in 'processing' status.
   */
  settleProcessingPaymentAtomic(
    tenantId: string,
    id: string,
  ): Promise<Payment | null>;
  /**
   * U5 (ACH async lifecycle) — atomically flip an IN-FLIGHT payment
   * 'processing' -> 'failed', stamping `reversedAt`/`reversalReason`, when
   * the bank debit is RETURNED before it ever settled
   * (`payment_intent.payment_failed` on an ACH that was still processing).
   * Guarded on `status = 'processing' AND reversed_at IS NULL` so a
   * duplicate delivery is a no-op. The caller (`reversePayment`) then backs
   * out the in-flight invoice credit. Distinct from `reversePaymentAtomic`,
   * which only reverses an already-SETTLED ('completed') payment (NSF after
   * settlement); keeping them separate preserves that path's `completed`
   * guard. Returns the updated payment, or `null` when the row does not
   * exist OR is not in 'processing' status.
   */
  reverseInFlightPaymentAtomic(
    tenantId: string,
    id: string,
    opts: ReversePaymentOptions,
  ): Promise<Payment | null>;
}

export function validatePaymentInput(input: RecordPaymentInput): string[] {
  const errors: string[] = [];
  if (!input.tenantId) errors.push('tenantId is required');
  if (!input.invoiceId) errors.push('invoiceId is required');
  if (!input.amountCents || input.amountCents <= 0) errors.push('amountCents must be positive');
  if (!Number.isInteger(input.amountCents)) errors.push('amountCents must be an integer');
  if (!input.method) errors.push('method is required');
  if (input.method && !['cash', 'check', 'credit_card', 'bank_transfer', 'other'].includes(input.method)) {
    errors.push('Invalid payment method');
  }
  if (!input.processedBy) errors.push('processedBy is required');
  return errors;
}

export async function recordPayment(
  input: RecordPaymentInput,
  invoiceRepo: InvoiceRepository,
  paymentRepo: PaymentRepository,
  moneyStateDeps?: RefreshJobMoneyStateDeps,
  paymentReceiptNotifier?: PaymentReceiptNotifier,
  auditRepo?: AuditRepository,
  auditContext?: RecordPaymentAuditContext,
): Promise<{ payment: Payment; invoice: Invoice }> {
  const errors = validatePaymentInput(input);
  if (errors.length > 0) throw new ValidationError(`Validation failed: ${errors.join(', ')}`);

  const invoice = await invoiceRepo.findById(input.tenantId, input.invoiceId);
  if (!invoice) throw new ValidationError('Invoice not found');

  const PAYABLE_STATUSES = ['open', 'partially_paid'];
  if (!PAYABLE_STATUSES.includes(invoice.status)) {
    throw new ValidationError(`Cannot record payment on invoice with status '${invoice.status}'`);
  }

  if (input.amountCents > invoice.amountDueCents) {
    throw new ValidationError('Payment amount exceeds amount due');
  }

  const payment: Payment = {
    id: uuidv4(),
    tenantId: input.tenantId,
    invoiceId: input.invoiceId,
    amountCents: input.amountCents,
    method: input.method,
    status: 'completed',
    providerReference: input.providerReference,
    note: input.note,
    receivedAt: new Date(),
    processedBy: input.processedBy,
    createdAt: new Date(),
    updatedAt: new Date(),
    refundedAmountCents: 0,
    refundedAt: null,
    lastRefundStripeId: null,
    reversedAt: null,
    reversalReason: null,
  };

  await paymentRepo.create(payment);

  // Update invoice balances
  const newAmountPaid = invoice.amountPaidCents + input.amountCents;
  const newAmountDue = Math.max(0, invoice.totals.totalCents - newAmountPaid);

  let newStatus = invoice.status;
  if (newAmountDue === 0) {
    newStatus = 'paid';
  } else if (newAmountPaid > 0 && ['open', 'partially_paid'].includes(invoice.status)) {
    newStatus = 'partially_paid';
  }

  const updatedInvoice = await invoiceRepo.update(input.tenantId, input.invoiceId, {
    amountPaidCents: newAmountPaid,
    amountDueCents: newAmountDue,
    status: newStatus,
    updatedAt: new Date(),
  });

  // Audit trail (CLAUDE.md: "All mutations: emit audit events"). Emitted
  // before the best-effort money-state rollup so that — on authenticated
  // /api routes, which run inside the request-scoped transaction — the
  // audit row commits or rolls back atomically with the payment + invoice
  // writes. A failure here intentionally bubbles: a payment with no audit
  // record is not an acceptable committed state.
  if (auditRepo) {
    const actorRole = auditContext?.actorRole ?? 'system';
    const correlationId = auditContext?.correlationId;
    await auditRepo.create(
      createAuditEvent({
        tenantId: input.tenantId,
        actorId: input.processedBy,
        actorRole,
        eventType: 'payment.recorded',
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

  // §6 Time-to-Cash. Roll the job's money-state forward (best-effort —
  // the payment + invoice writes already succeeded; a rollup failure
  // must not bounce them). No-op when the caller didn't wire the deps.
  if (updatedInvoice && moneyStateDeps) {
    await refreshJobMoneyStateSafe(
      input.tenantId,
      updatedInvoice.jobId,
      input.processedBy,
      moneyStateDeps,
    );
  }

  if (updatedInvoice && paymentReceiptNotifier) {
    await paymentReceiptNotifier.notifyPaymentReceived(
      input.tenantId,
      input.invoiceId,
      input.amountCents,
    );
  }

  return { payment, invoice: updatedInvoice! };
}

export async function getPaymentsByInvoice(
  tenantId: string,
  invoiceId: string,
  repository: PaymentRepository
): Promise<Payment[]> {
  return repository.findByInvoice(tenantId, invoiceId);
}

export class InMemoryPaymentRepository implements PaymentRepository {
  private payments: Map<string, Payment> = new Map();

  async create(payment: Payment): Promise<Payment> {
    this.payments.set(payment.id, { ...payment });
    return { ...payment };
  }

  async findById(tenantId: string, id: string): Promise<Payment | null> {
    const p = this.payments.get(id);
    if (!p || p.tenantId !== tenantId) return null;
    return { ...p };
  }

  async findByInvoice(tenantId: string, invoiceId: string): Promise<Payment[]> {
    return Array.from(this.payments.values())
      .filter((p) => p.tenantId === tenantId && p.invoiceId === invoiceId)
      .map((p) => ({ ...p }));
  }

  async findByProviderReference(
    tenantId: string,
    providerReference: string,
  ): Promise<Payment | null> {
    // Most-recent-first matches the pg impl's ORDER BY received_at DESC.
    const matches = Array.from(this.payments.values())
      .filter((p) => p.tenantId === tenantId && p.providerReference === providerReference)
      .sort((a, b) => b.receivedAt.getTime() - a.receivedAt.getTime());
    return matches[0] ? { ...matches[0] } : null;
  }

  async findByProviderReferenceCrossTenant(providerReference: string): Promise<Payment | null> {
    const matches = Array.from(this.payments.values())
      .filter((p) => p.providerReference === providerReference)
      .sort((a, b) => b.receivedAt.getTime() - a.receivedAt.getTime());
    return matches[0] ? { ...matches[0] } : null;
  }

  async findByTenant(tenantId: string, options?: PaymentListOptions): Promise<Payment[]> {
    return Array.from(this.payments.values())
      .filter((p) => p.tenantId === tenantId)
      .filter((p) => !options?.status || p.status === options.status)
      .filter((p) => !options?.from || p.receivedAt.getTime() >= options.from.getTime())
      .filter((p) => !options?.to || p.receivedAt.getTime() < options.to.getTime())
      .map((p) => ({ ...p }));
  }

  async update(tenantId: string, id: string, updates: Partial<Payment>): Promise<Payment | null> {
    const p = this.payments.get(id);
    if (!p || p.tenantId !== tenantId) return null;
    const updated = { ...p, ...updates };
    this.payments.set(id, updated);
    return { ...updated };
  }

  /**
   * D2-4 — mirror of the pg compare-and-swap. We yield to the microtask
   * queue once before reading + writing so that two `Promise.all`
   * callers actually interleave under the in-memory repo (otherwise
   * Node's single-threaded sync `Map` ops would serialize trivially and
   * the test couldn't observe the race). The read+check+write block
   * itself runs synchronously, which matches the atomicity of the
   * Postgres `UPDATE ... WHERE ... RETURNING` statement.
   */
  async incrementRefundAtomic(
    tenantId: string,
    id: string,
    opts: IncrementRefundOptions,
  ): Promise<Payment | null> {
    await Promise.resolve();
    const p = this.payments.get(id);
    if (!p || p.tenantId !== tenantId) return null;
    const next = (p.refundedAmountCents ?? 0) + opts.refundCents;
    if (next > p.amountCents) return null;
    const updated: Payment = {
      ...p,
      refundedAmountCents: next,
      refundedAt: opts.refundedAt,
      lastRefundStripeId: opts.stripeRefundId ?? p.lastRefundStripeId ?? null,
      updatedAt: new Date(),
    };
    this.payments.set(id, updated);
    return { ...updated };
  }

  /**
   * Mirror of the pg compare-and-swap reversal. Yields to the microtask
   * queue once so two concurrent callers interleave under the in-memory
   * repo (matching `incrementRefundAtomic`). The guard — only flip when
   * `status === 'completed'` and not yet reversed — makes a second call
   * a no-op, so a duplicate webhook can't double-reverse.
   */
  async reversePaymentAtomic(
    tenantId: string,
    id: string,
    opts: ReversePaymentOptions,
  ): Promise<Payment | null> {
    await Promise.resolve();
    const p = this.payments.get(id);
    if (!p || p.tenantId !== tenantId) return null;
    // `!= null` (loose) treats both null and a legacy `undefined` as
    // "not yet reversed"; a Date blocks the second reversal.
    if (p.status !== 'completed' || p.reversedAt != null) return null;
    const updated: Payment = {
      ...p,
      status: 'failed',
      reversedAt: opts.reversedAt,
      reversalReason: opts.reason,
      updatedAt: new Date(),
    };
    this.payments.set(id, updated);
    return { ...updated };
  }

  /**
   * U5 — mirror of the pg compare-and-swap settle. Yields once so two
   * concurrent `succeeded` deliveries interleave. The guard — only flip
   * when `status === 'processing'` — makes a second call (or a race with
   * the already-completed card path) a no-op.
   */
  async settleProcessingPaymentAtomic(
    tenantId: string,
    id: string,
  ): Promise<Payment | null> {
    await Promise.resolve();
    const p = this.payments.get(id);
    if (!p || p.tenantId !== tenantId) return null;
    if (p.status !== 'processing') return null;
    const updated: Payment = { ...p, status: 'completed', updatedAt: new Date() };
    this.payments.set(id, updated);
    return { ...updated };
  }

  /**
   * U5 — mirror of the pg compare-and-swap in-flight reversal. Yields once
   * so two concurrent deliveries interleave. The guard — only flip when
   * `status === 'processing'` and not yet reversed — makes a duplicate
   * ACH-return delivery a no-op.
   */
  async reverseInFlightPaymentAtomic(
    tenantId: string,
    id: string,
    opts: ReversePaymentOptions,
  ): Promise<Payment | null> {
    await Promise.resolve();
    const p = this.payments.get(id);
    if (!p || p.tenantId !== tenantId) return null;
    if (p.status !== 'processing' || p.reversedAt != null) return null;
    const updated: Payment = {
      ...p,
      status: 'failed',
      reversedAt: opts.reversedAt,
      reversalReason: opts.reason,
      updatedAt: new Date(),
    };
    this.payments.set(id, updated);
    return { ...updated };
  }
}
