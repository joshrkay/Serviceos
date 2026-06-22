import { describe, it, expect } from 'vitest';
import {
  InMemoryConversationRepository,
  recordAssistantTurn,
  type ConversationRepository,
} from '../../src/conversations/conversation-service';
import { InMemoryAuditRepository } from '../../src/audit/audit';

const TENANT = 'tenant-1';
const USER = 'user-1';

describe('Story 3.11 — recordAssistantTurn', () => {
  it('opens a new conversation when none is supplied and persists both turns', async () => {
    const repo = new InMemoryConversationRepository();
    const conversationId = await recordAssistantTurn(repo, {
      tenantId: TENANT,
      userId: USER,
      userText: 'Invoice the Rodriguez job',
      assistantText: 'Here is a draft invoice.',
    });
    expect(conversationId).toBeTruthy();

    const conv = await repo.findById(TENANT, conversationId);
    expect(conv).not.toBeNull();
    expect(conv!.createdBy).toBe(USER);
    expect(conv!.title).toBe('Invoice the Rodriguez job');

    const messages = await repo.getMessages(TENANT, conversationId);
    expect(messages).toHaveLength(2);
    expect(messages.map((m) => m.senderRole)).toEqual(['user', 'assistant']);
    expect(messages[0].content).toBe('Invoice the Rodriguez job');
    expect(messages[1].content).toBe('Here is a draft invoice.');
  });

  it('reuses the supplied conversation across turns', async () => {
    const repo = new InMemoryConversationRepository();
    const first = await recordAssistantTurn(repo, {
      tenantId: TENANT,
      userId: USER,
      userText: 'Hi',
      assistantText: 'Hello!',
    });
    const second = await recordAssistantTurn(repo, {
      tenantId: TENANT,
      userId: USER,
      conversationId: first,
      userText: 'Schedule Thompson',
      assistantText: 'Drafted a booking.',
    });
    expect(second).toBe(first);
    expect(await repo.getMessages(TENANT, first)).toHaveLength(4);
  });

  it('opens a fresh conversation when the supplied id is unknown/cross-tenant', async () => {
    const repo = new InMemoryConversationRepository();
    const id = await recordAssistantTurn(repo, {
      tenantId: TENANT,
      userId: USER,
      conversationId: 'does-not-exist',
      userText: 'Hi',
      assistantText: 'Hello!',
    });
    expect(id).not.toBe('does-not-exist');
    expect(await repo.findById(TENANT, id)).not.toBeNull();
  });

  it('records the operator turn even when the agent reply is empty', async () => {
    const repo = new InMemoryConversationRepository();
    const id = await recordAssistantTurn(repo, {
      tenantId: TENANT,
      userId: USER,
      userText: "What's my schedule?",
    });
    const messages = await repo.getMessages(TENANT, id);
    expect(messages).toHaveLength(1);
    expect(messages[0].senderRole).toBe('user');
  });

  // U9 follow-up — atomic new-thread create + the conversation.created audit.
  it('creates a new thread via the atomic path and emits conversation.created audit', async () => {
    const repo = new InMemoryConversationRepository();
    const auditRepo = new InMemoryAuditRepository();
    const id = await recordAssistantTurn(
      repo,
      { tenantId: TENANT, userId: USER, userText: 'Invoice Acme', assistantText: 'Drafted it.' },
      auditRepo,
    );
    expect(await repo.getMessages(TENANT, id)).toHaveLength(2);
    const events = await auditRepo.findByEntity(TENANT, 'conversation', id);
    expect(events.some((e) => e.eventType === 'conversation.created')).toBe(true);
  });

  it('does not emit a second conversation.created when appending to an existing thread', async () => {
    const repo = new InMemoryConversationRepository();
    const auditRepo = new InMemoryAuditRepository();
    const id = await recordAssistantTurn(repo, { tenantId: TENANT, userId: USER, userText: 'Hi', assistantText: 'Hello' }, auditRepo);
    await recordAssistantTurn(repo, { tenantId: TENANT, userId: USER, conversationId: id, userText: 'More', assistantText: 'Sure' }, auditRepo);
    const created = (await auditRepo.findByEntity(TENANT, 'conversation', id)).filter(
      (e) => e.eventType === 'conversation.created',
    );
    expect(created).toHaveLength(1);
    expect(await repo.getMessages(TENANT, id)).toHaveLength(4);
  });

  it('falls back to sequential create + addMessage when the repo lacks the atomic method', async () => {
    const repo = new InMemoryConversationRepository();
    // Shadow the optional capability so the fallback branch is exercised.
    (repo as { createConversationWithMessages?: unknown }).createConversationWithMessages = undefined;
    const id = await recordAssistantTurn(repo as ConversationRepository, {
      tenantId: TENANT,
      userId: USER,
      userText: 'Schedule Lee',
      assistantText: 'Drafted a booking.',
    });
    const messages = await repo.getMessages(TENANT, id);
    expect(messages.map((m) => m.senderRole)).toEqual(['user', 'assistant']);
  });
});

