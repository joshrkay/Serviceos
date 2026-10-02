/**
 * #1564 — the real HTTP client for Twilio's ISV A2P 10DLC sequence.
 *
 * Seam: createTwilioA2pClient({ fetch }) — the Twilio HTTP boundary. `fetch`
 * is the only thing stubbed; nothing here ever reaches twilio.com.
 *
 * Expected URLs / parameter names / policy SIDs are copied from Twilio's docs:
 *   https://www.twilio.com/docs/messaging/compliance/a2p-10dlc/onboarding-isv-api
 *   https://www.twilio.com/docs/messaging/api/brand-registration-resource
 *   https://www.twilio.com/docs/messaging/api/usapptoperson-resource
 */
import { describe, it, expect } from 'vitest';
import { createTwilioA2pClient } from '../../../src/integrations/twilio/a2p-10dlc/twilio-a2p-client';

type Call = { url: string; method: string; auth: string | null; body: URLSearchParams };

function fakeFetch(responses: Array<{ status?: number; json: unknown }>) {
  const calls: Call[] = [];
  const impl = async (url: string | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    calls.push({
      url: String(url),
      method: init?.method ?? 'GET',
      auth: headers.get('Authorization'),
      body: new URLSearchParams(typeof init?.body === 'string' ? init.body : ''),
    });
    const next = responses.shift() ?? { json: {} };
    const status = next.status ?? 200;
    return new Response(JSON.stringify(next.json), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });
  };
  return { impl: impl as typeof fetch, calls };
}

const creds = { accountSid: 'ACsub', authToken: 'tok' };

