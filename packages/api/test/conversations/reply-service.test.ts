import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  sendConversationReply,
  ConversationReplyError,
  type ConversationReplyDeps,
} from '../../src/conversations/reply-service';
import { InMemoryConversationRepository } from '../../src/conversations/conversation-service';
import { UNMATCHED_SMS_ENTITY_TYPE } from '../../src/sms/inbound-capture';
import type { Customer } from '../../src/customers/customer';

const TENANT = 'tenant-1';

function customer(overrides: Partial<Customer> = {}): Customer {
  return {
    id: 'cust-1',
    tenantId: TENANT,
    firstName: 'Sam',
    lastName: 'Smith',
    displayName: 'Sam Smith',
    preferredChannel: 'sms',
    smsConsent: true,
    isArchived: false,
    primaryPhone: '+15555550123',
    email: 'sam@example.com',
    ...overrides,
  } as Customer;
}

interface Harness {
  deps: ConversationReplyDeps;
  conversationRepo: InMemoryConversationRepository;
  delivery: { sendSms: ReturnType<typeof vi.fn>; sendEmail: ReturnType<typeof vi.fn> };
  dispatchRepo: { create: ReturnType<typeof vi.fn> };
  dncRepo: { isOnDnc: ReturnType<typeof vi.fn> };
  auditRepo: { create: ReturnType<typeof vi.fn> };
  customerRepo: { findById: ReturnType<typeof vi.fn> };
  leadRepo: { findById: ReturnType<typeof vi.fn> };
}

function harness(over: { customer?: Customer | null } = {}): Harness {
  const conversationRepo = new InMemoryConversationRepository();
  const delivery = {
    sendSms: vi
      .fn()
      .mockResolvedValue({ providerMessageId: 'SM-1', provider: 'sms-gateway', channel: 'sms' }),
    sendEmail: vi
      .fn()
      .mockResolvedValue({ providerMessageId: 'EM-1', provider: 'email-gateway', channel: 'email' }),
  };
  const dispatchRepo = {
    create: vi.fn().mockImplementation(async (input) => ({ id: 'disp-1', sentAt: new Date(), ...input })),
  };
  const dncRepo = { isOnDnc: vi.fn().mockResolvedValue(false) };
  const auditRepo = { create: vi.fn().mockResolvedValue(undefined) };
  const customerRepo = {
    findById: vi.fn().mockResolvedValue('customer' in over ? over.customer : customer()),
  };
  const leadRepo = { findById: vi.fn().mockResolvedValue(null) };
  const deps: ConversationReplyDeps = {
    conversationRepo,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    customerRepo: customerRepo as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    leadRepo: leadRepo as any,
    dncRepo,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    dispatchRepo: dispatchRepo as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    delivery: delivery as any,
    auditRepo,
    businessName: 'Acme Plumbing',
    now: () => new Date('2026-06-17T12:00:00Z'),
  };
  return { deps, conversationRepo, delivery, dispatchRepo, dncRepo, auditRepo, customerRepo, leadRepo };
}

async function customerThread(
  conversationRepo: InMemoryConversationRepository,
  entity: { entityType: string; entityId: string },
): Promise<string> {
  const conv = await conversationRepo.createConversation({
    tenantId: TENANT,
    title: 'thread',
    entityType: entity.entityType,
    entityId: entity.entityId,
    createdBy: 'system',
  });
  return conv.id;
}

