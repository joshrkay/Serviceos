import { v4 as uuidv4 } from 'uuid';
import { Invoice, InvoiceRepository } from './invoice';
import { ValidationError } from '../shared/errors';

export type PaymentStatus = 'pending' | 'completed' | 'failed' | 'refunded';
export type PaymentMethod = 'cash' | 'check' | 'credit_card' | 'bank_transfer' | 'other';

export interface Payment {
  id: string;
  tenantId: string;
  invoiceId: string;
  /**
   * Positive for incoming payments, NEGATIVE for refunds. The invoice
   * balance math (amount_paid_cents = sum of payments) treats a refund
   * as a negative payment so we don't need a parallel `refunds` table
   * or a separate column on the invoice.
   */
  amountCents: number;
  method: PaymentMethod;
  status: PaymentStatus;
  providerReference?: string;
  note?: string;
  /** Set on refund payments — points back to the original payment that's being refunded. */
  refundsPaymentId?: string;
  receivedAt: Date;
  processedBy: string;
  createdAt: Date;
  updatedAt: Date;
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

export interface PaymentRepository {
  create(payment: Payment): Promise<Payment>;
  findById(tenantId: string, id: string): Promise<Payment | null>;
  findByInvoice(tenantId: string, invoiceId: string): Promise<Payment[]>;
  update(tenantId: string, id: string, updates: Partial<Payment>): Promise<Payment | null>;
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
  paymentRepo: PaymentRepository
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

  return { payment, invoice: updatedInvoice! };
}

export async function getPaymentsByInvoice(
  tenantId: string,
  invoiceId: string,
  repository: PaymentRepository
): Promise<Payment[]> {
  return repository.findByInvoice(tenantId, invoiceId);
}

export interface RefundPaymentInput {
  tenantId: string;
  /** ID of the original (positive) payment being refunded. */
  paymentId: string;
  /** Refund amount in positive cents — the function negates it for storage. */
  amountCents: number;
  /** Free-form reason; required so refunds always have an audit trail. */
  reason: string;
  processedBy: string;
}

/**
 * Refund all or part of a previously-recorded payment. Stores the
 * refund as a NEW payment row with negative `amountCents` and
 * `refundsPaymentId` pointing at the original. The invoice balance
 * is recomputed from `amount_paid_cents -= refund` so the invoice
 * status flips back to `partially_paid` (or `open` on a full refund)
 * automatically.
 *
 * Constraints:
 *   - The refund cannot exceed the net amount currently paid on the
 *     invoice (sum of completed payments minus prior refunds).
 *   - Original payment must be `completed`.
 */
export async function refundPayment(
  input: RefundPaymentInput,
  invoiceRepo: InvoiceRepository,
  paymentRepo: PaymentRepository
): Promise<{ refund: Payment; invoice: Invoice }> {
  if (!input.tenantId) throw new ValidationError('tenantId is required');
  if (!input.paymentId) throw new ValidationError('paymentId is required');
  if (!Number.isInteger(input.amountCents) || input.amountCents <= 0) {
    throw new ValidationError('Refund amountCents must be a positive integer');
  }
  if (!input.reason || input.reason.trim().length === 0) {
    throw new ValidationError('Refund reason is required');
  }
  if (!input.processedBy) throw new ValidationError('processedBy is required');

  const original = await paymentRepo.findById(input.tenantId, input.paymentId);
  if (!original) throw new ValidationError('Payment not found');
  if (original.status !== 'completed') {
    throw new ValidationError(`Cannot refund payment with status '${original.status}'`);
  }
  if (original.amountCents <= 0) {
    throw new ValidationError('Cannot refund a refund');
  }

  const invoice = await invoiceRepo.findById(input.tenantId, original.invoiceId);
  if (!invoice) throw new ValidationError('Invoice not found');

  if (input.amountCents > invoice.amountPaidCents) {
    throw new ValidationError('Refund amount exceeds amount paid on invoice');
  }

  const refund: Payment = {
    id: uuidv4(),
    tenantId: input.tenantId,
    invoiceId: original.invoiceId,
    amountCents: -input.amountCents,
    method: original.method,
    status: 'completed',
    providerReference: original.providerReference,
    note: input.reason.trim(),
    refundsPaymentId: original.id,
    receivedAt: new Date(),
    processedBy: input.processedBy,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  await paymentRepo.create(refund);

  // Mark the original as refunded once cumulative refunds equal it.
  // Stored separately on the original row so the UI can show "Refunded"
  // without scanning every related payment.
  const allPayments = await paymentRepo.findByInvoice(input.tenantId, original.invoiceId);
  const totalRefundedAgainstOriginal = allPayments
    .filter((p) => p.refundsPaymentId === original.id)
    .reduce((sum, p) => sum + Math.abs(p.amountCents), 0);
  if (totalRefundedAgainstOriginal >= original.amountCents) {
    await paymentRepo.update(input.tenantId, original.id, {
      status: 'refunded',
      updatedAt: new Date(),
    });
  }

  // Recompute invoice balance and status. amount_paid_cents shrinks;
  // amount_due grows back. Status reverts: paid → partially_paid; or
  // partially_paid → open if every payment was undone.
  const newAmountPaid = invoice.amountPaidCents - input.amountCents;
  const newAmountDue = Math.max(0, invoice.totals.totalCents - newAmountPaid);
  let newStatus = invoice.status;
  if (newAmountPaid <= 0 && invoice.status !== 'canceled' && invoice.status !== 'void') {
    newStatus = 'open';
  } else if (newAmountDue > 0 && invoice.status === 'paid') {
    newStatus = 'partially_paid';
  }

  const updatedInvoice = await invoiceRepo.update(input.tenantId, invoice.id, {
    amountPaidCents: newAmountPaid,
    amountDueCents: newAmountDue,
    status: newStatus,
    updatedAt: new Date(),
  });

  if (!updatedInvoice) throw new Error('Failed to update invoice after refund');

  return { refund, invoice: updatedInvoice };
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

  async update(tenantId: string, id: string, updates: Partial<Payment>): Promise<Payment | null> {
    const p = this.payments.get(id);
    if (!p || p.tenantId !== tenantId) return null;
    const updated = { ...p, ...updates };
    this.payments.set(id, updated);
    return { ...updated };
  }
}
