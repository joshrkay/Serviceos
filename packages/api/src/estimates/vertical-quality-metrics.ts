import { VerticalType, ServiceCategory } from '../shared/vertical-types';
import { ApprovalRepository, EstimateApproval } from './approval';
import { EditDeltaRepository, EstimateEditDelta } from './edit-delta';
import { CorrectionPattern } from './analytics';

export interface VerticalEstimateQuality {
  tenantId: string;
  verticalType: VerticalType;
  serviceCategory?: ServiceCategory;
  promptVersion?: string;
  approvalRate: number;
  editRate: number;
  averageRevisions: number;
  lineItemAccuracy: number;
  commonCorrections: CorrectionPattern[];
  sampleSize: number;
  periodStart: Date;
  periodEnd: Date;
}

export interface ComputeQualityOptions {
  serviceCategory?: ServiceCategory;
  promptVersion?: string;
  periodStart?: Date;
  periodEnd?: Date;
}

export async function computeVerticalQualityMetrics(
  tenantId: string,
  verticalType: VerticalType,
  approvalRepo: ApprovalRepository,
  deltaRepo: EditDeltaRepository,
  estimateIds: string[],
  options: ComputeQualityOptions = {}
): Promise<VerticalEstimateQuality> {
  const now = new Date();
  const periodStart = options.periodStart ?? new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  const periodEnd = options.periodEnd ?? now;

  if (estimateIds.length === 0) {
    return {
      tenantId,
      verticalType,
      serviceCategory: options.serviceCategory,
      promptVersion: options.promptVersion,
      approvalRate: 0,
      editRate: 0,
      averageRevisions: 0,
      lineItemAccuracy: 1,
      commonCorrections: [],
      sampleSize: 0,
      periodStart,
      periodEnd,
    };
  }

  const approvals = await approvalRepo.findByTenant(tenantId);
  const relevantApprovals = approvals.filter((a) => estimateIds.includes(a.estimateId));

  const approved = relevantApprovals.filter(
    (a) => a.status === 'approved' || a.status === 'approved_with_edits'
  );
  // Gather deltas for all estimates
  const allDeltas: EstimateEditDelta[] = [];
  for (const estimateId of estimateIds) {
    const deltas = await deltaRepo.findByEstimate(tenantId, estimateId);
    allDeltas.push(...deltas);
  }

  const estimatesWithEdits = new Set(allDeltas.map((d) => d.estimateId)).size;

  // Count correction patterns
  const fieldCounts = new Map<string, { count: number; numericDeltas: number[] }>();

  for (const delta of allDeltas) {
    for (const entry of delta.deltas) {
      const field = entry.field || entry.type;
      const existing = fieldCounts.get(field) || { count: 0, numericDeltas: [] };
      existing.count += 1;
      if (typeof entry.oldValue === 'number' && typeof entry.newValue === 'number') {
        existing.numericDeltas.push(entry.newValue - entry.oldValue);
      }
      fieldCounts.set(field, existing);
    }
  }

  const commonCorrections: CorrectionPattern[] = Array.from(fieldCounts.entries())
    .map(([field, data]) => ({
      field,
      frequency: data.count,
      averageDelta:
        data.numericDeltas.length > 0
          ? data.numericDeltas.reduce((s, v) => s + v, 0) / data.numericDeltas.length
          : undefined,
    }))
    .sort((a, b) => b.frequency - a.frequency);

  const sampleSize = estimateIds.length;
  const approvalRate = approved.length / sampleSize;
  const editRate = estimatesWithEdits / sampleSize;
  const averageRevisions = allDeltas.length / sampleSize;

  // Line item accuracy: proportion of estimates without line-item-level changes
  const estimatesWithLineItemChanges = new Set(
    allDeltas
      .filter((d) => d.deltas.some((e) => e.type.startsWith('line_item_')))
      .map((d) => d.estimateId)
  ).size;
  const lineItemAccuracy = 1 - estimatesWithLineItemChanges / sampleSize;

  return {
    tenantId,
    verticalType,
    serviceCategory: options.serviceCategory,
    promptVersion: options.promptVersion,
    approvalRate,
    editRate,
    averageRevisions,
    lineItemAccuracy,
    commonCorrections,
    sampleSize,
    periodStart,
    periodEnd,
  };
}
