import { v4 as uuidv4 } from 'uuid';
import {
  LineItem,
  DocumentTotals,
  calculateDocumentTotals,
  normalizeLineItemTotals,
} from '../shared/billing-engine';
import { AuditRepository, createAuditEvent } from '../audit/audit';
import { ValidationError } from '../shared/errors';
import { SettingsRepository, getNextInvoiceNumber } from '../settings/settings';
import { buildOriginationMetadata } from '../leads/attribution-metadata';
import { RefreshJobMoneyStateDeps, refreshJobMoneyStateSafe } from '../jobs/job-money-state';
import { cancelInvoicePaymentIntents, deactivateInvoicePaymentLink } from './invoice-payment-link';
import type { PaymentLinkProvider } from '../payments/payment-link-provider';
import type { ConnectAccountResolver } from './public-invoice-service';

export type InvoiceStatus = 'draft' | 'open' | 'partially_paid' | 'paid' | 'void' | 'canceled';

export interface Invoice {
  id: string;
  tenantId: string;
  jobId: string;
  estimateId?: string;
  invoiceNumber: string;
  status: InvoiceStatus;
  lineItems: LineItem[];
  totals: DocumentTotals;
  amountPaidCents: number;
  amountDueCents: number;
  issuedAt?: Date;
  dueDate?: Date;
  customerMessage?: string;
  /** Random URL-safe token for unauthenticated customer payment-page links. */
  viewToken?: string;
  /** Timestamp the view_token becomes invalid. */
  viewTokenExpiresAt?: Date;
  /** Timestamp of the most recent send. */
  sentAt?: Date;
  /** ID of the most recent message_dispatches row. */
  lastDispatchId?: string;
  /** First time the customer opened the public payment link. */
  firstViewedAt?: Date;
  /** Number of times the public payment link has been opened. */
  viewCount?: number;
  /** Stripe Payment Link ID (e.g. plink_xxx) generated on first checkout request. */
  stripePaymentLinkId?: string;
  /** Stripe-hosted checkout URL returned with the payment link. */
  stripePaymentLinkUrl?: string;
  /** Inherits from `job.originatingLeadId` at creation; preserves source attribution. */
  originatingLeadId?: string;
  /** P21-001 — set when this invoice is a milestone of an invoice_schedules row. */
  scheduleId?: string;
  /** P21-001 — 0-based position of this invoice within its schedule's milestones. */
  milestoneIndex?: number;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateInvoiceInput {
  tenantId: string;
  jobId: string;
  estimateId?: string;
  invoiceNumber: string;
  lineItems: LineItem[];
  discountCents?: number;
  taxRateBps?: number;
  /** Processing-fee surcharge in basis points (Jobber parity). 0/omitted ⇒ none. */
  processingFeeBps?: number;
  customerMessage?: string;
  /** Optional override; routes auto-populate from job when omitted. */
  originatingLeadId?: string;
  /** P21-001/002 — link a minted milestone invoice to its schedule + position. */
  scheduleId?: string;
  milestoneIndex?: number;
  createdBy: string;
}

export interface UpdateInvoiceInput {
  lineItems?: LineItem[];
  discountCents?: number;
  taxRateBps?: number;
  processingFeeBps?: number;
  customerMessage?: string;
}

export interface InvoiceListOptions {
  status?: InvoiceStatus;
  jobId?: string;
  customerId?: string;
  /** ISO date — invoices with `due_date >= fromDueDate` are included. */
  fromDueDate?: Date;
  /** ISO date — invoices with `due_date <= toDueDate` are included. */
  toDueDate?: Date;
  /** ILIKE search across invoice_number / customer_message. */
  search?: string;
  /** Pagination cap. Default 50, hard-capped server-side at 200. */
  limit?: number;
  /** Pagination offset. Default 0. */
  offset?: number;
  /** Sort direction applied to the canonical sort column (created_at). */
  sort?: 'asc' | 'desc';
}

export interface InvoiceListResult {
  data: Invoice[];
  total: number;
}

/**
 * Update patch for `InvoiceRepository.update`. Identical to Partial<Invoice>
 * except the payment-link columns also accept `null`, which CLEARS the
 * column — needed when a link is deactivated (P0-1): `undefined` means
 * "leave unchanged", so without null there was no way to remove a dead
 * link, and every write path could only ever set the columns.
 */
export type InvoiceUpdate = Omit<
  Partial<Invoice>,
  'stripePaymentLinkId' | 'stripePaymentLinkUrl'
> & {
  stripePaymentLinkId?: string | null;
  stripePaymentLinkUrl?: string | null;
};

export const DEFAULT_INVOICE_LIMIT = 50;
export const MAX_INVOICE_LIMIT = 200;

export interface InvoiceRepository {
  create(invoice: Invoice): Promise<Invoice>;
  findById(tenantId: string, id: string): Promise<Invoice | null>;
  findByJob(tenantId: string, jobId: string): Promise<Invoice[]>;
  /**
   * Batched findByJob — all invoices for many jobs in ONE query instead of N.
   * Used by the invoicing queue / batch sweep to avoid an N+1 over completed
   * jobs. Returns all matching invoices; callers group by jobId.
   */
  findByJobs(tenantId: string, jobIds: string[]): Promise<Invoice[]>;
  findByTenant(tenantId: string, options?: InvoiceListOptions): Promise<Invoice[]>;
  /** P1-018: paginated `{ data, total }` form for list UIs. */
  listWithMeta?(tenantId: string, options?: InvoiceListOptions): Promise<InvoiceListResult>;
  update(tenantId: string, id: string, updates: InvoiceUpdate): Promise<Invoice | null>;
  /**
   * Atomically credit `deltaCents` to the paid balance in a SINGLE UPDATE,
   * recomputing amount_due and status from the row's own current values — never
   * from a caller's stale snapshot. Closes the recordPayment lost-update race:
   * two concurrent legitimate payments (e.g. a manual cash entry and a Stripe/ACH
   * webhook) otherwise each read the same amount_paid and blind-set it, silently
   * dropping one credit.
   *
   * The write itself is guarded (P0-3 / P0-6): it applies ONLY when the row is
   * currently payable ('open' / 'partially_paid') AND the credit fits the
   * remaining balance (`amount_paid + delta <= total`). A voided invoice can
   * therefore never be flipped to 'paid' by a racing credit, and two concurrent
   * full-balance credits cannot overpay — the loser gets null. Returns the
   * updated invoice, or null when the row is missing, not payable, or the
   * credit would exceed the total; callers must re-read to distinguish and
   * compensate for any payment row they already committed.
   */
  incrementAmountPaidAtomic(
    tenantId: string,
    id: string,
    deltaCents: number,
    now: Date,
  ): Promise<Invoice | null>;
  /**
   * Atomically DECREMENT the paid balance by `deltaCents` in a SINGLE UPDATE,
   * recomputing amount_due and status from the row's OWN current values — the
   * reversal-side analog of `incrementAmountPaidAtomic`. Closes the
   * `reversePayment` / in-flight-reversal lost-update race: the old path read
   * amount_paid into a JS snapshot and blind-set `snapshot − delta`, so a
   * concurrent credit (or a second reversal) clobbered it. Paid is clamped at 0
   * (GREATEST) and the reopened status is derived in-SQL: 'open' (nothing left
   * paid), 'paid' (still fully covered — e.g. one of several payments reversed),
   * else 'partially_paid'. Guarded to REOPENABLE statuses
   * ('open','partially_paid','paid') only, so a void/canceled/draft invoice is
   * left untouched (returns null, exactly as the read-modify-write path skipped
   * it). Returns the updated invoice, or null if not found OR not reopenable.
   */
  decrementAmountPaidAtomic(
    tenantId: string,
    id: string,
    deltaCents: number,
    now: Date,
  ): Promise<Invoice | null>;
  /**
   * Track-5 — the deposit-credit leg of the atomic-increment convention.
   * Same shape as `incrementAmountPaidAtomic` (single guarded UPDATE deriving
   * paid/due/status from the row's OWN current values, balance cap
   * `amount_paid + credit <= total`, GREATEST(0, …) due clamp), differing
   * ONLY in the status list: a deposit credit legitimately lands on the
   * freshly-created 'draft' invoice (both call sites credit immediately after
   * createInvoiceWithNextNumber), where a regular payment must still match 0
   * rows. Creditable statuses: 'draft', 'open', 'partially_paid'. A draft
   * STAYS 'draft' even when fully covered (issuing remains the operator's
   * explicit step); on an already-issued invoice the credit follows payment
   * semantics ('paid' / 'partially_paid'). Returns the updated invoice, or
   * null when the row is missing, not creditable, or the credit no longer
   * fits the remaining balance — callers must compensate the deposit payment
   * row they already committed (see applyDepositCreditToInvoice).
   */
  applyDepositCreditAtomic(
    tenantId: string,
    id: string,
    creditCents: number,
    now: Date,
  ): Promise<Invoice | null>;
  /**
   * P0-3 (reconciler leg) — absolute balance repair guarded in the SAME
   * statement: writes amountPaid/amountDue/status ONLY while the row's
   * current status is in `guardStatuses`. The crash-repair reconcilers
   * previously read a payable/reopenable status and then wrote the repaired
   * balance unconditionally, so a void committing between the read and the
   * write was resurrected to 'paid'/'partially_paid' — the same
   * check-then-act hole the atomic increment closes for credits. Returns
   * the updated invoice, or null when the row is missing or its live status
   * left the guarded set (the caller treats that as "nothing repaired").
   */
  reconcileBalanceAtomic(
    tenantId: string,
    id: string,
    balance: { amountPaidCents: number; amountDueCents: number; status: InvoiceStatus },
    guardStatuses: InvoiceStatus[],
    now: Date,
  ): Promise<Invoice | null>;
  /**
   * P0-9 (mint leg) — persist a freshly minted payment link ONLY while the
   * invoice is still payable, still owes exactly the balance the link was
   * priced at, and carries no other link. Minting spans a slow Stripe call:
   * a void or a credit can land between the mint-time read and the persist,
   * and an unguarded write would then attach a live link (priced at the
   * OLD balance) to a dead or repriced invoice — the unapplied-capture path
   * again, from the other side. Returns null when the guard loses; the
   * caller must deactivate the link it just minted.
   */
  setPaymentLinkIfPayable(
    tenantId: string,
    id: string,
    link: { linkId: string; linkUrl: string },
    expectedAmountDueCents: number,
    now: Date,
  ): Promise<Invoice | null>;
  /**
   * P0-9 — clear the payment-link columns ONLY while they still hold
   * `expectedLinkId` (single compare-and-swap UPDATE). Deactivation flows
   * hold an invoice snapshot that may predate a concurrent
   * deactivate-and-re-mint; a blind clear would wipe the NEW link's columns
   * while it stays live at Stripe. Returns true when the clear applied.
   * Optional: callers fall back to read-compare-clear.
   */
  clearPaymentLinkIfMatches?(
    tenantId: string,
    id: string,
    expectedLinkId: string,
  ): Promise<boolean>;
  /** Look up by unauthenticated view token — no tenant isolation needed (token is the secret). */
  findByViewToken?(token: string): Promise<Invoice | null>;
  /**
   * Atomically increment view_count and set first_viewed_at if not yet set.
   * Implementations that support it (Pg) should do this in a single UPDATE
   * to avoid the read-modify-write race when concurrent requests arrive.
   */
  incrementViewCount?(tenantId: string, id: string): Promise<void>;
}

export const INVOICE_STATUS_TRANSITIONS: Record<InvoiceStatus, InvoiceStatus[]> = {
  draft: ['open', 'canceled'],
  open: ['partially_paid', 'paid', 'void'],
  // 'paid' and 'partially_paid' can REOPEN when a settled payment is
  // reversed (ACH/bank NSF return or card chargeback — see
  // reversePayment() in payments/payment-service.ts). The reversal
  // recomputes the balance and drops the invoice back to 'partially_paid'
  // (other payments remain) or 'open' (no payments left), so it re-enters
  // normal collections. 'paid' is therefore no longer terminal.
  partially_paid: ['open', 'paid', 'void'],
  paid: ['open', 'partially_paid'],
  void: [],
  canceled: [],
};

export function validateInvoiceInput(input: CreateInvoiceInput): string[] {
  const errors: string[] = [];
  if (!input.tenantId) errors.push('tenantId is required');
  if (!input.jobId) errors.push('jobId is required');
  if (!input.invoiceNumber) errors.push('invoiceNumber is required');
  if (!input.createdBy) errors.push('createdBy is required');
  if (!input.lineItems || input.lineItems.length === 0) {
    errors.push('At least one line item is required');
  }
  return errors;
}

export function isValidInvoiceTransition(from: InvoiceStatus, to: InvoiceStatus): boolean {
  return INVOICE_STATUS_TRANSITIONS[from]?.includes(to) ?? false;
}

export function recalculateBalance(invoice: Invoice): Invoice {
  return {
    ...invoice,
    amountDueCents: Math.max(0, invoice.totals.totalCents - invoice.amountPaidCents),
  };
}

export function calculateDueDate(issuedAt: Date, paymentTermDays: number): Date {
  const dueDate = new Date(issuedAt);
  // Invoice terms are calendar-day arithmetic. Use UTC consistently so a
  // server's local timezone (or a DST transition) cannot shift the due date.
  dueDate.setUTCDate(dueDate.getUTCDate() + paymentTermDays);
  return dueDate;
}

export async function createInvoice(
  input: CreateInvoiceInput,
  repository: InvoiceRepository,
  auditRepo?: AuditRepository
): Promise<Invoice> {
  const errors = validateInvoiceInput(input);
  if (errors.length > 0) throw new ValidationError(`Validation failed: ${errors.join(', ')}`);

  // P0-2 — the client's totalCents is never persisted; every line total is
  // recomputed here from quantity × unitPriceCents (the web UI computes it
  // in float dollars and can be off by a cent on fractional quantities).
  const lineItems = normalizeLineItemTotals(input.lineItems);
  const totals = calculateDocumentTotals(
    lineItems,
    input.discountCents || 0,
    input.taxRateBps || 0,
    input.processingFeeBps || 0
  );

  const invoice: Invoice = {
    id: uuidv4(),
    tenantId: input.tenantId,
    jobId: input.jobId,
    estimateId: input.estimateId,
    invoiceNumber: input.invoiceNumber,
    status: 'draft',
    lineItems,
    totals,
    amountPaidCents: 0,
    amountDueCents: totals.totalCents,
    customerMessage: input.customerMessage,
    originatingLeadId: input.originatingLeadId,
    scheduleId: input.scheduleId,
    milestoneIndex: input.milestoneIndex,
    createdBy: input.createdBy,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  const created = await repository.create(invoice);

  if (auditRepo) {
    const event = createAuditEvent({
      tenantId: input.tenantId,
      actorId: input.createdBy,
      actorRole: 'owner',
      eventType: 'invoice.created',
      entityType: 'invoice',
      entityId: created.id,
      metadata: buildOriginationMetadata(created.originatingLeadId),
    });
    await auditRepo.create(event);
  }

  return created;
}

export async function listInvoices(
  tenantId: string,
  repository: InvoiceRepository,
  options?: InvoiceListOptions
): Promise<Invoice[]> {
  return repository.findByTenant(tenantId, options);
}

/**
 * P1-018: paginated invoice list with `{ data, total }`. Falls back to
 * in-memory pagination over `findByTenant` when the repo doesn't yet
 * implement `listWithMeta`.
 */
export async function listInvoicesWithMeta(
  tenantId: string,
  repository: InvoiceRepository,
  options?: InvoiceListOptions
): Promise<InvoiceListResult> {
  if (repository.listWithMeta) {
    return repository.listWithMeta(tenantId, options);
  }
  const all = await repository.findByTenant(tenantId, { ...options, limit: undefined, offset: undefined });
  const limit = Math.min(options?.limit ?? DEFAULT_INVOICE_LIMIT, MAX_INVOICE_LIMIT);
  const offset = options?.offset ?? 0;
  return { data: all.slice(offset, offset + limit), total: all.length };
}

/**
 * Insert-first, then allocate — a failed createInvoice never increments
 * the tenant's invoice counter, so there are no gaps in the user-visible
 * sequence.
 *
 * Flow:
 *   1. createInvoice with a placeholder number (passes validation but is
 *      replaced before the row is ever read by any caller)
 *   2. getNextInvoiceNumber — only runs when step 1 succeeded
 *   3. invoiceRepo.update rewrites the placeholder with the real number
 *
 * Residual risk: a crash between step 2 and step 3 leaves the counter
 * incremented while the row still shows the placeholder. That's a much
 * smaller exposure than the previous ordering, where any validation or
 * constraint failure in createInvoice burned a sequence number. A proper
 * pg transaction (SELECT FOR UPDATE settings + INSERT invoice) is the
 * long-term fix and lands alongside PgSettingsRepository when that ships.
 */
export async function createInvoiceWithNextNumber(
  input: Omit<CreateInvoiceInput, 'invoiceNumber'>,
  invoiceRepo: InvoiceRepository,
  settingsRepo: SettingsRepository,
  auditRepo?: AuditRepository
): Promise<Invoice> {
  const placeholderNumber = `PENDING-${uuidv4()}`;

  const invoice = await createInvoice(
    { ...input, invoiceNumber: placeholderNumber },
    invoiceRepo,
    auditRepo
  );

  const invoiceNumber = await getNextInvoiceNumber(input.tenantId, settingsRepo);
  const updated = await invoiceRepo.update(input.tenantId, invoice.id, {
    invoiceNumber,
  });
  if (!updated) {
    // Hard failure: the counter is now allocated but the placeholder row
    // can't be promoted to its real number. Returning a synthetic object
    // would desync the app state from persistence — callers must see this
    // as an error so it can be retried or alerted on.
    throw new Error(
      `Allocated invoice number ${invoiceNumber} but failed to update row ${invoice.id}`
    );
  }
  return updated;
}

export async function getInvoice(
  tenantId: string,
  id: string,
  repository: InvoiceRepository
): Promise<Invoice | null> {
  return repository.findById(tenantId, id);
}

export async function updateInvoice(
  tenantId: string,
  id: string,
  input: UpdateInvoiceInput,
  repository: InvoiceRepository
): Promise<Invoice | null> {
  const existing = await repository.findById(tenantId, id);
  if (!existing) return null;

  if (existing.status !== 'draft') {
    throw new ValidationError(`Cannot edit invoice in '${existing.status}' status`);
  }

  // P0-2 — client totals are recomputed, never trusted (see createInvoice).
  // Only INCOMING lines are normalized: a metadata-only edit must not
  // silently rewrite persisted totals the tenant has already seen.
  const lineItems = input.lineItems
    ? normalizeLineItemTotals(input.lineItems)
    : existing.lineItems;
  const discountCents = input.discountCents ?? existing.totals.discountCents;
  const taxRateBps = input.taxRateBps ?? existing.totals.taxRateBps;
  const processingFeeBps =
    input.processingFeeBps ?? existing.totals.processingFeeBps ?? 0;
  const totals = calculateDocumentTotals(lineItems, discountCents, taxRateBps, processingFeeBps);

  const updated = await repository.update(tenantId, id, {
    lineItems,
    totals,
    amountDueCents: Math.max(0, totals.totalCents - existing.amountPaidCents),
    customerMessage: input.customerMessage ?? existing.customerMessage,
    updatedAt: new Date(),
  });

  return updated;
}

export async function issueInvoice(
  tenantId: string,
  id: string,
  paymentTermDays: number,
  repository: InvoiceRepository,
  moneyStateDeps?: RefreshJobMoneyStateDeps,
): Promise<Invoice | null> {
  const invoice = await repository.findById(tenantId, id);
  if (!invoice) return null;

  if (!isValidInvoiceTransition(invoice.status, 'open')) {
    throw new ValidationError(`Invalid transition from ${invoice.status} to open`);
  }

  const issuedAt = new Date();
  const dueDate = calculateDueDate(issuedAt, paymentTermDays);

  const updated = await repository.update(tenantId, id, {
    status: 'open',
    issuedAt,
    dueDate,
    updatedAt: new Date(),
  });

  // §6 Time-to-Cash. Best-effort job money-state rollup.
  if (updated && moneyStateDeps) {
    await refreshJobMoneyStateSafe(tenantId, updated.jobId, 'system', moneyStateDeps);
  }

  return updated;
}

/**
 * Optional wiring for `transitionInvoiceStatus`. `auditRepo` + `actor` put
 * the status change on the audit trail (previously the status route emitted
 * NO event, so a void left no durable timestamp). `paymentLink` arms the
 * P0-1 fix: a void/cancel deactivates the invoice's hosted Stripe payment
 * link, closing the path where a customer pays a stale link on a dead
 * invoice and Stripe captures money the system refuses to credit. The same
 * provider also carries the P0-1 completion: minted PaymentIntent client
 * secrets are swept and cancelled so an Elements/Terminal secret held from
 * before the void can't complete either.
 */
export interface TransitionInvoiceStatusOptions {
  auditRepo?: AuditRepository;
  actor?: { actorId: string; actorRole: string };
  paymentLink?: {
    provider: PaymentLinkProvider;
    connectAccountResolver?: ConnectAccountResolver;
  };
}

export async function transitionInvoiceStatus(
  tenantId: string,
  id: string,
  newStatus: InvoiceStatus,
  repository: InvoiceRepository,
  moneyStateDeps?: RefreshJobMoneyStateDeps,
  opts?: TransitionInvoiceStatusOptions,
): Promise<Invoice | null> {
  const invoice = await repository.findById(tenantId, id);
  if (!invoice) return null;

  if (!isValidInvoiceTransition(invoice.status, newStatus)) {
    throw new ValidationError(`Invalid transition from ${invoice.status} to ${newStatus}`);
  }

  const updated = await repository.update(tenantId, id, {
    status: newStatus,
    updatedAt: new Date(),
  });

  if (updated && opts?.auditRepo) {
    await opts.auditRepo.create(
      createAuditEvent({
        tenantId,
        actorId: opts.actor?.actorId ?? 'system',
        actorRole: opts.actor?.actorRole ?? 'system',
        eventType: 'invoice.status_changed',
        entityType: 'invoice',
        entityId: id,
        metadata: { oldStatus: invoice.status, newStatus },
      }),
    );
  }

  // P0-1 — an invoice leaving the payable world must take its hosted
  // payment link with it. The link was priced at mint and is never
  // re-priced; left live, a customer can still pay it after the void and
  // Stripe captures money no local record will hold. Best-effort with an
  // audit trail either way; never blocks the transition itself.
  if (updated && (newStatus === 'void' || newStatus === 'canceled') && opts?.paymentLink) {
    // Deactivate from the POST-transition snapshot, not the read at the top:
    // a mint can legitimately win its payable guard between that read and the
    // status update committing, so the pre-transition snapshot may be missing
    // the very link that must now die on the voided invoice.
    await deactivateInvoicePaymentLink({
      tenantId,
      invoice: updated,
      reason: newStatus === 'void' ? 'voided' : 'canceled',
      invoiceRepo: repository,
      provider: opts.paymentLink.provider,
      connectAccountResolver: opts.paymentLink.connectAccountResolver,
      auditRepo: opts.auditRepo,
      actor: opts.actor,
    });
    // P0-1 completion — the link is only half the exposure: a PaymentIntent
    // client secret minted pre-void (public payment page / Terminal) stays
    // confirmable until the PI is cancelled. Sweep and cancel them through
    // the same provider; best-effort + audited, never blocks the transition.
    // Runs even when no link column is set — the public PI mint never
    // attaches a link to the invoice.
    await cancelInvoicePaymentIntents({
      tenantId,
      invoice: updated,
      reason: newStatus === 'void' ? 'voided' : 'canceled',
      provider: opts.paymentLink.provider,
      connectAccountResolver: opts.paymentLink.connectAccountResolver,
      auditRepo: opts.auditRepo,
      actor: opts.actor,
    });
  }

  // §6 Time-to-Cash. Best-effort job money-state rollup.
  if (updated && moneyStateDeps) {
    await refreshJobMoneyStateSafe(tenantId, updated.jobId, 'system', moneyStateDeps);
  }

  return updated;
}

export class InMemoryInvoiceRepository implements InvoiceRepository {
  private invoices: Map<string, Invoice> = new Map();

  async create(invoice: Invoice): Promise<Invoice> {
    this.invoices.set(invoice.id, { ...invoice, lineItems: [...invoice.lineItems] });
    return { ...invoice, lineItems: [...invoice.lineItems] };
  }

  async findById(tenantId: string, id: string): Promise<Invoice | null> {
    const i = this.invoices.get(id);
    if (!i || i.tenantId !== tenantId) return null;
    return { ...i, lineItems: [...i.lineItems] };
  }

  async findByJob(tenantId: string, jobId: string): Promise<Invoice[]> {
    return Array.from(this.invoices.values())
      .filter((i) => i.tenantId === tenantId && i.jobId === jobId)
      .map((i) => ({ ...i, lineItems: [...i.lineItems] }));
  }

  async findByJobs(tenantId: string, jobIds: string[]): Promise<Invoice[]> {
    const wanted = new Set(jobIds);
    return Array.from(this.invoices.values())
      .filter((i) => i.tenantId === tenantId && wanted.has(i.jobId))
      .map((i) => ({ ...i, lineItems: [...i.lineItems] }));
  }

  async findByTenant(tenantId: string, options?: InvoiceListOptions): Promise<Invoice[]> {
    let results = Array.from(this.invoices.values()).filter((i) => i.tenantId === tenantId);
    if (options?.status) results = results.filter((i) => i.status === options.status);
    if (options?.jobId) results = results.filter((i) => i.jobId === options.jobId);
    if (options?.fromDueDate) {
      const from = options.fromDueDate.getTime();
      results = results.filter((i) => i.dueDate !== undefined && i.dueDate.getTime() >= from);
    }
    if (options?.toDueDate) {
      const to = options.toDueDate.getTime();
      results = results.filter((i) => i.dueDate !== undefined && i.dueDate.getTime() <= to);
    }
    if (options?.search) {
      const q = options.search.toLowerCase();
      results = results.filter(
        (i) =>
          i.invoiceNumber.toLowerCase().includes(q) ||
          (i.customerMessage && i.customerMessage.toLowerCase().includes(q))
      );
    }
    // Default sort: createdAt DESC. P1-018 lets callers flip to ASC.
    const sortDir = options?.sort === 'asc' ? 1 : -1;
    results.sort((a, b) => sortDir * (a.createdAt.getTime() - b.createdAt.getTime()));
    if (options?.offset !== undefined || options?.limit !== undefined) {
      const offset = options?.offset ?? 0;
      const limit = options?.limit !== undefined
        ? Math.min(options.limit, MAX_INVOICE_LIMIT)
        : results.length;
      results = results.slice(offset, offset + limit);
    }
    return results.map((i) => ({ ...i, lineItems: [...i.lineItems] }));
  }

  async listWithMeta(tenantId: string, options?: InvoiceListOptions): Promise<InvoiceListResult> {
    const totalRows = await this.findByTenant(tenantId, {
      ...options,
      limit: undefined,
      offset: undefined,
    });
    const data = await this.findByTenant(tenantId, options);
    return { data, total: totalRows.length };
  }

  async update(tenantId: string, id: string, updates: InvoiceUpdate): Promise<Invoice | null> {
    const i = this.invoices.get(id);
    if (!i || i.tenantId !== tenantId) return null;
    // null on the link columns means CLEAR (Pg writes SQL NULL); the domain
    // object represents an absent link as undefined.
    const { stripePaymentLinkId, stripePaymentLinkUrl, ...rest } = updates;
    const updated: Invoice = { ...i, ...rest };
    if (stripePaymentLinkId !== undefined) {
      updated.stripePaymentLinkId = stripePaymentLinkId ?? undefined;
    }
    if (stripePaymentLinkUrl !== undefined) {
      updated.stripePaymentLinkUrl = stripePaymentLinkUrl ?? undefined;
    }
    this.invoices.set(id, updated);
    return { ...updated, lineItems: [...updated.lineItems] };
  }

  async incrementAmountPaidAtomic(
    tenantId: string,
    id: string,
    deltaCents: number,
    now: Date,
  ): Promise<Invoice | null> {
    const i = this.invoices.get(id);
    if (!i || i.tenantId !== tenantId) return null;
    // Mirror the Pg WHERE guards (P0-3 / P0-6): only a payable invoice takes a
    // credit, and only a credit that fits the remaining balance applies. A
    // void/canceled/draft row and an overpaying credit both return null,
    // exactly as the SQL returns 0 rows.
    if (i.status !== 'open' && i.status !== 'partially_paid') return null;
    if (i.amountPaidCents + deltaCents > i.totals.totalCents) return null;
    // JS is single-threaded, so read-modify-write here is already atomic; the
    // Pg impl uses a single UPDATE to get the same guarantee under real
    // concurrency. Recompute from the stored row, never a caller snapshot.
    const newPaid = i.amountPaidCents + deltaCents;
    const newDue = Math.max(0, i.totals.totalCents - newPaid);
    const status: InvoiceStatus = newDue === 0 ? 'paid' : 'partially_paid';
    const updated: Invoice = {
      ...i,
      amountPaidCents: newPaid,
      amountDueCents: newDue,
      status,
      updatedAt: now,
    };
    this.invoices.set(id, updated);
    return { ...updated, lineItems: [...updated.lineItems] };
  }

  async applyDepositCreditAtomic(
    tenantId: string,
    id: string,
    creditCents: number,
    now: Date,
  ): Promise<Invoice | null> {
    const i = this.invoices.get(id);
    if (!i || i.tenantId !== tenantId) return null;
    // Mirror the Pg WHERE guards (Track-5): a deposit credit lands only on a
    // creditable invoice — 'draft' (the freshly-created row both call sites
    // produce) plus the payable statuses — and only when it still fits the
    // remaining balance. A void/canceled/paid row and an over-total credit
    // both return null, exactly as the SQL matches 0 rows.
    if (i.status !== 'draft' && i.status !== 'open' && i.status !== 'partially_paid') return null;
    if (i.amountPaidCents + creditCents > i.totals.totalCents) return null;
    // JS is single-threaded, so read-modify-write here is already atomic; the
    // Pg impl uses a single UPDATE to get the same guarantee under real
    // concurrency. Recompute from the stored row, never a caller snapshot.
    const newPaid = i.amountPaidCents + creditCents;
    const newDue = Math.max(0, i.totals.totalCents - newPaid);
    // A draft stays 'draft' even when fully covered — issuing remains the
    // operator's explicit step. An issued invoice follows payment semantics.
    const status: InvoiceStatus =
      i.status === 'draft' ? 'draft' : newDue === 0 ? 'paid' : 'partially_paid';
    const updated: Invoice = {
      ...i,
      amountPaidCents: newPaid,
      amountDueCents: newDue,
      status,
      updatedAt: now,
    };
    this.invoices.set(id, updated);
    return { ...updated, lineItems: [...updated.lineItems] };
  }

  async decrementAmountPaidAtomic(
    tenantId: string,
    id: string,
    deltaCents: number,
    now: Date,
  ): Promise<Invoice | null> {
    const i = this.invoices.get(id);
    if (!i || i.tenantId !== tenantId) return null;
    // Only reopenable invoices are decremented; a void/canceled/draft row is
    // left untouched (null), mirroring the Pg WHERE guard and the prior
    // read-modify-write, which never touched a terminal invoice on reversal.
    const REOPENABLE: InvoiceStatus[] = ['open', 'partially_paid', 'paid'];
    if (!REOPENABLE.includes(i.status)) return null;
    // JS is single-threaded, so read-modify-write here is already atomic; the
    // Pg impl uses a single UPDATE to get the same guarantee under real
    // concurrency. Recompute from the stored row, never a caller snapshot.
    const newPaid = Math.max(0, i.amountPaidCents - deltaCents);
    const newDue = Math.max(0, i.totals.totalCents - newPaid);
    let status: InvoiceStatus;
    if (newPaid <= 0) status = 'open';
    else if (newPaid >= i.totals.totalCents) status = 'paid';
    else status = 'partially_paid';
    const updated: Invoice = {
      ...i,
      amountPaidCents: newPaid,
      amountDueCents: newDue,
      status,
      updatedAt: now,
    };
    this.invoices.set(id, updated);
    return { ...updated, lineItems: [...updated.lineItems] };
  }

  async reconcileBalanceAtomic(
    tenantId: string,
    id: string,
    balance: { amountPaidCents: number; amountDueCents: number; status: InvoiceStatus },
    guardStatuses: InvoiceStatus[],
    now: Date,
  ): Promise<Invoice | null> {
    const i = this.invoices.get(id);
    if (!i || i.tenantId !== tenantId) return null;
    // Mirror the Pg WHERE guard: the repair applies only while the live
    // status is still in the guarded set — a concurrently voided invoice is
    // left untouched (null), never resurrected.
    if (!guardStatuses.includes(i.status)) return null;
    const updated: Invoice = {
      ...i,
      amountPaidCents: balance.amountPaidCents,
      amountDueCents: balance.amountDueCents,
      status: balance.status,
      updatedAt: now,
    };
    this.invoices.set(id, updated);
    return { ...updated, lineItems: [...updated.lineItems] };
  }

  async setPaymentLinkIfPayable(
    tenantId: string,
    id: string,
    link: { linkId: string; linkUrl: string },
    expectedAmountDueCents: number,
    now: Date,
  ): Promise<Invoice | null> {
    const i = this.invoices.get(id);
    if (!i || i.tenantId !== tenantId) return null;
    // Mirror the Pg WHERE guard: payable, unchanged balance, no other link.
    if (i.status !== 'open' && i.status !== 'partially_paid') return null;
    if (i.amountDueCents !== expectedAmountDueCents) return null;
    if (i.stripePaymentLinkId !== undefined) return null;
    const updated: Invoice = {
      ...i,
      stripePaymentLinkId: link.linkId,
      stripePaymentLinkUrl: link.linkUrl,
      updatedAt: now,
    };
    this.invoices.set(id, updated);
    return { ...updated, lineItems: [...updated.lineItems] };
  }

  async clearPaymentLinkIfMatches(
    tenantId: string,
    id: string,
    expectedLinkId: string,
  ): Promise<boolean> {
    const i = this.invoices.get(id);
    if (!i || i.tenantId !== tenantId) return false;
    if (i.stripePaymentLinkId !== expectedLinkId) return false;
    this.invoices.set(id, {
      ...i,
      stripePaymentLinkId: undefined,
      stripePaymentLinkUrl: undefined,
      updatedAt: new Date(),
    });
    return true;
  }

  async findByViewToken(token: string): Promise<Invoice | null> {
    for (const inv of this.invoices.values()) {
      if (inv.viewToken === token) {
        if (inv.viewTokenExpiresAt && inv.viewTokenExpiresAt < new Date()) return null;
        return { ...inv, lineItems: [...inv.lineItems] };
      }
    }
    return null;
  }

  async incrementViewCount(tenantId: string, id: string): Promise<void> {
    const inv = this.invoices.get(id);
    if (!inv || inv.tenantId !== tenantId) return;
    const now = new Date();
    this.invoices.set(id, {
      ...inv,
      firstViewedAt: inv.firstViewedAt ?? now,
      viewCount: (inv.viewCount ?? 0) + 1,
      updatedAt: now,
    });
  }
}
