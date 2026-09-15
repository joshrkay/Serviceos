/**
 * Postgres integration — U6 conversation reply send (PRD row 9.12).
 *
 * Audit leg: the router (`routes/conversations.ts`) hands
 * `sendConversationReply` the request's `auditRepo`, so a SENT reply already
 * writes `conversation.reply.sent`; this file never wired one, so the row
 * was real but unasserted. It is wired below with the production
 * `PgAuditRepository` and read back.
 *
 * The refusals were the genuine product gap: a DNC-blocked reply and a
 * provider-failed reply both END the operator's action — one writes nothing
 * at all, the other writes a `failed` dispatch row — and neither left an
 * audit trail. "Nothing sent without my hand on it" is only half the row's
 * promise; the other half is that a suppression the owner did not choose is
 * visible afterwards. Both now emit `conversation.reply.suppressed` /
 * `.failed` through the same repository the `sent` event uses.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { getSharedTestDb, createTestTenant, closeSharedTestDb } from './shared';
import { PgConversationRepository } from '../../src/conversations/pg-conversation';
import { PgCustomerRepository } from '../../src/customers/pg-customer';
import { PgDispatchRepository } from '../../src/notifications/dispatch-repository';
import { PgDncRepository, normalizePhone } from '../../src/compliance/dnc';
import { PgAuditRepository } from '../../src/audit/pg-audit';
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
  let auditRepo: PgAuditRepository;
  let delivery: InMemoryDeliveryProvider;
  let tenant: { tenantId: string; userId: string };

  function deps(): ConversationReplyDeps {
    // Exactly what `routes/conversations.ts` passes at the send call site.
    return { conversationRepo, customerRepo, dispatchRepo, dncRepo, delivery, auditRepo };
  }

  beforeAll(async () => {
    pool = await getSharedTestDb();
    conversationRepo = new PgConversationRepository(pool);
    customerRepo = new PgCustomerRepository(pool);
    dispatchRepo = new PgDispatchRepository(pool);
    dncRepo = new PgDncRepository(pool);
    auditRepo = new PgAuditRepository(pool);
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

    // The send is audited through the same repository the router wires.
    const events = await auditRepo.findByEntity(tenant.tenantId, 'conversation', conv.id);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      tenantId: tenant.tenantId,
      eventType: 'conversation.reply.sent',
      entityType: 'conversation',
      entityId: conv.id,
      actorId: tenant.userId,
      actorRole: 'owner',
      correlationId: dispatches[0].id,
    });
    expect(events[0].metadata).toMatchObject({
      channel: 'sms',
      recipient: '+15555551001',
      dispatchId: dispatches[0].id,
    });

    // Tenant isolation — the dispatch row never bleeds to another tenant.
    const other = await createTestTenant(pool);
    const otherView = await dispatchRepo.findByEntity(
      other.tenantId,
      'conversation_reply',
      conv.id,
    );
    expect(otherView).toHaveLength(0);
    // T1 — and neither does the audit row.
    expect(
      await auditRepo.findByEntity(other.tenantId, 'conversation', conv.id),
    ).toHaveLength(0);
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

    // …but the refusal itself IS recorded. A suppression the owner did not
    // choose must not be invisible: the operator pressed Send and nothing
    // went out, and the audit trail is the only place that fact survives
    // (there is deliberately no dispatch row to carry it).
    const events = await auditRepo.findByEntity(tenant.tenantId, 'conversation', conv.id);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      tenantId: tenant.tenantId,
      eventType: 'conversation.reply.suppressed',
      entityType: 'conversation',
      entityId: conv.id,
      actorId: tenant.userId,
      actorRole: 'owner',
    });
    expect(events[0].metadata).toMatchObject({
      channel: 'sms',
      recipient: '+15555551002',
      reason: 'dnc_blocked',
    });
  });

  it('records a failed dispatch AND a conversation.reply.failed audit row when the provider throws', async () => {
    const customer = await customerRepo.create(
      baseCustomer(tenant.tenantId, tenant.userId, { primaryPhone: '+15555551003' }),
    );
    const conv = await conversationRepo.createConversation({
      tenantId: tenant.tenantId,
      title: 'Provider down',
      entityType: 'customer',
      entityId: customer.id,
      createdBy: tenant.userId,
    });

    // Same deps as production except the transport, which is made to fail the
    // way a real provider outage does.
    const failingDeps: ConversationReplyDeps = {
      ...deps(),
      delivery: {
        ...delivery,
        sendSms: async () => {
          throw new Error('provider unavailable');
        },
      } as unknown as InMemoryDeliveryProvider,
    };

    await expect(
      sendConversationReply(failingDeps, {
        tenantId: tenant.tenantId,
        conversationId: conv.id,
        body: 'are you there?',
        actorId: tenant.userId,
        actorRole: 'owner',
      }),
    ).rejects.toBeInstanceOf(ConversationReplyError);

    const dispatches = await dispatchRepo.findByEntity(
      tenant.tenantId,
      'conversation_reply',
      conv.id,
    );
    expect(dispatches).toHaveLength(1);
    expect(dispatches[0].status).toBe('failed');

    const events = await auditRepo.findByEntity(tenant.tenantId, 'conversation', conv.id);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      eventType: 'conversation.reply.failed',
      entityType: 'conversation',
      entityId: conv.id,
      actorRole: 'owner',
    });
    expect(events[0].metadata).toMatchObject({
      channel: 'sms',
      recipient: '+15555551003',
      reason: 'delivery_failed',
      dispatchId: dispatches[0].id,
    });
  });
});
