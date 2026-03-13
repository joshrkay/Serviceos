import {
  linkConversationToEstimate,
  validateEstimateLinkInput,
  InMemoryEstimateLinkRepository,
} from '../../src/estimates/estimate-linkage';
import {
  createConversationEvaluation,
  validateEvaluationInput,
} from '../../src/ai/evaluation/conversation-evaluation';

describe('P3-014 — Conversation-to-estimate linkage', () => {
  let repo: InMemoryEstimateLinkRepository;

  beforeEach(() => {
    repo = new InMemoryEstimateLinkRepository();
  });

  it('happy path — link created and retrievable by conversation', async () => {
    const link = linkConversationToEstimate({
      tenantId: 'tenant-1',
      conversationId: 'conv-1',
      messageId: 'msg-1',
      proposalRevisionId: 'rev-1',
      estimateId: 'est-1',
    });

    await repo.create(link);

    const byConv = await repo.findByConversation('tenant-1', 'conv-1');
    expect(byConv).toHaveLength(1);
    expect(byConv[0].estimateId).toBe('est-1');
    expect(byConv[0].messageId).toBe('msg-1');
    expect(byConv[0].proposalRevisionId).toBe('rev-1');
  });

  it('happy path — link retrievable by estimate', async () => {
    const link = linkConversationToEstimate({
      tenantId: 'tenant-1',
      conversationId: 'conv-1',
      estimateId: 'est-1',
    });

    await repo.create(link);

    const byEst = await repo.findByEstimate('tenant-1', 'est-1');
    expect(byEst).toHaveLength(1);
    expect(byEst[0].conversationId).toBe('conv-1');
  });

  it('happy path — multiple links per conversation', async () => {
    const link1 = linkConversationToEstimate({
      tenantId: 'tenant-1',
      conversationId: 'conv-1',
      estimateId: 'est-1',
    });
    const link2 = linkConversationToEstimate({
      tenantId: 'tenant-1',
      conversationId: 'conv-1',
      estimateId: 'est-2',
    });

    await repo.create(link1);
    await repo.create(link2);

    const byConv = await repo.findByConversation('tenant-1', 'conv-1');
    expect(byConv).toHaveLength(2);
  });

  it('happy path — tenant isolation enforced', async () => {
    const link = linkConversationToEstimate({
      tenantId: 'tenant-1',
      conversationId: 'conv-1',
      estimateId: 'est-1',
    });
    await repo.create(link);

    const result = await repo.findByConversation('tenant-other', 'conv-1');
    expect(result).toHaveLength(0);
  });

  it('happy path — conversation evaluation created', () => {
    const evaluation = createConversationEvaluation({
      tenantId: 'tenant-1',
      conversationId: 'conv-1',
      estimateId: 'est-1',
      proposalRevisionId: 'rev-1',
      aiRunId: 'run-1',
    });

    expect(evaluation.id).toBeTruthy();
    expect(evaluation.conversationId).toBe('conv-1');
    expect(evaluation.estimateId).toBe('est-1');
  });

  it('validation — missing required fields rejected', () => {
    const errors = validateEstimateLinkInput({});
    expect(errors).toContain('tenantId is required');
    expect(errors).toContain('conversationId is required');
    expect(errors).toContain('estimateId is required');
  });

  it('validation — evaluation input missing fields rejected', () => {
    const errors = validateEvaluationInput({});
    expect(errors).toContain('tenantId is required');
    expect(errors).toContain('conversationId is required');
    expect(errors).toContain('estimateId is required');
  });
});
