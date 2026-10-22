import type { Proposal, ProposalRepository } from '../../src/proposals/proposal';

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
