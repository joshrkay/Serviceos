import { describe, expect, it, vi } from 'vitest';

import {
  attachNumberAndConfigureWebhook,
  configureOptionalCnam,
  createTwilioMessagingService,
  createTwilioSubaccount,
  initiateTenDlcBrandAndCampaign,
  searchNumberLadder,
  type TwilioProvisioningClient,
} from '../../src/integrations/twilio/provisioning';

describe('twilio provisioning integration', () => {
  it('returns normalized IDs for happy path flows', async () => {
    const client: TwilioProvisioningClient = {
      createSubaccount: vi.fn(async () => ({ sid: 'AC123' })),
      createMessagingService: vi.fn(async () => ({ sid: 'MG123' })),
      initiateBrandRegistration: vi.fn(async () => ({ brandSid: 'BN123' })),
      initiateCampaignRegistration: vi.fn(async () => ({ campaignSid: 'CP123' })),
      searchAvailableNumbers: vi.fn(async () => [{ phoneNumber: '+15555550123', locality: 'Austin', region: 'TX' }]),
      purchaseNumber: vi.fn(async () => ({ sid: 'PN123', phoneNumber: '+15555550123' })),
      configureNumberWebhook: vi.fn(async () => ({ sid: 'PN123' })),
      configureCnam: vi.fn(async () => ({ sid: 'PN123' })),
    };

    await expect(createTwilioSubaccount(client, { friendlyName: 'Tenant A' })).resolves.toEqual({ ok: true, value: { subaccountSid: 'AC123' } });
    await expect(createTwilioMessagingService(client, { accountSid: 'AC123', friendlyName: 'Tenant A Messaging' })).resolves.toEqual({ ok: true, value: { messagingServiceSid: 'MG123' } });
    await expect(initiateTenDlcBrandAndCampaign(client, { accountSid: 'AC123', legalBusinessName: 'Biz', taxId: '99-0001', campaignUsecase: 'MARKETING', campaignDescription: 'promo' })).resolves.toEqual({ ok: true, value: { brandSid: 'BN123', campaignSid: 'CP123' } });
    await expect(searchNumberLadder(client, { accountSid: 'AC123', candidates: [{ areaCode: '415' }] })).resolves.toEqual({ ok: true, value: { selectedNumber: '+15555550123', locality: 'Austin', region: 'TX' } });
    await expect(attachNumberAndConfigureWebhook(client, { accountSid: 'AC123', phoneNumber: '+15555550123', smsUrl: 'https://example.com/sms' })).resolves.toEqual({ ok: true, value: { phoneNumberSid: 'PN123', attachedNumber: '+15555550123' } });
    await expect(configureOptionalCnam(client, { accountSid: 'AC123', phoneNumberSid: 'PN123', displayName: 'Tenant A' })).resolves.toEqual({ ok: true, value: { phoneNumberSid: 'PN123', cnamConfigured: true } });
  });

  it('returns normalized failure for provider errors', async () => {
    const client: TwilioProvisioningClient = {
      createSubaccount: vi.fn(async () => {
        throw { status: 429, code: 20429, message: 'Too many requests' };
      }),
      createMessagingService: vi.fn(),
      initiateBrandRegistration: vi.fn(),
      initiateCampaignRegistration: vi.fn(),
      searchAvailableNumbers: vi.fn(),
      purchaseNumber: vi.fn(),
      configureNumberWebhook: vi.fn(),
    };

    const result = await createTwilioSubaccount(client, { friendlyName: 'Tenant A' });
    expect(result).toEqual({
      ok: false,
      failure: { code: 'RATE_LIMIT', message: 'Too many requests', retriable: true, providerCode: '20429' },
    });
  });
});
