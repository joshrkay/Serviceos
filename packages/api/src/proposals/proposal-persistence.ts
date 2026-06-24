import type { AuditRepository } from '../audit/audit';
import { logProposalEvent } from './audit';
import type { Proposal, ProposalRepository, ProposalStatus, ProposalType } from './proposal';
import { UNDO_WINDOW_MS } from './lifecycle';

export const AUTO_APPROVE_POLICY_ACTOR_ID = 'auto-approve-policy';

export interface AutoApprovalProvenance {
  supervisorMode?: string;
  threshold: number | null;
  confidenceScore?: number;
  overallConfidence?: string;
  undoWindowMs: number;
  sourceTrustTier?: string;
}

function readProvenance(proposal: Proposal): AutoApprovalProvenance | undefined {
  const raw = proposal.sourceContext?.autoApprovalProvenance;
  if (!raw || typeof raw !== 'object') return undefined;
  return raw as AutoApprovalProvenance;
}

/** Emit policy-actor approval audit once per auto-approved proposal at persist time. */
export async function logAutoApprovalAuditIfNeeded(
  auditRepo: AuditRepository | undefined,
  proposal: Proposal,
): Promise<void> {
  if (!auditRepo || proposal.status !== 'approved') return;
  const provenance = readProvenance(proposal);
  if (!provenance) return;

  await logProposalEvent(
    auditRepo,
    proposal,
    'proposal.approved',
    { id: AUTO_APPROVE_POLICY_ACTOR_ID, role: 'system' },
    {
      channel: 'auto',
      supervisorMode: provenance.supervisorMode,
      threshold: provenance.threshold,
      confidenceScore: provenance.confidenceScore,
      overallConfidence: provenance.overallConfidence,
      undoWindowMs: provenance.undoWindowMs ?? UNDO_WINDOW_MS,
      sourceTrustTier: provenance.sourceTrustTier,
    },
  );
}

/**
 * Decorator: emits auto-approval audit after create / createMany when the
 * proposal lands `approved` at birth with stamped provenance.
 */
export class AuditingProposalRepository implements ProposalRepository {
  constructor(
    private readonly inner: ProposalRepository,
    private readonly auditRepo?: AuditRepository,
  ) {}

  async create(proposal: Proposal): Promise<Proposal> {
    const stored = await this.inner.create(proposal);
    await logAutoApprovalAuditIfNeeded(this.auditRepo, stored);
    return stored;
  }

  async createMany(proposals: Proposal[]): Promise<Proposal[]> {
    const stored = await this.inner.createMany(proposals);
    if (this.auditRepo) {
      await Promise.all(stored.map((p) => logAutoApprovalAuditIfNeeded(this.auditRepo, p)));
    }
    return stored;
  }

  findById(tenantId: string, id: string): Promise<Proposal | null> {
    return this.inner.findById(tenantId, id);
  }

  findByTenant(tenantId: string): Promise<Proposal[]> {
    return this.inner.findByTenant(tenantId);
  }

  findByStatus(tenantId: string, status: ProposalStatus): Promise<Proposal[]> {
    return this.inner.findByStatus(tenantId, status);
  }

  findExpiredScheduleProposals?(
    tenantId: string,
    proposalTypes: readonly ProposalType[],
    since: Date,
    limit: number,
  ): Promise<Proposal[]> {
    return this.inner.findExpiredScheduleProposals!(
      tenantId,
      proposalTypes,
      since,
      limit,
    );
  }

  findByAiRun(tenantId: string, aiRunId: string): Promise<Proposal[]> {
    return this.inner.findByAiRun(tenantId, aiRunId);
  }

  findByRecordingId(
    tenantId: string,
    recordingId: string,
    idempotencyKey: string,
  ): Promise<Proposal | null> {
    return this.inner.findByRecordingId(tenantId, recordingId, idempotencyKey);
  }

  findByChain(tenantId: string, chainId: string): Promise<Proposal[]> {
    return this.inner.findByChain(tenantId, chainId);
  }

  findByConversation?(tenantId: string, conversationId: string): Promise<Proposal[]> {
    if (!this.inner.findByConversation) return Promise.resolve([]);
    return this.inner.findByConversation(tenantId, conversationId);
  }

  updateStatus(
    tenantId: string,
    id: string,
    status: ProposalStatus,
    updates?: Parameters<ProposalRepository['updateStatus']>[3],
  ): Promise<Proposal | null> {
    return this.inner.updateStatus(tenantId, id, status, updates);
  }

  update(
    tenantId: string,
    id: string,
    updates: Parameters<ProposalRepository['update']>[2],
  ): Promise<Proposal | null> {
    return this.inner.update(tenantId, id, updates);
  }

  findReadyForExecution(windowMs: number): Promise<Proposal[]> {
    return this.inner.findReadyForExecution(windowMs);
  }

  claimForExecution(proposalId: string, workerId: string): Promise<Proposal | null> {
    return this.inner.claimForExecution(proposalId, workerId);
  }

  resetStaleExecuting(
    staleMinutes: number,
    maxRetries: number,
  ): Promise<{ resetToApproved: number; movedToFailed: number }> {
    return this.inner.resetStaleExecuting(staleMinutes, maxRetries);
  }
}
