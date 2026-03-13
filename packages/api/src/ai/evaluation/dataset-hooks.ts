import { v4 as uuidv4 } from 'uuid';
import { Proposal } from '../../proposals/proposal';
import { AiRun } from '../ai-run';

export interface EvaluationSnapshot {
  id: string;
  tenantId: string;
  proposalId: string;
  aiRunId?: string;
  taskType: string;
  input: {
    sourceContext: Record<string, unknown>;
    prompt?: string;
  };
  output: {
    payload: Record<string, unknown>;
    confidenceScore?: number;
  };
  outcome: {
    status: string;
    editedFields?: string[];
    rejectionReason?: string;
  };
  capturedAt: Date;
}

export interface EvaluationDatasetRepository {
  save(snapshot: EvaluationSnapshot): Promise<EvaluationSnapshot>;
  findByTaskType(tenantId: string, taskType: string): Promise<EvaluationSnapshot[]>;
  findByProposal(tenantId: string, proposalId: string): Promise<EvaluationSnapshot | null>;
  getAll(tenantId: string): Promise<EvaluationSnapshot[]>;
}

export class InMemoryEvaluationDatasetRepository implements EvaluationDatasetRepository {
  private snapshots: Map<string, EvaluationSnapshot> = new Map();

  async save(snapshot: EvaluationSnapshot): Promise<EvaluationSnapshot> {
    const stored = { ...snapshot };
    this.snapshots.set(stored.id, stored);
    return { ...stored };
  }

  async findByTaskType(tenantId: string, taskType: string): Promise<EvaluationSnapshot[]> {
    return Array.from(this.snapshots.values())
      .filter((s) => s.tenantId === tenantId && s.taskType === taskType)
      .map((s) => ({ ...s }));
  }

  async findByProposal(tenantId: string, proposalId: string): Promise<EvaluationSnapshot | null> {
    const snapshot = Array.from(this.snapshots.values()).find(
      (s) => s.tenantId === tenantId && s.proposalId === proposalId
    );
    return snapshot ? { ...snapshot } : null;
  }

  async getAll(tenantId: string): Promise<EvaluationSnapshot[]> {
    return Array.from(this.snapshots.values())
      .filter((s) => s.tenantId === tenantId)
      .map((s) => ({ ...s }));
  }
}

export async function captureEvaluationSnapshot(
  repo: EvaluationDatasetRepository,
  proposal: Proposal,
  aiRun?: AiRun,
  editedFields?: string[]
): Promise<EvaluationSnapshot> {
  const snapshot: EvaluationSnapshot = {
    id: uuidv4(),
    tenantId: proposal.tenantId,
    proposalId: proposal.id,
    aiRunId: aiRun?.id,
    taskType: proposal.proposalType,
    input: {
      sourceContext: proposal.sourceContext || {},
      prompt: aiRun?.inputSnapshot
        ? (aiRun.inputSnapshot.prompt as string | undefined)
        : undefined,
    },
    output: {
      payload: proposal.payload,
      confidenceScore: proposal.confidenceScore,
    },
    outcome: {
      status: proposal.status,
      editedFields: editedFields && editedFields.length > 0 ? editedFields : undefined,
      rejectionReason: proposal.rejectionReason,
    },
    capturedAt: new Date(),
  };

  return repo.save(snapshot);
}
