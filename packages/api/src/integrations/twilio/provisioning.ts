// Twilio subaccount provisioning helpers.
// Uses raw fetch (no Twilio SDK) matching the pattern in twilio-delivery-provider.ts.
// Master credentials (TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN) are used only here
// to create subaccounts — the runtime request path uses per-tenant creds.

const TWILIO_BASE = 'https://api.twilio.com/2010-04-01';

// US state → preferred area code for number search
const STATE_AREA_CODE: Record<string, string> = {
  AL: '205', AK: '907', AZ: '602', AR: '501', CA: '213',
  CO: '303', CT: '203', DE: '302', FL: '305', GA: '404',
  HI: '808', ID: '208', IL: '312', IN: '317', IA: '515',
  KS: '316', KY: '502', LA: '504', ME: '207', MD: '301',
  MA: '617', MI: '313', MN: '612', MS: '601', MO: '314',
  MT: '406', NE: '402', NV: '702', NH: '603', NJ: '201',
  NM: '505', NY: '212', NC: '704', ND: '701', OH: '216',
  OK: '405', OR: '503', PA: '215', RI: '401', SC: '803',
  SD: '605', TN: '615', TX: '214', UT: '801', VT: '802',
  VA: '703', WA: '206', WV: '304', WI: '414', WY: '307', DC: '202',
};

function basicAuth(sid: string, token: string): string {
  return 'Basic ' + Buffer.from(`${sid}:${token}`).toString('base64');
}

// fetch has no default timeout — a Twilio stall would hang the provisioning
// worker mid-subaccount-setup with no upper bound.
const TWILIO_PROVISIONING_TIMEOUT_MS = 20_000;

async function twilioPost<T>(
  url: string,
  accountSid: string,
  authToken: string,
  body: URLSearchParams
): Promise<T> {
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: basicAuth(accountSid, authToken),
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body: body.toString(),
    signal: AbortSignal.timeout(TWILIO_PROVISIONING_TIMEOUT_MS),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Twilio POST ${url} → ${res.status}: ${text}`);
  }
  return res.json() as Promise<T>;
}

async function twilioGet<T>(
  url: string,
  accountSid: string,
  authToken: string
): Promise<T> {
  const res = await fetch(url, {
    headers: {
      Authorization: basicAuth(accountSid, authToken),
      Accept: 'application/json',
    },
    signal: AbortSignal.timeout(TWILIO_PROVISIONING_TIMEOUT_MS),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Twilio GET ${url} → ${res.status}: ${text}`);
  }
  return res.json() as Promise<T>;
}

async function twilioDelete(
  url: string,
  accountSid: string,
  authToken: string
): Promise<void> {
  const res = await fetch(url, {
    method: 'DELETE',
    headers: {
      Authorization: basicAuth(accountSid, authToken),
      Accept: 'application/json',
    },
    signal: AbortSignal.timeout(TWILIO_PROVISIONING_TIMEOUT_MS),
  });
  // 404 → already released; treat as success so deprovision is idempotent.
  if (!res.ok && res.status !== 404) {
    const text = await res.text();
    throw new Error(`Twilio DELETE ${url} → ${res.status}: ${text}`);
  }
}

export interface TwilioSubaccount {
  sid: string;
  authToken: string;
}

export async function createTwilioSubaccountWithCreds(
  masterSid: string,
  masterToken: string,
  friendlyName: string
): Promise<TwilioSubaccount> {
  const result = await twilioPost<{ sid: string; auth_token: string }>(
    `${TWILIO_BASE}/Accounts.json`,
    masterSid,
    masterToken,
    new URLSearchParams({ FriendlyName: friendlyName })
  );
  return { sid: result.sid, authToken: result.auth_token };
}

export async function createMessagingService(
  subaccountSid: string,
  authToken: string,
  friendlyName: string,
  inboundSmsUrl: string
): Promise<string> {
  const result = await twilioPost<{ sid: string }>(
    `https://messaging.twilio.com/v1/Services`,
    subaccountSid,
    authToken,
    new URLSearchParams({
      FriendlyName: friendlyName,
      InboundRequestUrl: inboundSmsUrl,
      UseCase: 'mixed',
    })
  );
  return result.sid;
}

export interface AvailableNumber {
  phoneNumber: string; // E.164, e.g. "+15125551234"
  locality?: string;
  region?: string;
}

// Searches Twilio for purchasable US local numbers (voice + SMS capable).
// Works with either the MASTER account (the onboarding picker, before a
// subaccount exists) or a subaccount (the provisioning worker) — available
// numbers are global to the country, so the account only affects auth, not
// the candidate set. `limit` is clamped to a picker-friendly page size.
export async function searchAvailableNumbers(
  accountSid: string,
  authToken: string,
  opts: { areaCode?: string; contains?: string; limit?: number } = {}
): Promise<AvailableNumber[]> {
  const limit = Math.min(Math.max(opts.limit ?? 10, 1), 30);
  const params = new URLSearchParams({ VoiceEnabled: 'true', SmsEnabled: 'true' });
  if (opts.areaCode) params.set('AreaCode', opts.areaCode);
  if (opts.contains) params.set('Contains', opts.contains);
  params.set('PageSize', String(limit));
  const url = `${TWILIO_BASE}/Accounts/${accountSid}/AvailablePhoneNumbers/US/Local.json?${params}`;
  const result = await twilioGet<{
    available_phone_numbers: Array<{ phone_number: string; locality?: string; region?: string }>;
  }>(url, accountSid, authToken);
  return (result.available_phone_numbers ?? [])
    .slice(0, limit)
    .map((n) => ({ phoneNumber: n.phone_number, locality: n.locality, region: n.region }));
}

