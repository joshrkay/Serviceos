import { Proposal, ProposalRepository } from '../proposals/proposal';
import { AiRun, AiRunRepository } from './ai-run';

export function linkProposalToAiRun(
  proposal: Proposal,
  aiRunId: string,
  promptVersionId?: string,
): Proposal {
  return {
    ...proposal,
    aiRunId,
    promptVersionId,
    updatedAt: new Date(),
  };
}

export async function getProposalsByAiRun(
  proposalRepo: ProposalRepository,
  tenantId: string,
  aiRunId: string,
): Promise<Proposal[]> {
  return proposalRepo.findByAiRun(tenantId, aiRunId);
}

export async function getAiRunForProposal(
  aiRunRepo: AiRunRepository,
  tenantId: string,
  proposal: Proposal,
): Promise<AiRun | null> {
  if (!proposal.aiRunId) {
    return null;
  }
  return aiRunRepo.findById(tenantId, proposal.aiRunId);
}
