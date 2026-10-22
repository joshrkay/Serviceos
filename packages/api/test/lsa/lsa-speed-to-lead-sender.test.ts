import { describe, it, expect, vi } from 'vitest';
import { InMemoryConversationRepository } from '../../src/conversations/conversation-service';
import { createLsaSpeedToLeadSender } from '../../src/lsa/lsa-speed-to-lead-sender';
import type { Lead } from '../../src/leads/lead';

const TENANT = 'tenant-1';

function setup(opts: { dnc?: boolean } = {}) {
  const conversationRepo = new InMemoryConversationRepository();
  const delivery = {
    sendSms: vi.fn().mockResolvedValue({ providerMessageId: 'SM-1', provider: 'sms-gateway', channel: 'sms' }),
    sendEmail: vi.fn(),
  };
  const auditRepo = { create: vi.fn().mockResolvedValue(undefined) };
  const lead = {
    id: 'lead-1', tenantId: TENANT, firstName: 'Jane', lastName: '', primaryPhone: '+15555550123',
    source: 'marketplace', stage: 'new',
  } as Lead;
  const sender = createLsaSpeedToLeadSender({
    reply: {
      conversationRepo,
      customerRepo: { findById: vi.fn().mockResolvedValue(null) },
      leadRepo: { findById: vi.fn().mockResolvedValue(lead) },
      dncRepo: { isOnDnc: vi.fn().mockResolvedValue(opts.dnc ?? false) },
       
      dispatchRepo: { create: vi.fn().mockImplementation(async (i) => ({ id: 'd1', sentAt: new Date(), ...i })) } as any,
       
      delivery: delivery as any,
    },
    conversationRepo,
     
    auditRepo: auditRepo as any,
    getBusinessName: async () => 'Cool Air',
  });
  return { sender, delivery, auditRepo, conversationRepo };
}

describe('createLsaSpeedToLeadSender (#1738)', () => {
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
});
