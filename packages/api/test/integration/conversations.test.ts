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
});