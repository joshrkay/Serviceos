import { describe, it, expect } from 'vitest';
import { logInboundCallOnCustomerTimeline } from '../../src/telephony/inbound-call-log';
import { InMemoryConversationRepository } from '../../src/conversations/conversation-service';

const TENANT = 'tenant-1';
const CUSTOMER = 'cust-1';

describe('logInboundCallOnCustomerTimeline', () => {
  it('threads an inbound-call system_event onto the customer conversation', async () => {
    const repo = new InMemoryConversationRepository();
    const { conversation, message } = await logInboundCallOnCustomerTimeline({
      conversationRepo: repo,
      tenantId: TENANT,
      customerId: CUSTOMER,
      fromPhone: '+15125550100',
      callSid: 'CA123',
    });

    expect(conversation.entityType).toBe('customer');
    expect(conversation.entityId).toBe(CUSTOMER);

    const msgs = await repo.getMessages(TENANT, conversation.id);
    expect(msgs).toHaveLength(1);
    expect(msgs[0].id).toBe(message.id);
    expect(msgs[0].source).toBe('inbound_call');
    expect(msgs[0].messageType).toBe('system_event');
    expect(msgs[0].content).toMatch(/^Inbound call from .*0100$/);
    expect(msgs[0].metadata).toMatchObject({
      direction: 'inbound',
      channel: 'call',
      status: 'received',
      callSid: 'CA123',
    });
  });

  it('reuses the customer’s open thread across two inbound calls (no duplicate thread)', async () => {
    const repo = new InMemoryConversationRepository();
    const first = await logInboundCallOnCustomerTimeline({
      conversationRepo: repo,
      tenantId: TENANT,
      customerId: CUSTOMER,
      fromPhone: '+15125550100',
    });
    const second = await logInboundCallOnCustomerTimeline({
      conversationRepo: repo,
      tenantId: TENANT,
      customerId: CUSTOMER,
      fromPhone: '+15125550100',
      status: 'completed',
    });

    expect(second.conversation.id).toBe(first.conversation.id);
    const msgs = await repo.getMessages(TENANT, first.conversation.id);
    expect(msgs).toHaveLength(2);
  });
});
