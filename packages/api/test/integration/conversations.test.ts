import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { getSharedTestDb, createTestTenant, closeSharedTestDb } from './shared';
import { PgConversationRepository } from '../../src/conversations/pg-conversation';

describe('Postgres integration — conversations', () => {
  let pool: Pool;
  let conversationRepo: PgConversationRepository;
  let tenant: { tenantId: string; userId: string };

  beforeAll(async () => {
    pool = await getSharedTestDb();
    conversationRepo = new PgConversationRepository(pool);
    tenant = await createTestTenant(pool);
  });

  afterAll(async () => {
    await closeSharedTestDb();
  });

  describe('CRUD', () => {
    it('creates conversation and retrieves via findById', async () => {
      const conversation = await conversationRepo.createConversation({
        tenantId: tenant.tenantId,
        title: 'Test conversation',
        entityType: 'customer',
        entityId: crypto.randomUUID(),
        createdBy: tenant.userId,
      });

      const found = await conversationRepo.findById(tenant.tenantId, conversation.id);
      expect(found).not.toBeNull();
      expect(found!.title).toBe('Test conversation');
      expect(found!.status).toBe('open');
    });

    it('finds conversations by entity', async () => {
      const entityId = crypto.randomUUID();
      await conversationRepo.createConversation({
        tenantId: tenant.tenantId,
        title: 'Another conversation',
        entityType: 'customer',
        entityId: entityId,
        createdBy: tenant.userId,
      });

      const conversations = await conversationRepo.findByEntity(tenant.tenantId, 'customer', entityId);
      expect(conversations.length).toBeGreaterThanOrEqual(1);
    });

    it('adds message to conversation', async () => {
      const conversation = await conversationRepo.createConversation({
        tenantId: tenant.tenantId,
        title: 'Conversation with messages',
        createdBy: tenant.userId,
      });

      const message = await conversationRepo.addMessage({
        tenantId: tenant.tenantId,
        conversationId: conversation.id,
        messageType: 'text',
        content: 'Hello world',
        senderId: tenant.userId,
        senderRole: 'owner',
      });

      expect(message).not.toBeNull();
      expect(message.content).toBe('Hello world');

      const messages = await conversationRepo.getMessages(tenant.tenantId, conversation.id);
      expect(messages.length).toBe(1);
    });
  });

  describe('tenant isolation', () => {
    it('rejects cross-tenant access', async () => {
      const otherTenant = await createTestTenant(pool);
      const conversation = await conversationRepo.createConversation({
        tenantId: tenant.tenantId,
        title: 'Secret conversation',
        createdBy: tenant.userId,
      });

      const found = await conversationRepo.findById(otherTenant.tenantId, conversation.id);
      expect(found).toBeNull();
    });
  });

  // Story 3.11 — pins the real searchMessages SQL (a mocked Pool is not proof
  // the join/ILIKE/columns exist) + FORCE RLS isolation on the search path.
  describe('searchMessages (Story 3.11)', () => {
    it('matches by text and by linked entity, scoped to the tenant', async () => {
      const customerId = crypto.randomUUID();
      const custConv = await conversationRepo.createConversation({
        tenantId: tenant.tenantId,
        createdBy: tenant.userId,
        entityType: 'customer',
        entityId: customerId,
      });
      await conversationRepo.addMessage({
        tenantId: tenant.tenantId,
        conversationId: custConv.id,
        messageType: 'text',
        content: 'Send the Rodriguez invoice today',
        senderId: tenant.userId,
        senderRole: 'user',
      });

      const byText = await conversationRepo.searchMessages(tenant.tenantId, { text: 'rodriguez' });
      expect(byText.length).toBeGreaterThanOrEqual(1);
      expect(byText[0].message.content).toContain('Rodriguez');
      expect(byText[0].conversation.entityId).toBe(customerId);

      const byCustomer = await conversationRepo.searchMessages(tenant.tenantId, {
        entityType: 'customer',
        entityId: customerId,
      });
      expect(byCustomer).toHaveLength(1);

      // Combined text + entity narrows correctly.
      const combinedMiss = await conversationRepo.searchMessages(tenant.tenantId, {
        text: 'nonexistent-phrase-xyz',
        entityType: 'customer',
        entityId: customerId,
      });
      expect(combinedMiss).toHaveLength(0);
    });

    it('FORCE RLS isolates search results across tenants', async () => {
      const otherTenant = await createTestTenant(pool);
      const conv = await conversationRepo.createConversation({
        tenantId: tenant.tenantId,
        createdBy: tenant.userId,
        entityType: 'customer',
        entityId: crypto.randomUUID(),
      });
      await conversationRepo.addMessage({
        tenantId: tenant.tenantId,
        conversationId: conv.id,
        messageType: 'text',
        content: 'tenant-private search needle',
        senderId: tenant.userId,
        senderRole: 'user',
      });
      const leaked = await conversationRepo.searchMessages(otherTenant.tenantId, {
        text: 'tenant-private search needle',
      });
      expect(leaked).toHaveLength(0);
    });
  });

  // U9 follow-up — pins the real columns of the transactional create path (a
  // mocked Pool is not proof) + tenant isolation on the created thread.
  describe('createConversationWithMessages (Story 3.11 U9)', () => {
    it('atomically creates a conversation and its messages with real columns', async () => {
      const { conversation, messages } = await conversationRepo.createConversationWithMessages!(
        { tenantId: tenant.tenantId, createdBy: tenant.userId, title: 'Invoice Acme' },
        [
          { tenantId: tenant.tenantId, messageType: 'text', content: 'invoice acme', senderId: tenant.userId, senderRole: 'user', source: 'assistant' },
          { tenantId: tenant.tenantId, messageType: 'text', content: 'drafted it', senderId: 'assistant', senderRole: 'assistant', source: 'assistant' },
        ],
      );
      expect(conversation.title).toBe('Invoice Acme');
      expect(messages).toHaveLength(2);

      // Round-trips through a fresh read (proves the rows committed together).
      const persisted = await conversationRepo.getMessages(tenant.tenantId, conversation.id);
      expect(persisted.map((m) => m.senderRole)).toEqual(['user', 'assistant']);
      expect(persisted.map((m) => m.content)).toEqual(['invoice acme', 'drafted it']);

      // Cross-tenant isolation: another tenant cannot read the created thread.
      const otherTenant = await createTestTenant(pool);
      expect(await conversationRepo.findById(otherTenant.tenantId, conversation.id)).toBeNull();
      expect(await conversationRepo.getMessages(otherTenant.tenantId, conversation.id)).toHaveLength(0);
    });
  });
});