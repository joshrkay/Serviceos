import { v4 as uuidv4 } from 'uuid';
import { LineItem, DocumentTotals, calculateDocumentTotals } from '../shared/billing-engine';
import { AuditRepository, createAuditEvent } from '../audit/audit';
import { ValidationError } from '../shared/errors';
import { SettingsRepository, getNextInvoiceNumber } from '../settings/settings';
import { buildOriginationMetadata } from '../leads/attribution-metadata';
import { RefreshJobMoneyStateDeps, refreshJobMoneyStateSafe } from '../jobs/job-money-state';

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
  update(tenantId: string, id: string, updates: Partial<Invoice>): Promise<Invoice | null>;
  /**
   * Atomically credit `deltaCents` to the paid balance in a SINGLE UPDATE,
   * recomputing amount_due and status from the row's own current values — never
   * from a caller's stale snapshot. Closes the recordPayment lost-update race:
   * two concurrent legitimate payments (e.g. a manual cash entry and a Stripe/ACH
   * webhook) otherwise each read the same amount_paid and blind-set it, silently
   * dropping one credit. Returns the updated invoice, or null if not found.
   */
  incrementAmountPaidAtomic(
    tenantId: string,
    id: string,
    deltaCents: number,
    now: Date,
  ): Promise<Invoice | null>;
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
  dueDate.setDate(dueDate.getDate() + paymentTermDays);
  return dueDate;
}

export async function createInvoice(
  input: CreateInvoiceInput,
  repository: InvoiceRepository,
  auditRepo?: AuditRepository
): Promise<Invoice> {
  const errors = validateInvoiceInput(input);
  if (errors.length > 0) throw new ValidationError(`Validation failed: ${errors.join(', ')}`);

  const totals = calculateDocumentTotals(
    input.lineItems,
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
    lineItems: input.lineItems,
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

  const lineItems = input.lineItems ?? existing.lineItems;
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

export async function transitionInvoiceStatus(
  tenantId: string,
  id: string,
  newStatus: InvoiceStatus,
  repository: InvoiceRepository,
  moneyStateDeps?: RefreshJobMoneyStateDeps,
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

  async update(tenantId: string, id: string, updates: Partial<Invoice>): Promise<Invoice | null> {
    const i = this.invoices.get(id);
    if (!i || i.tenantId !== tenantId) return null;
    const updated = { ...i, ...updates };
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
    // JS is single-threaded, so read-modify-write here is already atomic; the
    // Pg impl uses a single UPDATE to get the same guarantee under real
    // concurrency. Recompute from the stored row, never a caller snapshot.
    const newPaid = i.amountPaidCents + deltaCents;
    const newDue = Math.max(0, i.totals.totalCents - newPaid);
    let status = i.status;
    if (newDue === 0) status = 'paid';
    else if (newPaid > 0 && (i.status === 'open' || i.status === 'partially_paid')) {
      status = 'partially_paid';
    }
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
