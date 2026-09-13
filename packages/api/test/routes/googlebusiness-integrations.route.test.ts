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

/** Fetch stub covering the whole callback flow: token exchange + v4 discovery. */
function makeConnectFetch(): ReturnType<typeof vi.fn> {
  return vi.fn(async (input: string | URL | Request): Promise<Response> => {
    const url = String(input);
    if (url.includes('oauth2.googleapis.com/token')) {
      return jsonRes({
        access_token: 'AT-x',
        refresh_token: 'RT-x',
        expires_in: 3600,
      });
    }
    if (url.includes('/v4/accounts/123/locations')) {
      return jsonRes({ locations: [{ name: 'accounts/123/locations/999' }] });
    }
    if (url.includes('/v4/accounts')) {
      return jsonRes({ accounts: [{ name: 'accounts/123' }] });
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
  auditRepo?: InMemoryAuditRepository;
  pollStateRepo?: InMemoryReviewPollStateRepository;
}) {
  const app = express();
  app.use(express.json());
  if (opts.authenticate !== false) {
    app.use((req: Request, _res: Response, next: NextFunction) => {
      (req as AuthenticatedRequest).auth = {
        userId: USER,
        sessionId: 'sess-1',
        tenantId: TENANT,
        role: 'owner',
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
      provider: 'google',
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
      provider: 'google',
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

  it('GET /google/callback ignores an open-redirect attempt and falls back to default', async () => {
    const { id: stateId } = await stateRepo.create({
      tenantId: TENANT,
      userId: USER,
      provider: 'google',
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
});
