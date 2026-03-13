import { v4 as uuidv4 } from 'uuid';

export type ProposalStatus = 'draft' | 'ready_for_review' | 'approved' | 'rejected' | 'expired' | 'executed' | 'execution_failed';
export type ProposalType = 'create_customer' | 'update_customer' | 'create_job' | 'create_appointment' | 'draft_estimate' | 'update_estimate';

const VALID_PROPOSAL_TYPES: ProposalType[] = [
  'create_customer',
  'update_customer',
  'create_job',
  'create_appointment',
  'draft_estimate',
  'update_estimate',
];

export interface Proposal {
  id: string;
  tenantId: string;
  proposalType: ProposalType;
  status: ProposalStatus;
  payload: Record<string, unknown>;
  summary: string;
  explanation?: string;
  confidenceScore?: number;
  confidenceFactors?: string[];
  sourceContext?: Record<string, unknown>;
  aiRunId?: string;
  promptVersionId?: string;
  targetEntityType?: string;
  targetEntityId?: string;
  resultEntityId?: string;
  rejectionReason?: string;
  rejectionDetails?: string;
  idempotencyKey?: string;
  expiresAt?: Date;
  executedAt?: Date;
  executedBy?: string;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateProposalInput {
  tenantId: string;
  proposalType: ProposalType;
  payload: Record<string, unknown>;
  summary: string;
  explanation?: string;
  confidenceScore?: number;
  confidenceFactors?: string[];
  sourceContext?: Record<string, unknown>;
  aiRunId?: string;
  promptVersionId?: string;
  targetEntityType?: string;
  targetEntityId?: string;
  idempotencyKey?: string;
  expiresAt?: Date;
  createdBy: string;
}

export interface ProposalRepository {
  create(proposal: Proposal): Promise<Proposal>;
  findById(tenantId: string, id: string): Promise<Proposal | null>;
  findByTenant(tenantId: string): Promise<Proposal[]>;
  findByStatus(tenantId: string, status: ProposalStatus): Promise<Proposal[]>;
  findByAiRun(tenantId: string, aiRunId: string): Promise<Proposal[]>;
  updateStatus(
    tenantId: string,
    id: string,
    status: ProposalStatus,
    updates?: Partial<Pick<Proposal, 'rejectionReason' | 'rejectionDetails' | 'resultEntityId' | 'executedAt' | 'executedBy'>>
  ): Promise<Proposal | null>;
  update(
    tenantId: string,
    id: string,
    updates: Partial<Omit<Proposal, 'id' | 'tenantId' | 'createdBy' | 'createdAt'>>
  ): Promise<Proposal | null>;
}

export function validateProposalInput(input: CreateProposalInput): string[] {
  const errors: string[] = [];
  if (!input.tenantId) errors.push('tenantId is required');
  if (!input.proposalType) {
    errors.push('proposalType is required');
  } else if (!VALID_PROPOSAL_TYPES.includes(input.proposalType)) {
    errors.push('proposalType is invalid');
  }
  if (!input.payload || typeof input.payload !== 'object') {
    errors.push('payload must be a non-null object');
  }
  if (!input.summary) errors.push('summary is required');
  if (!input.createdBy) errors.push('createdBy is required');
  if (
    input.confidenceScore !== undefined &&
    (typeof input.confidenceScore !== 'number' ||
      input.confidenceScore < 0 ||
      input.confidenceScore > 1)
  ) {
    errors.push('confidenceScore must be a number between 0 and 1');
  }
  return errors;
}

export function createProposal(input: CreateProposalInput): Proposal {
  const now = new Date();
  return {
    id: uuidv4(),
    tenantId: input.tenantId,
    proposalType: input.proposalType,
    status: 'draft',
    payload: input.payload,
    summary: input.summary,
    explanation: input.explanation,
    confidenceScore: input.confidenceScore,
    confidenceFactors: input.confidenceFactors,
    sourceContext: input.sourceContext,
    aiRunId: input.aiRunId,
    promptVersionId: input.promptVersionId,
    targetEntityType: input.targetEntityType,
    targetEntityId: input.targetEntityId,
    idempotencyKey: input.idempotencyKey,
    expiresAt: input.expiresAt,
    createdBy: input.createdBy,
    createdAt: now,
    updatedAt: now,
  };
}

export class InMemoryProposalRepository implements ProposalRepository {
  private proposals: Map<string, Proposal> = new Map();

  async create(proposal: Proposal): Promise<Proposal> {
    this.proposals.set(proposal.id, { ...proposal });
    return { ...proposal };
  }

  async findById(tenantId: string, id: string): Promise<Proposal | null> {
    const proposal = this.proposals.get(id);
    if (!proposal || proposal.tenantId !== tenantId) return null;
    return { ...proposal };
  }

  async findByTenant(tenantId: string): Promise<Proposal[]> {
    return Array.from(this.proposals.values())
      .filter((p) => p.tenantId === tenantId)
      .map((p) => ({ ...p }));
  }

  async findByStatus(tenantId: string, status: ProposalStatus): Promise<Proposal[]> {
    return Array.from(this.proposals.values())
      .filter((p) => p.tenantId === tenantId && p.status === status)
      .map((p) => ({ ...p }));
  }

  async findByAiRun(tenantId: string, aiRunId: string): Promise<Proposal[]> {
    return Array.from(this.proposals.values())
      .filter((p) => p.tenantId === tenantId && p.aiRunId === aiRunId)
      .map((p) => ({ ...p }));
  }

  async updateStatus(
    tenantId: string,
    id: string,
    status: ProposalStatus,
    updates?: Partial<Pick<Proposal, 'rejectionReason' | 'rejectionDetails' | 'resultEntityId' | 'executedAt' | 'executedBy'>>
  ): Promise<Proposal | null> {
    const proposal = this.proposals.get(id);
    if (!proposal || proposal.tenantId !== tenantId) return null;

    proposal.status = status;
    proposal.updatedAt = new Date();
    if (updates) {
      if (updates.rejectionReason !== undefined) proposal.rejectionReason = updates.rejectionReason;
      if (updates.rejectionDetails !== undefined) proposal.rejectionDetails = updates.rejectionDetails;
      if (updates.resultEntityId !== undefined) proposal.resultEntityId = updates.resultEntityId;
      if (updates.executedAt !== undefined) proposal.executedAt = updates.executedAt;
      if (updates.executedBy !== undefined) proposal.executedBy = updates.executedBy;
    }

    this.proposals.set(id, proposal);
    return { ...proposal };
  }

  async update(
    tenantId: string,
    id: string,
    updates: Partial<Omit<Proposal, 'id' | 'tenantId' | 'createdBy' | 'createdAt'>>
  ): Promise<Proposal | null> {
    const proposal = this.proposals.get(id);
    if (!proposal || proposal.tenantId !== tenantId) return null;

    Object.assign(proposal, updates, { updatedAt: new Date() });
    this.proposals.set(id, proposal);
    return { ...proposal };
  }
}
