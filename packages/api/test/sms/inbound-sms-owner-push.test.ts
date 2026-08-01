import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  createInboundCaptureHandler,
  buildSmsPreview,
  isComplianceKeywordMessage,
} from '../../src/sms/inbound-capture';
import type { InboundSmsContext } from '../../src/sms/inbound-dispatch';
import { OwnerNotificationService } from '../../src/notifications/owner-notification-service';
import { InMemoryPushDeliveryProvider } from '../../src/notifications/push-delivery-provider';
import { InMemoryDeviceTokenRepository } from '../../src/push/device-token-service';
import { setOwnerNotifications } from '../../src/notifications/owner-notifications-instance';

const tenantId = '550e8400-e29b-41d4-a716-446655440000';
const userId = 'user-owner-1';

/** Minimal conversation repo: every text opens a fresh customer thread. */
function makeConversationRepo(conversationId: string) {
  return {
    async findByEntity() {
      return [];
    },
    async createConversation(input: { entityType: string; entityId: string; title: string }) {
      return {
        id: conversationId,
        tenantId,
        status: 'open' as const,
        title: input.title,
        entityType: input.entityType,
        entityId: input.entityId,
        createdBy: 'system:sms-capture',
        createdAt: new Date(),
        updatedAt: new Date(),
      };
    },
    async addMessage() {
      return { id: 'msg-1' } as never;
    },
  };
}

function makeCtx(body: string): InboundSmsContext {
  return {
    tenantId,
    fromE164: '+15555550123',
    body,
    messageSid: 'SM123',
  };
}

describe('U3 — inbound SMS owner push', () => {
  let repo: InMemoryDeviceTokenRepository;
  let provider: InMemoryPushDeliveryProvider;

  beforeEach(async () => {
    repo = new InMemoryDeviceTokenRepository();
    provider = new InMemoryPushDeliveryProvider();
    await repo.register({
      tenantId,
      userId,
      expoPushToken: 'ExponentPushToken[a]',
      platform: 'ios',
    });
    setOwnerNotifications(new OwnerNotificationService({ deviceTokenRepo: repo, provider }));
  });

  afterEach(() => {
    setOwnerNotifications(undefined);
  });

  it('fires inbound_sms with the conversation id, customer name, and preview', async () => {
    const customer = {
      id: 'cust-1',
      displayName: 'Jane Doe',
    };
    const handler = createInboundCaptureHandler({
      conversationRepo: makeConversationRepo('conv-1'),
      customerRepo: {
        async findByPhoneNormalized() {
          return [customer as never];
        },
      },
    });

    const result = await handler.handle(makeCtx('Is the tech still coming?'));
    expect(result.handled).toBe(true);

    expect(provider.sent).toHaveLength(1);
    expect(provider.sent[0].data?.type).toBe('inbound_sms');
    expect(provider.sent[0].data?.screen).toBe('/messages/conv-1');
    expect(provider.sent[0].title).toContain('Jane Doe');
    expect(provider.sent[0].body).toBe('Is the tech still coming?');
  });

  it('truncates a long body to ~80 chars + ellipsis in the preview', async () => {
    const longBody = 'x'.repeat(200);
    const handler = createInboundCaptureHandler({
      conversationRepo: makeConversationRepo('conv-2'),
      customerRepo: {
        async findByPhoneNormalized() {
          return [{ id: 'cust-1', displayName: 'Jane' } as never];
        },
      },
    });

    await handler.handle(makeCtx(longBody));
    expect(provider.sent).toHaveLength(1);
    expect(provider.sent[0].body).toBe(`${'x'.repeat(80)}…`);
  });

  it('skips STOP/HELP compliance-keyword inbound (no push)', async () => {
    const handler = createInboundCaptureHandler({
      conversationRepo: makeConversationRepo('conv-3'),
      customerRepo: {
        async findByPhoneNormalized() {
          return [{ id: 'cust-1', displayName: 'Jane' } as never];
        },
      },
    });

    await handler.handle(makeCtx('STOP'));
    await handler.handle(makeCtx('Help'));
    expect(provider.sent).toHaveLength(0);
  });

  it('best-effort: a push failure does not change capture success', async () => {
    // No service registered → notifyOwner is a no-op; capture still succeeds.
    setOwnerNotifications(undefined);
    const handler = createInboundCaptureHandler({
      conversationRepo: makeConversationRepo('conv-4'),
      customerRepo: {
        async findByPhoneNormalized() {
          return [{ id: 'cust-1', displayName: 'Jane' } as never];
        },
      },
    });

    const result = await handler.handle(makeCtx('hello'));
    expect(result.handled).toBe(true);
  });
});

describe('U3 — preview + compliance helpers', () => {
  it('collapses whitespace and caps at 80 chars', () => {
    expect(buildSmsPreview('  hi   there  ')).toBe('hi there');
    expect(buildSmsPreview('a'.repeat(100))).toBe(`${'a'.repeat(80)}…`);
  });

  it('flags compliance keywords (punctuation-tolerant, case-insensitive)', () => {
    expect(isComplianceKeywordMessage('STOP')).toBe(true);
    expect(isComplianceKeywordMessage('help!')).toBe(true);
    expect(isComplianceKeywordMessage('unsubscribe me')).toBe(true);
    expect(isComplianceKeywordMessage('Is the tech coming?')).toBe(false);
  });
});
