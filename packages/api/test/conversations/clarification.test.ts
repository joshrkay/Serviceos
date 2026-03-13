import { InMemoryConversationRepository } from '../../src/conversations/conversation-service';
import {
  InMemoryClarificationStore,
  requestClarification,
  handleClarificationResponse,
} from '../../src/conversations/clarification';

describe('P2-014 — Clarification request workflow', () => {
  let conversationRepo: InMemoryConversationRepository;
  let store: InMemoryClarificationStore;

  beforeEach(() => {
    conversationRepo = new InMemoryConversationRepository();
    store = new InMemoryClarificationStore();
  });

  it('happy path — sends clarification request in conversation', async () => {
    const conv = await conversationRepo.createConversation({
      tenantId: 'tenant-1',
      createdBy: 'user-1',
    });

    const questions = ['What is the customer name?', 'What is the address?'];
    const context = { taskType: 'create_customer' };

    const request = await requestClarification(
      conversationRepo,
      store,
      'tenant-1',
      conv.id,
      questions,
      context,
      'user-1'
    );

    expect(request.id).toBeTruthy();
    expect(request.conversationId).toBe(conv.id);
    expect(request.questions).toEqual(questions);
    expect(request.status).toBe('pending');
    expect(request.messageId).toBeTruthy();

    const messages = await conversationRepo.getMessages('tenant-1', conv.id);
    expect(messages).toHaveLength(1);
    expect(messages[0].messageType).toBe('system_event');
    expect(messages[0].metadata).toEqual({
      type: 'clarification_request',
      questions,
    });
  });

  it('happy path — response returns enriched context', async () => {
    const conv = await conversationRepo.createConversation({
      tenantId: 'tenant-1',
      createdBy: 'user-1',
    });

    const originalContext = { taskType: 'create_customer', customerId: 'cust-1' };
    const request = await requestClarification(
      conversationRepo,
      store,
      'tenant-1',
      conv.id,
      ['What is the address?'],
      originalContext,
      'user-1'
    );

    const { originalContext: returnedOriginal, enrichedContext } =
      await handleClarificationResponse(store, request.id, '123 Main St');

    expect(returnedOriginal).toEqual(originalContext);
    expect(enrichedContext.taskType).toBe('create_customer');
    expect(enrichedContext.customerId).toBe('cust-1');
    expect(enrichedContext.clarificationResponse).toBe('123 Main St');
    expect(enrichedContext.clarificationId).toBe(request.id);
    expect(enrichedContext.clarificationQuestions).toEqual(['What is the address?']);

    const updated = await store.findById(request.id);
    expect(updated!.status).toBe('responded');
  });

  it('validation — handles missing clarification request', async () => {
    await expect(
      handleClarificationResponse(store, 'nonexistent-id', 'some response')
    ).rejects.toThrow('Clarification request not found: nonexistent-id');
  });

  it('happy path — multiple clarifications tracked per conversation', async () => {
    const conv = await conversationRepo.createConversation({
      tenantId: 'tenant-1',
      createdBy: 'user-1',
    });

    const request1 = await requestClarification(
      conversationRepo,
      store,
      'tenant-1',
      conv.id,
      ['Question 1?'],
      { step: 1 },
      'user-1'
    );

    const request2 = await requestClarification(
      conversationRepo,
      store,
      'tenant-1',
      conv.id,
      ['Question 2?'],
      { step: 2 },
      'user-1'
    );

    const all = await store.findByConversation(conv.id);
    expect(all).toHaveLength(2);
    expect(all.map((r) => r.id).sort()).toEqual([request1.id, request2.id].sort());

    const messages = await conversationRepo.getMessages('tenant-1', conv.id);
    expect(messages).toHaveLength(2);
  });
});
