import { v4 as uuidv4 } from 'uuid';
import { Invoice, InvoiceRepository, InvoiceStatus } from './invoice';
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

/**
 * E2a (one-time ACH) — input for recording an in-flight `processing`
 * payment. `providerReference` is REQUIRED (it is the Stripe
 * `payment_intent` id that uniqueness + idempotency key on) — unlike
 * `RecordPaymentInput` where it is optional for manual cash/check rows.
 */
export interface RecordProcessingPaymentInput {
  tenantId: string;
  invoiceId: string;
  amountCents: number;
  method: PaymentMethod;
  /** Stripe `payment_intent` id — the uniqueness + idempotency key. */
  providerReference: string;
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

/**
 * E2a (one-time ACH) — extra columns to stamp alongside the atomic
 * `processing -> {completed|failed}` transition (`transitionFromProcessing`).
 *
 * On a `completed` settlement we reconcile `amountCents` to Stripe's
 * authoritative `amount_received` (which can drift from the originally
 * announced `processing` amount) and set `receivedAt` to the settlement
 * time. On a `failed` transition we stamp `reversalReason` so the failure
 * carries a human-readable cause, mirroring `reversePaymentAtomic`. Every
 * field is optional — only the columns present are written.
 */
export interface TransitionFromProcessingExtras {
  /** Reconcile the row's settled magnitude (Stripe `amount_received`). */
  amountCents?: number;
  /** Stamp the settlement/failure time onto `paid_at`. */
  receivedAt?: Date;
  /** Why a processing payment failed (e.g. 'ach_failed'). */
  reversalReason?: string;
  /** Stamp the failure time onto `reversed_at` (failed transition only). */
  reversedAt?: Date;
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
   * none exists. `tenant_id` is required: the partial unique index on
   * `payments(tenant_id, reference_number)` (migration 178) is per-tenant,
   * so without the explicit scope a cross-tenant collision could resolve
   * incorrectly. The `ORDER BY paid_at DESC LIMIT 1` in the pg impl is kept
   * defensively for legacy rows written before migration 178 (and for the
   * dirty-data fallback where the migration created a NON-unique index).
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
   * E2a (one-time ACH) — race-safe insert of an in-flight `processing`
   * payment. `INSERT ... ON CONFLICT (tenant_id, reference_number) DO
   * NOTHING RETURNING *` against the partial unique index added in
   * migration 178. Returns the inserted row, or `null` when a row with
   * the same `(tenant_id, reference_number)` already exists (a redelivered
   * or concurrent `payment_intent.processing` event). This is the DB-level
   * backstop the ACH idempotency story rests on — the webhook-base dedup
   * keys on `(source, event_id)` and gives zero protection across the
   * distinct processing/succeeded/failed event ids for one PaymentIntent.
   */
  createIfNotExists(payment: Payment): Promise<Payment | null>;
  /**
   * E2a (one-time ACH) — atomic compare-and-swap out of `processing`. A
   * single `UPDATE payments SET status=$toStatus ... WHERE tenant_id AND
   * id AND status='processing' RETURNING *` so settle and fail are mutually
   * exclusive: whichever commits first flips the row, the loser sees a
   * non-`processing` status and matches 0 rows. Returns the updated row on
   * a winning CAS, or `null` when the row already left `processing`
   * (terminal no-op), mirroring `reversePaymentAtomic`'s idempotency. The
   * caller runs invoice/money-state/receipt effects ONLY after a non-null
   * return, so a lost CAS can never produce a phantom-paid invoice.
   */
  transitionFromProcessing(
    tenantId: string,
    id: string,
    toStatus: PaymentStatus,
    extras?: TransitionFromProcessingExtras,
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

  // Apply the FULL settled-money effect set (invoice balance/status,
  // audit `payment.recorded` + conditional `invoice.status_changed`,
  // money-state rollup, receipt). Shared verbatim with ACH settlement
  // (`settleProcessingPayment`) so the card path and the ACH path run
  // byte-identical effects — see `applySettledPayment`.
  const { invoice: updatedInvoice } = await applySettledPayment(
    invoice,
    payment,
    payment.amountCents,
    invoiceRepo,
    {
      actorId: input.processedBy,
      actorRole: auditContext?.actorRole,
      correlationId: auditContext?.correlationId,
    },
    moneyStateDeps,
    paymentReceiptNotifier,
    auditRepo,
  );

  return { payment, invoice: updatedInvoice };
}

/**
 * E2a — context for the shared settled-money effect helper.
 */
export interface ApplySettledPaymentContext {
  /** Audit actor id (the recording user, or a `system:*` sentinel). */
  actorId: string;
  /** Actor role to stamp (defaults to 'system'). */
  actorRole?: string;
  /** Correlation id (Stripe payment_intent / event id) for traceability. */
  correlationId?: string;
}

/**
 * Pure invoice balance + status math for applying `amountCents` of settled
 * money to `invoice`. Extracted from `recordPayment` so the card path and
 * ACH settlement compute the post-payment state identically. Returns the
 * new figures; the CALLER persists them (so the persisted row can be
 * audited atomically with the invoice update on /api routes).
 *
 * Integer cents throughout. `amountDueCents` floors at 0; status flips to
 * 'paid' when nothing is due, else 'partially_paid' while the invoice is
 * still open/partially_paid (a terminal status is left untouched).
 */
export function applyPaymentToInvoice(
  invoice: Invoice,
  amountCents: number,
): { amountPaidCents: number; amountDueCents: number; status: InvoiceStatus } {
  const amountPaidCents = invoice.amountPaidCents + amountCents;
  const amountDueCents = Math.max(0, invoice.totals.totalCents - amountPaidCents);

  let status = invoice.status;
  if (amountDueCents === 0) {
    status = 'paid';
  } else if (amountPaidCents > 0 && ['open', 'partially_paid'].includes(invoice.status)) {
    status = 'partially_paid';
  }

  return { amountPaidCents, amountDueCents, status };
}

/**
 * E2a — the shared post-create settled-money effect set. Performs EVERY
 * effect a normal settled payment has, in the order `recordPayment` always
 * has:
 *  1. invoice balance + status update (via `applyPaymentToInvoice`),
 *  2. audit `payment.recorded` (+ conditional `invoice.status_changed`),
 *  3. `refreshJobMoneyStateSafe` money-state rollup (best-effort),
 *  4. the payment-receipt notifier.
 *
 * Used by BOTH `recordPayment` (card/manual capture) and
 * `settleProcessingPayment` (ACH settlement) so the two paths are
 * byte-identical and ACH cannot diverge — same audit event TYPES the card
 * path emits (`payment.recorded`, NOT a new `payment.completed`, which
 * revenue consumers filtering `payment.recorded` would miss), the same
 * money-state call, the same receipt.
 *
 * The `payment` row is assumed already persisted (created or CAS-settled).
 * `appliedAmountCents` is the magnitude to apply to the invoice and to
 * stamp in the audit/receipt — for settlement this is the amount AFTER the
 * over-collection cap, which can be less than `payment.amountCents`.
 */
export async function applySettledPayment(
  invoice: Invoice,
  payment: Payment,
  appliedAmountCents: number,
  invoiceRepo: InvoiceRepository,
  context: ApplySettledPaymentContext,
  moneyStateDeps?: RefreshJobMoneyStateDeps,
  paymentReceiptNotifier?: PaymentReceiptNotifier,
  auditRepo?: AuditRepository,
): Promise<{ payment: Payment; invoice: Invoice }> {
  const next = applyPaymentToInvoice(invoice, appliedAmountCents);

  const updatedInvoice = await invoiceRepo.update(invoice.tenantId, invoice.id, {
    amountPaidCents: next.amountPaidCents,
    amountDueCents: next.amountDueCents,
    status: next.status,
    updatedAt: new Date(),
  });

  // Audit trail (CLAUDE.md: "All mutations: emit audit events"). Emitted
  // before the best-effort money-state rollup so that — on authenticated
  // /api routes, which run inside the request-scoped transaction — the
  // audit row commits or rolls back atomically with the payment + invoice
  // writes. A failure here intentionally bubbles: a payment with no audit
  // record is not an acceptable committed state.
  if (auditRepo) {
    const actorRole = context.actorRole ?? 'system';
    const correlationId = context.correlationId;
    await auditRepo.create(
      createAuditEvent({
        tenantId: invoice.tenantId,
        actorId: context.actorId,
        actorRole,
        eventType: 'payment.recorded',
        entityType: 'invoice',
        entityId: invoice.id,
        correlationId,
        metadata: {
          paymentId: payment.id,
          amountCents: appliedAmountCents,
          method: payment.method,
          providerReference: payment.providerReference ?? null,
          newInvoiceStatus: (updatedInvoice ?? invoice).status,
        },
      }),
    );

    if (updatedInvoice && updatedInvoice.status !== invoice.status) {
      await auditRepo.create(
        createAuditEvent({
          tenantId: invoice.tenantId,
          actorId: context.actorId,
          actorRole,
          eventType: 'invoice.status_changed',
          entityType: 'invoice',
          entityId: invoice.id,
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
      invoice.tenantId,
      updatedInvoice.jobId,
      context.actorId,
      moneyStateDeps,
    );
  }

  if (updatedInvoice && paymentReceiptNotifier) {
    await paymentReceiptNotifier.notifyPaymentReceived(
      invoice.tenantId,
      invoice.id,
      appliedAmountCents,
    );
  }

  return { payment, invoice: updatedInvoice! };
}

/**
 * E2a (one-time ACH) — record an in-flight `processing` payment WITHOUT
 * touching the invoice. Used by the `payment_intent.processing` webhook
 * branch: ACH funds take 1–4 business days to clear, so the invoice stays
 * `open` and NO receipt fires until settlement upgrades this row to
 * `completed` (`settleProcessingPayment`).
 *
 * Idempotency (two layers, R5/R9):
 *  - App-level any-row guard: if ANY payment already exists for this
 *    `(tenant, provider_reference)` we no-op and return it. This also
 *    covers the dirty-data fallback where migration 178 created a
 *    NON-unique index (so `createIfNotExists`'s ON CONFLICT cannot infer).
 *  - DB-level race backstop: the insert is `ON CONFLICT DO NOTHING`
 *    (`createIfNotExists`). A concurrent processing event that slips past
 *    the any-row read still cannot create a second row; a null insert
 *    result then resolves to the existing row.
 *
 * Emits `payment.processing` (entityType 'invoice', mirroring
 * `recordPayment`'s `payment.recorded`) ONLY when a row is actually
 * inserted, so a redelivered event does not duplicate the audit trail.
 * Does NOT validate the invoice balance or run the money-state rollup —
 * none of those effects apply until funds clear.
 */
export async function recordProcessingPayment(
  input: RecordProcessingPaymentInput,
  paymentRepo: PaymentRepository,
  auditRepo?: AuditRepository,
  auditContext?: RecordPaymentAuditContext,
): Promise<{ payment: Payment; created: boolean }> {
  if (!input.tenantId) throw new ValidationError('tenantId is required');
  if (!input.invoiceId) throw new ValidationError('invoiceId is required');
  if (!input.providerReference) throw new ValidationError('providerReference is required');
  if (!Number.isInteger(input.amountCents) || input.amountCents <= 0) {
    throw new ValidationError('amountCents must be a positive integer');
  }
  if (!input.method) throw new ValidationError('method is required');
  if (!input.processedBy) throw new ValidationError('processedBy is required');

  // App-level any-row guard — no-op if a row already exists for this
  // provider_reference (idempotent redelivery, or a row already settled /
  // failed). Also the only guard in the non-unique-index fallback case.
  const existing = await paymentRepo.findByProviderReference(
    input.tenantId,
    input.providerReference,
  );
  if (existing) {
    return { payment: existing, created: false };
  }

  const now = new Date();
  const payment: Payment = {
    id: uuidv4(),
    tenantId: input.tenantId,
    invoiceId: input.invoiceId,
    amountCents: input.amountCents,
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

  // DB-level race backstop: ON CONFLICT DO NOTHING. `null` ⇒ a concurrent
  // insert won the race; resolve to that row and treat as a no-op.
  const inserted = await paymentRepo.createIfNotExists(payment);
  if (!inserted) {
    const raced = await paymentRepo.findByProviderReference(
      input.tenantId,
      input.providerReference,
    );
    return { payment: raced ?? payment, created: false };
  }

  if (auditRepo) {
    await auditRepo.create(
      createAuditEvent({
        tenantId: input.tenantId,
        actorId: input.processedBy,
        actorRole: auditContext?.actorRole ?? 'system',
        eventType: 'payment.processing',
        entityType: 'invoice',
        entityId: input.invoiceId,
        correlationId: auditContext?.correlationId ?? input.providerReference,
        metadata: {
          paymentId: inserted.id,
          amountCents: inserted.amountCents,
          method: inserted.method,
          providerReference: inserted.providerReference ?? null,
        },
      }),
    );
  }

  return { payment: inserted, created: true };
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
   * E2a — mirror of the pg `INSERT ... ON CONFLICT DO NOTHING`. The
   * partial unique index is `(tenant_id, reference_number) WHERE
   * reference_number IS NOT NULL`, so the conflict key is the
   * (tenantId, providerReference) pair and a NULL providerReference is
   * never constrained (manual cash/check rows). Yields to the microtask
   * queue once so two concurrent callers interleave (matching the other
   * atomic helpers), then performs the existence check + insert as one
   * synchronous block — the atomicity of the `ON CONFLICT` statement.
   * Returns the inserted row, or `null` when a constrained duplicate
   * already exists.
   */
  async createIfNotExists(payment: Payment): Promise<Payment | null> {
    await Promise.resolve();
    if (payment.providerReference != null) {
      const conflict = Array.from(this.payments.values()).some(
        (p) =>
          p.tenantId === payment.tenantId &&
          p.providerReference === payment.providerReference,
      );
      if (conflict) return null;
    }
    this.payments.set(payment.id, { ...payment });
    return { ...payment };
  }

  /**
   * E2a — mirror of the pg atomic CAS out of `processing`. Yields to the
   * microtask queue once so a concurrent settle+fail pair interleaves,
   * then the guard — only flip while `status === 'processing'` — runs
   * synchronously, matching `UPDATE ... WHERE status='processing'
   * RETURNING *`. The loser sees a non-`processing` status and gets
   * `null`, so exactly one transition wins.
   */
  async transitionFromProcessing(
    tenantId: string,
    id: string,
    toStatus: PaymentStatus,
    extras?: TransitionFromProcessingExtras,
  ): Promise<Payment | null> {
    await Promise.resolve();
    const p = this.payments.get(id);
    if (!p || p.tenantId !== tenantId) return null;
    if (p.status !== 'processing') return null;
    const updated: Payment = {
      ...p,
      status: toStatus,
      amountCents: extras?.amountCents ?? p.amountCents,
      receivedAt: extras?.receivedAt ?? p.receivedAt,
      reversedAt: extras?.reversedAt ?? p.reversedAt,
      reversalReason: extras?.reversalReason ?? p.reversalReason,
      updatedAt: new Date(),
    };
    this.payments.set(id, updated);
    return { ...updated };
  }
}
