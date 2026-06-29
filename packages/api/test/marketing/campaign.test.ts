import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  InMemoryCampaignRepository,
  createCampaign,
  resolveRecipients,
  sendCampaign,
  validateCampaignInput,
} from '../../src/marketing/campaign';
import { InMemoryCustomerRepository, type Customer } from '../../src/customers/customer';
import { InMemoryTagRepository } from '../../src/customers/tag';
import { InMemoryAuditRepository } from '../../src/audit/audit';
import type { MessageDeliveryProvider } from '../../src/notifications/delivery-provider';

const TENANT = '11111111-1111-1111-1111-111111111111';
const ACTOR = 'user-1';

function customer(over: Partial<Customer> = {}): Customer {
  const now = new Date();
  return {
    id: over.id ?? `c-${Math.random().toString(36).slice(2)}`,
    tenantId: TENANT,
    firstName: 'Pat',
    lastName: 'Property',
    displayName: 'Pat Property',
    preferredChannel: 'email',
    smsConsent: false,
    isArchived: false,
    createdBy: ACTOR,
    createdAt: now,
    updatedAt: now,
    ...over,
  };
}

describe('marketing campaigns (MKT) — pure', () => {
  it('validates required fields', () => {
    expect(validateCampaignInput({ name: '', subject: '', bodyText: '' })).toEqual([
      'name is required',
      'subject is required',
      'bodyText is required',
    ]);
    expect(
      validateCampaignInput({ name: 'Spring', subject: 'Hi', bodyText: 'Body' }),
    ).toHaveLength(0);
  });

  it('resolveRecipients drops archived + no-email and de-dupes by email', () => {
    const recips = resolveRecipients(
      [
        customer({ id: 'a', email: 'a@x.com' }),
        customer({ id: 'b', email: undefined }), // no email → dropped
        customer({ id: 'c', email: 'a@x.com' }), // dup email → collapsed
        customer({ id: 'd', email: 'd@x.com', isArchived: true }), // archived → dropped
      ],
      null,
    );
    expect(recips.map((r) => r.email).sort()).toEqual(['a@x.com']);
  });

  it('resolveRecipients honors a tag segment', () => {
    const recips = resolveRecipients(
      [
        customer({ id: 'a', email: 'a@x.com' }),
        customer({ id: 'b', email: 'b@x.com' }),
      ],
      new Set(['b']),
    );
    expect(recips.map((r) => r.customerId)).toEqual(['b']);
  });
});

