import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { InMemoryLeadRepository } from '../../src/leads/lead';
import { createLead, isPhoneOriginatedLeadSource } from '../../src/leads/lead-service';
import { findOrCreateLeadByPhone } from '../../src/ai/skills/find-or-create-lead';
import { InMemoryAuditRepository } from '../../src/audit/audit';
import { OwnerNotificationService } from '../../src/notifications/owner-notification-service';
import { InMemoryPushDeliveryProvider } from '../../src/notifications/push-delivery-provider';
import { InMemoryDeviceTokenRepository } from '../../src/push/device-token-service';
import { setOwnerNotifications } from '../../src/notifications/owner-notifications-instance';

const TENANT = '00000000-0000-4000-8000-00000000000a';

describe('lead_captured owner push (U6)', () => {
  let leadRepo: InMemoryLeadRepository;
  let auditRepo: InMemoryAuditRepository;
  let provider: InMemoryPushDeliveryProvider;

  beforeEach(async () => {
    leadRepo = new InMemoryLeadRepository();
    auditRepo = new InMemoryAuditRepository();

    const tokenRepo = new InMemoryDeviceTokenRepository();
    await tokenRepo.register({
      tenantId: TENANT,
      userId: 'owner-1',
      expoPushToken: 'ExponentPushToken[lead-owner]',
      platform: 'ios',
    });
    provider = new InMemoryPushDeliveryProvider();
    setOwnerNotifications(
      new OwnerNotificationService({ deviceTokenRepo: tokenRepo, provider }),
    );
  });

  afterEach(() => {
    setOwnerNotifications(undefined);
  });

  it('classifies only phone_call as phone-originated', () => {
    expect(isPhoneOriginatedLeadSource('phone_call')).toBe(true);
    expect(isPhoneOriginatedLeadSource('web_form')).toBe(false);
    expect(isPhoneOriginatedLeadSource('sms')).toBe(false);
    expect(isPhoneOriginatedLeadSource('referral')).toBe(false);
  });

  it('fires lead_captured for a web/manual lead', async () => {
    const lead = await createLead(
      {
        tenantId: TENANT,
        firstName: 'Alice',
        lastName: 'Wong',
        source: 'web_form',
        createdBy: 'user-1',
        actorRole: 'owner',
      },
      leadRepo,
      auditRepo,
    );

    expect(provider.sent).toHaveLength(1);
    const msg = provider.sent[0];
    expect(msg.data?.type).toBe('lead_captured');
    expect(msg.data?.entityId).toBe(lead.id);
    expect(msg.body).toContain('Alice Wong');
  });

  it('does NOT fire lead_captured for a phone-originated (web path) lead', async () => {
    await createLead(
      {
        tenantId: TENANT,
        firstName: 'Voicemail',
        lastName: 'Caller',
        source: 'phone_call',
        createdBy: 'voicemail_webhook',
        actorRole: 'system',
      },
      leadRepo,
      auditRepo,
    );

    expect(provider.sent).toHaveLength(0);
  });

  it('does NOT fire lead_captured for an inbound-call lead (find-or-create default source)', async () => {
    const result = await findOrCreateLeadByPhone({
      tenantId: TENANT,
      fromPhone: '+15125550100',
      leadRepo,
      auditRepo,
    });

    expect(result.status).toBe('created');
    expect(result.lead.source).toBe('phone_call');
    expect(provider.sent).toHaveLength(0);
  });

  it('fires lead_captured for an SMS-capture lead (text channel, not a call)', async () => {
    const result = await findOrCreateLeadByPhone({
      tenantId: TENANT,
      fromPhone: '+15125550199',
      leadRepo,
      auditRepo,
      source: 'sms',
      channelLabel: 'text',
      auditVia: 'sms_capture',
    });

    expect(result.status).toBe('created');
    expect(provider.sent).toHaveLength(1);
    expect(provider.sent[0].data?.type).toBe('lead_captured');
  });

  it('does not block lead creation when no notifier is registered', async () => {
    setOwnerNotifications(undefined);
    const lead = await createLead(
      { tenantId: TENANT, firstName: 'Bob', source: 'web_form', createdBy: 'u1' },
      leadRepo,
      auditRepo,
    );
    expect(lead.id).toBeTruthy();
    expect(provider.sent).toHaveLength(0);
  });
});
