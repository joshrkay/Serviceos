import { describe, it, expect, beforeEach } from 'vitest';
import {
  InMemoryConversationRepository,
  messageDirection,
  type Message,
} from '../../src/conversations/conversation-service';

const TENANT = 'tenant-1';

async function thread(
  repo: InMemoryConversationRepository,
  entityType: string,
  entityId: string,
) {
  return repo.createConversation({
    tenantId: TENANT,
    title: `${entityType}:${entityId}`,
    entityType,
    entityId,
    createdBy: 'system',
  });
}

describe('U5 — messageDirection helper', () => {
  function msg(over: Partial<Message>): Message {
    return {
      id: 'm',
      tenantId: TENANT,
      conversationId: 'c',
      messageType: 'text',
      senderId: 's',
      senderRole: 'owner',
      createdAt: new Date(),
      ...over,
    };
  }

  it('honours explicit metadata.direction', () => {
    expect(messageDirection(msg({ metadata: { direction: 'inbound' } }))).toBe('inbound');
    expect(messageDirection(msg({ metadata: { direction: 'outbound' } }))).toBe('outbound');
  });

  it('infers inbound from a customer sender role', () => {
    expect(messageDirection(msg({ senderRole: 'customer' }))).toBe('inbound');
    expect(messageDirection(msg({ senderRole: 'owner' }))).toBe('outbound');
  });
});

describe('U5 — listInboxThreads', () => {
  let repo: InMemoryConversationRepository;

  beforeEach(() => {
    repo = new InMemoryConversationRepository();
  });

  it('summarises comms threads, excludes non-comms and empty threads, surfaces needs-reply first', async () => {
    // Customer A — last message inbound (needs reply).
    const a = await thread(repo, 'customer', 'cust-a');
    await repo.addMessage({
      tenantId: TENANT,
      conversationId: a.id,
      messageType: 'text',
      content: 'hello owner',
      senderId: 'owner',
      senderRole: 'owner',
      metadata: { direction: 'outbound' },
    });
    await repo.addMessage({
      tenantId: TENANT,
      conversationId: a.id,
      messageType: 'text',
      content: 'are you coming?',
      senderId: '+15555550000',
      senderRole: 'customer',
      metadata: { direction: 'inbound' },
    });

    // Customer B — last message outbound (no reply needed).
    const b = await thread(repo, 'customer', 'cust-b');
    await repo.addMessage({
      tenantId: TENANT,
      conversationId: b.id,
      messageType: 'text',
      content: 'on our way',
      senderId: 'owner',
      senderRole: 'owner',
      metadata: { direction: 'outbound' },
    });

    // Unmatched phone thread — counts as comms.
    const u = await thread(repo, 'sms_unmatched', '+15555559999');
    await repo.addMessage({
      tenantId: TENANT,
      conversationId: u.id,
      messageType: 'text',
      content: 'who is this',
      senderId: '+15555559999',
      senderRole: 'customer',
    });

    // A job conversation — NOT comms, excluded.
    const j = await thread(repo, 'job', 'job-1');
    await repo.addMessage({
      tenantId: TENANT,
      conversationId: j.id,
      messageType: 'text',
      content: 'internal',
      senderId: 'owner',
      senderRole: 'owner',
    });

    // An empty customer thread — excluded (no messages).
    await thread(repo, 'customer', 'cust-empty');

    const threads = await repo.listInboxThreads(TENANT);

    const ids = threads.map((t) => t.conversation.id);
    expect(ids).not.toContain(j.id);
    expect(ids).toContain(a.id);
    expect(ids).toContain(b.id);
    expect(ids).toContain(u.id);
    expect(threads).toHaveLength(3);

    // Needs-reply threads (A inbound, U inbound) come before B (outbound).
    expect(threads[threads.length - 1].conversation.id).toBe(b.id);

    const aSummary = threads.find((t) => t.conversation.id === a.id)!;
    expect(aSummary.needsReply).toBe(true);
    expect(aSummary.lastMessagePreview).toBe('are you coming?');
    expect(aSummary.lastMessageDirection).toBe('inbound');
    expect(aSummary.messageCount).toBe(2);

    const bSummary = threads.find((t) => t.conversation.id === b.id)!;
    expect(bSummary.needsReply).toBe(false);
  });

  it('includes lead-linked threads (unknown-caller captures)', async () => {
    const l = await thread(repo, 'lead', 'lead-1');
    await repo.addMessage({
      tenantId: TENANT,
      conversationId: l.id,
      messageType: 'text',
      content: 'do you do drywall?',
      senderId: '+15555551234',
      senderRole: 'customer',
    });

    const threads = await repo.listInboxThreads(TENANT);
    expect(threads.map((t) => t.conversation.id)).toContain(l.id);
    const summary = threads.find((t) => t.conversation.id === l.id)!;
    expect(summary.needsReply).toBe(true);
    expect(summary.lastMessagePreview).toBe('do you do drywall?');
  });

  it('filters to needs-reply only', async () => {
    const a = await thread(repo, 'customer', 'cust-a');
    await repo.addMessage({
      tenantId: TENANT,
      conversationId: a.id,
      messageType: 'text',
      content: 'inbound',
      senderId: '+1',
      senderRole: 'customer',
    });
    const b = await thread(repo, 'customer', 'cust-b');
    await repo.addMessage({
      tenantId: TENANT,
      conversationId: b.id,
      messageType: 'text',
      content: 'outbound',
      senderId: 'owner',
      senderRole: 'owner',
    });

    const threads = await repo.listInboxThreads(TENANT, { needsReplyOnly: true });
    expect(threads.map((t) => t.conversation.id)).toEqual([a.id]);
  });

  it('filters by status', async () => {
    const a = await thread(repo, 'customer', 'cust-a');
    await repo.addMessage({
      tenantId: TENANT,
      conversationId: a.id,
      messageType: 'text',
      content: 'hi',
      senderId: '+1',
      senderRole: 'customer',
    });
    expect(await repo.listInboxThreads(TENANT, { status: 'open' })).toHaveLength(1);
    expect(await repo.listInboxThreads(TENANT, { status: 'closed' })).toHaveLength(0);
  });

  it('isolates by tenant', async () => {
    const a = await thread(repo, 'customer', 'cust-a');
    await repo.addMessage({
      tenantId: TENANT,
      conversationId: a.id,
      messageType: 'text',
      content: 'hi',
      senderId: '+1',
      senderRole: 'customer',
    });
    expect(await repo.listInboxThreads('other-tenant')).toHaveLength(0);
  });
});