describe('createTwilioA2pClient', () => {
  it('creates the Secondary Customer Profile in the tenant subaccount with the ISV policy', async () => {
    const { impl, calls } = fakeFetch([{ json: { sid: 'BUprofile' } }]);
    const client = createTwilioA2pClient({ fetch: impl });

    const result = await client.createCustomerProfile(creds, {
      friendlyName: 'Acme Plumbing LLC secondary profile',
      email: 'compliance@example.com',
    });

    expect(result).toEqual({ sid: 'BUprofile' });
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe('POST');
    expect(calls[0].url).toBe('https://trusthub.twilio.com/v1/CustomerProfiles');
    expect(calls[0].auth).toBe('Basic ' + Buffer.from('ACsub:tok').toString('base64'));
    expect(calls[0].body.get('PolicySid')).toBe('RNdfbf3fae0e1107f8aded0e7cead80bf5');
    expect(calls[0].body.get('FriendlyName')).toBe('Acme Plumbing LLC secondary profile');
    expect(calls[0].body.get('Email')).toBe('compliance@example.com');
  });

  it('rejects with the Twilio status + error code when Twilio refuses a request', async () => {
    const { impl } = fakeFetch([
      { status: 400, json: { code: 70002, message: 'Invalid friendly name', status: 400 } },
    ]);
    const client = createTwilioA2pClient({ fetch: impl });

    await expect(
      client.createCustomerProfile(creds, { friendlyName: '', email: 'compliance@example.com' }),
    ).rejects.toMatchObject({ status: 400, code: 70002, message: expect.stringContaining('Invalid friendly name') });
  });

  it('maps every remaining ISV-guide request onto its documented endpoint and parameters', async () => {
    const TP_POLICY = 'RNb0d4771c2c98518d916a3d4cd70a8f8b';
    const cases: Array<{
      name: string;
      run: (c: ReturnType<typeof createTwilioA2pClient>) => Promise<unknown>;
      response: unknown;
      method: string;
      url: string;
      params?: Record<string, string>;
      repeated?: Record<string, string[]>;
      returns: unknown;
    }> = [
      {
        name: '1.2 business-information EndUser',
        run: (c) => c.createEndUser(creds, { type: 'customer_profile_business_information', friendlyName: 'biz', attributes: { business_name: 'Acme' } }),
        response: { sid: 'ITbiz' },
        method: 'POST',
        url: 'https://trusthub.twilio.com/v1/EndUsers',
        params: { Type: 'customer_profile_business_information', FriendlyName: 'biz', Attributes: '{"business_name":"Acme"}' },
        returns: { sid: 'ITbiz' },
      },
      {
        name: '1.3 attach to the Customer Profile',
        run: (c) => c.assignCustomerProfileEntity(creds, 'BUprofile', 'ITbiz'),
        response: { sid: 'BVassign' },
        method: 'POST',
        url: 'https://trusthub.twilio.com/v1/CustomerProfiles/BUprofile/EntityAssignments',
        params: { ObjectSid: 'ITbiz' },
        returns: { sid: 'BVassign' },
      },
      {
        name: '1.6 Address in the subaccount',
        run: (c) => c.createAddress(creds, { customerName: 'Acme', street: '1 Main St', city: 'Austin', region: 'TX', postalCode: '78701', isoCountry: 'US' }),
        response: { sid: 'ADaddr' },
        method: 'POST',
        url: 'https://api.twilio.com/2010-04-01/Accounts/ACsub/Addresses.json',
        params: { CustomerName: 'Acme', Street: '1 Main St', City: 'Austin', Region: 'TX', PostalCode: '78701', IsoCountry: 'US' },
        returns: { sid: 'ADaddr' },
      },
      {
        name: '1.7 address SupportingDocument',
        run: (c) => c.createSupportingDocument(creds, { type: 'customer_profile_address', friendlyName: 'addr', attributes: { address_sids: 'ADaddr' } }),
        response: { sid: 'RDdoc' },
        method: 'POST',
        url: 'https://trusthub.twilio.com/v1/SupportingDocuments',
        params: { Type: 'customer_profile_address', FriendlyName: 'addr', Attributes: '{"address_sids":"ADaddr"}' },
        returns: { sid: 'RDdoc' },
      },
      {
        name: '1.10 evaluate the Customer Profile',
        run: (c) => c.evaluateCustomerProfile(creds, 'BUprofile'),
        response: { sid: 'ELeval', status: 'noncompliant', results: [{ valid: false }] },
        method: 'POST',
        url: 'https://trusthub.twilio.com/v1/CustomerProfiles/BUprofile/Evaluations',
        params: { PolicySid: 'RNdfbf3fae0e1107f8aded0e7cead80bf5' },
        returns: { status: 'noncompliant', results: [{ valid: false }] },
      },
      {
        name: '1.11 submit the Customer Profile',
        run: (c) => c.submitCustomerProfile(creds, 'BUprofile'),
        response: { sid: 'BUprofile', status: 'pending-review' },
        method: 'POST',
        url: 'https://trusthub.twilio.com/v1/CustomerProfiles/BUprofile',
        params: { Status: 'pending-review' },
        returns: undefined,
      },
      {
        name: 'fetch the Customer Profile',
        run: (c) => c.fetchCustomerProfile(creds, 'BUprofile'),
        response: { sid: 'BUprofile', status: 'twilio-rejected', errors: [{ code: 1 }] },
        method: 'GET',
        url: 'https://trusthub.twilio.com/v1/CustomerProfiles/BUprofile',
        returns: { status: 'twilio-rejected', errors: [{ code: 1 }] },
      },
      {
        name: '2.1 A2P TrustProduct',
        run: (c) => c.createTrustProduct(creds, { friendlyName: 'tp', email: 'compliance@example.com' }),
        response: { sid: 'BUtrust' },
        method: 'POST',
        url: 'https://trusthub.twilio.com/v1/TrustProducts',
        params: { FriendlyName: 'tp', Email: 'compliance@example.com', PolicySid: TP_POLICY },
        returns: { sid: 'BUtrust' },
      },
      {
        name: '2.3/2.4 attach to the TrustProduct',
        run: (c) => c.assignTrustProductEntity(creds, 'BUtrust', 'BUprofile'),
        response: { sid: 'BVx' },
        method: 'POST',
        url: 'https://trusthub.twilio.com/v1/TrustProducts/BUtrust/EntityAssignments',
        params: { ObjectSid: 'BUprofile' },
        returns: { sid: 'BVx' },
      },
      {
        name: '2.5 evaluate the TrustProduct',
        run: (c) => c.evaluateTrustProduct(creds, 'BUtrust'),
        response: { status: 'compliant', results: [] },
        method: 'POST',
        url: 'https://trusthub.twilio.com/v1/TrustProducts/BUtrust/Evaluations',
        params: { PolicySid: TP_POLICY },
        returns: { status: 'compliant', results: [] },
      },
      {
        name: '2.6 submit the TrustProduct',
        run: (c) => c.submitTrustProduct(creds, 'BUtrust'),
        response: { sid: 'BUtrust' },
        method: 'POST',
        url: 'https://trusthub.twilio.com/v1/TrustProducts/BUtrust',
        params: { Status: 'pending-review' },
        returns: undefined,
      },
      {
        name: 'fetch the TrustProduct',
        run: (c) => c.fetchTrustProduct(creds, 'BUtrust'),
        response: { sid: 'BUtrust', status: 'twilio-approved', errors: null },
        method: 'GET',
        url: 'https://trusthub.twilio.com/v1/TrustProducts/BUtrust',
        returns: { status: 'twilio-approved', errors: [] },
      },
      {
        name: '3 BrandRegistration',
        run: (c) => c.createBrandRegistration(creds, { customerProfileBundleSid: 'BUprofile', a2pProfileBundleSid: 'BUtrust' }),
        response: { sid: 'BNbrand', status: 'PENDING' },
        method: 'POST',
        url: 'https://messaging.twilio.com/v1/a2p/BrandRegistrations',
        params: { CustomerProfileBundleSid: 'BUprofile', A2PProfileBundleSid: 'BUtrust' },
        returns: { sid: 'BNbrand' },
      },
      {
        name: 'fetch the BrandRegistration',
        run: (c) => c.fetchBrandRegistration(creds, 'BNbrand'),
        response: { sid: 'BNbrand', status: 'FAILED', failure_reason: 'EIN mismatch', errors: [{ description: 'Tax ID does not match' }] },
        method: 'GET',
        url: 'https://messaging.twilio.com/v1/a2p/BrandRegistrations/BNbrand',
        returns: { status: 'FAILED', failureReason: 'EIN mismatch', errors: [{ description: 'Tax ID does not match' }] },
      },
      {
        name: 'UsAppToPerson campaign on the Messaging Service',
        run: (c) =>
          c.createUsAppToPersonCampaign(creds, 'MGsvc', {
            brandRegistrationSid: 'BNbrand',
            usecase: 'MIXED',
            description: 'Appointment and invoice texts',
            messageFlow: 'Customers give their number when booking.',
            messageSamples: ['Sample one is long enough', 'Sample two is long enough'],
            hasEmbeddedLinks: true,
            hasEmbeddedPhone: false,
            optOutKeywords: ['STOP', 'UNSUBSCRIBE'],
          }),
        response: { sid: 'QEcampaign', campaign_status: 'PENDING' },
        method: 'POST',
        url: 'https://messaging.twilio.com/v1/Services/MGsvc/Compliance/Usa2p',
        params: {
          BrandRegistrationSid: 'BNbrand',
          UsAppToPersonUsecase: 'MIXED',
          Description: 'Appointment and invoice texts',
          MessageFlow: 'Customers give their number when booking.',
          HasEmbeddedLinks: 'true',
          HasEmbeddedPhone: 'false',
        },
        repeated: {
          MessageSamples: ['Sample one is long enough', 'Sample two is long enough'],
          OptOutKeywords: ['STOP', 'UNSUBSCRIBE'],
        },
        returns: { sid: 'QEcampaign' },
      },
      {
        name: 'fetch the UsAppToPerson campaign',
        run: (c) => c.fetchUsAppToPersonCampaign(creds, 'MGsvc', 'QEcampaign'),
        response: { sid: 'QEcampaign', campaign_status: 'VERIFIED', errors: [] },
        method: 'GET',
        url: 'https://messaging.twilio.com/v1/Services/MGsvc/Compliance/Usa2p/QEcampaign',
        returns: { campaignStatus: 'VERIFIED', errors: [] },
      },
    ];

    for (const tc of cases) {
      const { impl, calls } = fakeFetch([{ json: tc.response }]);
      const client = createTwilioA2pClient({ fetch: impl });
      const result = await tc.run(client);
      expect(result, tc.name).toEqual(tc.returns);
      expect(calls, tc.name).toHaveLength(1);
      expect(calls[0].method, tc.name).toBe(tc.method);
      expect(calls[0].url, tc.name).toBe(tc.url);
      expect(calls[0].auth, tc.name).toBe('Basic ' + Buffer.from('ACsub:tok').toString('base64'));
      for (const [k, v] of Object.entries(tc.params ?? {})) {
        expect(calls[0].body.get(k), `${tc.name} ${k}`).toBe(v);
      }
      for (const [k, v] of Object.entries(tc.repeated ?? {})) {
        expect(calls[0].body.getAll(k), `${tc.name} ${k}`).toEqual(v);
      }
    }
  });
});
