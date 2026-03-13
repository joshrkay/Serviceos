import { v4 as uuidv4 } from 'uuid';
import { LineItem, DocumentTotals, calculateDocumentTotals } from '../shared/billing-engine';
import { AuditRepository, createAuditEvent } from '../audit/audit';

export type EstimateStatus = 'draft' | 'ready_for_review' | 'sent' | 'accepted' | 'rejected' | 'expired';

export interface Estimate {
  id: string;
  tenantId: string;
  jobId: string;
  estimateNumber: string;
  status: EstimateStatus;
  lineItems: LineItem[];
  totals: DocumentTotals;
  validUntil?: Date;
  customerMessage?: string;
  internalNotes?: string;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateEstimateInput {
  tenantId: string;
  jobId: string;
  estimateNumber: string;
  lineItems: LineItem[];
  discountCents?: number;
  taxRateBps?: number;
  validUntil?: Date;
  customerMessage?: string;
  internalNotes?: string;
  createdBy: string;
}

export interface UpdateEstimateInput {
  lineItems?: LineItem[];
  discountCents?: number;
  taxRateBps?: number;
  validUntil?: Date;
  customerMessage?: string;
  internalNotes?: string;
}

export interface EstimateRepository {
  create(estimate: Estimate): Promise<Estimate>;
  findById(tenantId: string, id: string): Promise<Estimate | null>;
  findByJob(tenantId: string, jobId: string): Promise<Estimate[]>;
  findByTenant(tenantId: string): Promise<Estimate[]>;
  update(tenantId: string, id: string, updates: Partial<Estimate>): Promise<Estimate | null>;
}

export const ESTIMATE_STATUS_TRANSITIONS: Record<EstimateStatus, EstimateStatus[]> = {
  draft: ['ready_for_review', 'sent'],
  ready_for_review: ['sent', 'draft'],
  sent: ['accepted', 'rejected', 'expired'],
  accepted: [],
  rejected: ['draft'],
  expired: ['draft'],
};

export function validateEstimateInput(input: CreateEstimateInput): string[] {
  const errors: string[] = [];
  if (!input.tenantId) errors.push('tenantId is required');
  if (!input.jobId) errors.push('jobId is required');
  if (!input.estimateNumber) errors.push('estimateNumber is required');
  if (!input.createdBy) errors.push('createdBy is required');
  if (!input.lineItems || input.lineItems.length === 0) {
    errors.push('At least one line item is required');
  }
  return errors;
}

export function isValidEstimateTransition(from: EstimateStatus, to: EstimateStatus): boolean {
  return ESTIMATE_STATUS_TRANSITIONS[from]?.includes(to) ?? false;
}

export async function createEstimate(
  input: CreateEstimateInput,
  repository: EstimateRepository,
  auditRepo?: AuditRepository
): Promise<Estimate> {
  const totals = calculateDocumentTotals(
    input.lineItems,
    input.discountCents || 0,
    input.taxRateBps || 0
  );

  const estimate: Estimate = {
    id: uuidv4(),
    tenantId: input.tenantId,
    jobId: input.jobId,
    estimateNumber: input.estimateNumber,
    status: 'draft',
    lineItems: input.lineItems,
    totals,
    validUntil: input.validUntil,
    customerMessage: input.customerMessage,
    internalNotes: input.internalNotes,
    createdBy: input.createdBy,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  const created = await repository.create(estimate);

  if (auditRepo) {
    const event = createAuditEvent({
      tenantId: input.tenantId,
      actorId: input.createdBy,
      actorRole: 'owner',
      eventType: 'estimate.created',
      entityType: 'estimate',
      entityId: created.id,
    });
    await auditRepo.create(event);
  }

  return created;
}

export async function getEstimate(
  tenantId: string,
  id: string,
  repository: EstimateRepository
): Promise<Estimate | null> {
  return repository.findById(tenantId, id);
}

export async function updateEstimate(
  tenantId: string,
  id: string,
  input: UpdateEstimateInput,
  repository: EstimateRepository
): Promise<Estimate | null> {
  const existing = await repository.findById(tenantId, id);
  if (!existing) return null;

  const lineItems = input.lineItems ?? existing.lineItems;
  const discountCents = input.discountCents ?? existing.totals.discountCents;
  const taxRateBps = input.taxRateBps ?? existing.totals.taxRateBps;
  const totals = calculateDocumentTotals(lineItems, discountCents, taxRateBps);

  return repository.update(tenantId, id, {
    lineItems,
    totals,
    validUntil: input.validUntil ?? existing.validUntil,
    customerMessage: input.customerMessage ?? existing.customerMessage,
    internalNotes: input.internalNotes ?? existing.internalNotes,
    updatedAt: new Date(),
  });
}

export async function transitionEstimateStatus(
  tenantId: string,
  id: string,
  newStatus: EstimateStatus,
  repository: EstimateRepository
): Promise<Estimate | null> {
  const estimate = await repository.findById(tenantId, id);
  if (!estimate) return null;

  if (!isValidEstimateTransition(estimate.status, newStatus)) {
    throw new Error(`Invalid transition from ${estimate.status} to ${newStatus}`);
  }

  return repository.update(tenantId, id, { status: newStatus, updatedAt: new Date() });
}

export class InMemoryEstimateRepository implements EstimateRepository {
  private estimates: Map<string, Estimate> = new Map();

  async create(estimate: Estimate): Promise<Estimate> {
    this.estimates.set(estimate.id, { ...estimate, lineItems: [...estimate.lineItems] });
    return { ...estimate, lineItems: [...estimate.lineItems] };
  }

  async findById(tenantId: string, id: string): Promise<Estimate | null> {
    const e = this.estimates.get(id);
    if (!e || e.tenantId !== tenantId) return null;
    return { ...e, lineItems: [...e.lineItems] };
  }

  async findByJob(tenantId: string, jobId: string): Promise<Estimate[]> {
    return Array.from(this.estimates.values())
      .filter((e) => e.tenantId === tenantId && e.jobId === jobId)
      .map((e) => ({ ...e, lineItems: [...e.lineItems] }));
  }

  async findByTenant(tenantId: string): Promise<Estimate[]> {
    return Array.from(this.estimates.values())
      .filter((e) => e.tenantId === tenantId)
      .map((e) => ({ ...e, lineItems: [...e.lineItems] }));
  }

  async update(tenantId: string, id: string, updates: Partial<Estimate>): Promise<Estimate | null> {
    const e = this.estimates.get(id);
    if (!e || e.tenantId !== tenantId) return null;
    const updated = { ...e, ...updates };
    this.estimates.set(id, updated);
    return { ...updated, lineItems: [...updated.lineItems] };
  }
}
