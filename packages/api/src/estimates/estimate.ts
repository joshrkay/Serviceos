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

export function createEstimate(input: CreateEstimateInput): Estimate {
  const now = new Date();
  return {
    id: uuidv4(),
    tenantId: input.tenantId,
    verticalId: input.verticalId,
    categoryId: input.categoryId,
    status: 'draft',
    lineItems: input.lineItems,
    snapshot: input.snapshot,
    source: input.source,
    createdBy: input.createdBy,
    createdAt: now,
    updatedAt: now,
  };
}

export function approveEstimate(estimate: Estimate, approvedBy: string): Estimate {
  return {
    ...estimate,
    status: 'approved',
    approvedAt: new Date(),
    approvedBy,
    updatedAt: new Date(),
  };
}

export function rejectEstimate(estimate: Estimate): Estimate {
  return {
    ...estimate,
    status: 'rejected',
    updatedAt: new Date(),
  };
}

export class InMemoryEstimateRepository implements EstimateRepository {
  private estimates: Map<string, Estimate> = new Map();

  async create(estimate: Estimate): Promise<Estimate> {
    this.estimates.set(estimate.id, { ...estimate });
    return { ...estimate };
  }

  async findById(tenantId: string, id: string): Promise<Estimate | null> {
    const estimate = this.estimates.get(id);
    if (!estimate || estimate.tenantId !== tenantId) return null;
    return { ...estimate };
  }

  async findByTenant(tenantId: string): Promise<Estimate[]> {
    return Array.from(this.estimates.values())
      .filter((e) => e.tenantId === tenantId)
      .map((e) => ({ ...e }));
  }

  async findApproved(tenantId: string): Promise<Estimate[]> {
    return Array.from(this.estimates.values())
      .filter((e) => e.tenantId === tenantId && e.status === 'approved')
      .map((e) => ({ ...e }));
  }

  async updateStatus(tenantId: string, id: string, status: EstimateStatus): Promise<Estimate | null> {
    const estimate = this.estimates.get(id);
    if (!estimate || estimate.tenantId !== tenantId) return null;
    estimate.status = status;
    estimate.updatedAt = new Date();
    this.estimates.set(id, estimate);
    return { ...estimate };
  }
}
