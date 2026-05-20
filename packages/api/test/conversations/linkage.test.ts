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

describe('P0-037 — voice and SMS conversation linkage', () => {
  let repo: InMemoryConversationLinkRepository;

  beforeEach(() => {
    repo = new InMemoryConversationLinkRepository();
  });

  it('round-trips a voice_session link — create, list-by-conversation, list-by-entity', async () => {
    const link = await linkConversation(
      {
        tenantId: 'tenant-1',
        conversationId: 'conv-voice',
        entityType: 'voice_session',
        entityId: 'vs-1',
      },
      repo
    );

    expect(link.id).toBeTruthy();
    expect(link.entityType).toBe('voice_session');
    expect(link.entityId).toBe('vs-1');

    const byConversation = await getConversationLinks('tenant-1', 'conv-voice', repo);
    expect(byConversation).toHaveLength(1);
    expect(byConversation[0].entityType).toBe('voice_session');

    const byEntity = await getConversationsForEntity('tenant-1', 'voice_session', 'vs-1', repo);
    expect(byEntity).toHaveLength(1);
    expect(byEntity[0].conversationId).toBe('conv-voice');
  });

  it('round-trips an sms_conversation link — create, list-by-conversation, list-by-entity', async () => {
    const link = await linkConversation(
      {
        tenantId: 'tenant-1',
        conversationId: 'conv-sms',
        entityType: 'sms_conversation',
        entityId: 'sms-1',
      },
      repo
    );

    expect(link.entityType).toBe('sms_conversation');

    const byConversation = await getConversationLinks('tenant-1', 'conv-sms', repo);
    expect(byConversation).toHaveLength(1);
    expect(byConversation[0].entityType).toBe('sms_conversation');

    const byEntity = await getConversationsForEntity('tenant-1', 'sms_conversation', 'sms-1', repo);
    expect(byEntity).toHaveLength(1);
    expect(byEntity[0].conversationId).toBe('conv-sms');
  });

  it('threads a recovery SMS to its originating voice session (P8-015 scenario)', async () => {
    // Both the originating voice intake and the recovery SMS reply link to the
    // same conversation, so list-by-conversation surfaces the full thread.
    await linkConversation(
      {
        tenantId: 'tenant-1',
        conversationId: 'conv-recovery',
        entityType: 'voice_session',
        entityId: 'vs-intake',
      },
      repo
    );
    await linkConversation(
      {
        tenantId: 'tenant-1',
        conversationId: 'conv-recovery',
        entityType: 'sms_conversation',
        entityId: 'sms-reply',
      },
      repo
    );

    const links = await getConversationLinks('tenant-1', 'conv-recovery', repo);
    expect(links).toHaveLength(2);
    expect(links.map((l) => l.entityType).sort()).toEqual(['sms_conversation', 'voice_session']);
  });

  it('existing entity-type round-trips remain green', async () => {
    const types: Array<'customer' | 'job' | 'estimate' | 'invoice'> = [
      'customer',
      'job',
      'estimate',
      'invoice',
    ];

    for (const entityType of types) {
      const link = await linkConversation(
        {
          tenantId: 'tenant-1',
          conversationId: `conv-${entityType}`,
          entityType,
          entityId: `${entityType}-1`,
        },
        repo
      );
      expect(link.entityType).toBe(entityType);

      const byEntity = await getConversationsForEntity('tenant-1', entityType, `${entityType}-1`, repo);
      expect(byEntity).toHaveLength(1);
    }
  });

  it('validator accepts the new entity types', () => {
    expect(
      validateLinkInput({
        tenantId: 'tenant-1',
        conversationId: 'conv-1',
        entityType: 'voice_session',
        entityId: 'vs-1',
      })
    ).toEqual([]);
    expect(
      validateLinkInput({
        tenantId: 'tenant-1',
        conversationId: 'conv-1',
        entityType: 'sms_conversation',
        entityId: 'sms-1',
      })
    ).toEqual([]);
  });

  it('validator rejects an unknown entity type', () => {
    const errors = validateLinkInput({
      tenantId: 'tenant-1',
      conversationId: 'conv-1',
      entityType: 'foo' as any,
      entityId: 'f-1',
    });
    expect(errors).toContain('Invalid entityType');
  });
});
