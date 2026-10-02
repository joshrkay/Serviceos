// #1564 — raw-fetch HTTP client for Twilio's ISV A2P 10DLC registration
// sequence (no Twilio SDK, matching integrations/twilio/provisioning.ts).
//
// Every call is made with the TENANT SUBACCOUNT's credentials, per the ISV
// guide ("use the Twilio Account SID and Auth Token for the Account your
// customer will use for A2P 10DLC messaging"):
//   https://www.twilio.com/docs/messaging/compliance/a2p-10dlc/onboarding-isv-api
//
// Never log request bodies from here: the business-information EndUser carries
// the tenant's EIN.

const TRUSTHUB_BASE = 'https://trusthub.twilio.com/v1';
const MESSAGING_BASE = 'https://messaging.twilio.com/v1';
const API_BASE = 'https://api.twilio.com/2010-04-01';

/** Policy SID for a Secondary Customer Profile (ISV guide step 1.1). */
export const SECONDARY_CUSTOMER_PROFILE_POLICY_SID = 'RNdfbf3fae0e1107f8aded0e7cead80bf5';

/** Policy SID for the A2P Messaging Profile TrustProduct (ISV guide step 2.1). */
export const A2P_TRUST_PRODUCT_POLICY_SID = 'RNb0d4771c2c98518d916a3d4cd70a8f8b';

const REQUEST_TIMEOUT_MS = 20_000;

export interface TwilioCreds {
  accountSid: string;
  authToken: string;
}

/** TrustHub bundle statuses (CustomerProfile + TrustProduct share the enum). */
export type TrustHubBundleStatus =
  | 'draft'
  | 'pending-review'
  | 'in-review'
  | 'twilio-rejected'
  | 'twilio-approved';

export interface TrustHubEvaluation {
  status: 'compliant' | 'noncompliant';
  /** Twilio's per-requirement results; untyped in the API spec. */
  results: unknown[];
}

export interface TrustHubBundle {
  status: TrustHubBundleStatus;
  errors: unknown[];
}

/** https://www.twilio.com/docs/messaging/api/brand-registration-resource */
export type BrandRegistrationStatus =
  | 'PENDING'
  | 'APPROVED'
  | 'FAILED'
  | 'IN_REVIEW'
  | 'DELETION_PENDING'
  | 'DELETION_FAILED'
  | 'SUSPENDED';

/** https://www.twilio.com/docs/messaging/api/usapptoperson-resource */
export type CampaignStatus = 'PENDING' | 'IN_PROGRESS' | 'FAILED' | 'VERIFIED';

export interface UsAppToPersonCampaignInput {
  brandRegistrationSid: string;
  usecase: string;
  description: string;
  messageFlow: string;
  messageSamples: string[];
  hasEmbeddedLinks: boolean;
  hasEmbeddedPhone: boolean;
  optInMessage?: string;
  optOutMessage?: string;
  helpMessage?: string;
  optInKeywords?: string[];
  optOutKeywords?: string[];
  helpKeywords?: string[];
}

export interface TwilioA2pClient {
  createCustomerProfile(
    creds: TwilioCreds,
    input: { friendlyName: string; email: string; statusCallback?: string },
  ): Promise<{ sid: string }>;
  createEndUser(
    creds: TwilioCreds,
    input: { type: string; friendlyName: string; attributes: Record<string, unknown> },
  ): Promise<{ sid: string }>;
  assignCustomerProfileEntity(creds: TwilioCreds, customerProfileSid: string, objectSid: string): Promise<{ sid: string }>;
  createAddress(
    creds: TwilioCreds,
    input: {
      customerName: string;
      street: string;
      streetSecondary?: string;
      city: string;
      region: string;
      postalCode: string;
      isoCountry: string;
    },
  ): Promise<{ sid: string }>;
  createSupportingDocument(
    creds: TwilioCreds,
    input: { type: string; friendlyName: string; attributes: Record<string, unknown> },
  ): Promise<{ sid: string }>;
  evaluateCustomerProfile(creds: TwilioCreds, customerProfileSid: string): Promise<TrustHubEvaluation>;
  submitCustomerProfile(creds: TwilioCreds, customerProfileSid: string): Promise<void>;
  fetchCustomerProfile(creds: TwilioCreds, customerProfileSid: string): Promise<TrustHubBundle>;
  createTrustProduct(
    creds: TwilioCreds,
    input: { friendlyName: string; email: string; statusCallback?: string },
  ): Promise<{ sid: string }>;
  assignTrustProductEntity(creds: TwilioCreds, trustProductSid: string, objectSid: string): Promise<{ sid: string }>;
  evaluateTrustProduct(creds: TwilioCreds, trustProductSid: string): Promise<TrustHubEvaluation>;
  submitTrustProduct(creds: TwilioCreds, trustProductSid: string): Promise<void>;
  fetchTrustProduct(creds: TwilioCreds, trustProductSid: string): Promise<TrustHubBundle>;
  createBrandRegistration(
    creds: TwilioCreds,
    input: { customerProfileBundleSid: string; a2pProfileBundleSid: string },
  ): Promise<{ sid: string }>;
  fetchBrandRegistration(
    creds: TwilioCreds,
    brandSid: string,
  ): Promise<{ status: BrandRegistrationStatus; failureReason: string | null; errors: unknown[] }>;
  createUsAppToPersonCampaign(
    creds: TwilioCreds,
    messagingServiceSid: string,
    input: UsAppToPersonCampaignInput,
  ): Promise<{ sid: string }>;
  fetchUsAppToPersonCampaign(
    creds: TwilioCreds,
    messagingServiceSid: string,
    campaignSid: string,
  ): Promise<{ campaignStatus: CampaignStatus; errors: unknown[] }>;
}

