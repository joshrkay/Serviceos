/**
 * Review-monitoring self-serve — Google Business connect routes.
 *
 * Mirrors calendar-integrations.route.test.ts: an unauthenticated OAuth
 * callback router (state-nonce bound) + an authed lifecycle router
 * (status / connect / disconnect), tenant-scoped via Clerk auth.
 *
 * The load-bearing test here is the callback→worker round-trip: the
 * callback must persist credentials on `tenant_integrations` in the
 * EXACT shape `runGoogleReviewsSweep` reads (encrypted `accessTokenEnc`
 * + `providerData.{accountId,locationId}`), proven by running the real
 * sweep against the repo the callback wrote to.
 */
import request from 'supertest';
import express, { Request, Response, NextFunction } from 'express';
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import {
  createGoogleBusinessIntegrationsRouter,
  createGoogleBusinessOAuthCallbackRouter,
} from '../../src/routes/googlebusiness-integrations';
import {
  InMemoryGoogleBusinessIntegrationRepository,
} from '../../src/reputation/google-business-integration';
import { InMemoryOAuthStateRepository } from '../../src/integrations/calendar-integration';
import { InMemoryReviewPollStateRepository } from '../../src/reputation/poll-state';
import { InMemoryReviewRepository } from '../../src/reputation/review';
import { InMemoryAuditRepository } from '../../src/audit/audit';
import { InMemorySettingsRepository } from '../../src/settings/settings';
import { runGoogleReviewsSweep } from '../../src/workers/google-reviews';
import { createLogger } from '../../src/logging/logger';
import type { AuthenticatedRequest } from '../../src/auth/clerk';

const TENANT = 'tenant-gbp-1';
const USER = 'user-gbp-1';
const TEST_KEY = '0'.repeat(64);
const SELECTION = {
  accountId: '123',
  locationId: '999',
  placeId: 'ChIJplace',
  reviewUrl: 'https://g.page/r/review-999',
  locationTitle: 'Acme Plumbing',
};

const GOOGLE_CONFIG = {
  clientId: 'cid',
  clientSecret: 'csec',
  redirectUri:
    'https://api.example.com/api/googlebusiness-integrations/google/callback',
};

