import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { getSharedTestDb, createTestTenant, closeSharedTestDb } from './shared';
import { PgConversationRepository } from '../../src/conversations/pg-conversation';
import { PgCustomerRepository } from '../../src/customers/pg-customer';
import { PgDispatchRepository } from '../../src/notifications/dispatch-repository';
import { PgDncRepository, normalizePhone } from '../../src/compliance/dnc';
import { InMemoryDeliveryProvider } from '../../src/notifications/delivery-provider';
import {
  sendConversationReply,
  ConversationReplyError,
  type ConversationReplyDeps,
} from '../../src/conversations/reply-service';
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

describe('Postgres integration — U6 conversation reply send', () => {
  let pool: Pool;
  let conversationRepo: PgConversationRepository;
  let customerRepo: PgCustomerRepository;
  let dispatchRepo: PgDispatchRepository;
  let dncRepo: PgDncRepository;
  let delivery: InMemoryDeliveryProvider;
  let tenant: { tenantId: string; userId: string };

  function deps(): ConversationReplyDeps {
    return { conversationRepo, customerRepo, dispatchRepo, dncRepo, delivery };
  }

  beforeAll(async () => {
    pool = await getSharedTestDb();
    conversationRepo = new PgConversationRepository(pool);
    customerRepo = new PgCustomerRepository(pool);
    dispatchRepo = new PgDispatchRepository(pool);
    dncRepo = new PgDncRepository(pool);
    delivery = new InMemoryDeliveryProvider();
    tenant = await createTestTenant(pool);
  });

  afterAll(async () => {
    await closeSharedTestDb();
  });

  it('persists a sent dispatch row and an outbound message under the right tenant', async () => {
    const customer = await customerRepo.create(
      baseCustomer(tenant.tenantId, tenant.userId, { primaryPhone: '+15555551001' }),
    );
    const conv = await conversationRepo.createConversation({
      tenantId: tenant.tenantId,
      title: 'Sam Smith',
      entityType: 'customer',
      entityId: customer.id,
      createdBy: tenant.userId,
    });

    const result = await sendConversationReply(deps(), {
      tenantId: tenant.tenantId,
      conversationId: conv.id,
      body: 'On our way!',
      actorId: tenant.userId,
      actorRole: 'owner',
    });
    expect(result.channel).toBe('sms');

    const dispatches = await dispatchRepo.findByEntity(
      tenant.tenantId,
      'conversation_reply',
      conv.id,
    );
    expect(dispatches).toHaveLength(1);
    expect(dispatches[0].status).toBe('sent');
    expect(dispatches[0].channel).toBe('sms');
    expect(dispatches[0].recipient).toBe('+15555551001');

    const messages = await conversationRepo.getMessages(tenant.tenantId, conv.id);
    expect(messages).toHaveLength(1);
    expect(messages[0].content).toBe('On our way!');
    expect(messages[0].metadata).toMatchObject({ direction: 'outbound', channel: 'sms' });

    // Tenant isolation — the dispatch row never bleeds to another tenant.
    const other = await createTestTenant(pool);
    const otherView = await dispatchRepo.findByEntity(
      other.tenantId,
      'conversation_reply',
      conv.id,
    );
    expect(otherView).toHaveLength(0);
  });

  it('blocks a reply to a DNC number and writes no dispatch row', async () => {
    const customer = await customerRepo.create(
      baseCustomer(tenant.tenantId, tenant.userId, { primaryPhone: '+15555551002' }),
    );
    await dncRepo.addToDnc(tenant.tenantId, normalizePhone('+15555551002'), 'test');
    const conv = await conversationRepo.createConversation({
      tenantId: tenant.tenantId,
      title: 'Opted out',
      entityType: 'customer',
      entityId: customer.id,
      createdBy: tenant.userId,
    });

    await expect(
      sendConversationReply(deps(), {
        tenantId: tenant.tenantId,
        conversationId: conv.id,
        body: 'hello',
        actorId: tenant.userId,
        actorRole: 'owner',
      }),
    ).rejects.toBeInstanceOf(ConversationReplyError);

    const dispatches = await dispatchRepo.findByEntity(
      tenant.tenantId,
      'conversation_reply',
      conv.id,
    );
    expect(dispatches).toHaveLength(0);
    expect(await conversationRepo.getMessages(tenant.tenantId, conv.id)).toHaveLength(0);
  });
});