/**
 * A non-2xx Twilio response. Carries the HTTP status and Twilio's numeric
 * error code (https://www.twilio.com/docs/api/errors) so callers can tell a
 * retryable outage (429 / 5xx) from a rejected registration (4xx). The
 * message is Twilio's own error text — never the request body.
 */
export class TwilioApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: number | undefined,
    message: string,
    /** Twilio's own human-readable error text (may be empty). */
    readonly detail: string = '',
  ) {
    super(message);
    this.name = 'TwilioApiError';
  }

  get retriable(): boolean {
    return this.status === 429 || this.status >= 500;
  }
}

async function parseOrThrow<T>(res: Response, label: string): Promise<T> {
  if (!res.ok) {
    let code: number | undefined;
    let detail = '';
    try {
      const body = (await res.json()) as { code?: number; message?: string };
      code = typeof body.code === 'number' ? body.code : undefined;
      detail = typeof body.message === 'string' ? body.message : '';
    } catch {
      // Non-JSON error body (e.g. a proxy 502) — status alone classifies it.
    }
    throw new TwilioApiError(
      res.status,
      code,
      `Twilio ${label} → ${res.status}${code ? ` (${code})` : ''}: ${detail}`,
      detail,
    );
  }
  return (await res.json()) as T;
}

function basicAuth(sid: string, token: string): string {
  return 'Basic ' + Buffer.from(`${sid}:${token}`).toString('base64');
}