describe('marketing campaigns (MKT) — orchestration', () => {
  let campaignRepo: InMemoryCampaignRepository;
  let customerRepo: InMemoryCustomerRepository;
  let tagRepo: InMemoryTagRepository;
  let audit: InMemoryAuditRepository;
  let delivery: MessageDeliveryProvider;
  let sendEmail: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    campaignRepo = new InMemoryCampaignRepository();
    customerRepo = new InMemoryCustomerRepository();
    tagRepo = new InMemoryTagRepository();
    audit = new InMemoryAuditRepository();
    sendEmail = vi.fn().mockResolvedValue({ providerMessageId: 'm', provider: 'test', channel: 'email' });
    delivery = { sendSms: vi.fn(), sendEmail } as unknown as MessageDeliveryProvider;
  });

  function deps() {
    return { campaignRepo, customerRepo, tagRepo, delivery, auditRepo: audit };
  }

  it('creates a draft and emits an audit event', async () => {
    const c = await createCampaign(
      { tenantId: TENANT, name: 'Spring promo', subject: 'Save', bodyText: 'Body', createdBy: ACTOR },
      campaignRepo,
      audit,
    );
    expect(c.status).toBe('draft');
    const events = await audit.findByEntity(TENANT, 'marketing_campaign', c.id);
    expect(events[0].eventType).toBe('marketing_campaign.created');
  });

  it('sends to all active customers with an email and records counts', async () => {
    await customerRepo.create(customer({ id: 'a', email: 'a@x.com' }));
    await customerRepo.create(customer({ id: 'b', email: 'b@x.com' }));
    await customerRepo.create(customer({ id: 'c', email: undefined })); // skipped
    const c = await createCampaign(
      { tenantId: TENANT, name: 'All', subject: 'Hi', bodyText: 'Body', createdBy: ACTOR },
      campaignRepo,
    );
    const sent = await sendCampaign(TENANT, c.id, deps(), ACTOR);
    expect(sent.status).toBe('sent');
    expect(sent.recipientCount).toBe(2);
    expect(sent.sentCount).toBe(2);
    expect(sendEmail).toHaveBeenCalledTimes(2);
    const events = await audit.findByEntity(TENANT, 'marketing_campaign', c.id);
    expect(events.some((e) => e.eventType === 'marketing_campaign.sent')).toBe(true);
  });

  it('targets a tag segment', async () => {
    await customerRepo.create(customer({ id: 'a', email: 'a@x.com' }));
    await customerRepo.create(customer({ id: 'b', email: 'b@x.com' }));
    await tagRepo.addTag(TENANT, 'b', 'vip');
    const c = await createCampaign(
      { tenantId: TENANT, name: 'VIP', subject: 'Hi', bodyText: 'Body', segmentTag: 'vip', createdBy: ACTOR },
      campaignRepo,
    );
    const sent = await sendCampaign(TENANT, c.id, deps(), ACTOR);
    expect(sent.recipientCount).toBe(1);
    expect(sendEmail).toHaveBeenCalledWith(expect.objectContaining({ to: 'b@x.com', subject: 'Hi' }));
  });

  it('targets a customer group via the group-member resolver', async () => {
    await customerRepo.create(customer({ id: 'a', email: 'a@x.com' }));
    await customerRepo.create(customer({ id: 'b', email: 'b@x.com' }));
    const groupMemberIds = vi.fn().mockResolvedValue(['a']);
    const c = await createCampaign(
      { tenantId: TENANT, name: 'Grp', subject: 'Hi', bodyText: 'Body', segmentGroupId: 'g1', createdBy: ACTOR },
      campaignRepo,
    );
    const sent = await sendCampaign(TENANT, c.id, { ...deps(), groupMemberIds }, ACTOR);
    expect(groupMemberIds).toHaveBeenCalledWith(TENANT, 'g1');
    expect(sent.recipientCount).toBe(1);
    expect(sendEmail).toHaveBeenCalledWith(expect.objectContaining({ to: 'a@x.com' }));
  });

  it('counts per-recipient failures without aborting', async () => {
    await customerRepo.create(customer({ id: 'a', email: 'a@x.com' }));
    await customerRepo.create(customer({ id: 'b', email: 'b@x.com' }));
    sendEmail.mockRejectedValueOnce(new Error('bounce')).mockResolvedValueOnce({
      providerMessageId: 'm',
      provider: 'test',
      channel: 'email',
    });
    const c = await createCampaign(
      { tenantId: TENANT, name: 'All', subject: 'Hi', bodyText: 'Body', createdBy: ACTOR },
      campaignRepo,
    );
    const sent = await sendCampaign(TENANT, c.id, deps(), ACTOR);
    expect(sent.sentCount).toBe(1);
    expect(sent.failedCount).toBe(1);
  });

  it('does not re-send an already-sent campaign', async () => {
    await customerRepo.create(customer({ id: 'a', email: 'a@x.com' }));
    const c = await createCampaign(
      { tenantId: TENANT, name: 'Once', subject: 'Hi', bodyText: 'Body', createdBy: ACTOR },
      campaignRepo,
    );
    await sendCampaign(TENANT, c.id, deps(), ACTOR);
    sendEmail.mockClear();
    const again = await sendCampaign(TENANT, c.id, deps(), ACTOR);
    expect(again.status).toBe('sent');
    expect(sendEmail).not.toHaveBeenCalled();
  });
});
