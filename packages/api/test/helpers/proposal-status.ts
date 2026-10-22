import type { InMemoryProposalRepository, Proposal, ProposalRepository, ProposalStatus } from '../../src/proposals/proposal';

type StatusUpdates = Parameters<ProposalRepository['updateStatus']>[3];

/**
 * Moves a fixture proposal to 'executed' along legal lifecycle edges
 * (→ approved → executed), the way a real approval and execution would. The
 * repository's status-write gate refuses a direct draft → executed jump.
 */
export async function markExecuted(
  repo: ProposalRepository,
  tenantId: string,
  id: string,
  updates?: StatusUpdates,
): Promise<Proposal | null> {
  const current = await repo.findById(tenantId, id);
  if (current && current.status !== 'approved' && current.status !== 'executed') {
    await repo.updateStatus(tenantId, id, 'approved');
  }
  return repo.updateStatus(tenantId, id, 'executed', updates);
}

/**
 * Persists an approval along legal edges (draft/ready_for_review → approved),
 * carrying the fixture's `approvedAt` so a test can backdate it past the undo
 * window. Replaces writing a whole `transitionProposal` result back through
 * `update`, which can no longer carry status.
 */
export async function markApproved(
  repo: ProposalRepository,
  tenantId: string,
  approved: Proposal,
): Promise<Proposal | null> {
  return repo.updateStatus(tenantId, approved.id, 'approved', {
    approvedAt: approved.approvedAt,
  });
}

/**
 * Seeds an in-memory fixture row straight into a status, the way a test INSERT
 * would, for states only a worker or sweeper reaches (execution_failed, undone)
 * that a fixture can't walk to through the repository's status-write gate.
 * Never use this for a move the code under test is meant to make.
 */
export function forceStatus(
  repo: InMemoryProposalRepository,
  tenantId: string,
  id: string,
  status: ProposalStatus,
  extra: Partial<Proposal> = {},
): Proposal {
  const rows = (repo as unknown as { proposals: Map<string, Proposal> }).proposals;
  const row = rows.get(id);
  if (!row || row.tenantId !== tenantId) throw new Error(`forceStatus: no proposal ${id}`);
  Object.assign(row, extra, { status, updatedAt: new Date() });
  return { ...row };
}
