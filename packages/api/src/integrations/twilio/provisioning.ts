export type ProvisioningFailureCode =
  | 'AUTH'
  | 'RATE_LIMIT'
  | 'NETWORK'
  | 'VALIDATION'
  | 'CONFLICT'
  | 'NOT_FOUND'
  | 'UNKNOWN';

export type ProvisioningResult<T> =
  | { ok: true; value: T }
  | { ok: false; failure: { code: ProvisioningFailureCode; message: string; retriable: boolean; providerCode?: string } };

function classifyTwilioError(error: unknown): ProvisioningResult<never>['failure'] {
  const e = error as { code?: number; message?: string; status?: number };
  const status = e.status ?? 0;
  const code = e.code ?? 0;

  if (status === 401 || status === 403) return { code: 'AUTH', message: e.message ?? 'Unauthorized', retriable: false, providerCode: String(code) };
  if (status === 404) return { code: 'NOT_FOUND', message: e.message ?? 'Resource not found', retriable: false, providerCode: String(code) };
  if (status === 409) return { code: 'CONFLICT', message: e.message ?? 'Conflict', retriable: false, providerCode: String(code) };
  if (status === 429) return { code: 'RATE_LIMIT', message: e.message ?? 'Rate limited', retriable: true, providerCode: String(code) };
  if (status >= 400 && status < 500) return { code: 'VALIDATION', message: e.message ?? 'Validation failed', retriable: false, providerCode: String(code) };
  if (status >= 500) return { code: 'NETWORK', message: e.message ?? 'Provider unavailable', retriable: true, providerCode: String(code) };
  return { code: 'UNKNOWN', message: e.message ?? 'Unknown Twilio error', retriable: true, providerCode: code ? String(code) : undefined };
}

export type TwilioProvisioningClient = {
  createSubaccount(input: { friendlyName: string }): Promise<{ sid: string }>;
  createMessagingService(input: { accountSid: string; friendlyName: string }): Promise<{ sid: string }>;
  initiateBrandRegistration(input: { accountSid: string; legalBusinessName: string; taxId: string }): Promise<{ brandSid: string }>;
  initiateCampaignRegistration(input: { accountSid: string; brandSid: string; usecase: string; description: string }): Promise<{ campaignSid: string }>;
  searchAvailableNumbers(input: { accountSid: string; areaCode?: string; contains?: string; limit: number }): Promise<Array<{ phoneNumber: string; locality?: string; region?: string }>>;
  purchaseNumber(input: { accountSid: string; phoneNumber: string; messagingServiceSid?: string }): Promise<{ sid: string; phoneNumber: string }>;
  configureNumberWebhook(input: { accountSid: string; phoneNumberSid: string; smsUrl: string; statusCallbackUrl?: string }): Promise<{ sid: string }>;
  configureCnam?(input: { accountSid: string; phoneNumberSid: string; displayName: string }): Promise<{ sid: string }>;
};

export async function createTwilioSubaccount(client: TwilioProvisioningClient, input: { friendlyName: string }): Promise<ProvisioningResult<{ subaccountSid: string }>> {
  try {
    const created = await client.createSubaccount(input);
    return { ok: true, value: { subaccountSid: created.sid } };
  } catch (error) {
    return { ok: false, failure: classifyTwilioError(error) };
  }
}

export async function createTwilioMessagingService(client: TwilioProvisioningClient, input: { accountSid: string; friendlyName: string }): Promise<ProvisioningResult<{ messagingServiceSid: string }>> {
  try {
    const created = await client.createMessagingService(input);
    return { ok: true, value: { messagingServiceSid: created.sid } };
  } catch (error) {
    return { ok: false, failure: classifyTwilioError(error) };
  }
}

export async function initiateTenDlcBrandAndCampaign(client: TwilioProvisioningClient, input: { accountSid: string; legalBusinessName: string; taxId: string; campaignUsecase: string; campaignDescription: string }): Promise<ProvisioningResult<{ brandSid: string; campaignSid: string }>> {
  try {
    const brand = await client.initiateBrandRegistration({ accountSid: input.accountSid, legalBusinessName: input.legalBusinessName, taxId: input.taxId });
    const campaign = await client.initiateCampaignRegistration({ accountSid: input.accountSid, brandSid: brand.brandSid, usecase: input.campaignUsecase, description: input.campaignDescription });
    return { ok: true, value: { brandSid: brand.brandSid, campaignSid: campaign.campaignSid } };
  } catch (error) {
    return { ok: false, failure: classifyTwilioError(error) };
  }
}

export async function searchNumberLadder(client: TwilioProvisioningClient, input: { accountSid: string; candidates: Array<{ areaCode?: string; contains?: string }>; limitPerCandidate?: number }): Promise<ProvisioningResult<{ selectedNumber: string; locality?: string; region?: string }>> {
  try {
    const limit = input.limitPerCandidate ?? 1;
    for (const candidate of input.candidates) {
      const numbers = await client.searchAvailableNumbers({ accountSid: input.accountSid, areaCode: candidate.areaCode, contains: candidate.contains, limit });
      const selected = numbers[0];
      if (selected) {
        return { ok: true, value: { selectedNumber: selected.phoneNumber, locality: selected.locality, region: selected.region } };
      }
    }
    return { ok: false, failure: { code: 'NOT_FOUND', message: 'No numbers available for requested ladder', retriable: true } };
  } catch (error) {
    return { ok: false, failure: classifyTwilioError(error) };
  }
}

export async function attachNumberAndConfigureWebhook(client: TwilioProvisioningClient, input: { accountSid: string; phoneNumber: string; messagingServiceSid?: string; smsUrl: string; statusCallbackUrl?: string }): Promise<ProvisioningResult<{ phoneNumberSid: string; attachedNumber: string }>> {
  try {
    const purchased = await client.purchaseNumber({ accountSid: input.accountSid, phoneNumber: input.phoneNumber, messagingServiceSid: input.messagingServiceSid });
    await client.configureNumberWebhook({ accountSid: input.accountSid, phoneNumberSid: purchased.sid, smsUrl: input.smsUrl, statusCallbackUrl: input.statusCallbackUrl });
    return { ok: true, value: { phoneNumberSid: purchased.sid, attachedNumber: purchased.phoneNumber } };
  } catch (error) {
    return { ok: false, failure: classifyTwilioError(error) };
  }
}

export async function configureOptionalCnam(client: TwilioProvisioningClient, input: { accountSid: string; phoneNumberSid: string; displayName: string }): Promise<ProvisioningResult<{ phoneNumberSid: string; cnamConfigured: boolean }>> {
  if (!client.configureCnam) {
    return { ok: true, value: { phoneNumberSid: input.phoneNumberSid, cnamConfigured: false } };
  }

  try {
    await client.configureCnam(input);
    return { ok: true, value: { phoneNumberSid: input.phoneNumberSid, cnamConfigured: true } };
  } catch (error) {
    return { ok: false, failure: classifyTwilioError(error) };
  }
}
