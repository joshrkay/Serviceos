import { createAuditEvent, AuditRepository, AuditEvent } from '../audit/audit';
import { Proposal, ProposalRepository } from './proposal';

export const PROPOSAL_EVENT_TYPES = [
  'proposal.created',
  'proposal.submitted',
  'proposal.approved',
  'proposal.rejected',
  'proposal.expired',
  'proposal.executed',
  'proposal.execution_failed',
  'proposal.edited',
] as const;

export type ProposalEventType = (typeof PROPOSAL_EVENT_TYPES)[number];

export async function logProposalEvent(
  auditRepo: AuditRepository,
  proposal: Proposal,
  eventType: string,
  actor: { id: string; role: string }
): Promise<AuditEvent> {
  const event = createAuditEvent({
    tenantId: proposal.tenantId,
    actorId: actor.id,
    actorRole: actor.role,
    eventType,
    entityType: 'proposal',
    entityId: proposal.id,
    metadata: {
      proposalType: proposal.proposalType,
      status: proposal.status,
    },
  });
  return auditRepo.create(event);
}

export async function getProposalTimeline(
  auditRepo: AuditRepository,
  tenantId: string,
  proposalId: string
): Promise<AuditEvent[]> {
  const events = await auditRepo.findByEntity(tenantId, 'proposal', proposalId);
  return events.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
}

export async function getEntityProposals(
  proposalRepo: ProposalRepository,
  tenantId: string,
  entityType: string,
  entityId: string
): Promise<Proposal[]> {
  const all = await proposalRepo.findByTenant(tenantId);
  return all.filter(
    (p) => p.targetEntityType === entityType && p.targetEntityId === entityId
  );
}
