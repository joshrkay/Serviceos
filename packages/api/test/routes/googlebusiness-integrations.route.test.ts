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
import { runGoogleReviewsSweep } from '../../src/workers/google-reviews';
import { createLogger } from '../../src/logging/logger';
import type { AuthenticatedRequest } from '../../src/auth/clerk';
import {
  InMemorySettingsRepository,
  type SettingsRepository,
  type TenantSettings,
} from '../../src/settings/settings';

const TENANT = 'tenant-gbp-1';
const USER = 'user-gbp-1';
const TEST_KEY = '0'.repeat(64);

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

const REVIEW_URL_999 = 'https://search.google.com/local/writereview?placeid=PID-999';
const REVIEW_URL_1000 = 'https://search.google.com/local/writereview?placeid=PID-1000';

const LOC_999 = {
  name: 'locations/999',
  title: 'Acme HVAC',
  metadata: { placeId: 'PID-999', newReviewUri: REVIEW_URL_999 },
};
const LOC_1000 = {
  name: 'locations/1000',
  title: 'Acme Plumbing',
  metadata: { placeId: 'PID-1000', newReviewUri: REVIEW_URL_1000 },
};

/**
 * Fetch stub covering the whole callback flow: token exchange, v4 account
 * discovery and Business Information location details.
 */
function makeConnectFetch(
  locations: unknown[] = [LOC_999],
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
    if (url.includes('mybusinessbusinessinformation.googleapis.com/v1/accounts/123/locations')) {
      return jsonRes({ locations });
    }
    if (url.includes('/v4/accounts')) {
      return jsonRes({ accounts: [{ name: 'accounts/123' }] });
    }
    return jsonRes({}, 404);
  });
}

