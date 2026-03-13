import {
  InMemoryConversationRepository,
  validateCreateConversation,
  validateCreateMessage,
} from '../../src/conversations/conversation-service';

describe('P0-011 — Conversation and message persistence', () => {
  let repo: InMemoryConversationRepository;

  beforeEach(() => {
    repo = new InMemoryConversationRepository();
  });

  it('happy path — creates conversation and retrieves it', async () => {
    const conv = await repo.createConversation({
      tenantId: 'tenant-1',
      title: 'Job #123 Discussion',
      entityType: 'job',
      entityId: 'job-123',
      createdBy: 'user-1',
    });

    expect(conv.id).toBeTruthy();
    expect(conv.status).toBe('open');

    const found = await repo.findById('tenant-1', conv.id);
    expect(found).not.toBeNull();
    expect(found!.title).toBe('Job #123 Discussion');
  });

  it('happy path — adds messages to conversation', async () => {
    const conv = await repo.createConversation({
      tenantId: 'tenant-1',
      createdBy: 'user-1',
    });

    await repo.addMessage({
      tenantId: 'tenant-1',
      conversationId: conv.id,
      messageType: 'text',
      content: 'Hello!',
      senderId: 'user-1',
      senderRole: 'owner',
    });

    await repo.addMessage({
      tenantId: 'tenant-1',
      conversationId: conv.id,
      messageType: 'note',
      content: 'Internal note',
      senderId: 'user-2',
      senderRole: 'dispatcher',
    });

    const messages = await repo.getMessages('tenant-1', conv.id);
    expect(messages).toHaveLength(2);
    expect(messages[0].messageType).toBe('text');
    expect(messages[1].messageType).toBe('note');
  });

  it('happy path — supports all message types', async () => {
    const conv = await repo.createConversation({
      tenantId: 'tenant-1',
      createdBy: 'user-1',
    });

    for (const type of ['text', 'transcript', 'system_event', 'note'] as const) {
      const msg = await repo.addMessage({
        tenantId: 'tenant-1',
        conversationId: conv.id,
        messageType: type,
        content: `Content for ${type}`,
        senderId: 'user-1',
        senderRole: 'owner',
      });
      expect(msg.messageType).toBe(type);
    }
  });

  it('validation — rejects missing tenantId', () => {
    const errors = validateCreateConversation({ tenantId: '', createdBy: 'user-1' });
    expect(errors).toContain('tenantId is required');
  });

  it('validation — rejects missing createdBy', () => {
    const errors = validateCreateConversation({ tenantId: 'tenant-1', createdBy: '' });
    expect(errors).toContain('createdBy is required');
  });

  it('validation — rejects text message without content', () => {
    const errors = validateCreateMessage({
      tenantId: 'tenant-1',
      conversationId: 'conv-1',
      messageType: 'text',
      senderId: 'user-1',
      senderRole: 'owner',
    });
    expect(errors).toContain('content is required for text messages');
  });

  it('validation — rejects invalid message type', () => {
    const errors = validateCreateMessage({
      tenantId: 'tenant-1',
      conversationId: 'conv-1',
      messageType: 'invalid' as any,
      senderId: 'user-1',
      senderRole: 'owner',
    });
    expect(errors).toContain('Invalid messageType');
  });
});
