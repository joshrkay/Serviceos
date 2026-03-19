import {
  linkConversation,
  getConversationLinks,
  getConversationsForEntity,
  validateLinkInput,
  InMemoryConversationLinkRepository,
} from '../../src/conversations/linkage';

describe('P1-014 — Conversation linkage to customers and jobs', () => {
  let repo: InMemoryConversationLinkRepository;

  beforeEach(() => {
    repo = new InMemoryConversationLinkRepository();
  });

  it('happy path — links conversation to customer', async () => {
    const link = await linkConversation(
      { tenantId: 'tenant-1', conversationId: 'conv-1', entityType: 'customer', entityId: 'cust-1' },
      repo
    );

    expect(link.id).toBeTruthy();
    expect(link.entityType).toBe('customer');
    expect(link.entityId).toBe('cust-1');
  });

  it('happy path — links conversation to job', async () => {
    const link = await linkConversation(
      { tenantId: 'tenant-1', conversationId: 'conv-1', entityType: 'job', entityId: 'job-1' },
      repo
    );

    expect(link.entityType).toBe('job');
  });

  it('happy path — multiple links per conversation', async () => {
    await linkConversation(
      { tenantId: 'tenant-1', conversationId: 'conv-1', entityType: 'customer', entityId: 'cust-1' },
      repo
    );
    await linkConversation(
      { tenantId: 'tenant-1', conversationId: 'conv-1', entityType: 'job', entityId: 'job-1' },
      repo
    );

    const links = await getConversationLinks('tenant-1', 'conv-1', repo);
    expect(links).toHaveLength(2);
  });

  it('happy path — retrieves conversations for entity', async () => {
    await linkConversation(
      { tenantId: 'tenant-1', conversationId: 'conv-1', entityType: 'customer', entityId: 'cust-1' },
      repo
    );
    await linkConversation(
      { tenantId: 'tenant-1', conversationId: 'conv-2', entityType: 'customer', entityId: 'cust-1' },
      repo
    );

    const links = await getConversationsForEntity('tenant-1', 'customer', 'cust-1', repo);
    expect(links).toHaveLength(2);
  });

  it('validation — rejects missing required fields', () => {
    const errors = validateLinkInput({
      tenantId: '',
      conversationId: '',
      entityType: '' as any,
      entityId: '',
    });
    expect(errors).toContain('tenantId is required');
    expect(errors).toContain('conversationId is required');
    expect(errors).toContain('entityType is required');
    expect(errors).toContain('entityId is required');
  });

  it('validation — rejects invalid entityType', () => {
    const errors = validateLinkInput({
      tenantId: 'tenant-1',
      conversationId: 'conv-1',
      entityType: 'widget' as any,
      entityId: 'w-1',
    });
    expect(errors).toContain('Invalid entityType');
  });

  it('validation — linkConversation surfaces validator errors', async () => {
    await expect(
      linkConversation(
        { tenantId: 'tenant-1', conversationId: 'conv-1', entityType: 'widget' as any, entityId: 'w-1' },
        repo
      )
    ).rejects.toThrow('Validation failed: Invalid entityType');
  });
});