export function createTwilioA2pClient(deps: { fetch?: typeof fetch } = {}): TwilioA2pClient {
  const doFetch = deps.fetch ?? fetch;

  type Param = string | string[] | undefined;

  async function post<T>(creds: TwilioCreds, url: string, params: Record<string, Param>): Promise<T> {
    const body = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (v === undefined) continue;
      // List parameters (MessageSamples, *Keywords) repeat the key, the
      // form encoding Twilio documents for array params.
      for (const item of Array.isArray(v) ? v : [v]) body.append(k, item);
    }
    const res = await doFetch(url, {
      method: 'POST',
      headers: {
        Authorization: basicAuth(creds.accountSid, creds.authToken),
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: body.toString(),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    return parseOrThrow<T>(res, `POST ${new URL(url).pathname}`);
  }

  async function get<T>(creds: TwilioCreds, url: string): Promise<T> {
    const res = await doFetch(url, {
      method: 'GET',
      headers: {
        Authorization: basicAuth(creds.accountSid, creds.authToken),
        Accept: 'application/json',
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    return parseOrThrow<T>(res, `GET ${new URL(url).pathname}`);
  }

  const sidOnly = (r: { sid: string }) => ({ sid: r.sid });
  const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
  const evaluation = (r: { status: 'compliant' | 'noncompliant'; results?: unknown }): TrustHubEvaluation => ({
    status: r.status,
    results: list(r.results),
  });
  const bundle = (r: { status: TrustHubBundleStatus; errors?: unknown }): TrustHubBundle => ({
    status: r.status,
    errors: list(r.errors),
  });

  return {
    async createEndUser(creds, input) {
      return sidOnly(
        await post(creds, `${TRUSTHUB_BASE}/EndUsers`, {
          Type: input.type,
          FriendlyName: input.friendlyName,
          Attributes: JSON.stringify(input.attributes),
        }),
      );
    },

    async assignCustomerProfileEntity(creds, customerProfileSid, objectSid) {
      return sidOnly(
        await post(creds, `${TRUSTHUB_BASE}/CustomerProfiles/${customerProfileSid}/EntityAssignments`, {
          ObjectSid: objectSid,
        }),
      );
    },

    async createAddress(creds, input) {
      return sidOnly(
        await post(creds, `${API_BASE}/Accounts/${creds.accountSid}/Addresses.json`, {
          FriendlyName: input.customerName,
          CustomerName: input.customerName,
          Street: input.street,
          StreetSecondary: input.streetSecondary,
          City: input.city,
          Region: input.region,
          PostalCode: input.postalCode,
          IsoCountry: input.isoCountry,
        }),
      );
    },

    async createSupportingDocument(creds, input) {
      return sidOnly(
        await post(creds, `${TRUSTHUB_BASE}/SupportingDocuments`, {
          Type: input.type,
          FriendlyName: input.friendlyName,
          Attributes: JSON.stringify(input.attributes),
        }),
      );
    },

    async evaluateCustomerProfile(creds, customerProfileSid) {
      return evaluation(
        await post(creds, `${TRUSTHUB_BASE}/CustomerProfiles/${customerProfileSid}/Evaluations`, {
          PolicySid: SECONDARY_CUSTOMER_PROFILE_POLICY_SID,
        }),
      );
    },

    async submitCustomerProfile(creds, customerProfileSid) {
      await post(creds, `${TRUSTHUB_BASE}/CustomerProfiles/${customerProfileSid}`, { Status: 'pending-review' });
    },

    async fetchCustomerProfile(creds, customerProfileSid) {
      return bundle(await get(creds, `${TRUSTHUB_BASE}/CustomerProfiles/${customerProfileSid}`));
    },

    async createTrustProduct(creds, input) {
      return sidOnly(
        await post(creds, `${TRUSTHUB_BASE}/TrustProducts`, {
          FriendlyName: input.friendlyName,
          Email: input.email,
          PolicySid: A2P_TRUST_PRODUCT_POLICY_SID,
          StatusCallback: input.statusCallback,
        }),
      );
    },

    async assignTrustProductEntity(creds, trustProductSid, objectSid) {
      return sidOnly(
        await post(creds, `${TRUSTHUB_BASE}/TrustProducts/${trustProductSid}/EntityAssignments`, {
          ObjectSid: objectSid,
        }),
      );
    },

    async evaluateTrustProduct(creds, trustProductSid) {
      return evaluation(
        await post(creds, `${TRUSTHUB_BASE}/TrustProducts/${trustProductSid}/Evaluations`, {
          PolicySid: A2P_TRUST_PRODUCT_POLICY_SID,
        }),
      );
    },

    async submitTrustProduct(creds, trustProductSid) {
      await post(creds, `${TRUSTHUB_BASE}/TrustProducts/${trustProductSid}`, { Status: 'pending-review' });
    },

    async fetchTrustProduct(creds, trustProductSid) {
      return bundle(await get(creds, `${TRUSTHUB_BASE}/TrustProducts/${trustProductSid}`));
    },

    async createBrandRegistration(creds, input) {
      return sidOnly(
        await post(creds, `${MESSAGING_BASE}/a2p/BrandRegistrations`, {
          CustomerProfileBundleSid: input.customerProfileBundleSid,
          A2PProfileBundleSid: input.a2pProfileBundleSid,
        }),
      );
    },

    async fetchBrandRegistration(creds, brandSid) {
      const r = await get<{ status: BrandRegistrationStatus; failure_reason?: string | null; errors?: unknown }>(
        creds,
        `${MESSAGING_BASE}/a2p/BrandRegistrations/${brandSid}`,
      );
      return { status: r.status, failureReason: r.failure_reason ?? null, errors: list(r.errors) };
    },

    async createUsAppToPersonCampaign(creds, messagingServiceSid, input) {
      return sidOnly(
        await post(creds, `${MESSAGING_BASE}/Services/${messagingServiceSid}/Compliance/Usa2p`, {
          BrandRegistrationSid: input.brandRegistrationSid,
          UsAppToPersonUsecase: input.usecase,
          Description: input.description,
          MessageFlow: input.messageFlow,
          MessageSamples: input.messageSamples,
          HasEmbeddedLinks: String(input.hasEmbeddedLinks),
          HasEmbeddedPhone: String(input.hasEmbeddedPhone),
          OptInMessage: input.optInMessage,
          OptOutMessage: input.optOutMessage,
          HelpMessage: input.helpMessage,
          OptInKeywords: input.optInKeywords,
          OptOutKeywords: input.optOutKeywords,
          HelpKeywords: input.helpKeywords,
        }),
      );
    },

    async fetchUsAppToPersonCampaign(creds, messagingServiceSid, campaignSid) {
      const r = await get<{ campaign_status: CampaignStatus; errors?: unknown }>(
        creds,
        `${MESSAGING_BASE}/Services/${messagingServiceSid}/Compliance/Usa2p/${campaignSid}`,
      );
      return { campaignStatus: r.campaign_status, errors: list(r.errors) };
    },

    async createCustomerProfile(creds, input) {
      const r = await post<{ sid: string }>(creds, `${TRUSTHUB_BASE}/CustomerProfiles`, {
        FriendlyName: input.friendlyName,
        Email: input.email,
        PolicySid: SECONDARY_CUSTOMER_PROFILE_POLICY_SID,
        StatusCallback: input.statusCallback,
      });
      return { sid: r.sid };
    },
  };
}
