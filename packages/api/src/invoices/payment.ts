import { v4 as uuidv4 } from 'uuid';
import { Invoice, InvoiceRepository } from './invoice';
import { ValidationError } from '../shared/errors';
import { RefreshJobMoneyStateDeps, refreshJobMoneyStateSafe } from '../jobs/job-money-state';

export type PaymentStatus = 'pending' | 'completed' | 'failed' | 'refunded';
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

export interface PaymentRepository {
  create(payment: Payment): Promise<Payment>;
  findById(tenantId: string, id: string): Promise<Payment | null>;
  findByInvoice(tenantId: string, invoiceId: string): Promise<Payment[]>;
  findByTenant(tenantId: string, options?: PaymentListOptions): Promise<Payment[]>;
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
}
