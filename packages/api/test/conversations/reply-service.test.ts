import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  sendConversationReply,
  ConversationReplyError,
  type ConversationReplyDeps,
} from '../../src/conversations/reply-service';
import { InMemoryConversationRepository } from '../../src/conversations/conversation-service';
import { UNMATCHED_SMS_ENTITY_TYPE } from '../../src/sms/inbound-capture';
import { normalizePhone } from '../../src/compliance/dnc';
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

  it('passes a stable idempotency key (conversation + channel + minute + body) to the provider', async () => {
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

  it('an exact re-tap of the same reply text in the same minute dedupes (identical key)', async () => {
    const id = await customerThread(h.conversationRepo, {
      entityType: 'customer',
      entityId: 'cust-1',
    });
    const send = () =>
      sendConversationReply(h.deps, {
        tenantId: TENANT,
        conversationId: id,
        body: 'On our way!',
        actorId: 'owner-1',
        actorRole: 'owner',
      });
    await send();
    await send();
    const k1 = h.delivery.sendSms.mock.calls[0][0].idempotencyKey;
    const k2 = h.delivery.sendSms.mock.calls[1][0].idempotencyKey;
    expect(k1).toBe(k2); // double-tap collapses at the provider/ledger
  });

  it('two DIFFERENT replies in the same minute get distinct keys (no dispatch-unique collision)', async () => {
    const id = await customerThread(h.conversationRepo, {
      entityType: 'customer',
      entityId: 'cust-1',
    });
    await sendConversationReply(h.deps, {
      tenantId: TENANT,
      conversationId: id,
      body: 'On our way!',
      actorId: 'owner-1',
      actorRole: 'owner',
    });
    await sendConversationReply(h.deps, {
      tenantId: TENANT,
      conversationId: id,
      body: 'Actually, running 10 min late.',
      actorId: 'owner-1',
      actorRole: 'owner',
    });
    const k1 = h.delivery.sendSms.mock.calls[0][0].idempotencyKey;
    const k2 = h.delivery.sendSms.mock.calls[1][0].idempotencyKey;
    // Both fall in the same 1-minute window (mocked `now`), but the body hash
    // separates them so the second send does not collide on the dispatch
    // unique (tenant_id, idempotency_key) and get dropped/mis-threaded.
    expect(k1).not.toBe(k2);
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

// ─── Comms C3 — reply resolves within its own channel thread ─────────────────

describe('C3 channel selection', () => {
  async function inbound(
    repo: InMemoryConversationRepository,
    conversationId: string,
    channel: 'sms' | 'email',
    at: Date,
  ): Promise<void> {
    await repo.addMessage({
      tenantId: TENANT,
      conversationId,
      messageType: 'text',
      content: 'inbound',
      senderId: 'cust-1',
      senderRole: 'customer',
      source: channel,
      metadata: { direction: 'inbound', channel, createdAtOverride: at.toISOString() },
    });
  }

  const input = (conversationId: string, channel?: 'sms' | 'email') => ({
    tenantId: TENANT,
    conversationId,
    body: 'On my way',
    actorId: 'user-1',
    actorRole: 'owner',
    ...(channel ? { channel } : {}),
  });

  it('defaults to the thread channel (customer texted in) even when preference says email', async () => {
    const h = harness({ customer: customer({ preferredChannel: 'email' }) });
    const convId = await customerThread(h.conversationRepo, {
      entityType: 'customer',
      entityId: 'cust-1',
    });
    await inbound(h.conversationRepo, convId, 'sms', new Date('2026-06-17T11:00:00Z'));
    const result = await sendConversationReply(h.deps, input(convId));
    expect(result.channel).toBe('sms');
    expect(h.delivery.sendSms).toHaveBeenCalledTimes(1);
    expect(h.delivery.sendEmail).not.toHaveBeenCalled();
  });

  it('thread-derived channel with no address on file asks — never silently flips', async () => {
    // Customer emailed in, but the email has since been removed from the record.
    const h = harness({ customer: customer({ email: undefined }) });
    const convId = await customerThread(h.conversationRepo, {
      entityType: 'customer',
      entityId: 'cust-1',
    });
    await inbound(h.conversationRepo, convId, 'email', new Date('2026-06-17T11:00:00Z'));
    await expect(sendConversationReply(h.deps, input(convId))).rejects.toMatchObject({
      code: 'channel_selection_required',
    });
    expect(h.delivery.sendSms).not.toHaveBeenCalled();
    expect(h.delivery.sendEmail).not.toHaveBeenCalled();
  });

  it('preference-derived default with no address falls through to the sole deliverable channel', async () => {
    // Preference says email but only a phone exists and the thread has no
    // inbound traffic — one deliverable channel is deterministic, not a guess.
    const h = harness({
      customer: customer({ preferredChannel: 'email', email: undefined }),
    });
    const convId = await customerThread(h.conversationRepo, {
      entityType: 'customer',
      entityId: 'cust-1',
    });
    const result = await sendConversationReply(h.deps, input(convId));
    expect(result.channel).toBe('sms');
    expect(h.delivery.sendSms).toHaveBeenCalledTimes(1);
  });

  it('both channels deliverable with no thread channel and no usable preference asks', async () => {
    const h = harness({ customer: customer({ preferredChannel: 'none' }) });
    const convId = await customerThread(h.conversationRepo, {
      entityType: 'customer',
      entityId: 'cust-1',
    });
    await expect(sendConversationReply(h.deps, input(convId))).rejects.toMatchObject({
      code: 'channel_selection_required',
    });
  });

  it('explicit channel selection performs a cross-channel reply', async () => {
    const h = harness();
    const convId = await customerThread(h.conversationRepo, {
      entityType: 'customer',
      entityId: 'cust-1',
    });
    await inbound(h.conversationRepo, convId, 'sms', new Date('2026-06-17T11:00:00Z'));
    const result = await sendConversationReply(h.deps, input(convId, 'email'));
    expect(result.channel).toBe('email');
    expect(h.delivery.sendEmail).toHaveBeenCalledTimes(1);
  });

  // ─── The reply goes to the human who wrote, not to the account ───────────
  // A customer's phone lookup also matches secondary phones and
  // customer_contacts rows, so on a landlord/tenant/property-manager account
  // the sender is routinely NOT primaryPhone. Replying to the account sends
  // it to a different person (spec §4 — a privacy failure, not a UX one).

  async function inboundFrom(
    repo: InMemoryConversationRepository,
    conversationId: string,
    fromE164: string,
    at: Date,
  ): Promise<void> {
    await repo.addMessage({
      tenantId: TENANT,
      conversationId,
      messageType: 'text',
      content: 'the tech never showed',
      senderId: fromE164,
      senderRole: 'customer',
      source: 'sms',
      metadata: {
        direction: 'inbound',
        channel: 'sms',
        fromE164,
        createdAtOverride: at.toISOString(),
      },
    });
  }

  it('replies to the contact number that texted, not the account primary phone', async () => {
    const h = harness(); // primaryPhone is +15555550123 (the landlord)
    const convId = await customerThread(h.conversationRepo, {
      entityType: 'customer',
      entityId: 'cust-1',
    });
    // A site contact on the same account texts from their own number.
    await inboundFrom(h.conversationRepo, convId, '+15125550142', new Date('2026-06-17T11:00:00Z'));

    const result = await sendConversationReply(h.deps, input(convId));

    expect(result.channel).toBe('sms');
    expect(h.delivery.sendSms).toHaveBeenCalledTimes(1);
    expect(h.delivery.sendSms.mock.calls[0][0]).toMatchObject({ to: '+15125550142' });
    expect(h.delivery.sendSms.mock.calls[0][0].to).not.toBe('+15555550123');
  });

  it('falls back to the account phone when the thread has no captured sender', async () => {
    const h = harness();
    const convId = await customerThread(h.conversationRepo, {
      entityType: 'customer',
      entityId: 'cust-1',
    });
    // Owner-initiated thread: no inbound message, so nothing to inherit.
    const result = await sendConversationReply(h.deps, input(convId));
    expect(result.channel).toBe('sms');
    expect(h.delivery.sendSms.mock.calls[0][0]).toMatchObject({ to: '+15555550123' });
  });

  it('DNC is checked against the contact who texted, not the account primary', async () => {
    const h = harness();
    // The contact's own number is on the DNC list; the account primary is not.
    h.dncRepo.isOnDnc.mockImplementation(async (_t: string, phone: string) =>
      normalizePhone(phone) === normalizePhone('+15125550142'),
    );
    const convId = await customerThread(h.conversationRepo, {
      entityType: 'customer',
      entityId: 'cust-1',
    });
    await inboundFrom(h.conversationRepo, convId, '+15125550142', new Date('2026-06-17T11:00:00Z'));

    await expect(sendConversationReply(h.deps, input(convId))).rejects.toMatchObject({
      code: 'dnc_blocked',
    });
    expect(h.delivery.sendSms).not.toHaveBeenCalled();
  });

  it('uses the bounded findLatestInbound lookup instead of scanning getMessages', async () => {
    const h = harness();
    const convId = await customerThread(h.conversationRepo, {
      entityType: 'customer',
      entityId: 'cust-1',
    });
    await inbound(h.conversationRepo, convId, 'sms', new Date('2026-06-17T11:00:00Z'));
    const bounded = vi.spyOn(h.conversationRepo, 'findLatestInbound');
    const scan = vi.spyOn(h.conversationRepo, 'getMessages');
    await sendConversationReply(h.deps, input(convId));
    expect(bounded).toHaveBeenCalledTimes(1);
    expect(scan).not.toHaveBeenCalled();
  });
});
