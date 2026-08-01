import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { getSharedTestDb, createTestTenant, closeSharedTestDb } from './shared';
import { PgConversationRepository } from '../../src/conversations/pg-conversation';
import { PgCustomerRepository } from '../../src/customers/pg-customer';
import { PgLeadRepository } from '../../src/leads/pg-lead';
import type { Customer } from '../../src/customers/customer';
import {
  createInboundCaptureHandler,
  UNMATCHED_SMS_ENTITY_TYPE,
} from '../../src/sms/inbound-capture';

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

describe('Postgres integration — U4 inbound SMS capture', () => {
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

  it('resolves the sender phone to a customer and threads the inbound text (real columns pinned)', async () => {
    const customer = await customerRepo.create(
      baseCustomer(tenant.tenantId, tenant.userId, { primaryPhone: '+15555550199' }),
    );

    const handler = createInboundCaptureHandler({ conversationRepo, customerRepo });
    const result = await handler.handle({
      tenantId: tenant.tenantId,
      fromE164: '+15555550199',
      body: 'is the tech still coming?',
      messageSid: 'SM-int-1',
    });
    expect(result).toEqual({ handled: true, handler: 'sms-capture' });

    const threads = await conversationRepo.findByEntity(
      tenant.tenantId,
      'customer',
      customer.id,
    );
    expect(threads).toHaveLength(1);

    const messages = await conversationRepo.getMessages(tenant.tenantId, threads[0].id);
    expect(messages).toHaveLength(1);
    // Pin the real persisted columns — channel=sms, inbound direction, body.
    expect(messages[0].content).toBe('is the tech still coming?');
    expect(messages[0].source).toBe('sms');
    expect(messages[0].senderRole).toBe('customer');
    expect(messages[0].metadata).toMatchObject({ direction: 'inbound', channel: 'sms' });
  });

  it('appends a second inbound text onto the same open thread', async () => {
    const customer = await customerRepo.create(
      baseCustomer(tenant.tenantId, tenant.userId, { primaryPhone: '+15555550200' }),
    );
    const handler = createInboundCaptureHandler({ conversationRepo, customerRepo });

    await handler.handle({
      tenantId: tenant.tenantId,
      fromE164: '+15555550200',
      body: 'first',
      messageSid: 'SM-int-2a',
    });
    await handler.handle({
      tenantId: tenant.tenantId,
      fromE164: '+15555550200',
      body: 'second',
      messageSid: 'SM-int-2b',
    });

    const threads = await conversationRepo.findByEntity(
      tenant.tenantId,
      'customer',
      customer.id,
    );
    expect(threads).toHaveLength(1);
    const messages = await conversationRepo.getMessages(tenant.tenantId, threads[0].id);
    expect(messages.map((m) => m.content)).toEqual(['first', 'second']);
  });

  it('find-or-creates a lead for an unknown number and threads onto it (deduped on repeat)', async () => {
    const handler = createInboundCaptureHandler({ conversationRepo, customerRepo, leadRepo });
    const first = await handler.handle({
      tenantId: tenant.tenantId,
      fromE164: '+15555559999',
      body: 'hello?',
      messageSid: 'SM-int-3a',
    });
    expect(first.handled).toBe(true);

    // normalizePhone (and the leads phone_normalized generated column) strip the
    // leading country-code '1' from an 11-digit number: +15555559999 → 5555559999.
    const lead = await leadRepo.findByPhoneNormalized(tenant.tenantId, '5555559999');
    expect(lead).not.toBeNull();
    expect(lead!.primaryPhone).toBe('+15555559999');
    // Tagged 'sms' (distinct from call-origin leads) — pins the leads_source_check
    // migration accepts the value at the DB layer.
    expect(lead!.source).toBe('sms');

    const threads = await conversationRepo.findByEntity(tenant.tenantId, 'lead', lead!.id);
    expect(threads).toHaveLength(1);

    // A second text dedupes onto the same lead + thread.
    await handler.handle({
      tenantId: tenant.tenantId,
      fromE164: '+15555559999',
      body: 'still there?',
      messageSid: 'SM-int-3b',
    });
    const after = await conversationRepo.findByEntity(tenant.tenantId, 'lead', lead!.id);
    expect(after).toHaveLength(1);
    const messages = await conversationRepo.getMessages(tenant.tenantId, after[0].id);
    expect(messages.map((m) => m.content)).toEqual(['hello?', 'still there?']);
  });

  it('threads as unmatched when no lead repo is wired', async () => {
    const handler = createInboundCaptureHandler({ conversationRepo, customerRepo });
    const result = await handler.handle({
      tenantId: tenant.tenantId,
      fromE164: '+15555558888',
      body: 'anyone?',
      messageSid: 'SM-int-3c',
    });
    expect(result.handled).toBe(true);
    const threads = await conversationRepo.findByEntity(
      tenant.tenantId,
      UNMATCHED_SMS_ENTITY_TYPE,
      '+15555558888',
    );
    expect(threads).toHaveLength(1);
  });

  it('collapses concurrent unmatched-number captures to one open thread (migration 200 index)', async () => {
    // Two texts from the same unknown number arrive at once. Without migration
    // 200's uq_conversations_open_noncustomer index (and the 23505 recovery in
    // openOrAppendConversation), each could lose the open-thread race and split
    // into two parallel sms_unmatched threads. They must collapse to one.
    const handler = createInboundCaptureHandler({ conversationRepo, customerRepo });
    const from = '+15555557777';
    const results = await Promise.all([
      handler.handle({ tenantId: tenant.tenantId, fromE164: from, body: 'a', messageSid: 'SM-int-5a' }),
      handler.handle({ tenantId: tenant.tenantId, fromE164: from, body: 'b', messageSid: 'SM-int-5b' }),
    ]);
    expect(results.every((r) => r.handled)).toBe(true);

    const threads = await conversationRepo.findByEntity(
      tenant.tenantId,
      UNMATCHED_SMS_ENTITY_TYPE,
      from,
    );
    const open = threads.filter((t) => t.status === 'open');
    expect(open).toHaveLength(1);
    const messages = await conversationRepo.getMessages(tenant.tenantId, open[0].id);
    expect(messages.map((m) => m.content).sort()).toEqual(['a', 'b']);
  });

  it('collapses concurrent new-lead captures to one open thread (migration 200 index)', async () => {
    // Same race for a brand-new lead: two simultaneous texts find-or-create the
    // lead and then both try to open its thread. Migration 200 covers 'lead'
    // too, so the recovery re-reads the winner and both texts land on it.
    const handler = createInboundCaptureHandler({ conversationRepo, customerRepo, leadRepo });
    const from = '+15555556666';
    await Promise.all([
      handler.handle({ tenantId: tenant.tenantId, fromE164: from, body: 'x', messageSid: 'SM-int-6a' }),
      handler.handle({ tenantId: tenant.tenantId, fromE164: from, body: 'y', messageSid: 'SM-int-6b' }),
    ]);

    const lead = await leadRepo.findByPhoneNormalized(tenant.tenantId, '5555556666');
    expect(lead).not.toBeNull();
    const threads = await conversationRepo.findByEntity(tenant.tenantId, 'lead', lead!.id);
    const open = threads.filter((t) => t.status === 'open');
    expect(open).toHaveLength(1);
  });

  it('does not bleed a captured thread across tenants', async () => {
    const other = await createTestTenant(pool);
    const customer = await customerRepo.create(
      baseCustomer(tenant.tenantId, tenant.userId, { primaryPhone: '+15555550222' }),
    );
    const handler = createInboundCaptureHandler({ conversationRepo, customerRepo });
    await handler.handle({
      tenantId: tenant.tenantId,
      fromE164: '+15555550222',
      body: 'private',
      messageSid: 'SM-int-4',
    });

    const threads = await conversationRepo.findByEntity(
      tenant.tenantId,
      'customer',
      customer.id,
    );
    expect(threads).toHaveLength(1);
    const fromOther = await conversationRepo.findById(other.tenantId, threads[0].id);
    expect(fromOther).toBeNull();
  });
});
