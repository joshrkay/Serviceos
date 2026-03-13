import { v4 as uuidv4 } from 'uuid';
import { VerticalType, ServiceCategory } from '../shared/vertical-types';
import { ApprovalStatus } from './approval';

export interface EstimateSummarySnapshot {
  id: string;
  tenantId: string;
  estimateId: string;
  verticalType?: VerticalType;
  serviceCategory?: ServiceCategory;
  lineItemDescriptions: string[];
  totalCents: number;
  customerMessage?: string;
  approvalOutcome: ApprovalStatus;
  createdAt: Date;
}

export interface EstimateSummarySnapshotRepository {
  create(snapshot: EstimateSummarySnapshot): Promise<EstimateSummarySnapshot>;
  findByTenant(tenantId: string): Promise<EstimateSummarySnapshot[]>;
  findByFilters(tenantId: string, filters: { verticalType?: VerticalType; serviceCategory?: ServiceCategory; limit?: number }): Promise<EstimateSummarySnapshot[]>;
}

export function createEstimateSummarySnapshot(
  tenantId: string,
  estimateId: string,
  lineItemDescriptions: string[],
  totalCents: number,
  approvalOutcome: ApprovalStatus,
  options?: {
    verticalType?: VerticalType;
    serviceCategory?: ServiceCategory;
    customerMessage?: string;
  }
): EstimateSummarySnapshot {
  return {
    id: uuidv4(),
    tenantId,
    estimateId,
    verticalType: options?.verticalType,
    serviceCategory: options?.serviceCategory,
    lineItemDescriptions: [...lineItemDescriptions],
    totalCents,
    customerMessage: options?.customerMessage,
    approvalOutcome,
    createdAt: new Date(),
  };
}

export function validateSnapshot(snapshot: Partial<EstimateSummarySnapshot>): string[] {
  const errors: string[] = [];
  if (!snapshot.tenantId) errors.push('tenantId is required');
  if (!snapshot.estimateId) errors.push('estimateId is required');
  if (!snapshot.approvalOutcome) errors.push('approvalOutcome is required');
  if (snapshot.totalCents !== undefined && snapshot.totalCents < 0) errors.push('totalCents must be non-negative');
  return errors;
}

export class InMemoryEstimateSummarySnapshotRepository implements EstimateSummarySnapshotRepository {
  private snapshots: Map<string, EstimateSummarySnapshot> = new Map();

  async create(snapshot: EstimateSummarySnapshot): Promise<EstimateSummarySnapshot> {
    this.snapshots.set(snapshot.id, { ...snapshot, lineItemDescriptions: [...snapshot.lineItemDescriptions] });
    return { ...snapshot, lineItemDescriptions: [...snapshot.lineItemDescriptions] };
  }

  async findByTenant(tenantId: string): Promise<EstimateSummarySnapshot[]> {
    return Array.from(this.snapshots.values())
      .filter((s) => s.tenantId === tenantId)
      .map((s) => ({ ...s, lineItemDescriptions: [...s.lineItemDescriptions] }));
  }

  async findByFilters(tenantId: string, filters: { verticalType?: VerticalType; serviceCategory?: ServiceCategory; limit?: number }): Promise<EstimateSummarySnapshot[]> {
    let results = Array.from(this.snapshots.values())
      .filter((s) => {
        if (s.tenantId !== tenantId) return false;
        if (filters.verticalType && s.verticalType !== filters.verticalType) return false;
        if (filters.serviceCategory && s.serviceCategory !== filters.serviceCategory) return false;
        return true;
      })
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());

    if (filters.limit) {
      results = results.slice(0, filters.limit);
    }

    return results.map((s) => ({ ...s, lineItemDescriptions: [...s.lineItemDescriptions] }));
  }
}