function seedSettings(
  tenantId: string,
  googleReviewUrl?: string,
): Promise<InMemorySettingsRepository> {
  const repo = new InMemorySettingsRepository();
  const now = new Date();
  return repo
    .create({
      id: 'settings-1',
      tenantId,
      businessName: 'Acme',
      timezone: 'America/New_York',
      estimatePrefix: 'EST',
      invoicePrefix: 'INV',
      nextEstimateNumber: 1,
      nextInvoiceNumber: 1,
      defaultPaymentTermDays: 30,
      terminologyPreferences: {},
      createdAt: now,
      updatedAt: now,
      ...(googleReviewUrl !== undefined ? { googleReviewUrl } : {}),
    } as TenantSettings)
    .then(() => repo);
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
  settingsRepo?: SettingsRepository;
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
        accountId: '123',
        locationId: '999',
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
      accountId: '123',
      locationId: '999',
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
    expect(summary?.placeId).toBe('PID-999');
    expect(summary?.reviewUrl).toBe(REVIEW_URL_999);
    expect(summary?.locationStatus).toBe('connected');

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
      accountId: '123',
      locationId: '999',
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

  describe('location selection + review link (#1762)', () => {
    async function runCallback(
      locations: unknown[],
      settingsRepo?: SettingsRepository,
      redirectAfter?: string,
    ) {
      const { id: stateId } = await stateRepo.create({
        tenantId: TENANT,
        userId: USER,
        provider: 'google_business',
        ...(redirectAfter ? { redirectAfter } : {}),
      });
      const auditRepo = new InMemoryAuditRepository();
      const app = buildApp({
        integrationRepo,
        stateRepo,
        authenticate: false,
        googleConfig: GOOGLE_CONFIG,
        googleFetch: makeConnectFetch(locations) as unknown as typeof fetch,
        auditRepo,
        settingsRepo,
      });
      const res = await request(app)
        .get('/api/googlebusiness-integrations/google/callback')
        .query({ code: 'auth-xyz', state: stateId });
      return { res, auditRepo };
    }

    it('one location connects directly and fills an empty googleReviewUrl', async () => {
      const settingsRepo = await seedSettings(TENANT);
      const { res, auditRepo } = await runCallback([LOC_999], settingsRepo);
      expect(res.headers.location).toContain('googlebusiness_connected=1');
      expect(res.headers.location).not.toContain('googlebusiness_pick');
      expect((await settingsRepo.findByTenant(TENANT))?.googleReviewUrl).toBe(REVIEW_URL_999);
      const summary = await integrationRepo.get(TENANT);
      const events = await auditRepo.findByEntity(TENANT, 'googlebusiness_integration', summary!.id);
      expect(events[0].metadata).toMatchObject({ locationStatus: 'connected', reviewUrlFilled: true });
    });

    it('never overwrites a hand-entered review link', async () => {
      const settingsRepo = await seedSettings(TENANT, 'https://g.page/r/my-own/review');
      await runCallback([LOC_999], settingsRepo);
      expect((await settingsRepo.findByTenant(TENANT))?.googleReviewUrl).toBe(
        'https://g.page/r/my-own/review',
      );
    });

    it('several locations: stores needs_selection, no location, sends the owner to the picker', async () => {
      const settingsRepo = await seedSettings(TENANT);
      const { res } = await runCallback([LOC_999, LOC_1000], settingsRepo, '/home');
      expect(res.headers.location).toContain('googlebusiness_pick=1');
      expect(res.headers.location).toContain('/settings');
      const summary = await integrationRepo.get(TENANT);
      expect(summary?.locationStatus).toBe('needs_selection');
      expect(summary?.locationId).toBeNull();
      expect(summary?.accountId).toBe('123');
      expect((await settingsRepo.findByTenant(TENANT))?.googleReviewUrl).toBeUndefined();
    });

    it('zero locations: explicit no_location status', async () => {
      await runCallback([]);
      const summary = await integrationRepo.get(TENANT);
      expect(summary?.locationStatus).toBe('no_location');
      expect(summary?.locationId).toBeNull();
      const app = buildApp({ integrationRepo, stateRepo });
      const res = await request(app).get('/api/googlebusiness-integrations/');
      expect(res.body.data.locationStatus).toBe('no_location');
    });

    async function seedMulti() {
      await runCallback([LOC_999, LOC_1000]);
    }

    it('GET /google/locations lists live locations for the picker', async () => {
      await seedMulti();
      const app = buildApp({
        integrationRepo,
        stateRepo,
        googleConfig: GOOGLE_CONFIG,
        googleFetch: makeConnectFetch([LOC_999, LOC_1000]) as unknown as typeof fetch,
      });
      const res = await request(app).get('/api/googlebusiness-integrations/google/locations');
      expect(res.status).toBe(200);
      expect(res.body.data.map((l: { locationId: string }) => l.locationId)).toEqual(['999', '1000']);
      expect(res.body.data[0]).toMatchObject({ title: 'Acme HVAC', placeId: 'PID-999' });
    });

    it('PUT /google/location stores the pick, fills the review link, and audits', async () => {
      await seedMulti();
      const settingsRepo = await seedSettings(TENANT);
      const auditRepo = new InMemoryAuditRepository();
      const app = buildApp({
        integrationRepo,
        stateRepo,
        googleConfig: GOOGLE_CONFIG,
        googleFetch: makeConnectFetch([LOC_999, LOC_1000]) as unknown as typeof fetch,
        settingsRepo,
        auditRepo,
      });
      const res = await request(app)
        .put('/api/googlebusiness-integrations/google/location')
        .send({ locationId: '1000' });
      expect(res.status).toBe(200);
      const summary = await integrationRepo.get(TENANT);
      expect(summary).toMatchObject({
        locationStatus: 'connected',
        locationId: '1000',
        placeId: 'PID-1000',
        reviewUrl: REVIEW_URL_1000,
      });
      expect((await settingsRepo.findByTenant(TENANT))?.googleReviewUrl).toBe(REVIEW_URL_1000);
      const events = await auditRepo.findByEntity(TENANT, 'googlebusiness_integration', summary!.id);
      expect(events.map((e) => e.eventType)).toContain('googlebusiness_integration.location_changed');
    });

    it('switching location replaces an auto-filled link but not a hand-entered one', async () => {
      await runCallback([LOC_999, LOC_1000]);
      const autoRepo = await seedSettings(TENANT);
      const handRepo = await seedSettings(TENANT, 'https://g.page/r/mine');
      const fetchStub = makeConnectFetch([LOC_999, LOC_1000]) as unknown as typeof fetch;
      const pick = async (id: string, settingsRepo: SettingsRepository) =>
        request(buildApp({ integrationRepo, stateRepo, googleConfig: GOOGLE_CONFIG, googleFetch: fetchStub, settingsRepo }))
          .put('/api/googlebusiness-integrations/google/location')
          .send({ locationId: id });

      await pick('999', autoRepo);
      await pick('1000', autoRepo);
      expect((await autoRepo.findByTenant(TENANT))?.googleReviewUrl).toBe(REVIEW_URL_1000);

      await pick('999', handRepo);
      expect((await handRepo.findByTenant(TENANT))?.googleReviewUrl).toBe('https://g.page/r/mine');
    });

    it('PUT /google/location rejects a location not on the account and a technician', async () => {
      await seedMulti();
      const mk = (role?: 'technician') =>
        buildApp({
          integrationRepo,
          stateRepo,
          googleConfig: GOOGLE_CONFIG,
          googleFetch: makeConnectFetch([LOC_999, LOC_1000]) as unknown as typeof fetch,
          ...(role ? { role } : {}),
        });
      const bad = await request(mk())
        .put('/api/googlebusiness-integrations/google/location')
        .send({ locationId: 'nope' });
      expect(bad.status).toBe(400);
      const tech = await request(mk('technician'))
        .put('/api/googlebusiness-integrations/google/location')
        .send({ locationId: '999' });
      expect(tech.status).toBe(403);
    });

    it('PUT /google/location 404s when Google is not connected', async () => {
      const res = await request(buildApp({ integrationRepo, stateRepo, googleConfig: GOOGLE_CONFIG }))
        .put('/api/googlebusiness-integrations/google/location')
        .send({ locationId: '999' });
      expect(res.status).toBe(404);
    });
  });
});
