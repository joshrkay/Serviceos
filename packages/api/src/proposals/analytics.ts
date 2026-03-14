import { v4 as uuidv4 } from 'uuid';
import { Proposal, ProposalStatus } from './proposal';

export interface ProposalOutcome {
  proposalId: string;
  tenantId: string;
  proposalType: string;
  outcome: 'approved' | 'approved_with_edits' | 'rejected' | 'expired' | 'execution_failed';
  editedFields?: string[];
  rejectionReason?: string;
  confidenceScore?: number;
  recordedAt: Date;
}

export interface AnalyticsSummary {
  totalProposals: number;
  approvalRate: number;
  editRate: number;
  rejectionRate: number;
  executionFailureRate: number;
  averageConfidence: number;
  byType: Record<string, {
    total: number;
    approved: number;
    rejected: number;
    edited: number;
  }>;
}

export interface ProposalAnalyticsRepository {
  recordOutcome(outcome: ProposalOutcome): Promise<ProposalOutcome>;
  getOutcomes(tenantId: string, dateRange?: { from: Date; to: Date }): Promise<ProposalOutcome[]>;
}

export class InMemoryProposalAnalyticsRepository implements ProposalAnalyticsRepository {
  private outcomes: ProposalOutcome[] = [];

  async recordOutcome(outcome: ProposalOutcome): Promise<ProposalOutcome> {
    const stored = { ...outcome };
    this.outcomes.push(stored);
    return { ...stored };
  }

  async getOutcomes(tenantId: string, dateRange?: { from: Date; to: Date }): Promise<ProposalOutcome[]> {
    return this.outcomes
      .filter((o) => o.tenantId === tenantId)
      .filter((o) => {
        if (!dateRange) return true;
        return o.recordedAt >= dateRange.from && o.recordedAt <= dateRange.to;
      })
      .map((o) => ({ ...o }));
  }
}

function determineOutcome(proposal: Proposal, editedFields?: string[]): ProposalOutcome['outcome'] {
  if (proposal.status === 'rejected') return 'rejected';
  if (proposal.status === 'expired') return 'expired';
  if (proposal.status === 'execution_failed') return 'execution_failed';
  if (editedFields && editedFields.length > 0) return 'approved_with_edits';
  return 'approved';
}

export async function recordProposalOutcome(
  repo: ProposalAnalyticsRepository,
  proposal: Proposal,
  editedFields?: string[]
): Promise<ProposalOutcome> {
  const outcome: ProposalOutcome = {
    proposalId: proposal.id,
    tenantId: proposal.tenantId,
    proposalType: proposal.proposalType,
    outcome: determineOutcome(proposal, editedFields),
    editedFields: editedFields && editedFields.length > 0 ? editedFields : undefined,
    rejectionReason: proposal.rejectionReason,
    confidenceScore: proposal.confidenceScore,
    recordedAt: new Date(),
  };

  return repo.recordOutcome(outcome);
}

export async function getAnalyticsSummary(
  repo: ProposalAnalyticsRepository,
  tenantId: string,
  dateRange?: { from: Date; to: Date }
): Promise<AnalyticsSummary> {
  const outcomes = await repo.getOutcomes(tenantId, dateRange);
  const total = outcomes.length;

  if (total === 0) {
    return {
      totalProposals: 0,
      approvalRate: 0,
      editRate: 0,
      rejectionRate: 0,
      executionFailureRate: 0,
      averageConfidence: 0,
      byType: {},
    };
  }

  const approved = outcomes.filter((o) => o.outcome === 'approved' || o.outcome === 'approved_with_edits').length;
  const edited = outcomes.filter((o) => o.outcome === 'approved_with_edits').length;
  const rejected = outcomes.filter((o) => o.outcome === 'rejected').length;
  const executionFailed = outcomes.filter((o) => o.outcome === 'execution_failed').length;

  const confidenceScores = outcomes
    .filter((o) => o.confidenceScore !== undefined)
    .map((o) => o.confidenceScore!);
  const averageConfidence =
    confidenceScores.length > 0
      ? confidenceScores.reduce((sum, s) => sum + s, 0) / confidenceScores.length
      : 0;

  const byType: AnalyticsSummary['byType'] = {};
  for (const outcome of outcomes) {
    if (!byType[outcome.proposalType]) {
      byType[outcome.proposalType] = { total: 0, approved: 0, rejected: 0, edited: 0 };
    }
    const entry = byType[outcome.proposalType];
    entry.total++;
    if (outcome.outcome === 'approved' || outcome.outcome === 'approved_with_edits') {
      entry.approved++;
    }
    if (outcome.outcome === 'rejected') {
      entry.rejected++;
    }
    if (outcome.outcome === 'approved_with_edits') {
      entry.edited++;
    }
  }

  return {
    totalProposals: total,
    approvalRate: approved / total,
    editRate: edited / total,
    rejectionRate: rejected / total,
    executionFailureRate: executionFailed / total,
    averageConfidence,
    byType,
  };
}