describe('U6 — sendConversationReply', () => {
  let h: Harness;

  beforeEach(() => {
    h = harness();
  });

  it('sends an SMS reply, records a sent dispatch, threads the outbound message, audits', async () => {
    const id = await customerThread(h.conversationRepo, {
      entityType: 'customer',
      entityId: 'cust-1',
    });

    const result = await sendConversationReply(h.deps, {
      tenantId: TENANT,
      conversationId: id,
      body: 'On our way!',
      actorId: 'owner-1',
      actorRole: 'owner',
    });

    expect(h.delivery.sendSms).toHaveBeenCalledTimes(1);
    expect(h.delivery.sendSms.mock.calls[0][0]).toMatchObject({
      to: '+15555550123',
      body: 'On our way!',
      tenantId: TENANT,
    });
    expect(h.dispatchRepo.create).toHaveBeenCalledTimes(1);
    expect(h.dispatchRepo.create.mock.calls[0][0]).toMatchObject({
      entityType: 'conversation_reply',
      entityId: id,
      channel: 'sms',
      recipient: '+15555550123',
      status: 'sent',
    });
    expect(result.channel).toBe('sms');
    expect(result.dispatchId).toBe('disp-1');

    const messages = await h.conversationRepo.getMessages(TENANT, id);
    expect(messages).toHaveLength(1);
    expect(messages[0].content).toBe('On our way!');
    expect(messages[0].senderRole).toBe('owner');
    expect(messages[0].source).toBe('sms');
    expect(messages[0].metadata).toMatchObject({ direction: 'outbound', channel: 'sms' });

    expect(h.auditRepo.create).toHaveBeenCalledTimes(1);
    expect(h.auditRepo.create.mock.calls[0][0]).toMatchObject({
      eventType: 'conversation.reply.sent',
      entityId: id,
    });
  });

  it('passes a stable idempotency key (conversation + channel + minute) to the provider', async () => {
    const id = await customerThread(h.conversationRepo, {
      entityType: 'customer',
      entityId: 'cust-1',
    });
    await sendConversationReply(h.deps, {
      tenantId: TENANT,
      conversationId: id,
      body: 'hi',
      actorId: 'owner-1',
      actorRole: 'owner',
    });
    const key = h.delivery.sendSms.mock.calls[0][0].idempotencyKey as string;
    expect(key).toContain(`conversation_reply:${id}:sms:`);
    expect(h.dispatchRepo.create.mock.calls[0][0].idempotencyKey).toBe(key);
  });

  it('sends by email when the customer prefers email', async () => {
    h = harness({ customer: customer({ preferredChannel: 'email' }) });
    const id = await customerThread(h.conversationRepo, {
      entityType: 'customer',
      entityId: 'cust-1',
    });

    const result = await sendConversationReply(h.deps, {
      tenantId: TENANT,
      conversationId: id,
      body: 'Invoice attached',
      actorId: 'owner-1',
      actorRole: 'owner',
    });

    expect(h.delivery.sendEmail).toHaveBeenCalledTimes(1);
    expect(h.delivery.sendEmail.mock.calls[0][0]).toMatchObject({
      to: 'sam@example.com',
      subject: 'Message from Acme Plumbing',
      text: 'Invoice attached',
    });
    expect(result.channel).toBe('email');
  });

  it('falls back to SMS when the preferred email channel has no address', async () => {
    h = harness({ customer: customer({ preferredChannel: 'email', email: undefined }) });
    const id = await customerThread(h.conversationRepo, {
      entityType: 'customer',
      entityId: 'cust-1',
    });
    const result = await sendConversationReply(h.deps, {
      tenantId: TENANT,
      conversationId: id,
      body: 'hello',
      actorId: 'owner-1',
      actorRole: 'owner',
    });
    expect(result.channel).toBe('sms');
    expect(h.delivery.sendSms).toHaveBeenCalledTimes(1);
  });

  it('blocks a send to an opted-out (DNC) number — no dispatch, no delivery, no message', async () => {
    h = harness();
    h.dncRepo.isOnDnc.mockResolvedValue(true);
    const id = await customerThread(h.conversationRepo, {
      entityType: 'customer',
      entityId: 'cust-1',
    });

    await expect(
      sendConversationReply(h.deps, {
        tenantId: TENANT,
        conversationId: id,
        body: 'hi',
        actorId: 'owner-1',
        actorRole: 'owner',
      }),
    ).rejects.toMatchObject({ code: 'dnc_blocked' });

    expect(h.delivery.sendSms).not.toHaveBeenCalled();
    expect(h.dispatchRepo.create).not.toHaveBeenCalled();
    expect(await h.conversationRepo.getMessages(TENANT, id)).toHaveLength(0);
  });

  it('records a failed dispatch and throws when the provider fails (no message appended)', async () => {
    h = harness();
    h.delivery.sendSms.mockRejectedValue(new Error('twilio 500'));
    const id = await customerThread(h.conversationRepo, {
      entityType: 'customer',
      entityId: 'cust-1',
    });

    await expect(
      sendConversationReply(h.deps, {
        tenantId: TENANT,
        conversationId: id,
        body: 'hi',
        actorId: 'owner-1',
        actorRole: 'owner',
      }),
    ).rejects.toBeInstanceOf(ConversationReplyError);

    expect(h.dispatchRepo.create).toHaveBeenCalledTimes(1);
    expect(h.dispatchRepo.create.mock.calls[0][0]).toMatchObject({ status: 'failed' });
    expect(await h.conversationRepo.getMessages(TENANT, id)).toHaveLength(0);
  });

  it('replies to a phone-keyed unmatched thread by SMS to the originating number', async () => {
    h = harness();
    const id = await customerThread(h.conversationRepo, {
      entityType: UNMATCHED_SMS_ENTITY_TYPE,
      entityId: '+15555559999',
    });

    const result = await sendConversationReply(h.deps, {
      tenantId: TENANT,
      conversationId: id,
      body: 'who is this?',
      actorId: 'owner-1',
      actorRole: 'owner',
    });

    expect(h.customerRepo.findById).not.toHaveBeenCalled();
    expect(result.channel).toBe('sms');
    expect(h.delivery.sendSms.mock.calls[0][0].to).toBe('+15555559999');
  });

  it('replies to a lead-linked thread by SMS to the lead phone', async () => {
    h = harness();
    h.leadRepo.findById.mockResolvedValue({
      id: 'lead-1',
      tenantId: TENANT,
      firstName: 'Pat',
      lastName: 'Prospect',
      primaryPhone: '+15555551234',
      source: 'phone_call',
      stage: 'new',
      createdBy: 'x',
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const id = await customerThread(h.conversationRepo, {
      entityType: 'lead',
      entityId: 'lead-1',
    });

    const result = await sendConversationReply(h.deps, {
      tenantId: TENANT,
      conversationId: id,
      body: 'Thanks for reaching out!',
      actorId: 'owner-1',
      actorRole: 'owner',
    });

    expect(h.leadRepo.findById).toHaveBeenCalledWith(TENANT, 'lead-1');
    expect(result.channel).toBe('sms');
    expect(h.delivery.sendSms.mock.calls[0][0].to).toBe('+15555551234');
    expect(h.dispatchRepo.create.mock.calls[0][0]).toMatchObject({
      entityType: 'conversation_reply',
      entityId: id,
    });
  });

  it('throws not_found for an unknown conversation', async () => {
    await expect(
      sendConversationReply(h.deps, {
        tenantId: TENANT,
        conversationId: 'missing',
        body: 'hi',
        actorId: 'owner-1',
        actorRole: 'owner',
      }),
    ).rejects.toMatchObject({ code: 'not_found' });
  });

  it('throws empty_body for a blank reply', async () => {
    const id = await customerThread(h.conversationRepo, {
      entityType: 'customer',
      entityId: 'cust-1',
    });
    await expect(
      sendConversationReply(h.deps, {
        tenantId: TENANT,
        conversationId: id,
        body: '   ',
        actorId: 'owner-1',
        actorRole: 'owner',
      }),
    ).rejects.toMatchObject({ code: 'empty_body' });
  });
});
