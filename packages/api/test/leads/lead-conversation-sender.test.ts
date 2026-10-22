import { describe, it, expect, vi } from 'vitest';
import { InMemoryConversationRepository } from '../../src/conversations/conversation-service';
import { createLeadConversationSender, LeadTextUnconfirmedError } from '../../src/leads/lead-conversation-sender';
import type { Lead } from '../../src/leads/lead';

const TENANT = 'tenant-1';

function setup(opts: { dnc?: boolean; dispatchFails?: boolean; deliveryFails?: boolean } = {}) {
  const conversationRepo = new InMemoryConversationRepository();
  const delivery = {
    sendSms: opts.deliveryFails
      ? vi.fn().mockRejectedValue(new Error('twilio 500'))
      : vi.fn().mockResolvedValue({ providerMessageId: 'SM-1', provider: 'sms-gateway', channel: 'sms' }),
    sendEmail: vi.fn(),
  };
  const auditRepo = { create: vi.fn().mockResolvedValue(undefined) };
  const lead = {
    id: 'lead-1', tenantId: TENANT, firstName: 'Jane', lastName: '', primaryPhone: '+15555550123',
    source: 'marketplace', stage: 'new',
  } as Lead;
  const sender = createLeadConversationSender({
    reply: {
      conversationRepo,
      customerRepo: { findById: vi.fn().mockResolvedValue(null) },
      leadRepo: { findById: vi.fn().mockResolvedValue(lead) },
      dncRepo: { isOnDnc: vi.fn().mockResolvedValue(opts.dnc ?? false) },
       
      dispatchRepo: {
        create: vi.fn().mockImplementation(async (i) => {
          if (opts.dispatchFails && i.status === 'sent') throw new Error('db down');
          return { id: 'd1', sentAt: new Date(), ...i };
        }),
      } as any,
       
      delivery: delivery as any,
    },
    conversationRepo,
     
    auditRepo: auditRepo as any,
    getBusinessName: async () => 'Cool Air',
  }, { title: 'Google Local Services lead', actorId: 'system:lsa' });
  return { sender, delivery, auditRepo, conversationRepo };
}

describe('createLeadConversationSender (#1738)', () => {
  it('sends an SMS reply on the lead conversation', async () => {
    const { sender, delivery } = setup();
    await sender({ tenantId: TENANT, leadId: 'lead-1', toPhone: '+15555550123', body: 'hello' });
    expect(delivery.sendSms).toHaveBeenCalledTimes(1);
  });

  it('never texts a DNC number and audits the suppression', async () => {
    const { sender, delivery, auditRepo } = setup({ dnc: true });
    await expect(
      sender({ tenantId: TENANT, leadId: 'lead-1', toPhone: '+15555550123', body: 'hello' }),
    ).rejects.toMatchObject({ code: 'dnc_blocked' });
    expect(delivery.sendSms).not.toHaveBeenCalled();
    expect(auditRepo.create.mock.calls.map((c) => c[0].eventType)).toContain('conversation.reply.suppressed');
  });

  it('opens one lead-linked conversation and reuses it', async () => {
    const { sender, conversationRepo } = setup();
    await sender({ tenantId: TENANT, leadId: 'lead-1', toPhone: '+15555550123', body: 'a' });
    await sender({ tenantId: TENANT, leadId: 'lead-1', toPhone: '+15555550123', body: 'b' });
    expect(await conversationRepo.findByEntity(TENANT, 'lead', 'lead-1')).toHaveLength(1);
  });

  it('opens the conversation under the caller-supplied title and actor', async () => {
    const { sender, conversationRepo } = setup();
    await sender({ tenantId: TENANT, leadId: 'lead-1', toPhone: '+15555550123', body: 'a' });
    const [conversation] = await conversationRepo.findByEntity(TENANT, 'lead', 'lead-1');
    expect(conversation).toMatchObject({ title: 'Google Local Services lead', createdBy: 'system:lsa' });
  });

  it('a provider failure stays a definite delivery_failed refusal', async () => {
    const { sender } = setup({ deliveryFails: true });
    await expect(
      sender({ tenantId: TENANT, leadId: 'lead-1', toPhone: '+15555550123', body: 'a' }),
    ).rejects.toMatchObject({ code: 'delivery_failed' });
  });

  it('a failure after the provider accepted the text is "unconfirmed", not "not sent"', async () => {
    const { sender, delivery } = setup({ dispatchFails: true });
    const err = await sender({ tenantId: TENANT, leadId: 'lead-1', toPhone: '+15555550123', body: 'a' }).catch((e) => e);
    expect(delivery.sendSms).toHaveBeenCalledTimes(1);
    expect(err).toBeInstanceOf(LeadTextUnconfirmedError);
    expect(err.message).toBe('unconfirmed');
  });
});