function jsonRes(body: unknown, status = 200): Response {
  return {
    ok: status < 400,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

type StubLocation = {
  name: string;
  title?: string;
  storefrontAddress?: { addressLines?: string[]; locality?: string };
  metadata?: { placeId?: string; newReviewUri?: string };
};

const ONE_LOCATION: StubLocation[] = [
  {
    name: 'locations/999',
    title: 'Acme Plumbing',
    storefrontAddress: { addressLines: ['1 Main St'], locality: 'Austin' },
    metadata: { placeId: 'ChIJplace', newReviewUri: 'https://g.page/r/review-999' },
  },
];

/**
 * Fetch stub covering the whole callback flow: token exchange + discovery
 * (Account Management accounts, Business Information locations). Every
 * location sits under account 123 unless `byAccount` says otherwise.
 */
function makeConnectFetch(
  byAccount: Record<string, StubLocation[]> = { '123': ONE_LOCATION },
): ReturnType<typeof vi.fn> {
  return vi.fn(async (input: string | URL | Request): Promise<Response> => {
    const url = String(input);
    if (url.includes('oauth2.googleapis.com/token')) {
      return jsonRes({
        access_token: 'AT-x',
        refresh_token: 'RT-x',
        expires_in: 3600,
      });
    }
    const locMatch = url.match(
      /mybusinessbusinessinformation\.googleapis\.com\/v1\/accounts\/(\w+)\/locations/,
    );
    if (locMatch) {
      return jsonRes({ locations: byAccount[locMatch[1]] ?? [] });
    }
    if (url.includes('mybusinessaccountmanagement.googleapis.com/v1/accounts')) {
      return jsonRes({
        accounts: Object.keys(byAccount).map((id) => ({ name: `accounts/${id}` })),
      });
    }
    return jsonRes({}, 404);
  });
}

function buildApp(opts: {
  integrationRepo: InMemoryGoogleBusinessIntegrationRepository;
  stateRepo: InMemoryOAuthStateRepository;
  googleConfig?: typeof GOOGLE_CONFIG;
  googleFetch?: typeof fetch;
  authenticate?: boolean;
  role?: NonNullable<AuthenticatedRequest['auth']>['role'];
  auditRepo?: InMemoryAuditRepository;
  pollStateRepo?: InMemoryReviewPollStateRepository;
  settingsRepo?: InMemorySettingsRepository;
}) {
  const app = express();
  app.use(express.json());
  if (opts.authenticate !== false) {
    app.use((req: Request, _res: Response, next: NextFunction) => {
      (req as AuthenticatedRequest).auth = {
        userId: USER,
        sessionId: 'sess-1',
        tenantId: TENANT,
        role: opts.role ?? 'owner',
      };
      next();
    });
  }
  const deps = {
    integrationRepo: opts.integrationRepo,
    stateRepo: opts.stateRepo,
    googleConfig: opts.googleConfig,
    googleFetch: opts.googleFetch,
    appBaseUrl: 'https://app.example.com',
    auditRepo: opts.auditRepo,
    pollStateRepo: opts.pollStateRepo,
    settingsRepo: opts.settingsRepo,
  };
  // Callback first — in prod it mounts BEFORE the global Clerk auth.
  app.use(
    '/api/googlebusiness-integrations',
    createGoogleBusinessOAuthCallbackRouter(deps),
  );
  app.use(
    '/api/googlebusiness-integrations',
    createGoogleBusinessIntegrationsRouter(deps),
  );
  return app;
}

describe('Google Business integrations routes', () => {
  let originalKey: string | undefined;
  let integrationRepo: InMemoryGoogleBusinessIntegrationRepository;
  let stateRepo: InMemoryOAuthStateRepository;

  beforeAll(() => {
    originalKey = process.env.TENANT_ENCRYPTION_KEY;
    process.env.TENANT_ENCRYPTION_KEY = TEST_KEY;
  });

  afterAll(() => {
    if (originalKey === undefined) delete process.env.TENANT_ENCRYPTION_KEY;
    else process.env.TENANT_ENCRYPTION_KEY = originalKey;
  });

  beforeEach(() => {
    integrationRepo = new InMemoryGoogleBusinessIntegrationRepository();
    stateRepo = new InMemoryOAuthStateRepository();
  });

  describe('auth gating (Clerk-authed, tenant-scoped)', () => {
    it('rejects unauthenticated requests on every lifecycle endpoint', async () => {
      const app = buildApp({
        integrationRepo,
        stateRepo,
        googleConfig: GOOGLE_CONFIG,
        authenticate: false,
      });
      expect(
        (await request(app).get('/api/googlebusiness-integrations/')).status,
      ).toBe(401);
      expect(
        (
          await request(app).post(
            '/api/googlebusiness-integrations/google/connect',
          )
        ).status,
      ).toBe(401);
      expect(
        (await request(app).delete('/api/googlebusiness-integrations/google'))
          .status,
      ).toBe(401);
    });

    it('GET / is tenant-scoped — another tenant’s integration is invisible', async () => {
      await integrationRepo.upsert({
        tenantId: 'tenant-other',
        accessToken: 'AT',
        refreshToken: 'RT',
        accessTokenExpiresAt: new Date(Date.now() + 3600_000),
        selection: SELECTION,
      });
      const app = buildApp({ integrationRepo, stateRepo });
      const res = await request(app).get('/api/googlebusiness-integrations/');
      expect(res.status).toBe(200);
      expect(res.body.data).toBeNull();
    });
  });

  it('GET / returns null when nothing is connected', async () => {
    const app = buildApp({ integrationRepo, stateRepo });
    const res = await request(app).get('/api/googlebusiness-integrations/');
    expect(res.status).toBe(200);
    expect(res.body.data).toBeNull();
  });

  it('GET / returns metadata + poll state (never token blobs) when connected', async () => {
    await integrationRepo.upsert({
      tenantId: TENANT,
      accessToken: 'AT',
      refreshToken: 'RT',
      accessTokenExpiresAt: new Date(Date.now() + 3600_000),
      selection: SELECTION,
    });
    const pollStateRepo = new InMemoryReviewPollStateRepository();
    // Simulate a broken-credentials backoff so the surface shows it.
    await pollStateRepo.recordQuotaError(TENANT, 3600);

    const app = buildApp({ integrationRepo, stateRepo, pollStateRepo });
    const res = await request(app).get('/api/googlebusiness-integrations/');
    expect(res.status).toBe(200);
    expect(res.body.data.provider).toBe('google_business');
    expect(res.body.data.accountId).toBe('123');
    expect(res.body.data.locationId).toBe('999');
    // Visible degradation: the backoff window is exposed to the UI.
    expect(res.body.data.backoffUntil).toBeTruthy();
    // No token material of any shape leaks.
    const raw = JSON.stringify(res.body);
    expect(raw).not.toContain('AT');
    expect(raw).not.toContain('RT');
    expect(raw).not.toContain('TokenEnc');
  });

  it('403s a technician on connect and disconnect (tenant-wide integration, settings:update)', async () => {
    const app = buildApp({ integrationRepo, stateRepo, googleConfig: GOOGLE_CONFIG, role: 'technician' });
    const connect = await request(app).post('/api/googlebusiness-integrations/google/connect').send({});
    expect(connect.status).toBe(403);
    const disconnect = await request(app).delete('/api/googlebusiness-integrations/google');
    expect(disconnect.status).toBe(403);
  });

  it('POST /google/connect mints a business.manage consent URL with a state nonce', async () => {
    const auditRepo = new InMemoryAuditRepository();
    const app = buildApp({
      integrationRepo,
      stateRepo,
      googleConfig: GOOGLE_CONFIG,
      auditRepo,
    });
    const res = await request(app).post(
      '/api/googlebusiness-integrations/google/connect',
    );
    expect(res.status).toBe(200);
    expect(res.body.url).toContain('accounts.google.com');
    expect(res.body.url).toContain('client_id=cid');
    expect(res.body.url).toContain('business.manage');
    const stateMatch = (res.body.url as string).match(/state=([^&]+)/);
    expect(stateMatch).toBeTruthy();

    // Audit mirrors the calendar flow: connect intent keyed to the nonce.
    const events = await auditRepo.findByEntity(
      TENANT,
      'oauth_state',
      decodeURIComponent(stateMatch![1]),
    );
    expect(events).toHaveLength(1);
    expect(events[0].eventType).toBe('googlebusiness_integration.connected');
    expect(events[0].actorId).toBe(USER);
  });

  it('POST /google/connect returns 400 when Google config is missing', async () => {
    const app = buildApp({ integrationRepo, stateRepo });
    const res = await request(app).post(
      '/api/googlebusiness-integrations/google/connect',
    );
    expect(res.status).toBe(400);
  });

  it('GET /google/callback exchanges the code, stores worker-readable credentials, discovers account/location, and redirects', async () => {
    const auditRepo = new InMemoryAuditRepository();
    const { id: stateId } = await stateRepo.create({
      tenantId: TENANT,
      userId: USER,
      provider: 'google_business',
    });
    const fetchMock = makeConnectFetch();

    const app = buildApp({
      integrationRepo,
      stateRepo,
      authenticate: false,
      googleConfig: GOOGLE_CONFIG,
      googleFetch: fetchMock as unknown as typeof fetch,
      auditRepo,
    });

    const res = await request(app)
      .get('/api/googlebusiness-integrations/google/callback')
      .query({ code: 'auth-xyz', state: stateId });

    expect(res.status).toBe(302);
    expect(res.headers.location).toContain('/settings?googlebusiness_connected=1');

    const summary = await integrationRepo.get(TENANT);
    expect(summary?.accountId).toBe('123');
    expect(summary?.locationId).toBe('999');

    // Audit: callback consumed by the system actor (no Clerk session).
    const events = await auditRepo.findByEntity(
      TENANT,
      'googlebusiness_integration',
      summary!.id,
    );
    expect(events).toHaveLength(1);
    expect(events[0].eventType).toBe(
      'googlebusiness_integration.callback_consumed',
    );
    expect(events[0].actorId).toBe('system:google-oauth-callback');
  });

  it('callback-written credentials are readable by the ACTUAL poll worker (end-to-end shape proof)', async () => {
    const { id: stateId } = await stateRepo.create({
      tenantId: TENANT,
      userId: USER,
      provider: 'google_business',
    });
    const app = buildApp({
      integrationRepo,
      stateRepo,
      authenticate: false,
      googleConfig: GOOGLE_CONFIG,
      googleFetch: makeConnectFetch() as unknown as typeof fetch,
    });
    await request(app)
      .get('/api/googlebusiness-integrations/google/callback')
      .query({ code: 'auth-xyz', state: stateId });

    // Now run the REAL sweep with the repo standing in as the
    // CredentialResolver (same `tenant_integrations` row shape).
    const reviewRepo = new InMemoryReviewRepository();
    const pollStateRepo = new InMemoryReviewPollStateRepository();
    const sweepFetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      // The worker must present the token the callback stored (encrypted
      // at rest, decrypted via TENANT_ENCRYPTION_KEY on read).
      expect(headers.Authorization).toBe('Bearer AT-x');
      expect(String(input)).toContain('/accounts/123/locations/999/reviews');
      return jsonRes({
        reviews: [
          {
            name: 'accounts/123/locations/999/reviews/r1',
            reviewer: { displayName: 'Alice' },
            starRating: 'FIVE',
            comment: 'Great',
            createTime: '2026-08-05T10:00:00Z',
            updateTime: '2026-08-05T10:00:00Z',
          },
        ],
      });
    });

    const result = await runGoogleReviewsSweep({
      reviewRepo,
      pollStateRepo,
      credentialResolver: integrationRepo,
      listTenantIds: async () => [TENANT],
      logger: createLogger({ service: 'test', environment: 'test', level: 'error' }),
      fetchFn: sweepFetch as unknown as typeof fetch,
    });

    expect(result.failed).toBe(0);
    expect(result.persisted).toBe(1);
  });

  it('GET /google/callback redirects with googlebusiness_error when Google returns ?error=', async () => {
    const app = buildApp({
      integrationRepo,
      stateRepo,
      authenticate: false,
      googleConfig: GOOGLE_CONFIG,
    });
    const res = await request(app)
      .get('/api/googlebusiness-integrations/google/callback')
      .query({ error: 'access_denied' });
    expect(res.status).toBe(302);
    expect(res.headers.location).toContain('googlebusiness_error=access_denied');
  });

  it('GET /google/callback rejects an invalid/expired state', async () => {
    const app = buildApp({
      integrationRepo,
      stateRepo,
      authenticate: false,
      googleConfig: GOOGLE_CONFIG,
    });
    const res = await request(app)
      .get('/api/googlebusiness-integrations/google/callback')
      .query({ code: 'xyz', state: 'unknown-state' });
    expect(res.status).toBe(400);
  });

  it('GET /google/callback rejects a state minted by the calendar connect flow', async () => {
    // Calendar connect is open to any member and shares the Google OAuth
    // client; its nonce must not complete this owner-only connect even
    // when the code exchange would succeed.
    const { id: stateId } = await stateRepo.create({
      tenantId: TENANT,
      userId: 'technician-1',
      provider: 'google',
    });
    const fetchMock = makeConnectFetch();
    const app = buildApp({
      integrationRepo,
      stateRepo,
      authenticate: false,
      googleConfig: GOOGLE_CONFIG,
      googleFetch: fetchMock as unknown as typeof fetch,
    });
    const res = await request(app)
      .get('/api/googlebusiness-integrations/google/callback')
      .query({ code: 'auth-xyz', state: stateId });
    expect(res.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await integrationRepo.get(TENANT)).toBeNull();
  });

  it('GET /google/callback ignores an open-redirect attempt and falls back to default', async () => {
    const { id: stateId } = await stateRepo.create({
      tenantId: TENANT,
      userId: USER,
      provider: 'google_business',
      redirectAfter: '//evil.com/phish',
    });
    const app = buildApp({
      integrationRepo,
      stateRepo,
      authenticate: false,
      googleConfig: GOOGLE_CONFIG,
      googleFetch: makeConnectFetch() as unknown as typeof fetch,
    });
    const res = await request(app)
      .get('/api/googlebusiness-integrations/google/callback')
      .query({ code: 'auth-xyz', state: stateId });
    expect(res.status).toBe(302);
    expect(res.headers.location).toContain('/settings?googlebusiness_connected=1');
    expect(res.headers.location).not.toContain('evil.com');
  });

  it('DELETE /google disconnects, audits, and the worker then skips the tenant silently', async () => {
    const auditRepo = new InMemoryAuditRepository();
    await integrationRepo.upsert({
      tenantId: TENANT,
      accessToken: 'AT',
      refreshToken: 'RT',
      accessTokenExpiresAt: new Date(Date.now() + 3600_000),
      selection: SELECTION,
    });
    const app = buildApp({ integrationRepo, stateRepo, auditRepo });
    const res = await request(app).delete(
      '/api/googlebusiness-integrations/google',
    );
    expect(res.status).toBe(200);
    expect(res.body.revoked).toBe(true);
    expect(await integrationRepo.get(TENANT)).toBeNull();

    const events = await auditRepo.findByEntity(
      TENANT,
      'googlebusiness_integration',
      `${TENANT}:google_business`,
    );
    expect(events).toHaveLength(1);
    expect(events[0].eventType).toBe('googlebusiness_integration.disconnected');

    // The sweep now sees no credential row → silent skip (no failures).
    const result = await runGoogleReviewsSweep({
      reviewRepo: new InMemoryReviewRepository(),
      pollStateRepo: new InMemoryReviewPollStateRepository(),
      credentialResolver: integrationRepo,
      listTenantIds: async () => [TENANT],
      logger: createLogger({ service: 'test', environment: 'test', level: 'error' }),
      fetchFn: (async () => {
        throw new Error('must not fetch after disconnect');
      }) as unknown as typeof fetch,
    });
    expect(result.failed).toBe(0);
    expect(result.fetched).toBe(0);
  });

  it('DELETE /google returns 404 when nothing was connected', async () => {
    const app = buildApp({ integrationRepo, stateRepo });
    const res = await request(app).delete(
      '/api/googlebusiness-integrations/google',
    );
    expect(res.status).toBe(404);
  });

  describe('D-044 — choosing the Google listing and filling the review link', () => {
    const TWO_LOCATIONS: Record<string, StubLocation[]> = {
      '123': ONE_LOCATION,
      '456': [
        {
          name: 'locations/555',
          title: 'Acme North',
          metadata: { placeId: 'ChIJnorth', newReviewUri: 'https://g.page/r/review-555' },
        },
      ],
    };

    async function connect(
      byAccount: Record<string, StubLocation[]>,
      extra: { settingsRepo?: InMemorySettingsRepository; auditRepo?: InMemoryAuditRepository } = {},
    ) {
      const { id: stateId } = await stateRepo.create({
        tenantId: TENANT,
        userId: USER,
        provider: 'google_business',
      });
      const app = buildApp({
        integrationRepo,
        stateRepo,
        authenticate: false,
        googleConfig: GOOGLE_CONFIG,
        googleFetch: makeConnectFetch(byAccount) as unknown as typeof fetch,
        ...extra,
      });
      return request(app)
        .get('/api/googlebusiness-integrations/google/callback')
        .query({ code: 'auth-xyz', state: stateId });
    }

    async function settingsWith(googleReviewUrl?: string) {
      const settingsRepo = new InMemorySettingsRepository();
      await settingsRepo.upsertIdentityFields(TENANT, { businessName: 'Acme' });
      if (googleReviewUrl !== undefined) {
        await settingsRepo.update(TENANT, { googleReviewUrl });
      }
      return settingsRepo;
    }

    it('one location: connects it and fills the empty review link', async () => {
      const settingsRepo = await settingsWith();
      const auditRepo = new InMemoryAuditRepository();
      const res = await connect({ '123': ONE_LOCATION }, { settingsRepo, auditRepo });
      expect(res.status).toBe(302);

      const status = await request(
        buildApp({ integrationRepo, stateRepo }),
      ).get('/api/googlebusiness-integrations/');
      expect(status.body.data).toMatchObject({
        locationState: 'connected',
        locationId: '999',
        locationTitle: 'Acme Plumbing',
        placeId: 'ChIJplace',
        reviewUrl: 'https://g.page/r/review-999',
      });
      expect((await settingsRepo.findByTenant(TENANT))?.googleReviewUrl).toBe(
        'https://g.page/r/review-999',
      );
      const summary = await integrationRepo.get(TENANT);
      const [event] = await auditRepo.findByEntity(TENANT, 'googlebusiness_integration', summary!.id);
      expect(event.metadata).toMatchObject({ reviewUrlFilled: true, locationCount: 1 });
    });

    it('one location: a review link the owner typed is kept', async () => {
      const settingsRepo = await settingsWith('https://g.page/r/typed-by-owner');
      await connect({ '123': ONE_LOCATION }, { settingsRepo });
      expect((await settingsRepo.findByTenant(TENANT))?.googleReviewUrl).toBe(
        'https://g.page/r/typed-by-owner',
      );
    });

    it('several locations: nothing is chosen for the owner (needs_pick)', async () => {
      const settingsRepo = await settingsWith();
      await connect(TWO_LOCATIONS, { settingsRepo });
      const status = await request(buildApp({ integrationRepo, stateRepo })).get(
        '/api/googlebusiness-integrations/',
      );
      expect(status.body.data).toMatchObject({ locationState: 'needs_pick', locationId: null });
      expect((await settingsRepo.findByTenant(TENANT))?.googleReviewUrl ?? null).toBeNull();
    });

    it('no locations: reports no_location instead of a silent null', async () => {
      await connect({ '123': [] });
      const status = await request(buildApp({ integrationRepo, stateRepo })).get(
        '/api/googlebusiness-integrations/',
      );
      expect(status.body.data).toMatchObject({ locationState: 'no_location', locationId: null });
    });

    it('disconnect then connect a different listing replaces the old listing review link', async () => {
      const settingsRepo = await settingsWith();
      await connect({ '123': ONE_LOCATION }, { settingsRepo });
      expect(await integrationRepo.disconnect(TENANT)).toBe(true);
      await connect({ '456': TWO_LOCATIONS['456'] }, { settingsRepo });
      expect((await settingsRepo.findByTenant(TENANT))?.googleReviewUrl).toBe(
        'https://g.page/r/review-555',
      );
    });

    it('a reconnect keeps the location the owner already chose', async () => {
      await connect(TWO_LOCATIONS);
      await integrationRepo.selectLocation(TENANT, {
        accountId: '456',
        locationId: '555',
        placeId: 'ChIJnorth',
        reviewUrl: 'https://g.page/r/review-555',
        locationTitle: 'Acme North',
      });
      await connect(TWO_LOCATIONS);
      const summary = await integrationRepo.get(TENANT);
      expect(summary).toMatchObject({ accountId: '456', locationId: '555', locationCount: 2 });
    });

    it('GET /google/locations lists every location across accounts', async () => {
      await connect(TWO_LOCATIONS);
      const app = buildApp({
        integrationRepo,
        stateRepo,
        googleConfig: GOOGLE_CONFIG,
        googleFetch: makeConnectFetch(TWO_LOCATIONS) as unknown as typeof fetch,
      });
      const res = await request(app).get('/api/googlebusiness-integrations/google/locations');
      expect(res.status).toBe(200);
      expect(res.body.data.map((l: { locationId: string; title: string }) => [l.locationId, l.title])).toEqual([
        ['999', 'Acme Plumbing'],
        ['555', 'Acme North'],
      ]);
    });

    it('PUT /google/location chooses a location, fills the review link and audits', async () => {
      await connect(TWO_LOCATIONS);
      const settingsRepo = await settingsWith();
      const auditRepo = new InMemoryAuditRepository();
      const app = buildApp({
        integrationRepo,
        stateRepo,
        googleConfig: GOOGLE_CONFIG,
        googleFetch: makeConnectFetch(TWO_LOCATIONS) as unknown as typeof fetch,
        settingsRepo,
        auditRepo,
      });
      const res = await request(app)
        .put('/api/googlebusiness-integrations/google/location')
        .send({ accountId: '456', locationId: '555' });
      expect(res.status).toBe(200);
      expect(res.body.reviewUrlFilled).toBe(true);
      expect(res.body.data).toMatchObject({
        locationState: 'connected',
        locationId: '555',
        locationTitle: 'Acme North',
        reviewUrl: 'https://g.page/r/review-555',
      });
      expect((await settingsRepo.findByTenant(TENANT))?.googleReviewUrl).toBe(
        'https://g.page/r/review-555',
      );
      const summary = await integrationRepo.get(TENANT);
      const events = await auditRepo.findByEntity(TENANT, 'googlebusiness_integration', summary!.id);
      expect(events.map((e) => e.eventType)).toContain('googlebusiness_integration.location_selected');
    });

    it('PUT /google/location switching listings replaces the previously derived link', async () => {
      const settingsRepo = await settingsWith();
      await connect(TWO_LOCATIONS, { settingsRepo });
      const app = buildApp({
        integrationRepo,
        stateRepo,
        googleConfig: GOOGLE_CONFIG,
        googleFetch: makeConnectFetch(TWO_LOCATIONS) as unknown as typeof fetch,
        settingsRepo,
      });
      await request(app)
        .put('/api/googlebusiness-integrations/google/location')
        .send({ accountId: '123', locationId: '999' });
      await request(app)
        .put('/api/googlebusiness-integrations/google/location')
        .send({ accountId: '456', locationId: '555' });
      expect((await settingsRepo.findByTenant(TENANT))?.googleReviewUrl).toBe(
        'https://g.page/r/review-555',
      );
    });

    it('PUT /google/location to a listing with no review link clears the old one and says so', async () => {
      const WITH_UNVERIFIED: Record<string, StubLocation[]> = {
        '123': ONE_LOCATION,
        '789': [{ name: 'locations/777', title: 'Acme South' }],
      };
      const settingsRepo = await settingsWith();
      await connect(WITH_UNVERIFIED, { settingsRepo });
      const app = buildApp({
        integrationRepo,
        stateRepo,
        googleConfig: GOOGLE_CONFIG,
        googleFetch: makeConnectFetch(WITH_UNVERIFIED) as unknown as typeof fetch,
        settingsRepo,
      });
      await request(app)
        .put('/api/googlebusiness-integrations/google/location')
        .send({ accountId: '123', locationId: '999' });
      const res = await request(app)
        .put('/api/googlebusiness-integrations/google/location')
        .send({ accountId: '789', locationId: '777' });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ reviewUrlFilled: false, reviewUrlCleared: true });
      expect((await settingsRepo.findByTenant(TENANT))?.googleReviewUrl ?? null).toBeNull();
    });

    it('PUT /google/location rejects a location Google does not list for this connection', async () => {
      await connect(TWO_LOCATIONS);
      const app = buildApp({
        integrationRepo,
        stateRepo,
        googleConfig: GOOGLE_CONFIG,
        googleFetch: makeConnectFetch(TWO_LOCATIONS) as unknown as typeof fetch,
      });
      const bad = await request(app)
        .put('/api/googlebusiness-integrations/google/location')
        .send({ accountId: '123', locationId: '555' });
      expect(bad.status).toBe(400);
      const missing = await request(app)
        .put('/api/googlebusiness-integrations/google/location')
        .send({ accountId: '123' });
      expect(missing.status).toBe(400);
      expect((await integrationRepo.get(TENANT))?.locationId).toBeNull();
    });

    it('picker endpoints are owner-only and need a connection', async () => {
      const techApp = buildApp({ integrationRepo, stateRepo, role: 'technician' });
      expect(
        (await request(techApp).get('/api/googlebusiness-integrations/google/locations')).status,
      ).toBe(403);
      expect(
        (await request(techApp)
          .put('/api/googlebusiness-integrations/google/location')
          .send({ accountId: '1', locationId: '2' })).status,
      ).toBe(403);
      const ownerApp = buildApp({ integrationRepo, stateRepo, googleConfig: GOOGLE_CONFIG });
      expect(
        (await request(ownerApp).get('/api/googlebusiness-integrations/google/locations')).status,
      ).toBe(404);
    });

    it('a revoked connection asks the owner to reconnect', async () => {
      await connect(TWO_LOCATIONS);
      const revoked = vi.fn(async () => jsonRes({ error: 'invalid_grant' }, 401));
      const app = buildApp({
        integrationRepo,
        stateRepo,
        googleConfig: GOOGLE_CONFIG,
        googleFetch: revoked as unknown as typeof fetch,
      });
      const res = await request(app).get('/api/googlebusiness-integrations/google/locations');
      expect(res.status).toBe(400);
      expect(JSON.stringify(res.body)).toContain('Reconnect Google Business');
    });
  });
});
