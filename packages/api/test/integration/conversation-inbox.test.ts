import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { getSharedTestDb, createTestTenant, closeSharedTestDb } from './shared';
import { PgConversationRepository } from '../../src/conversations/pg-conversation';
import { PgCustomerRepository } from '../../src/customers/pg-customer';
import type { Customer } from '../../src/customers/customer';

function baseCustomer(
  tenantId: string,
  userId: string,
  overrides: Partial<Customer> = {},
): Customer {
  const now = new Date();
  return {
    id: crypto.randomUUID(),
    tenantId,
    firstName: 'Sam',
    lastName: 'Smith',
    displayName: 'Sam Smith',
    preferredChannel: 'sms',
    smsConsent: true,
    isArchived: false,
    createdBy: userId,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  } as Customer;
}

describe('Postgres integration — U5 inbox thread listing', () => {
  let pool: Pool;
  let conversationRepo: PgConversationRepository;
  let customerRepo: PgCustomerRepository;
  let tenant: { tenantId: string; userId: string };

  beforeAll(async () => {
    pool = await getSharedTestDb();
    conversationRepo = new PgConversationRepository(pool);
    customerRepo = new PgCustomerRepository(pool);
    tenant = await createTestTenant(pool);
  });

  afterAll(async () => {
    await closeSharedTestDb();
  });

  it('lists customer + unmatched comms threads with the customer name joined, newest-inbound first', async () => {
    const customer = await customerRepo.create(
      baseCustomer(tenant.tenantId, tenant.userId, {
        displayName: 'Dana Diaz',
        primaryPhone: '+15555552001',
      }),
    );

    // Customer thread — last message inbound (needs reply).
    const custThread = await conversationRepo.createConversation({
      tenantId: tenant.tenantId,
      title: 'Dana Diaz',
      entityType: 'customer',
      entityId: customer.id,
      createdBy: tenant.userId,
    });
    await conversationRepo.addMessage({
      tenantId: tenant.tenantId,
      conversationId: custThread.id,
      messageType: 'text',
      content: 'thanks!',
      senderId: tenant.userId,
      senderRole: 'owner',
      source: 'sms',
      metadata: { direction: 'outbound', channel: 'sms' },
    });
    await conversationRepo.addMessage({
      tenantId: tenant.tenantId,
      conversationId: custThread.id,
      messageType: 'text',
      content: 'one more question',
      senderId: '+15555552001',
      senderRole: 'customer',
      source: 'sms',
      metadata: { direction: 'inbound', channel: 'sms' },
    });

    // Unmatched phone thread — last message inbound.
    const unmatched = await conversationRepo.createConversation({
      tenantId: tenant.tenantId,
      title: 'SMS from +15555559001',
      entityType: 'sms_unmatched',
      entityId: '+15555559001',
      createdBy: 'system:sms-capture',
    });
    await conversationRepo.addMessage({
      tenantId: tenant.tenantId,
      conversationId: unmatched.id,
      messageType: 'text',
      content: 'hello?',
      senderId: '+15555559001',
      senderRole: 'customer',
      source: 'sms',
      metadata: { direction: 'inbound', channel: 'sms' },
    });

    // A non-comms (job) conversation — must be excluded.
    const jobThread = await conversationRepo.createConversation({
      tenantId: tenant.tenantId,
      title: 'job thread',
      entityType: 'job',
      entityId: crypto.randomUUID(),
      createdBy: tenant.userId,
    });
    await conversationRepo.addMessage({
      tenantId: tenant.tenantId,
      conversationId: jobThread.id,
      messageType: 'text',
      content: 'internal note',
      senderId: tenant.userId,
      senderRole: 'owner',
    });

    const threads = await conversationRepo.listInboxThreads(tenant.tenantId);
    const ids = threads.map((t) => t.conversation.id);

    expect(ids).toContain(custThread.id);
    expect(ids).toContain(unmatched.id);
    expect(ids).not.toContain(jobThread.id);

    const cust = threads.find((t) => t.conversation.id === custThread.id)!;
    expect(cust.customerName).toBe('Dana Diaz');
    expect(cust.needsReply).toBe(true);
    expect(cust.lastMessagePreview).toBe('one more question');
    expect(cust.messageCount).toBe(2);

    const un = threads.find((t) => t.conversation.id === unmatched.id)!;
    expect(un.customerName).toBeUndefined();
    expect(un.needsReply).toBe(true);
  });

  it('does not surface another tenant’s threads', async () => {
    const other = await createTestTenant(pool);
    const otherThreads = await conversationRepo.listInboxThreads(other.tenantId);
    expect(otherThreads.every((t) => t.conversation.tenantId === other.tenantId)).toBe(true);
  });
});
