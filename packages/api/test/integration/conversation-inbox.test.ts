import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { getSharedTestDb, createTestTenant, closeSharedTestDb } from './shared';
import { PgConversationRepository } from '../../src/conversations/pg-conversation';
import { PgCustomerRepository } from '../../src/customers/pg-customer';
import { PgLeadRepository } from '../../src/leads/pg-lead';
import type { Customer } from '../../src/customers/customer';
import type { Lead } from '../../src/leads/lead';

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

describe('Postgres integration — U5 inbox thread listing', () => {
  let pool: Pool;
  let conversationRepo: PgConversationRepository;
  let customerRepo: PgCustomerRepository;
  let leadRepo: PgLeadRepository;
  let tenant: { tenantId: string; userId: string };

  beforeAll(async () => {
    pool = await getSharedTestDb();
    conversationRepo = new PgConversationRepository(pool);
    customerRepo = new PgCustomerRepository(pool);
    leadRepo = new PgLeadRepository(pool);
    tenant = await createTestTenant(pool);
  });

  afterAll(async () => {
    await closeSharedTestDb();
  });

  it('lists customer + unmatched comms threads with the customer name joined, newest-inbound first', async () => {
    const customer = await customerRepo.create(
      baseCustomer(tenant.tenantId, tenant.userId, {
        displayName: 'Dana Diaz',
        primaryPhone: '+15555552001',
      }),
    );

    // Customer thread — last message inbound (needs reply).
    const custThread = await conversationRepo.createConversation({
      tenantId: tenant.tenantId,
      title: 'Dana Diaz',
      entityType: 'customer',
      entityId: customer.id,
      createdBy: tenant.userId,
    });
    await conversationRepo.addMessage({
      tenantId: tenant.tenantId,
      conversationId: custThread.id,
      messageType: 'text',
      content: 'thanks!',
      senderId: tenant.userId,
      senderRole: 'owner',
      source: 'sms',
      metadata: { direction: 'outbound', channel: 'sms' },
    });
    await conversationRepo.addMessage({
      tenantId: tenant.tenantId,
      conversationId: custThread.id,
      messageType: 'text',
      content: 'one more question',
      senderId: '+15555552001',
      senderRole: 'customer',
      source: 'sms',
      metadata: { direction: 'inbound', channel: 'sms' },
    });

    // Unmatched phone thread — last message inbound.
    const unmatched = await conversationRepo.createConversation({
      tenantId: tenant.tenantId,
      title: 'SMS from +15555559001',
      entityType: 'sms_unmatched',
      entityId: '+15555559001',
      createdBy: 'system:sms-capture',
    });
    await conversationRepo.addMessage({
      tenantId: tenant.tenantId,
      conversationId: unmatched.id,
      messageType: 'text',
      content: 'hello?',
      senderId: '+15555559001',
      senderRole: 'customer',
      source: 'sms',
      metadata: { direction: 'inbound', channel: 'sms' },
    });

    // A lead-linked thread (unknown-caller capture) — the lead's name is
    // joined into the summary.
    const now = new Date();
    const lead: Lead = {
      id: crypto.randomUUID(),
      tenantId: tenant.tenantId,
      firstName: 'Robin',
      lastName: 'Rivera',
      primaryPhone: '+15555559500',
      source: 'phone_call',
      sourceDetail: 'Inbound text',
      stage: 'new',
      createdBy: 'system:sms-capture',
      createdAt: now,
      updatedAt: now,
    };
    await leadRepo.create(lead);
    const leadThread = await conversationRepo.createConversation({
      tenantId: tenant.tenantId,
      title: 'Robin Rivera',
      entityType: 'lead',
      entityId: lead.id,
      createdBy: 'system:sms-capture',
    });
    await conversationRepo.addMessage({
      tenantId: tenant.tenantId,
      conversationId: leadThread.id,
      messageType: 'text',
      content: 'do you do drywall?',
      senderId: '+15555559500',
      senderRole: 'customer',
      source: 'sms',
      metadata: { direction: 'inbound', channel: 'sms' },
    });

    // A non-comms (job) conversation — must be excluded.
    const jobThread = await conversationRepo.createConversation({
      tenantId: tenant.tenantId,
      title: 'job thread',
      entityType: 'job',
      entityId: crypto.randomUUID(),
      createdBy: tenant.userId,
    });
    await conversationRepo.addMessage({
      tenantId: tenant.tenantId,
      conversationId: jobThread.id,
      messageType: 'text',
      content: 'internal note',
      senderId: tenant.userId,
      senderRole: 'owner',
    });

    const threads = await conversationRepo.listInboxThreads(tenant.tenantId);
    const ids = threads.map((t) => t.conversation.id);

    expect(ids).toContain(custThread.id);
    expect(ids).toContain(unmatched.id);
    expect(ids).toContain(leadThread.id);
    expect(ids).not.toContain(jobThread.id);

    const cust = threads.find((t) => t.conversation.id === custThread.id)!;
    expect(cust.customerName).toBe('Dana Diaz');
    expect(cust.needsReply).toBe(true);
    expect(cust.lastMessagePreview).toBe('one more question');
    expect(cust.messageCount).toBe(2);

    const un = threads.find((t) => t.conversation.id === unmatched.id)!;
    expect(un.customerName).toBeUndefined();
    expect(un.needsReply).toBe(true);

    const ld = threads.find((t) => t.conversation.id === leadThread.id)!;
    expect(ld.customerName).toBe('Robin Rivera');
    expect(ld.needsReply).toBe(true);
  });

  /**
   * G1 (#1009 on #1013), row 9.12: the prior version of this test seeded
   * NOTHING for the neighbour tenant, so `otherThreads.every(...)` over an
   * empty array was vacuously true — it could not have caught a leak. This
   * seeds a real unanswered thread for a second ("neighbour") tenant and
   * asserts it surfaces in ITS OWN listing (sanity — the fixture is real)
   * but never in the first tenant's.
   */
  it('T1: a neighbour tenant’s unanswered thread never appears in another tenant’s inbox listing', async () => {
    const neighbourTenant = await createTestTenant(pool);
    const neighbourCustomer = await customerRepo.create(
      baseCustomer(neighbourTenant.tenantId, neighbourTenant.userId, {
        displayName: 'Neighbour Nolan',
        primaryPhone: '+15555553001',
      }),
    );
    const neighbourThread = await conversationRepo.createConversation({
      tenantId: neighbourTenant.tenantId,
      title: 'Neighbour Nolan',
      entityType: 'customer',
      entityId: neighbourCustomer.id,
      createdBy: neighbourTenant.userId,
    });
    await conversationRepo.addMessage({
      tenantId: neighbourTenant.tenantId,
      conversationId: neighbourThread.id,
      messageType: 'text',
      content: 'are you open Saturday?',
      senderId: '+15555553001',
      senderRole: 'customer',
      source: 'sms',
      metadata: { direction: 'inbound', channel: 'sms' },
    });

    const neighbourThreads = await conversationRepo.listInboxThreads(neighbourTenant.tenantId);
    expect(neighbourThreads.map((t) => t.conversation.id)).toContain(neighbourThread.id);

    const firstTenantThreads = await conversationRepo.listInboxThreads(tenant.tenantId);
    expect(firstTenantThreads.map((t) => t.conversation.id)).not.toContain(neighbourThread.id);
    expect(firstTenantThreads.every((t) => t.conversation.tenantId === tenant.tenantId)).toBe(true);
  });

  /**
   * "Reply drafts" (the second half of 9.12's story — "with a reply
   * drafted for me") do not exist anywhere in the codebase: InboxThreadSummary
   * (conversation-service.ts:82-93) carries no draft field, there is no
   * `replyDraft`/`draftReply` type or table, and no AI-drafting call site
   * feeds this listing. it.fails documents the gap rather than asserting a
   * feature that isn't wired — a real draft-storage implementation should
   * turn this test red (failing to fail), not green.
   */
  it.fails('story claim not met in code: a neighbour tenant’s draft reply is never visible', async () => {
    // A real seeded thread, not an empty listing — otherwise threads[0] is
    // `undefined` and this sentinel fails for "no thread exists" rather than
    // "no replyDraft field exists", and would keep passing (vacuously) even
    // after a real draft feature is wired. Caught in review on this PR.
    const neighbourTenant = await createTestTenant(pool);
    const neighbourCustomer = await customerRepo.create(
      baseCustomer(neighbourTenant.tenantId, neighbourTenant.userId, {
        displayName: 'Sentinel Sam',
        primaryPhone: '+15555554001',
      }),
    );
    const neighbourThread = await conversationRepo.createConversation({
      tenantId: neighbourTenant.tenantId,
      title: 'Sentinel Sam',
      entityType: 'customer',
      entityId: neighbourCustomer.id,
      createdBy: neighbourTenant.userId,
    });
    await conversationRepo.addMessage({
      tenantId: neighbourTenant.tenantId,
      conversationId: neighbourThread.id,
      messageType: 'text',
      content: 'can you fit me in tomorrow?',
      senderId: '+15555554001',
      senderRole: 'customer',
      source: 'sms',
      metadata: { direction: 'inbound', channel: 'sms' },
    });

    const threads = await conversationRepo.listInboxThreads(neighbourTenant.tenantId);
    const thread = threads.find((t) => t.conversation.id === neighbourThread.id);
    // No such field exists today — this assertion is what a real
    // reply-draft feature would need to satisfy.
    expect(thread).toHaveProperty('replyDraft');
  });
});
