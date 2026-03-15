import { v4 as uuidv4 } from 'uuid';
import { Estimate } from './estimate';

export interface ApprovedEstimateMetadata {
  id: string;
  tenantId: string;
  estimateId: string;
  verticalSlug: string;
  categoryId: string;
  approvedAt: Date;
  approvedBy: string;
  lineItemCount: number;
  totalAmount: number;
  tags: string[];
  searchableContent: string;
}

export interface CreateApprovedEstimateMetadataInput {
  tenantId: string;
  estimateId: string;
  verticalSlug: string;
  categoryId: string;
  approvedAt: Date;
  approvedBy: string;
  lineItemCount: number;
  totalAmount: number;
  tags: string[];
  searchableContent: string;
}

export interface ApprovedEstimateMetadataRepository {
  create(metadata: ApprovedEstimateMetadata): Promise<ApprovedEstimateMetadata>;
  findByTenant(tenantId: string): Promise<ApprovedEstimateMetadata[]>;
  findByVerticalAndCategory(tenantId: string, verticalSlug: string, categoryId: string): Promise<ApprovedEstimateMetadata[]>;
  findRecent(tenantId: string, limit: number): Promise<ApprovedEstimateMetadata[]>;
}

export function validateApprovedEstimateMetadataInput(input: CreateApprovedEstimateMetadataInput): string[] {
  const errors: string[] = [];
  if (!input.tenantId) errors.push('tenantId is required');
  if (!input.estimateId) errors.push('estimateId is required');
  if (!input.verticalSlug) errors.push('verticalSlug is required');
  if (!input.categoryId) errors.push('categoryId is required');
  if (!input.approvedBy) errors.push('approvedBy is required');
  return errors;
}

export function createApprovedEstimateMetadata(
  estimate: Estimate,
  verticalSlug: string,
  categoryId: string
): ApprovedEstimateMetadata {
  return {
    id: uuidv4(),
    tenantId: estimate.tenantId,
    estimateId: estimate.id,
    verticalSlug,
    categoryId,
    approvedAt: estimate.approvedAt || new Date(),
    approvedBy: estimate.approvedBy || 'unknown',
    lineItemCount: estimate.lineItems.length,
    totalAmount: estimate.lineItems.reduce((sum, li) => sum + li.total, 0),
    tags: extractTags(estimate),
    searchableContent: buildSearchableContent(estimate),
  };
}

export function buildSearchableContent(estimate: Estimate): string {
  const parts: string[] = [];
  for (const li of estimate.lineItems) {
    parts.push(li.description);
    if (li.category) parts.push(li.category);
  }
  return parts.join(' ').toLowerCase();
}

function extractTags(estimate: Estimate): string[] {
  const tags = new Set<string>();
  for (const li of estimate.lineItems) {
    if (li.category) tags.add(li.category);
  }
  return Array.from(tags);
}

export class InMemoryApprovedEstimateMetadataRepository implements ApprovedEstimateMetadataRepository {
  private records: Map<string, ApprovedEstimateMetadata> = new Map();

  async create(metadata: ApprovedEstimateMetadata): Promise<ApprovedEstimateMetadata> {
    this.records.set(metadata.id, { ...metadata });
    return { ...metadata };
  }

  async findByTenant(tenantId: string): Promise<ApprovedEstimateMetadata[]> {
    return Array.from(this.records.values())
      .filter((r) => r.tenantId === tenantId)
      .map((r) => ({ ...r }));
  }

  async findByVerticalAndCategory(tenantId: string, verticalSlug: string, categoryId: string): Promise<ApprovedEstimateMetadata[]> {
    return Array.from(this.records.values())
      .filter((r) => r.tenantId === tenantId && r.verticalSlug === verticalSlug && r.categoryId === categoryId)
      .map((r) => ({ ...r }));
  }

  async findRecent(tenantId: string, limit: number): Promise<ApprovedEstimateMetadata[]> {
    return Array.from(this.records.values())
      .filter((r) => r.tenantId === tenantId)
      .sort((a, b) => b.approvedAt.getTime() - a.approvedAt.getTime())
      .slice(0, limit)
      .map((r) => ({ ...r }));
  }
}
