import { v4 as uuidv4 } from 'uuid';

export type ApprovalStatus = 'pending' | 'approved' | 'approved_with_edits' | 'rejected';

export interface EstimateApproval {
  id: string;
  tenantId: string;
  estimateId: string;
  status: ApprovalStatus;
  approvedBy?: string;
  approvedAt?: Date;
  rejectedBy?: string;
  rejectedAt?: Date;
  rejectionReason?: string;
  approvedWithEdits: boolean;
  finalRevisionId?: string;
  metadata?: Record<string, unknown>;
  createdAt: Date;
}

export interface RecordApprovalInput {
  tenantId: string;
  estimateId: string;
  approvedBy: string;
  approvedWithEdits?: boolean;
  finalRevisionId?: string;
  metadata?: Record<string, unknown>;
}

export interface RecordRejectionInput {
  tenantId: string;
  estimateId: string;
  rejectedBy: string;
  rejectionReason?: string;
  metadata?: Record<string, unknown>;
}

export interface ApprovalRepository {
  create(approval: EstimateApproval): Promise<EstimateApproval>;
  findByEstimate(tenantId: string, estimateId: string): Promise<EstimateApproval | null>;
  findByTenant(tenantId: string): Promise<EstimateApproval[]>;
}

export function validateApprovalInput(input: RecordApprovalInput): string[] {
  const errors: string[] = [];
  if (!input.tenantId) errors.push('tenantId is required');
  if (!input.estimateId) errors.push('estimateId is required');
  if (!input.approvedBy) errors.push('approvedBy is required');
  return errors;
}

export function validateRejectionInput(input: RecordRejectionInput): string[] {
  const errors: string[] = [];
  if (!input.tenantId) errors.push('tenantId is required');
  if (!input.estimateId) errors.push('estimateId is required');
  if (!input.rejectedBy) errors.push('rejectedBy is required');
  return errors;
}

async function ensureNoExistingDecision(
  repository: ApprovalRepository,
  tenantId: string,
  estimateId: string
): Promise<void> {
  const existing = await repository.findByEstimate(tenantId, estimateId);
  if (existing) throw new Error('Approval or rejection already recorded for this estimate');
}

export async function recordApproval(
  input: RecordApprovalInput,
  repository: ApprovalRepository
): Promise<EstimateApproval> {
  await ensureNoExistingDecision(repository, input.tenantId, input.estimateId);

  const approval: EstimateApproval = {
    id: uuidv4(),
    tenantId: input.tenantId,
    estimateId: input.estimateId,
    status: input.approvedWithEdits ? 'approved_with_edits' : 'approved',
    approvedBy: input.approvedBy,
    approvedAt: new Date(),
    approvedWithEdits: input.approvedWithEdits ?? false,
    finalRevisionId: input.finalRevisionId,
    metadata: input.metadata,
    createdAt: new Date(),
  };

  return repository.create(approval);
}

export async function recordRejection(
  input: RecordRejectionInput,
  repository: ApprovalRepository
): Promise<EstimateApproval> {
  await ensureNoExistingDecision(repository, input.tenantId, input.estimateId);

  const approval: EstimateApproval = {
    id: uuidv4(),
    tenantId: input.tenantId,
    estimateId: input.estimateId,
    status: 'rejected',
    rejectedBy: input.rejectedBy,
    rejectedAt: new Date(),
    rejectionReason: input.rejectionReason,
    approvedWithEdits: false,
    metadata: input.metadata,
    createdAt: new Date(),
  };

  return repository.create(approval);
}

export class InMemoryApprovalRepository implements ApprovalRepository {
  private approvals: Map<string, EstimateApproval> = new Map();

  async create(approval: EstimateApproval): Promise<EstimateApproval> {
    this.approvals.set(approval.id, { ...approval });
    return { ...approval };
  }

  async findByEstimate(tenantId: string, estimateId: string): Promise<EstimateApproval | null> {
    const found = Array.from(this.approvals.values()).find(
      (a) => a.tenantId === tenantId && a.estimateId === estimateId
    );
    return found ? { ...found } : null;
  }

  async findByTenant(tenantId: string): Promise<EstimateApproval[]> {
    return Array.from(this.approvals.values())
      .filter((a) => a.tenantId === tenantId)
      .map((a) => ({ ...a }));
  }
}
