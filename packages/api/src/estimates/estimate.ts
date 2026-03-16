import { v4 as uuidv4 } from 'uuid';

export type EstimateStatus = 'draft' | 'pending_review' | 'approved' | 'rejected' | 'sent';
export type RevisionSource = 'manual' | 'ai_generated' | 'ai_revised';

export interface LineItem {
  id: string;
  description: string;
  quantity: number;
  unitPrice: number;
  total: number;
  category?: string;
  bundleId?: string;
  metadata?: Record<string, unknown>;
}

export interface Estimate {
  id: string;
  tenantId: string;
  verticalId?: string;
  categoryId?: string;
  status: EstimateStatus;
  lineItems: LineItem[];
  snapshot: Record<string, unknown>;
  source: RevisionSource;
  approvedAt?: Date;
  approvedBy?: string;
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
  verticalId?: string;
  categoryId?: string;
  lineItems: LineItem[];
  snapshot: Record<string, unknown>;
  source: RevisionSource;
  createdBy: string;
}

export interface EstimateRepository {
  create(estimate: Estimate): Promise<Estimate>;
  findById(tenantId: string, id: string): Promise<Estimate | null>;
  findByTenant(tenantId: string): Promise<Estimate[]>;
  findApproved(tenantId: string): Promise<Estimate[]>;
  updateStatus(tenantId: string, id: string, status: EstimateStatus): Promise<Estimate | null>;
}

export function validateEstimateInput(input: CreateEstimateInput): string[] {
  const errors: string[] = [];
  if (!input.tenantId) errors.push('tenantId is required');
  if (!input.createdBy) errors.push('createdBy is required');
  if (!input.source) errors.push('source is required');
  if (!Array.isArray(input.lineItems)) errors.push('lineItems must be an array');
  if (!input.snapshot || typeof input.snapshot !== 'object') {
    errors.push('snapshot must be a non-null object');
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
  const errors = validateEstimateInput(input);
  if (errors.length > 0) throw new Error(`Validation failed: ${errors.join(', ')}`);

  const totals = calculateDocumentTotals(
    input.lineItems,
    input.discountCents ?? 0,
    input.taxRateBps ?? 0
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
      actorRole: 'unknown',
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

  if (!['draft', 'ready_for_review'].includes(existing.status)) {
    throw new Error(`Cannot edit estimate in '${existing.status}' status`);
  }

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
