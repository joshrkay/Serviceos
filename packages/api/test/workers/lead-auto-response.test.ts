import { describe, it, expect, beforeEach } from 'vitest';
import {
  createLeadAutoResponseWorker,
  LEAD_AUTO_RESPONSE_JOB_TYPE,
  type LeadAutoResponsePayload,
} from '../../src/workers/lead-auto-response';
import { InMemoryLeadRepository, type Lead } from '../../src/leads/lead';
import { InMemoryAuditRepository } from '../../src/audit/audit';
import { InMemorySettingsRepository } from '../../src/settings/settings';
import { InMemoryConversationRepository } from '../../src/conversations/conversation-service';
import { InMemoryDispatchRepository } from '../../src/notifications/dispatch-repository';
import { InMemoryDncRepository } from '../../src/compliance/dnc';
import { InMemoryDeliveryProvider } from '../../src/notifications/delivery-provider';
import { createLogger } from '../../src/logging/logger';
import type { QueueMessage } from '../../src/queues/queue';
import type { LLMGateway } from '../../src/ai/gateway/gateway';

const logger = createLogger({ service: 'test', environment: 'test' });
const TENANT = '11111111-1111-4111-8111-111111111111';

function makeLead(overrides: Partial<Lead> = {}): Lead {
  const now = new Date();
  return {
    id: crypto.randomUUID(),
    tenantId: TENANT,
    firstName: 'Sandra',
    lastName: 'Wu',
    source: 'web_form',
    stage: 'new',
    primaryPhone: '5125550100',
    email: 'sandra@example.com',
    smsConsent: false,
    createdBy: 'public_intake',
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function msg(payload: LeadAutoResponsePayload): QueueMessage<LeadAutoResponsePayload> {
  return {
    id: crypto.randomUUID(),
    type: LEAD_AUTO_RESPONSE_JOB_TYPE,
    payload,
    attempts: 1,
    maxAttempts: 3,
    idempotencyKey: `${LEAD_AUTO_RESPONSE_JOB_TYPE}:${payload.leadId}`,
    createdAt: new Date().toISOString(),
  };
}

describe('lead-auto-response worker', () => {
  let leadRepo: InMemoryLeadRepository;
  let auditRepo: InMemoryAuditRepository;
  let settingsRepo: InMemorySettingsRepository;
  let conversationRepo: InMemoryConversationRepository;
  let dispatchRepo: InMemoryDispatchRepository;
  let dncRepo: InMemoryDncRepository;
  let delivery: InMemoryDeliveryProvider;

  function buildWorker(gateway?: LLMGateway) {
    return createLeadAutoResponseWorker({
      leadRepo,
      settingsRepo,
      conversationRepo,
      dispatchRepo,
      dncRepo,
      auditRepo,
      gateway,
      delivery,
    });
  }

  beforeEach(() => {
    leadRepo = new InMemoryLeadRepository();
    auditRepo = new InMemoryAuditRepository();
    settingsRepo = new InMemorySettingsRepository();
    conversationRepo = new InMemoryConversationRepository();
    dispatchRepo = new InMemoryDispatchRepository();
    dncRepo = new InMemoryDncRepository();
    delivery = new InMemoryDeliveryProvider();
  });

  it('sends an SMS when consent is given and logs to the lead thread', async () => {
    const lead = await leadRepo.create(makeLead({ smsConsent: true }));
    await buildWorker().handle(msg({ tenantId: TENANT, leadId: lead.id }), logger);

    expect(delivery.sentSms).toHaveLength(1);
    expect(delivery.sentSms[0].to).toBe('5125550100');
    expect(delivery.sentSms[0].body).toContain('Reply STOP');

    const threads = await conversationRepo.findByEntity(TENANT, 'lead', lead.id);
    expect(threads).toHaveLength(1);
    const messages = await conversationRepo.getMessages(TENANT, threads[0].id);
    expect(messages.some((m) => m.source === 'lead_auto_response')).toBe(true);

    expect(auditRepo.getAll().some((a) => a.eventType === 'lead.auto_responded')).toBe(true);
  });

  it('does not send SMS without consent, but still sends email + logs', async () => {
    const lead = await leadRepo.create(makeLead({ smsConsent: false }));
    await buildWorker().handle(msg({ tenantId: TENANT, leadId: lead.id }), logger);

    expect(delivery.sentSms).toHaveLength(0);
    expect(delivery.sentEmails).toHaveLength(1);
    const threads = await conversationRepo.findByEntity(TENANT, 'lead', lead.id);
    const messages = await conversationRepo.getMessages(TENANT, threads[0].id);
    expect(messages.some((m) => m.source === 'lead_auto_response')).toBe(true);
  });

  it('respects DNC even with consent (no SMS)', async () => {
    const lead = await leadRepo.create(makeLead({ smsConsent: true }));
    await dncRepo.addToDnc(TENANT, '5125550100', 'test');
    await buildWorker().handle(msg({ tenantId: TENANT, leadId: lead.id }), logger);
    expect(delivery.sentSms).toHaveLength(0);
  });

  it('is idempotent — a second run does not re-send or duplicate the thread message', async () => {
    const lead = await leadRepo.create(makeLead({ smsConsent: true }));
    const worker = buildWorker();
    await worker.handle(msg({ tenantId: TENANT, leadId: lead.id }), logger);
    await worker.handle(msg({ tenantId: TENANT, leadId: lead.id }), logger);

    expect(delivery.sentSms).toHaveLength(1);
    const threads = await conversationRepo.findByEntity(TENANT, 'lead', lead.id);
    const messages = await conversationRepo.getMessages(TENANT, threads[0].id);
    expect(messages.filter((m) => m.source === 'lead_auto_response')).toHaveLength(1);
  });

  it('uses gateway-generated copy when available', async () => {
    const lead = await leadRepo.create(makeLead({ smsConsent: true }));
    const fakeGateway = {
      complete: async () => ({
        content: 'Hi Sandra, thanks! We will call you shortly. Reply STOP to opt out.',
        model: 'm',
        provider: 'p',
        tokenUsage: { input: 1, output: 1, total: 2 },
        latencyMs: 1,
      }),
    } as unknown as LLMGateway;

    await buildWorker(fakeGateway).handle(msg({ tenantId: TENANT, leadId: lead.id }), logger);
    expect(delivery.sentSms[0].body).toContain('We will call you shortly');
    expect(delivery.sentSms[0].body).toContain('Reply STOP');
  });

  it('falls back to deterministic copy when the gateway throws', async () => {
    const lead = await leadRepo.create(makeLead({ smsConsent: true }));
    const throwingGateway = {
      complete: async () => {
        throw new Error('gateway down');
      },
    } as unknown as LLMGateway;

    await buildWorker(throwingGateway).handle(msg({ tenantId: TENANT, leadId: lead.id }), logger);
    expect(delivery.sentSms).toHaveLength(1);
    expect(delivery.sentSms[0].body).toContain('thanks for reaching out');
  });

  it('skips a lead with no contact channel', async () => {
    const lead = await leadRepo.create(
      makeLead({ primaryPhone: undefined, email: undefined }),
    );
    await buildWorker().handle(msg({ tenantId: TENANT, leadId: lead.id }), logger);
    expect(delivery.sentSms).toHaveLength(0);
    expect(delivery.sentEmails).toHaveLength(0);
    expect(await conversationRepo.findByEntity(TENANT, 'lead', lead.id)).toHaveLength(0);
  });
});
