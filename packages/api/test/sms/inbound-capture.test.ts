import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  createInboundCaptureHandler,
  UNMATCHED_SMS_ENTITY_TYPE,
} from '../../src/sms/inbound-capture';
import { InMemoryConversationRepository } from '../../src/conversations/conversation-service';
import type { Customer } from '../../src/customers/customer';
import {
  __resetKeywordRegistryForTests,
  registerKeywordHandler,
  registerCaptureHandler,
  dispatchInboundSms,
  type InboundSmsContext,
} from '../../src/sms/inbound-dispatch';

const TENANT = '11111111-1111-1111-1111-111111111111';

function ctx(overrides: Partial<InboundSmsContext> = {}): InboundSmsContext {
  return {
    tenantId: TENANT,
    fromE164: '+15555550123',
    body: 'is the tech still coming?',
    messageSid: 'SM-test-1',
    ...overrides,
  };
}

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
    ...overrides,
  } as Customer;
}

describe('U4 — inbound SMS capture handler', () => {
  let conversationRepo: InMemoryConversationRepository;
  let auditRepo: { create: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    conversationRepo = new InMemoryConversationRepository();
    auditRepo = { create: vi.fn().mockResolvedValue(undefined) };
  });

  it('threads a known customer text onto a new customer conversation', async () => {
    const findByPhoneNormalized = vi.fn().mockResolvedValue([customer()]);
    const handler = createInboundCaptureHandler({
      conversationRepo,
      customerRepo: { findByPhoneNormalized },
      auditRepo,
    });

    const result = await handler.handle(ctx());

    expect(result).toEqual({ handled: true, handler: 'sms-capture' });
    expect(findByPhoneNormalized).toHaveBeenCalledWith(TENANT, '15555550123');

    const threads = await conversationRepo.findByEntity(TENANT, 'customer', 'cust-1');
    expect(threads).toHaveLength(1);
    expect(threads[0].title).toBe('Sam Smith');

    const messages = await conversationRepo.getMessages(TENANT, threads[0].id);
    expect(messages).toHaveLength(1);
    expect(messages[0].content).toBe('is the tech still coming?');
    expect(messages[0].senderRole).toBe('customer');
    expect(messages[0].source).toBe('sms');
    expect(messages[0].metadata).toMatchObject({
      direction: 'inbound',
      channel: 'sms',
      messageSid: 'SM-test-1',
    });
    expect(messages[0].metadata).not.toHaveProperty('unmatched');
  });

  it('emits an sms.inbound.captured audit event for a matched customer', async () => {
    const handler = createInboundCaptureHandler({
      conversationRepo,
      customerRepo: { findByPhoneNormalized: vi.fn().mockResolvedValue([customer()]) },
      auditRepo,
    });

    await handler.handle(ctx());

    expect(auditRepo.create).toHaveBeenCalledTimes(1);
    const event = auditRepo.create.mock.calls[0][0];
    expect(event).toMatchObject({
      eventType: 'sms.inbound.captured',
      entityType: 'conversation',
      actorId: 'system:sms-capture',
    });
    expect(event.metadata).toMatchObject({ matched: true, customerId: 'cust-1' });
  });

  it('reuses the open thread for a back-and-forth instead of spawning a new one', async () => {
    const handler = createInboundCaptureHandler({
      conversationRepo,
      customerRepo: { findByPhoneNormalized: vi.fn().mockResolvedValue([customer()]) },
      auditRepo,
    });

    await handler.handle(ctx({ body: 'first', messageSid: 'SM-1' }));
    await handler.handle(ctx({ body: 'second', messageSid: 'SM-2' }));

    const threads = await conversationRepo.findByEntity(TENANT, 'customer', 'cust-1');
    expect(threads).toHaveLength(1);
    const messages = await conversationRepo.getMessages(TENANT, threads[0].id);
    expect(messages.map((m) => m.content)).toEqual(['first', 'second']);
  });

  it('threads an unknown number under a phone-keyed unmatched conversation (no lead, no guess)', async () => {
    const handler = createInboundCaptureHandler({
      conversationRepo,
      customerRepo: { findByPhoneNormalized: vi.fn().mockResolvedValue([]) },
      auditRepo,
    });

    const result = await handler.handle(ctx());
    expect(result.handled).toBe(true);

    const threads = await conversationRepo.findByEntity(
      TENANT,
      UNMATCHED_SMS_ENTITY_TYPE,
      '+15555550123',
    );
    expect(threads).toHaveLength(1);
    expect(threads[0].title).toBe('SMS from +15555550123');
    const messages = await conversationRepo.getMessages(TENANT, threads[0].id);
    expect(messages[0].metadata).toMatchObject({ unmatched: true });
    const event = auditRepo.create.mock.calls[0][0];
    expect(event.metadata).toMatchObject({ matched: false });
  });

  it('does not guess between multiple customer matches — threads as unmatched', async () => {
    const handler = createInboundCaptureHandler({
      conversationRepo,
      customerRepo: {
        findByPhoneNormalized: vi
          .fn()
          .mockResolvedValue([customer({ id: 'a' }), customer({ id: 'b' })]),
      },
      auditRepo,
    });

    await handler.handle(ctx());

    expect(await conversationRepo.findByEntity(TENANT, 'customer', 'a')).toHaveLength(0);
    expect(
      await conversationRepo.findByEntity(TENANT, UNMATCHED_SMS_ENTITY_TYPE, '+15555550123'),
    ).toHaveLength(1);
  });

  it('threads as unmatched when the resolver method is unavailable', async () => {
    const handler = createInboundCaptureHandler({
      conversationRepo,
      customerRepo: {},
      auditRepo,
    });

    const result = await handler.handle(ctx());
    expect(result.handled).toBe(true);
    expect(
      await conversationRepo.findByEntity(TENANT, UNMATCHED_SMS_ENTITY_TYPE, '+15555550123'),
    ).toHaveLength(1);
  });

  it('declines an empty/whitespace body without creating a thread', async () => {
    const findByPhoneNormalized = vi.fn();
    const handler = createInboundCaptureHandler({
      conversationRepo,
      customerRepo: { findByPhoneNormalized },
      auditRepo,
    });

    const result = await handler.handle(ctx({ body: '   ' }));
    expect(result).toEqual({ handled: false, handler: 'sms-capture', reason: 'empty_body' });
    expect(findByPhoneNormalized).not.toHaveBeenCalled();
  });

  it('declines (does not claim) when persistence fails, and logs', async () => {
    const logger = { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() };
    const failingRepo = {
      findByEntity: vi.fn().mockResolvedValue([]),
      createConversation: vi.fn().mockRejectedValue(new Error('db down')),
      addMessage: vi.fn(),
    };
    const handler = createInboundCaptureHandler({
      conversationRepo: failingRepo,
      customerRepo: { findByPhoneNormalized: vi.fn().mockResolvedValue([]) },
      auditRepo,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      logger: logger as any,
    });

    const result = await handler.handle(ctx());
    expect(result).toEqual({ handled: false, handler: 'sms-capture', reason: 'capture_error' });
    expect(logger.error).toHaveBeenCalled();
  });
});

describe('U4 — capture runs LAST in the dispatcher chain', () => {
  beforeEach(() => {
    __resetKeywordRegistryForTests();
  });

  it('captures a message no keyword handler claims', async () => {
    const captured: string[] = [];
    registerCaptureHandler({
      name: 'sms-capture',
      async handle(c) {
        captured.push(c.body);
        return { handled: true, handler: 'sms-capture' };
      },
    });

    const result = await dispatchInboundSms(ctx({ body: 'random free text' }));
    expect(result).toEqual({ handled: true, handler: 'sms-capture' });
    expect(captured).toEqual(['random free text']);
  });

  it('never sees a message a keyword handler already claimed (e.g. STOP)', async () => {
    const captured: string[] = [];
    registerKeywordHandler({
      keywords: ['stop'],
      async handle() {
        return { handled: true, handler: 'stop-reply' };
      },
    });
    registerCaptureHandler({
      name: 'sms-capture',
      async handle(c) {
        captured.push(c.body);
        return { handled: true, handler: 'sms-capture' };
      },
    });

    const result = await dispatchInboundSms(ctx({ body: 'STOP' }));
    expect(result.handler).toBe('stop-reply');
    expect(captured).toEqual([]);
  });
});
