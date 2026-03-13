import { InMemoryConversationRepository } from '../../src/conversations/conversation-service';
import {
  createProposalMessage,
  getAvailableActions,
  buildProposalCard,
} from '../../src/conversations/proposal-rendering';
import { createProposal, CreateProposalInput, Proposal } from '../../src/proposals/proposal';
import { transitionProposal } from '../../src/proposals/lifecycle';

describe('P2-022 — Inline proposal rendering in conversation', () => {
  let conversationRepo: InMemoryConversationRepository;

  const baseInput: CreateProposalInput = {
    tenantId: 'tenant-1',
    proposalType: 'create_customer',
    payload: { name: 'John Doe' },
    summary: 'Create customer John Doe',
    explanation: 'Based on voice call transcript',
    confidenceScore: 0.92,
    createdBy: 'user-1',
  };

  beforeEach(() => {
    conversationRepo = new InMemoryConversationRepository();
  });

  it('happy path — creates proposal message with correct metadata', async () => {
    const conv = await conversationRepo.createConversation({
      tenantId: 'tenant-1',
      createdBy: 'user-1',
    });

    const proposal = createProposal(baseInput);

    const { messageId } = await createProposalMessage(
      conversationRepo,
      'tenant-1',
      conv.id,
      proposal,
      'user-1'
    );

    expect(messageId).toBeTruthy();

    const messages = await conversationRepo.getMessages('tenant-1', conv.id);
    expect(messages).toHaveLength(1);

    const msg = messages[0];
    expect(msg.messageType).toBe('system_event');
    expect(msg.metadata).toBeDefined();
    expect(msg.metadata!.proposalId).toBe(proposal.id);
    expect(msg.metadata!.type).toBe('create_customer');
    expect(msg.metadata!.summary).toBe('Create customer John Doe');
    expect(msg.metadata!.confidence).toBe(0.92);
    expect(msg.metadata!.status).toBe('draft');
    expect(msg.metadata!.actions).toEqual(['submit']);
    expect(msg.metadata!.explanation).toBe('Based on voice call transcript');
  });

  it('happy path — available actions match proposal status', () => {
    expect(getAvailableActions('draft')).toEqual(['submit']);
    expect(getAvailableActions('ready_for_review')).toEqual(['approve', 'reject', 'edit']);
    expect(getAvailableActions('approved')).toEqual(['execute']);
    expect(getAvailableActions('rejected')).toEqual(['redraft']);
    expect(getAvailableActions('execution_failed')).toEqual(['redraft']);
    expect(getAvailableActions('executed')).toEqual([]);
    expect(getAvailableActions('expired')).toEqual([]);
  });

  it('validation — draft proposal has submit action', () => {
    const proposal = createProposal(baseInput);
    expect(proposal.status).toBe('draft');

    const card = buildProposalCard(proposal);
    expect(card.actions).toEqual(['submit']);
  });

  it('validation — ready_for_review has approve/reject/edit actions', () => {
    let proposal = createProposal(baseInput);
    proposal = transitionProposal(proposal, 'ready_for_review', 'user-1');

    const card = buildProposalCard(proposal);
    expect(card.actions).toEqual(['approve', 'reject', 'edit']);
  });

  it('validation — executed proposal has no actions', () => {
    let proposal = createProposal(baseInput);
    proposal = transitionProposal(proposal, 'ready_for_review', 'user-1');
    proposal = transitionProposal(proposal, 'approved', 'user-1');
    proposal = transitionProposal(proposal, 'executed', 'user-1');

    const card = buildProposalCard(proposal);
    expect(card.actions).toEqual([]);
    expect(card.status).toBe('executed');
  });
});
