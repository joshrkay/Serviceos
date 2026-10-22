/**
 * D-044 / #1771 — update_google_listing_website: the payload contract, the manual
 * action class, owner-level approval, and the execution handler against a mocked
 * Google client (fetch).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { updateGoogleListingWebsitePayloadSchema } from '../../src/proposals/contracts/google-listing-website';
import { validateProposalPayload } from '../../src/proposals/contracts';
import {
  InMemoryProposalRepository,
  VALID_PROPOSAL_TYPES,
  actionClassForProposalType,
  createProposal,
  decideInitialStatus,
  type Proposal,
} from '../../src/proposals/proposal';
import { UpdateGoogleListingWebsiteExecutionHandler } from '../../src/proposals/execution/google-listing-website-handler';
import { createExecutionHandlerRegistry } from '../../src/proposals/execution/handlers';
import { InMemoryAuditRepository } from '../../src/audit/audit';
import { approveProposal } from '../../src/proposals/actions';
import { InMemoryGoogleBusinessIntegrationRepository } from '../../src/reputation/google-business-integration';
import { actionClassForProposalType as sharedActionClass } from '@ai-service-os/shared';

const TENANT = 'tenant-glw-1';
const SITE = 'https://joes.sites.example.com';
const BOOK = 'https://app.example.com/book?t=tenant-glw-1';
const CONFIG = { clientId: 'cid', clientSecret: 'sec', redirectUri: 'https://x/cb' };

function approved(payload: Record<string, unknown>): Proposal {
  return {
    ...createProposal({
      tenantId: TENANT,
      proposalType: 'update_google_listing_website',
      payload,
      summary: 'Show your website on Google',
      createdBy: 'u-1',
    }),
    status: 'approved',
  };
}

describe('update_google_listing_website payload contract', () => {
  it('accepts a website, with or without a booking link', () => {
    expect(updateGoogleListingWebsitePayloadSchema.parse({ websiteUri: ` ${SITE} ` }).websiteUri).toBe(SITE);
    expect(validateProposalPayload('update_google_listing_website', { websiteUri: SITE, bookingUri: BOOK }).valid).toBe(true);
  });

  it.each([
    [{}, 'missing website'],
    [{ websiteUri: '' }, 'empty website'],
    [{ websiteUri: 'joes.com' }, 'not a URL'],
    [{ websiteUri: 'javascript:alert(1)' }, 'not http(s)'],
    [{ websiteUri: 'ftp://joes.com' }, 'not http(s)'],
    [{ websiteUri: SITE, bookingUri: 'nope' }, 'bad booking link'],
  ])('rejects %j (%s)', (payload) => {
    expect(validateProposalPayload('update_google_listing_website', payload).valid).toBe(false);
  });
});

describe('update_google_listing_website is never auto-executed', () => {
  it('is a registered manual-class type on both the API and shared sides', () => {
    expect(VALID_PROPOSAL_TYPES).toContain('update_google_listing_website');
    expect(actionClassForProposalType('update_google_listing_website')).toBe('manual');
    expect(sharedActionClass('update_google_listing_website')).toBe('manual');
  });

  it('lands as a draft at every trust tier and confidence', () => {
    for (const tier of ['autonomous', 'graduates_fast', 'graduates_slowly', 'always_asks'] as const) {
      expect(
        decideInitialStatus({ proposalType: 'update_google_listing_website', sourceTrustTier: tier, confidenceScore: 1 }),
      ).toBe('draft');
    }
  });

  it('has an execution handler in the registry', () => {
    expect(createExecutionHandlerRegistry({}).has('update_google_listing_website')).toBe(true);
  });

  it('needs settings:update to approve: a dispatcher cannot, an owner can', async () => {
    const repo = new InMemoryProposalRepository();
    const proposal = await repo.create(
      createProposal({
        tenantId: TENANT,
        proposalType: 'update_google_listing_website',
        payload: { websiteUri: SITE },
        summary: 's',
        createdBy: 'u-1',
      }),
    );
    await expect(approveProposal(repo, TENANT, proposal.id, 'd-1', 'dispatcher', new InMemoryAuditRepository())).rejects.toThrow();
    expect((await repo.findById(TENANT, proposal.id))?.status).toBe('draft');
    expect((await approveProposal(repo, TENANT, proposal.id, 'o-1', 'owner', new InMemoryAuditRepository())).status).toBe('approved');
  });
});

type Call = { url: string; method: string; body: unknown; auth: string | null };

describe('UpdateGoogleListingWebsiteExecutionHandler', () => {
  let originalKey: string | undefined;
  beforeAll(() => {
    originalKey = process.env.TENANT_ENCRYPTION_KEY;
    process.env.TENANT_ENCRYPTION_KEY = '0'.repeat(64);
  });
  afterAll(() => {
    if (originalKey === undefined) delete process.env.TENANT_ENCRYPTION_KEY;
    else process.env.TENANT_ENCRYPTION_KEY = originalKey;
  });

  let integrationRepo: InMemoryGoogleBusinessIntegrationRepository;
  let auditRepo: InMemoryAuditRepository;
  let calls: Call[];

  beforeEach(() => {
    integrationRepo = new InMemoryGoogleBusinessIntegrationRepository();
    auditRepo = new InMemoryAuditRepository();
    calls = [];
  });

  async function connect(withLocation = true) {
    return integrationRepo.upsert({
      tenantId: TENANT,
      accessToken: 'AT-old',
      refreshToken: 'RT',
      accessTokenExpiresAt: new Date(Date.now() + 3600_000),
      ...(withLocation
        ? {
            selection: {
              accountId: '123',
              locationId: '999',
              placeId: 'ChIJ',
              reviewUrl: null,
              locationTitle: 'Joes',
            },
          }
        : {}),
      locationCount: withLocation ? 1 : 2,
    });
  }

  /** A fetch that answers each Google endpoint from `routes`, recording every call. */
  function googleFetch(
    routes: (url: string, method: string, auth: string | null) => { status: number; body?: unknown } | undefined,
  ): typeof fetch {
    return (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      const auth = (init?.headers as Record<string, string> | undefined)?.Authorization ?? null;
      const raw = init?.body ? String(init.body) : undefined;
      // The token endpoint takes a form body; everything else is JSON.
      calls.push({ url, method, body: raw && raw.startsWith('{') ? JSON.parse(raw) : raw, auth });
      const out = routes(url, method, auth) ?? { status: 200, body: {} };
      return {
        ok: out.status >= 200 && out.status < 300,
        status: out.status,
        headers: new Headers(),
        json: async () => out.body ?? {},
        text: async () => JSON.stringify(out.body ?? {}),
      } as Response;
    }) as typeof fetch;
  }

  const ctx = { tenantId: TENANT, executedBy: 'owner-1', executedByRole: 'owner' as const };

  function handler(fetchFn: typeof fetch) {
    return new UpdateGoogleListingWebsiteExecutionHandler(integrationRepo, CONFIG, auditRepo, fetchFn);
  }

  it('patches websiteUri on the location, adds the appointment link, records the site and audits', async () => {
    const summary = await connect();
    const fetchFn = googleFetch((url, method) =>
      method === 'GET' && url.includes('placeActionLinks') ? { status: 200, body: { placeActionLinks: [] } } : undefined,
    );
    const result = await handler(fetchFn).execute(approved({ websiteUri: SITE, bookingUri: BOOK }), ctx);

    expect(result).toEqual({ success: true, resultEntityId: summary.id });
    const patch = calls.find((c) => c.method === 'PATCH')!;
    expect(patch.url).toBe(
      'https://mybusinessbusinessinformation.googleapis.com/v1/locations/999?updateMask=websiteUri',
    );
    expect(patch.body).toEqual({ websiteUri: SITE });
    expect(patch.auth).toBe('Bearer AT-old');
    const create = calls.find((c) => c.method === 'POST')!;
    expect(create.url).toBe('https://mybusinessplaceactions.googleapis.com/v1/locations/999/placeActionLinks');
    expect(create.body).toEqual({ uri: BOOK, placeActionType: 'APPOINTMENT', isPreferred: true });

    expect((await integrationRepo.get(TENANT))?.listingWebsiteUri).toBe(SITE);
    const [event] = await auditRepo.findByEntity(TENANT, 'google_business_listing', summary.id);
    expect(event).toMatchObject({
      eventType: 'google_listing.website_set',
      actorId: 'owner-1',
      metadata: { websiteUri: SITE, bookingUri: BOOK, bookingLinkCreated: true },
    });
  });

  it('does not duplicate a booking link Google already has', async () => {
    await connect();
    const fetchFn = googleFetch((url, method) =>
      method === 'GET'
        ? { status: 200, body: { placeActionLinks: [{ uri: BOOK, placeActionType: 'APPOINTMENT' }] } }
        : undefined,
    );
    const result = await handler(fetchFn).execute(approved({ websiteUri: SITE, bookingUri: BOOK }), ctx);
    expect(result.success).toBe(true);
    expect(calls.some((c) => c.method === 'POST')).toBe(false);
  });

  it('writes only the website when the payload has no booking link', async () => {
    await connect();
    const result = await handler(googleFetch(() => undefined)).execute(approved({ websiteUri: SITE }), ctx);
    expect(result.success).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe('PATCH');
  });

  it('refreshes an expired token on 401 and retries once', async () => {
    await connect();
    let patches = 0;
    const fetchFn = googleFetch((url, method, auth) => {
      if (url.includes('oauth2.googleapis.com/token')) {
        return { status: 200, body: { access_token: 'AT-new', expires_in: 3600 } };
      }
      if (method === 'PATCH') {
        patches += 1;
        return auth === 'Bearer AT-new' ? { status: 200, body: {} } : { status: 401, body: {} };
      }
      return undefined;
    });
    const result = await handler(fetchFn).execute(approved({ websiteUri: SITE }), ctx);
    expect(result.success).toBe(true);
    expect(patches).toBe(2);
    expect((await integrationRepo.getTokens(TENANT))?.accessToken).toBe('AT-new');
  });

  it('writes nothing when the listing is disconnected', async () => {
    const fetchFn = googleFetch(() => undefined);
    const result = await handler(fetchFn).execute(approved({ websiteUri: SITE }), ctx);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/not connected/);
    expect(calls).toHaveLength(0);
  });

  it('writes nothing when connected but no location is chosen', async () => {
    await connect(false);
    const result = await handler(googleFetch(() => undefined)).execute(approved({ websiteUri: SITE }), ctx);
    expect(result.success).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it('refuses a payload with no website, calling Google never', async () => {
    await connect();
    const result = await handler(googleFetch(() => undefined)).execute(approved({ websiteUri: '' }), ctx);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/contract/);
    expect(calls).toHaveLength(0);
  });

  it('surfaces a reason when Google rejects the credentials for good, recording nothing', async () => {
    await connect();
    const fetchFn = googleFetch((url) =>
      url.includes('oauth2.googleapis.com/token') ? { status: 400, body: { error: 'invalid_grant' } } : { status: 401 },
    );
    const result = await handler(fetchFn).execute(approved({ websiteUri: SITE }), ctx);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/Reconnect your Google Business Profile/);
    expect((await integrationRepo.get(TENANT))?.listingWebsiteUri).toBeNull();
    const events = await auditRepo.findByEntity(TENANT, 'google_business_listing', (await integrationRepo.get(TENANT))!.id);
    expect(events.map((e) => e.eventType)).toEqual(['google_listing.website_failed']);
  });

  it('surfaces Google\'s error text when the API refuses the change', async () => {
    await connect();
    const result = await handler(
      googleFetch((_u, method) => (method === 'PATCH' ? { status: 403, body: { error: 'API not enabled' } } : undefined)),
    ).execute(approved({ websiteUri: SITE }), ctx);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/Google did not accept the change.*403/);
  });

  it('says the website landed when only the booking link fails', async () => {
    await connect();
    const result = await handler(
      googleFetch((url, method) =>
        url.includes('placeActionLinks') && method === 'GET'
          ? { status: 200, body: {} }
          : url.includes('placeActionLinks')
            ? { status: 403, body: {} }
            : undefined,
      ),
    ).execute(approved({ websiteUri: SITE, bookingUri: BOOK }), ctx);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/^Your website is on Google, but the booking link was not added/);
    expect((await integrationRepo.get(TENANT))?.listingWebsiteUri).toBe(SITE);
  });

  it('reports a wiring fault instead of a synthetic success', async () => {
    const h = new UpdateGoogleListingWebsiteExecutionHandler(undefined, null, auditRepo);
    expect(h.isFullyWired()).toBe(false);
    expect(await h.execute(approved({ websiteUri: SITE }), ctx)).toEqual({
      success: false,
      error: 'handler_not_wired:googleBusinessIntegrationRepo',
    });
  });
});

