import { Proposal, ProposalRepository, CreateProposalInput, createProposal } from './proposal';
import { validateProposalPayload } from './contracts';
import { ValidationError } from '../shared/errors';
import { linkProposalToAiRun } from '../ai/proposal-linkage';

export interface CreateProposalDraftInput extends Omit<CreateProposalInput, 'sourceContext'> {
  sourceContext?: Record<string, unknown>;
  conversationId?: string;
}

export async function createProposalDraft(
  proposalRepo: ProposalRepository,
  input: CreateProposalDraftInput,
): Promise<Proposal> {
  const validation = validateProposalPayload(input.proposalType, input.payload);
  if (!validation.valid) {
    throw new ValidationError(`Proposal payload validation failed: ${(validation.errors ?? []).join(', ')}`);
  }

  const draft = createProposal({
    ...input,
    sourceContext: {
      ...(input.sourceContext ?? {}),
      ...(input.conversationId ? { conversationId: input.conversationId } : {}),
    },
  });

  const linked = input.aiRunId
    ? linkProposalToAiRun(draft, input.aiRunId, input.promptVersionId)
    : draft;

  return proposalRepo.create(linked);
}
