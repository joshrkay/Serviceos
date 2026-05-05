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
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Twilio GET ${url} → ${res.status}: ${text}`);
  }
  return res.json() as Promise<T>;
}

export interface TwilioSubaccount {
  sid: string;
  authToken: string;
}

export async function createTwilioSubaccount(
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

export interface PurchasedNumber {
  sid: string;
  phoneNumber: string;
}

export async function purchasePhoneNumber(
  subaccountSid: string,
  authToken: string,
  region: string | null,
  voiceUrl: string,
  statusCallbackUrl: string
): Promise<PurchasedNumber> {
  const areaCode = region ? STATE_AREA_CODE[region.toUpperCase()] : null;

  const searchWithAreaCode = async (ac?: string): Promise<string | null> => {
    const params = new URLSearchParams({ VoiceEnabled: 'true', SmsEnabled: 'true' });
    if (ac) params.set('AreaCode', ac);
    const url = `${TWILIO_BASE}/Accounts/${subaccountSid}/AvailablePhoneNumbers/US/Local.json?${params}`;
    const result = await twilioGet<{ available_phone_numbers: Array<{ phone_number: string }> }>(
      url,
      subaccountSid,
      authToken
    );
    return result.available_phone_numbers[0]?.phone_number ?? null;
  };

  let phoneToOrder = areaCode ? await searchWithAreaCode(areaCode) : null;
  // Fallback: any available US number
  if (!phoneToOrder) phoneToOrder = await searchWithAreaCode();
  if (!phoneToOrder) {
    throw new Error(`No available US phone numbers found for region ${region ?? 'any'}`);
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
