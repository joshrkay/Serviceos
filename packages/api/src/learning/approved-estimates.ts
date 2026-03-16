// P4-005A/005B/005C: Approved Estimate Retrieval for Learning
// Retrieves approved estimates with provenance data for AI learning context

import { Estimate, EstimateRepository } from '../estimates/estimate';

export interface ApprovedEstimateContext {
  tenantId: string;
  estimateId: string;
  estimateNumber: string;
  jobId: string;
  lineItems: ApprovedLineItemContext[];
  totals: {
    subtotalCents: number;
    discountCents: number;
    taxCents: number;
    totalCents: number;
  };
  categoryId?: string;
  verticalType?: string;
  wasEditedBeforeApproval: boolean;
  editedFields?: string[];
  approvalSource: 'manual' | 'ai_generated' | 'ai_revised' | 'template' | 'cloned';
  createdAt: Date;
}

export interface ApprovedLineItemContext {
  description: string;
  category?: string;
  quantity: number;
  unitPriceCents: number;
  totalCents: number;
  taxable: boolean;
}

export interface EstimateRetrievalQuery {
  tenantId: string;
  verticalType?: string;
  categoryId?: string;
  minTotalCents?: number;
  maxTotalCents?: number;
  limit?: number;
  approvalSource?: string;
}

export interface ApprovedEstimateRepository {
  findApprovedByTenant(query: EstimateRetrievalQuery): Promise<ApprovedEstimateContext[]>;
  findSimilar(
    tenantId: string,
    categoryId: string,
    totalCentsRange: { min: number; max: number },
    limit: number
  ): Promise<ApprovedEstimateContext[]>;
  getApprovalStats(tenantId: string): Promise<ApprovalStats>;
}

export interface ApprovalStats {
  totalApproved: number;
  totalRejected: number;
  totalApprovedWithEdits: number;
  approvalRate: number;
  cleanApprovalRate: number;
  editRate: number;
  averageTotalCents: number;
  byCategory: Record<string, { count: number; avgTotalCents: number }>;
}

export function buildApprovedEstimateContext(
  estimate: Estimate,
  metadata: {
    categoryId?: string;
    verticalType?: string;
    wasEdited: boolean;
    editedFields?: string[];
    approvalSource: string;
  }
): ApprovedEstimateContext {
  return {
    tenantId: estimate.tenantId,
    estimateId: estimate.id,
    estimateNumber: estimate.estimateNumber,
    jobId: estimate.jobId,
    lineItems: estimate.lineItems.map((li) => ({
      description: li.description,
      category: li.category,
      quantity: li.quantity,
      unitPriceCents: li.unitPriceCents,
      totalCents: li.totalCents,
      taxable: li.taxable,
    })),
    totals: {
      subtotalCents: estimate.totals.subtotalCents,
      discountCents: estimate.totals.discountCents,
      taxCents: estimate.totals.taxCents,
      totalCents: estimate.totals.totalCents,
    },
    categoryId: metadata.categoryId,
    verticalType: metadata.verticalType,
    wasEditedBeforeApproval: metadata.wasEdited,
    editedFields: metadata.editedFields,
    approvalSource: metadata.approvalSource as ApprovedEstimateContext['approvalSource'],
    createdAt: estimate.createdAt,
  };
}

export function computeApprovalStats(
  approved: ApprovedEstimateContext[],
  rejected: number
): ApprovalStats {
  const totalApproved = approved.length;
  const totalApprovedWithEdits = approved.filter((e) => e.wasEditedBeforeApproval).length;
  const cleanApprovals = totalApproved - totalApprovedWithEdits;
  const total = totalApproved + rejected;

  const byCategory: Record<string, { count: number; avgTotalCents: number }> = {};
  let totalAmount = 0;

  for (const estimate of approved) {
    totalAmount += estimate.totals.totalCents;
    const cat = estimate.categoryId || 'uncategorized';
    if (!byCategory[cat]) {
      byCategory[cat] = { count: 0, avgTotalCents: 0 };
    }
    byCategory[cat].count += 1;
    byCategory[cat].avgTotalCents += estimate.totals.totalCents;
  }

  // Convert sums to averages
  for (const cat of Object.keys(byCategory)) {
    byCategory[cat].avgTotalCents = Math.round(
      byCategory[cat].avgTotalCents / byCategory[cat].count
    );
  }

  return {
    totalApproved,
    totalRejected: rejected,
    totalApprovedWithEdits,
    approvalRate: total > 0 ? totalApproved / total : 0,
    cleanApprovalRate: total > 0 ? cleanApprovals / total : 0,
    editRate: totalApproved > 0 ? totalApprovedWithEdits / totalApproved : 0,
    averageTotalCents: totalApproved > 0 ? Math.round(totalAmount / totalApproved) : 0,
    byCategory,
  };
}

export class InMemoryApprovedEstimateRepository implements ApprovedEstimateRepository {
  private estimates: ApprovedEstimateContext[] = [];

  addEstimate(estimate: ApprovedEstimateContext): void {
    this.estimates.push(estimate);
  }

  async findApprovedByTenant(query: EstimateRetrievalQuery): Promise<ApprovedEstimateContext[]> {
    let results = this.estimates.filter((e) => e.tenantId === query.tenantId);

    if (query.verticalType) {
      results = results.filter((e) => e.verticalType === query.verticalType);
    }
    if (query.categoryId) {
      results = results.filter((e) => e.categoryId === query.categoryId);
    }
    if (query.minTotalCents !== undefined) {
      results = results.filter((e) => e.totals.totalCents >= query.minTotalCents!);
    }
    if (query.maxTotalCents !== undefined) {
      results = results.filter((e) => e.totals.totalCents <= query.maxTotalCents!);
    }
    if (query.approvalSource) {
      results = results.filter((e) => e.approvalSource === query.approvalSource);
    }

    results.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());

    if (query.limit) {
      results = results.slice(0, query.limit);
    }

    return results;
  }

  async findSimilar(
    tenantId: string,
    categoryId: string,
    totalCentsRange: { min: number; max: number },
    limit: number
  ): Promise<ApprovedEstimateContext[]> {
    return this.estimates
      .filter(
        (e) =>
          e.tenantId === tenantId &&
          e.categoryId === categoryId &&
          e.totals.totalCents >= totalCentsRange.min &&
          e.totals.totalCents <= totalCentsRange.max
      )
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .slice(0, limit);
  }

  async getApprovalStats(tenantId: string): Promise<ApprovalStats> {
    const tenantEstimates = this.estimates.filter((e) => e.tenantId === tenantId);
    return computeApprovalStats(tenantEstimates, 0);
  }
}
