import request from 'supertest';
import express, { Request, Response, NextFunction } from 'express';
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import {
  createCalendarIntegrationsRouter,
  createCalendarOAuthCallbackRouter,
} from '../../src/routes/calendar-integrations';
import {
  InMemoryCalendarIntegrationRepository,
  InMemoryOAuthStateRepository,
} from '../../src/integrations/calendar-integration';
import type { AuthenticatedRequest } from '../../src/auth/clerk';

const TENANT = 'tenant-cal-1';
const USER = 'user-cal-1';
const TEST_KEY = '0'.repeat(64);

function jsonRes(body: unknown, status = 200): Response {
  return {
    ok: status < 400,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

function buildApp(opts: {
  integrationRepo: InMemoryCalendarIntegrationRepository;
  stateRepo: InMemoryOAuthStateRepository;
  googleConfig?: {
    clientId: string;
    clientSecret: string;
    redirectUri: string;
  };
  googleFetch?: typeof fetch;
  authenticate?: boolean;
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
  // Mount the unauth callback first (so it's reachable WITHOUT the
  // auth middleware in the prod app).
  app.use(
    '/api/calendar-integrations',
    createCalendarOAuthCallbackRouter({
      integrationRepo: opts.integrationRepo,
      stateRepo: opts.stateRepo,
      googleConfig: opts.googleConfig,
      googleFetch: opts.googleFetch,
      appBaseUrl: 'https://app.example.com',
    }),
  );
  app.use(
    '/api/calendar-integrations',
    createCalendarIntegrationsRouter({
      integrationRepo: opts.integrationRepo,
      stateRepo: opts.stateRepo,
      googleConfig: opts.googleConfig,
      googleFetch: opts.googleFetch,
      appBaseUrl: 'https://app.example.com',
    }),
  );
  return app;
}

describe('Calendar integrations routes (PR 1)', () => {
  let originalKey: string | undefined;
  let integrationRepo: InMemoryCalendarIntegrationRepository;
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
    integrationRepo = new InMemoryCalendarIntegrationRepository();
    stateRepo = new InMemoryOAuthStateRepository();
  });

  it('GET / returns null when no integration is connected', async () => {
    const app = buildApp({ integrationRepo, stateRepo });
    const res = await request(app).get('/api/calendar-integrations/');
    expect(res.status).toBe(200);
    expect(res.body.data).toBeNull();
  });

  it('GET / returns the integration metadata (no token blobs) when connected', async () => {
    await integrationRepo.upsert({
      tenantId: TENANT, userId: USER, provider: 'google',
      accessToken: 'a', refreshToken: 'r',
      accessTokenExpiresAt: new Date(Date.now() + 3600_000),
      externalAccountEmail: 'alice@example.com',
    });
    const app = buildApp({ integrationRepo, stateRepo });
    const res = await request(app).get('/api/calendar-integrations/');
    expect(res.status).toBe(200);
    expect(res.body.data.externalAccountEmail).toBe('alice@example.com');
    expect(res.body.data.status).toBe('active');
    expect(res.body.data.accessTokenEncrypted).toBeUndefined();
    expect(res.body.data.refreshTokenEncrypted).toBeUndefined();
  });

  it('POST /google/connect returns a Google authorization URL with a state nonce', async () => {
    const app = buildApp({
      integrationRepo,
      stateRepo,
      googleConfig: {
        clientId: 'cid',
        clientSecret: 'csec',
        redirectUri: 'https://api.example.com/api/calendar-integrations/google/callback',
      },
    });
    const res = await request(app).post('/api/calendar-integrations/google/connect');
    expect(res.status).toBe(200);
    expect(res.body.url).toContain('accounts.google.com');
    expect(res.body.url).toContain('client_id=cid');
    // State nonce was minted.
    const stateMatch = (res.body.url as string).match(/state=([^&]+)/);
    expect(stateMatch).toBeTruthy();
  });

  it('POST /google/connect returns 400 when Google config is missing', async () => {
    const app = buildApp({ integrationRepo, stateRepo });
    const res = await request(app).post('/api/calendar-integrations/google/connect');
    expect(res.status).toBe(400);
  });

  it('GET /google/callback exchanges code, persists tokens, redirects to Settings', async () => {
    // Pre-create a state nonce.
    const { id: stateId } = await stateRepo.create({
      tenantId: TENANT,
      userId: USER,
      provider: 'google',
    });

    const fetchMock = vi.fn(async (input: string | URL | Request): Promise<Response> => {
      if (String(input).includes('/token')) {
        return jsonRes({
          access_token: 'AT-x',
          refresh_token: 'RT-x',
          expires_in: 3600,
        });
      }
      if (String(input).includes('/userinfo')) {
        return jsonRes({ email: 'invitee@example.com' });
      }
      return jsonRes({}, 404);
    });

    const app = buildApp({
      integrationRepo,
      stateRepo,
      authenticate: false,
      googleConfig: {
        clientId: 'cid',
        clientSecret: 'csec',
        redirectUri: 'https://api.example.com/api/calendar-integrations/google/callback',
      },
      googleFetch: fetchMock as unknown as typeof fetch,
    });

    const res = await request(app)
      .get('/api/calendar-integrations/google/callback')
      .query({ code: 'auth-xyz', state: stateId });

    expect(res.status).toBe(302);
    expect(res.headers.location).toContain('/settings?calendar_connected=1');

    // Persisted.
    const row = await integrationRepo.findByUser(TENANT, USER, 'google');
    expect(row?.externalAccountEmail).toBe('invitee@example.com');
    expect(row?.status).toBe('active');
  });

  it('GET /google/callback rejects an invalid/expired state', async () => {
    const app = buildApp({
      integrationRepo,
      stateRepo,
      authenticate: false,
      googleConfig: {
        clientId: 'cid',
        clientSecret: 'csec',
        redirectUri: 'https://api.example.com/cb',
      },
    });
    const res = await request(app)
      .get('/api/calendar-integrations/google/callback')
      .query({ code: 'xyz', state: 'unknown-state' });
    expect(res.status).toBe(400);
  });

  it('GET /google/callback redirects with calendar_error when Google returns ?error=access_denied', async () => {
    const app = buildApp({
      integrationRepo,
      stateRepo,
      authenticate: false,
      googleConfig: {
        clientId: 'cid',
        clientSecret: 'csec',
        redirectUri: 'https://api.example.com/cb',
      },
    });
    const res = await request(app)
      .get('/api/calendar-integrations/google/callback')
      .query({ error: 'access_denied' });
    expect(res.status).toBe(302);
    expect(res.headers.location).toContain('calendar_error=access_denied');
  });

  it('DELETE /google revokes the integration', async () => {
    await integrationRepo.upsert({
      tenantId: TENANT, userId: USER, provider: 'google',
      accessToken: 'a', refreshToken: 'r',
      accessTokenExpiresAt: new Date(Date.now() + 3600_000),
      externalAccountEmail: 'alice@example.com',
    });
    const app = buildApp({ integrationRepo, stateRepo });
    const res = await request(app).delete('/api/calendar-integrations/google');
    expect(res.status).toBe(200);
    expect(res.body.revoked).toBe(true);
    const after = await integrationRepo.findByUser(TENANT, USER, 'google');
    expect(after?.status).toBe('revoked');
  });

  it('DELETE /google returns 404 when nothing was connected', async () => {
    const app = buildApp({ integrationRepo, stateRepo });
    const res = await request(app).delete('/api/calendar-integrations/google');
    expect(res.status).toBe(404);
  });
});
