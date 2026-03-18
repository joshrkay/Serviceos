import { v4 as uuidv4 } from 'uuid';
import { LineItem, DocumentTotals, calculateDocumentTotals } from '../shared/billing-engine';
import { AuditRepository, createAuditEvent } from '../audit/audit';
import { ValidationError } from '../shared/errors';

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
  customerMessage?: string;
  createdBy: string;
}

export interface UpdateInvoiceInput {
  lineItems?: LineItem[];
  discountCents?: number;
  taxRateBps?: number;
  customerMessage?: string;
}

export interface InvoiceRepository {
  create(invoice: Invoice): Promise<Invoice>;
  findById(tenantId: string, id: string): Promise<Invoice | null>;
  findByJob(tenantId: string, jobId: string): Promise<Invoice[]>;
  findByTenant(tenantId: string): Promise<Invoice[]>;
  update(tenantId: string, id: string, updates: Partial<Invoice>): Promise<Invoice | null>;
}

export const INVOICE_STATUS_TRANSITIONS: Record<InvoiceStatus, InvoiceStatus[]> = {
  draft: ['open', 'canceled'],
  open: ['partially_paid', 'paid', 'void'],
  partially_paid: ['paid', 'void'],
  paid: [],
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
  if (errors.length > 0) throw new Error(`Validation failed: ${errors.join(', ')}`);

  const totals = calculateDocumentTotals(
    input.lineItems,
    input.discountCents || 0,
    input.taxRateBps || 0
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
    });
    await auditRepo.create(event);
  }

  return created;
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

  const lineItems = input.lineItems ?? existing.lineItems;
  const discountCents = input.discountCents ?? existing.totals.discountCents;
  const taxRateBps = input.taxRateBps ?? existing.totals.taxRateBps;
  const totals = calculateDocumentTotals(lineItems, discountCents, taxRateBps);

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
  repository: InvoiceRepository
): Promise<Invoice | null> {
  const invoice = await repository.findById(tenantId, id);
  if (!invoice) return null;

  if (!isValidInvoiceTransition(invoice.status, 'open')) {
    throw new ValidationError(`Invalid transition from ${invoice.status} to open`);
  }

  const issuedAt = new Date();
  const dueDate = calculateDueDate(issuedAt, paymentTermDays);

  return repository.update(tenantId, id, {
    status: 'open',
    issuedAt,
    dueDate,
    updatedAt: new Date(),
  });
}

export async function transitionInvoiceStatus(
  tenantId: string,
  id: string,
  newStatus: InvoiceStatus,
  repository: InvoiceRepository
): Promise<Invoice | null> {
  const invoice = await repository.findById(tenantId, id);
  if (!invoice) return null;

  if (!isValidInvoiceTransition(invoice.status, newStatus)) {
    throw new ValidationError(`Invalid transition from ${invoice.status} to ${newStatus}`);
  }

  return repository.update(tenantId, id, { status: newStatus, updatedAt: new Date() });
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

  async findByTenant(tenantId: string): Promise<Invoice[]> {
    return Array.from(this.invoices.values())
      .filter((i) => i.tenantId === tenantId)
      .map((i) => ({ ...i, lineItems: [...i.lineItems] }));
  }

  async update(tenantId: string, id: string, updates: Partial<Invoice>): Promise<Invoice | null> {
    const i = this.invoices.get(id);
    if (!i || i.tenantId !== tenantId) return null;
    const updated = { ...i, ...updates };
    this.invoices.set(id, updated);
    return { ...updated, lineItems: [...updated.lineItems] };
  }
}