export interface PurchasedNumber {
  sid: string;
  phoneNumber: string;
}

export async function purchasePhoneNumber(
  subaccountSid: string,
  authToken: string,
  region: string | null,
  voiceUrl: string,
  statusCallbackUrl: string,
  // When the tradesperson picked a specific number, order exactly that one
  // and skip the search. Twilio rejects the purchase (throws) if the number
  // was taken between the picker listing it and this call.
  preferredNumber?: string
): Promise<PurchasedNumber> {
  let phoneToOrder: string | null = preferredNumber ?? null;

  if (!phoneToOrder) {
    const areaCode = region ? STATE_AREA_CODE[region.toUpperCase()] : null;
    const firstAvailable = async (ac?: string): Promise<string | null> => {
      const found = await searchAvailableNumbers(subaccountSid, authToken, {
        ...(ac ? { areaCode: ac } : {}),
        limit: 1,
      });
      return found[0]?.phoneNumber ?? null;
    };

    phoneToOrder = areaCode ? await firstAvailable(areaCode) : null;
    // Fallback: any available US number
    if (!phoneToOrder) phoneToOrder = await firstAvailable();
    if (!phoneToOrder) {
      throw new Error(`No available US phone numbers found for region ${region ?? 'any'}`);
    }
  }

  const purchased = await twilioPost<{ sid: string; phone_number: string }>(
    `${TWILIO_BASE}/Accounts/${subaccountSid}/IncomingPhoneNumbers.json`,
    subaccountSid,
    authToken,
    new URLSearchParams({
      PhoneNumber: phoneToOrder,
      VoiceUrl: voiceUrl,
      StatusCallback: statusCallbackUrl,
    })
  );
  return { sid: purchased.sid, phoneNumber: purchased.phone_number };
}

export async function attachNumberToMessagingService(
  subaccountSid: string,
  authToken: string,
  messagingServiceSid: string,
  phoneNumberSid: string
): Promise<void> {
  await twilioPost(
    `https://messaging.twilio.com/v1/Services/${messagingServiceSid}/PhoneNumbers`,
    subaccountSid,
    authToken,
    new URLSearchParams({ PhoneNumberSid: phoneNumberSid })
  );
}

// Lists all phone numbers owned by a Twilio subaccount. Used to recover from
// crash-after-purchase-before-persist: if the worker bought a number on a
// previous attempt but failed to persist the SID, calling this on retry finds
// the orphaned number so we don't buy another one.
export async function listSubaccountPhoneNumbers(
  subaccountSid: string,
  authToken: string
): Promise<PurchasedNumber[]> {
  const result = await twilioGet<{
    incoming_phone_numbers: Array<{ sid: string; phone_number: string }>;
  }>(
    `${TWILIO_BASE}/Accounts/${subaccountSid}/IncomingPhoneNumbers.json`,
    subaccountSid,
    authToken
  );
  return result.incoming_phone_numbers.map((n) => ({ sid: n.sid, phoneNumber: n.phone_number }));
}

// Releases a single phone number owned by a subaccount. Uses the
// subaccount's own credentials. Idempotent (404 is swallowed).
export async function releasePhoneNumber(
  subaccountSid: string,
  authToken: string,
  phoneNumberSid: string
): Promise<void> {
  await twilioDelete(
    `${TWILIO_BASE}/Accounts/${subaccountSid}/IncomingPhoneNumbers/${phoneNumberSid}.json`,
    subaccountSid,
    authToken
  );
}

// Permanently closes a subaccount. Must be authenticated with the MASTER
// credentials (a subaccount cannot close itself). Closing releases all of
// the subaccount's phone numbers and messaging services. Irreversible after
// ~30 days. Idempotent: closing an already-closed subaccount is a no-op POST.
export async function closeSubaccount(
  masterSid: string,
  masterToken: string,
  subaccountSid: string
): Promise<void> {
  await twilioPost(
    `${TWILIO_BASE}/Accounts/${subaccountSid}.json`,
    masterSid,
    masterToken,
    new URLSearchParams({ Status: 'closed' })
  );
}

export type ProvisioningFailureCode =
  | 'AUTH'
  | 'RATE_LIMIT'
  | 'NETWORK'
  | 'VALIDATION'
  | 'CONFLICT'
  | 'NOT_FOUND'
  | 'UNKNOWN';

export type ProvisioningFailure = {
  code: ProvisioningFailureCode;
  message: string;
  retriable: boolean;
  providerCode?: string;
};

export type ProvisioningResult<T> =
  | { ok: true; value: T }
  | { ok: false; failure: ProvisioningFailure };

function classifyTwilioError(error: unknown): ProvisioningFailure {
  const e = error as { code?: number; message?: string; status?: number };
  const status = e.status ?? 0;
  const code = e.code ?? 0;

  if (status === 401 || status === 403) return { code: 'AUTH', message: e.message ?? 'Unauthorized', retriable: false, providerCode: code ? String(code) : undefined };
  if (status === 404) return { code: 'NOT_FOUND', message: e.message ?? 'Resource not found', retriable: false, providerCode: code ? String(code) : undefined };
  if (status === 409) return { code: 'CONFLICT', message: e.message ?? 'Conflict', retriable: false, providerCode: code ? String(code) : undefined };
  if (status === 429) return { code: 'RATE_LIMIT', message: e.message ?? 'Rate limited', retriable: true, providerCode: code ? String(code) : undefined };
  if (status >= 400 && status < 500) return { code: 'VALIDATION', message: e.message ?? 'Validation failed', retriable: false, providerCode: code ? String(code) : undefined };
  if (status >= 500) return { code: 'NETWORK', message: e.message ?? 'Provider unavailable', retriable: true, providerCode: code ? String(code) : undefined };
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