describe('Story 3.11 — searchMessages', () => {
  async function seed() {
    const repo = new InMemoryConversationRepository();
    // Customer-linked thread.
    const custConv = await repo.createConversation({
      tenantId: TENANT,
      createdBy: USER,
      entityType: 'customer',
      entityId: 'cust-7',
    });
    await repo.addMessage({
      tenantId: TENANT,
      conversationId: custConv.id,
      messageType: 'text',
      content: 'Send the Rodriguez invoice please',
      senderId: USER,
      senderRole: 'user',
    });
    // Job-linked thread.
    const jobConv = await repo.createConversation({
      tenantId: TENANT,
      createdBy: USER,
      entityType: 'job',
      entityId: 'job-3',
    });
    await repo.addMessage({
      tenantId: TENANT,
      conversationId: jobConv.id,
      messageType: 'text',
      content: 'Crew running late on the roof job',
      senderId: USER,
      senderRole: 'user',
    });
    return { repo, custConv, jobConv };
  }

  it('finds messages by free text (case-insensitive)', async () => {
    const { repo } = await seed();
    const hits = await repo.searchMessages(TENANT, { text: 'rodriguez' });
    expect(hits).toHaveLength(1);
    expect(hits[0].message.content).toContain('Rodriguez');
    expect(hits[0].conversation.entityType).toBe('customer');
    expect(hits[0].conversation.entityId).toBe('cust-7');
  });

  it('filters by linked customer and by linked job', async () => {
    const { repo } = await seed();
    expect(await repo.searchMessages(TENANT, { entityType: 'customer', entityId: 'cust-7' })).toHaveLength(1);
    const jobHits = await repo.searchMessages(TENANT, { entityType: 'job', entityId: 'job-3' });
    expect(jobHits).toHaveLength(1);
    expect(jobHits[0].message.content).toContain('roof');
  });

  it('combines text + entity filters', async () => {
    const { repo } = await seed();
    expect(await repo.searchMessages(TENANT, { text: 'invoice', entityType: 'job', entityId: 'job-3' })).toHaveLength(0);
    expect(await repo.searchMessages(TENANT, { text: 'invoice', entityType: 'customer', entityId: 'cust-7' })).toHaveLength(1);
  });

  it('isolates results across tenants', async () => {
    const { repo } = await seed();
    expect(await repo.searchMessages('other-tenant', { text: 'rodriguez' })).toHaveLength(0);
  });

  it('honors the limit', async () => {
    const { repo, custConv } = await seed();
    for (let i = 0; i < 5; i++) {
      await repo.addMessage({
        tenantId: TENANT,
        conversationId: custConv.id,
        messageType: 'text',
        content: `note ${i}`,
        senderId: USER,
        senderRole: 'user',
      });
    }
    expect(await repo.searchMessages(TENANT, { text: 'note', limit: 3 })).toHaveLength(3);
  });
});
