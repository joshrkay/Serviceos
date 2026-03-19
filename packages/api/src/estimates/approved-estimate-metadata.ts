import { v4 as uuidv4 } from 'uuid';
import { ApprovalStatus } from './approval';
import { VerticalType, ServiceCategory } from '../shared/vertical-types';
import { ValidationError } from '../shared/errors';

export interface ApprovedEstimateMetadata {
  id: string;
  tenantId: string;
  estimateId: string;
  verticalType?: VerticalType;
  serviceCategory?: ServiceCategory;
  approvalOutcome: ApprovalStatus;
  approvedAt: Date;
  lineItemCount: number;
  totalCents: number;
  lineItemSummary: string[];
  tags?: string[];
}

export interface CreateApprovedEstimateMetadataInput {
  tenantId: string;
  estimateId: string;
  verticalType?: VerticalType;
  serviceCategory?: ServiceCategory;
  approvalOutcome: ApprovalStatus;
  approvedAt: Date;
  lineItemCount: number;
  totalCents: number;
  lineItemSummary: string[];
  tags?: string[];
}

export interface ApprovedEstimateFilters {
  verticalType?: VerticalType;
  serviceCategory?: ServiceCategory;
  dateRange?: { from: Date; to: Date };
}

export function validateApprovedEstimateMetadataInput(input: CreateApprovedEstimateMetadataInput): string[] {
  const errors: string[] = [];
  if (!input.tenantId) errors.push('tenantId is required');
  if (!input.estimateId) errors.push('estimateId is required');
  if (!input.approvalOutcome) errors.push('approvalOutcome is required');
  if (input.lineItemCount < 0) errors.push('lineItemCount must be non-negative');
  if (input.totalCents < 0) errors.push('totalCents must be non-negative');
  return errors;
}

export interface ApprovedEstimateMetadataRepository {
  create(metadata: ApprovedEstimateMetadata): Promise<ApprovedEstimateMetadata>;
  findByTenant(tenantId: string): Promise<ApprovedEstimateMetadata[]>;
  findByFilters(tenantId: string, filters: ApprovedEstimateFilters): Promise<ApprovedEstimateMetadata[]>;
  findByEstimate(tenantId: string, estimateId: string): Promise<ApprovedEstimateMetadata | null>;
}

export async function createApprovedEstimateMetadata(
  input: CreateApprovedEstimateMetadataInput,
  repository: ApprovedEstimateMetadataRepository
): Promise<ApprovedEstimateMetadata> {
  const errors = validateApprovedEstimateMetadataInput(input);
  if (errors.length > 0) {
    throw new ValidationError(`Validation failed: ${errors.join(', ')}`, { errors });
  }

  const metadata: ApprovedEstimateMetadata = {
    id: uuidv4(),
    ...input,
  };
  return repository.create(metadata);
}

// P4-005B: Tenant-scoped approved-estimate lookup
export async function lookupApprovedEstimates(
  tenantId: string,
  filters: ApprovedEstimateFilters,
  repository: ApprovedEstimateMetadataRepository
): Promise<ApprovedEstimateMetadata[]> {
  return repository.findByFilters(tenantId, filters);
}

export class InMemoryApprovedEstimateMetadataRepository implements ApprovedEstimateMetadataRepository {
  private records: Map<string, ApprovedEstimateMetadata> = new Map();

  async create(metadata: ApprovedEstimateMetadata): Promise<ApprovedEstimateMetadata> {
    this.records.set(metadata.id, { ...metadata, lineItemSummary: [...metadata.lineItemSummary] });
    return { ...metadata, lineItemSummary: [...metadata.lineItemSummary] };
  }

  async findByTenant(tenantId: string): Promise<ApprovedEstimateMetadata[]> {
    return Array.from(this.records.values())
      .filter((m) => m.tenantId === tenantId)
      .map((m) => ({ ...m, lineItemSummary: [...m.lineItemSummary] }));
  }

  async findByFilters(tenantId: string, filters: ApprovedEstimateFilters): Promise<ApprovedEstimateMetadata[]> {
    return Array.from(this.records.values())
      .filter((m) => {
        if (m.tenantId !== tenantId) return false;
        if (filters.verticalType && m.verticalType !== filters.verticalType) return false;
        if (filters.serviceCategory && m.serviceCategory !== filters.serviceCategory) return false;
        if (filters.dateRange) {
          if (m.approvedAt < filters.dateRange.from || m.approvedAt > filters.dateRange.to) return false;
        }
        return true;
      })
      .map((m) => ({ ...m, lineItemSummary: [...m.lineItemSummary] }));
  }

  async findByEstimate(tenantId: string, estimateId: string): Promise<ApprovedEstimateMetadata | null> {
    const found = Array.from(this.records.values()).find(
      (m) => m.tenantId === tenantId && m.estimateId === estimateId
    );
    return found ? { ...found, lineItemSummary: [...found.lineItemSummary] } : null;
  }
}
