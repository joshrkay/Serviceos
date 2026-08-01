/**
 * P8-015 / P0-037 — production RecoveryThreader (createRecoveryThreader).
 *
 * Pins: thread-target parity with inbound capture (known customer → customer
 * thread; unknown → sms_unmatched), open-thread reuse, the outbound message
 * row's inbox metadata, both P0-037 links, idempotent re-threading, and the
 * single dropped_call_recovery.threaded audit event. The real-Postgres
 * outcome (outbound + later inbound land on ONE conversation, RLS on links)
 * is pinned in test/integration/dropped-call-worker.test.ts.
 */
import { describe, expect, it, beforeEach } from 'vitest';
import { createRecoveryThreader } from '../../../src/sms/recovery/recovery-threader';
import { InMemoryConversationRepository } from '../../../src/conversations/conversation-service';
import { InMemoryConversationLinkRepository } from '../../../src/conversations/linkage';
import { InMemoryAuditRepository } from '../../../src/audit/audit';
import { createLogger } from '../../../src/logging/logger';
import type { Customer } from '../../../src/customers/customer';

const logger = createLogger({ service: 'test', environment: 'test', level: 'error' });
const TENANT = '00000000-0000-0000-0000-000000000001';
const SESSION = '00000000-0000-0000-0000-0000000000aa';
const E164 = '+15551234567';
const SID = 'SM_recovery_1';
const BODY = 'Hi — this is Shop. We got cut off on your call.';

function makeCustomerRepo(customers: Customer[]) {
  return {
    async findByPhoneNormalized(_tenantId: string, _phone: string): Promise<Customer[]> {
      return customers;
    },
  };
}

describe('createRecoveryThreader', () => {
  let conversationRepo: InMemoryConversationRepository;
  let conversationLinkRepo: InMemoryConversationLinkRepository;
  let auditRepo: InMemoryAuditRepository;

  beforeEach(() => {
    conversationRepo = new InMemoryConversationRepository();
    conversationLinkRepo = new InMemoryConversationLinkRepository();
    auditRepo = new InMemoryAuditRepository();
  });

  function makeThreader(customers: Customer[]) {
    return createRecoveryThreader({
      conversationRepo,
      conversationLinkRepo,
      customerRepo: makeCustomerRepo(customers),
      auditRepo,
      logger,
    });
  }

  const KNOWN_CUSTOMER = {
    id: 'cust-1',
    displayName: 'Dana Vega',
  } as Customer;

  it('threads onto the known customer thread with the outbound inbox message + both links', async () => {
    const thread = makeThreader([KNOWN_CUSTOMER]);

    await thread({
      tenantId: TENANT,
      voiceSessionId: SESSION,
      smsMessageSid: SID,
      callerE164: E164,
      body: BODY,
    });

    const conversations = await conversationRepo.findByEntity(TENANT, 'customer', 'cust-1');
    expect(conversations).toHaveLength(1);
    const conversation = conversations[0];

    const messages = await conversationRepo.getMessages(TENANT, conversation.id);
    expect(messages).toHaveLength(1);
    expect(messages[0].content).toBe(BODY);
    expect(messages[0].metadata).toMatchObject({
      direction: 'outbound',
      channel: 'sms',
      messageSid: SID,
      voiceSessionId: SESSION,
      customerId: 'cust-1',
    });

    const links = await conversationLinkRepo.findByConversation(TENANT, conversation.id);
    expect(links).toHaveLength(2);
    expect(links.map((l) => `${l.entityType}:${l.entityId}`).sort()).toEqual([
      `sms_conversation:${SID}`,
      `voice_session:${SESSION}`,
    ]);

    const threaded = auditRepo.events.find(
      (e) => e.eventType === 'dropped_call_recovery.threaded',
    );
    expect(threaded?.entityId).toBe(conversation.id);
    expect(threaded?.metadata).toMatchObject({
      voiceSessionId: SESSION,
      smsMessageSid: SID,
      threadEntityType: 'customer',
    });
    // Conversation creation itself is audited too (createConversationWithAudit).
    expect(
      auditRepo.events.some((e) => e.eventType === 'conversation.created'),
    ).toBe(true);
  });

  it('reuses an existing OPEN thread instead of creating a duplicate', async () => {
    const existing = await conversationRepo.createConversation({
      tenantId: TENANT,
      entityType: 'customer',
      entityId: 'cust-1',
      createdBy: 'someone-else',
      title: 'Dana Vega',
    });

    const thread = makeThreader([KNOWN_CUSTOMER]);
    await thread({
      tenantId: TENANT,
      voiceSessionId: SESSION,
      smsMessageSid: SID,
      callerE164: E164,
      body: BODY,
    });

    const conversations = await conversationRepo.findByEntity(TENANT, 'customer', 'cust-1');
    expect(conversations).toHaveLength(1);
    expect(conversations[0].id).toBe(existing.id);
    expect(await conversationRepo.getMessages(TENANT, existing.id)).toHaveLength(1);
  });

  it('unknown caller (no lead repo) threads under sms_unmatched keyed by E.164', async () => {
    const thread = makeThreader([]);
    await thread({
      tenantId: TENANT,
      voiceSessionId: SESSION,
      smsMessageSid: SID,
      callerE164: E164,
      body: BODY,
    });

    const conversations = await conversationRepo.findByEntity(TENANT, 'sms_unmatched', E164);
    expect(conversations).toHaveLength(1);
    const messages = await conversationRepo.getMessages(TENANT, conversations[0].id);
    expect(messages[0].metadata).toMatchObject({ direction: 'outbound', messageSid: SID });
  });

  it('re-threading after a partial failure duplicates neither links nor threads', async () => {
    const thread = makeThreader([KNOWN_CUSTOMER]);
    const input = {
      tenantId: TENANT,
      voiceSessionId: SESSION,
      smsMessageSid: SID,
      callerE164: E164,
      body: BODY,
    };
    await thread(input);
    await thread(input);

    const conversations = await conversationRepo.findByEntity(TENANT, 'customer', 'cust-1');
    expect(conversations).toHaveLength(1);
    // Links dedupe on the four-tuple (Pg: ON CONFLICT; in-memory mirrors by id
    // — assert via findByEntity to be implementation-neutral).
    const sessionLinks = await conversationLinkRepo.findByEntity(
      TENANT,
      'voice_session',
      SESSION,
    );
    expect(sessionLinks.map((l) => l.conversationId)).toEqual(
      Array.from(new Set(sessionLinks.map((l) => l.conversationId))),
    );
  });

  it('propagates a link-repo failure so the handler counts it (best-effort at that layer)', async () => {
    const failingLinks = {
      async create() {
        throw new Error('links table down');
      },
      async findByConversation() {
        return [];
      },
      async findByEntity() {
        return [];
      },
      async delete() {
        return false;
      },
    };
    const thread = createRecoveryThreader({
      conversationRepo,
      conversationLinkRepo: failingLinks,
      customerRepo: makeCustomerRepo([KNOWN_CUSTOMER]),
      auditRepo,
      logger,
    });

    await expect(
      thread({
        tenantId: TENANT,
        voiceSessionId: SESSION,
        smsMessageSid: SID,
        callerE164: E164,
        body: BODY,
      }),
    ).rejects.toThrow('links table down');
    // The message row landed before the failure — the caller (handler) logs
    // and moves on; the SMS is never re-sent for a threading failure.
    const conversations = await conversationRepo.findByEntity(TENANT, 'customer', 'cust-1');
    expect(await conversationRepo.getMessages(TENANT, conversations[0].id)).toHaveLength(1);
  });
});
