import { ConversationRepository, CreateMessageInput } from './conversation-service';
import { Proposal, ProposalStatus } from '../proposals/proposal';

export function getAvailableActions(status: ProposalStatus): string[] {
  switch (status) {
    case 'draft':
      return ['submit'];
    case 'ready_for_review':
      return ['approve', 'reject', 'edit'];
    case 'approved':
      return ['execute'];
    case 'rejected':
      return ['redraft'];
    case 'execution_failed':
      return ['redraft'];
    case 'executed':
      return [];
    case 'expired':
      return [];
    default:
      return [];
  }
}

export function buildProposalCard(proposal: Proposal): Record<string, unknown> {
  return {
    proposalId: proposal.id,
    type: proposal.proposalType,
    summary: proposal.summary,
    confidence: proposal.confidenceScore,
    status: proposal.status,
    actions: getAvailableActions(proposal.status),
    explanation: proposal.explanation,
  };
}

export async function createProposalMessage(
  conversationRepo: ConversationRepository,
  tenantId: string,
  conversationId: string,
  proposal: Proposal,
  userId: string
): Promise<{ messageId: string }> {
  const metadata = buildProposalCard(proposal);

  const message = await conversationRepo.addMessage({
    tenantId,
    conversationId,
    messageType: 'system_event',
    content: proposal.summary,
    senderId: userId,
    senderRole: 'system',
    metadata,
  });

  return { messageId: message.id };
}
