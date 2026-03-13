import { ApprovalRepository, EstimateApproval } from './approval';
import { EditDeltaRepository, EstimateEditDelta, DeltaEntry } from './edit-delta';

export interface CorrectionPattern {
  field: string;
  frequency: number;
  averageDelta?: number;
}

export interface EstimateAnalytics {
  tenantId: string;
  totalEstimates: number;
  approvalRate: number;
  rejectionRate: number;
  approvedWithEditsRate: number;
  editRate: number;
  averageRevisions: number;
  commonCorrections: CorrectionPattern[];
}

export async function computeEstimateAnalytics(
  tenantId: string,
  approvalRepo: ApprovalRepository,
  deltaRepo: EditDeltaRepository,
  estimateIds: string[]
): Promise<EstimateAnalytics> {
  const approvals = await approvalRepo.findByTenant(tenantId);
  const totalEstimates = estimateIds.length;

  if (totalEstimates === 0) {
    return {
      tenantId,
      totalEstimates: 0,
      approvalRate: 0,
      rejectionRate: 0,
      approvedWithEditsRate: 0,
      editRate: 0,
      averageRevisions: 0,
      commonCorrections: [],
    };
  }

  const approved = approvals.filter((a) => a.status === 'approved' || a.status === 'approved_with_edits');
  const rejected = approvals.filter((a) => a.status === 'rejected');
  const approvedWithEdits = approvals.filter((a) => a.status === 'approved_with_edits');

  // Gather all deltas
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
      averageDelta: data.numericDeltas.length > 0
        ? data.numericDeltas.reduce((s, v) => s + v, 0) / data.numericDeltas.length
        : undefined,
    }))
    .sort((a, b) => b.frequency - a.frequency);

  const totalRevisions = allDeltas.length;

  return {
    tenantId,
    totalEstimates,
    approvalRate: approved.length / totalEstimates,
    rejectionRate: rejected.length / totalEstimates,
    approvedWithEditsRate: approvedWithEdits.length / totalEstimates,
    editRate: estimatesWithEdits / totalEstimates,
    averageRevisions: totalEstimates > 0 ? totalRevisions / totalEstimates : 0,
    commonCorrections,
  };
}
