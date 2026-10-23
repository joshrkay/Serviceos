/**
 * OAuth callbacks (Google Calendar, Google Business, QuickBooks) only accept
 * a `state` the SAME browser started.
 *
 * The callbacks run without an app session (the provider redirects the
 * browser there), so before this change the state nonce alone decided which
 * tenant/user the new connection landed in, whichever browser presented it.
 *
 * Now the connect route (authenticated) sets a short-lived HttpOnly cookie
 * carrying the state, and the callback refuses a state the browser's cookie
 * does not match — without consuming it. In production the callback URL is
 * on the API origin while the cookie lives on the web origin, so a cookie-less
 * callback on another host is relayed once to the same path on the web origin.
 */
import request from 'supertest';
import express, { Request, Response, NextFunction } from 'express';
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import {
  createCalendarIntegrationsRouter,
  createCalendarOAuthCallbackRouter,
} from '../../src/routes/calendar-integrations';
import {
  createGoogleBusinessIntegrationsRouter,
  createGoogleBusinessOAuthCallbackRouter,
} from '../../src/routes/googlebusiness-integrations';
import {
  createIntegrationsOAuthCallbackRouter,
  createIntegrationsRouter,
} from '../../src/routes/integrations';
import {
  InMemoryCalendarIntegrationRepository,
  InMemoryOAuthStateRepository,
} from '../../src/integrations/calendar-integration';
import { InMemoryGoogleBusinessIntegrationRepository } from '../../src/reputation/google-business-integration';
import {
  InMemoryAccountingIntegrationRepository,
  InMemoryAccountingOAuthStateRepository,
  InMemoryAccountingSyncLogRepository,
} from '../../src/integrations/accounting/repository';
import { OAUTH_RELAY_PARAM } from '../../src/integrations/oauth-state-binding';
import type { AuthenticatedRequest } from '../../src/auth/clerk';
import type { IntegrationsRouteDeps } from '../../src/routes/integrations';
import { toErrorResponse } from '../../src/shared/errors';

const WEB = 'https://app.example.com';
const WEB_HOST = 'app.example.com';
const API_HOST = 'api.example.com';
const TENANT_A = '0a0a0a0a-0000-4000-8000-00000000000a';
const TENANT_B = '0b0b0b0b-0000-4000-8000-00000000000b';
const USER_A = 'user_a';
const USER_A2 = 'user_a2';
const USER_B = 'user_b';

function jsonRes(body: unknown, status = 200): globalThis.Response {
  return {
    ok: status < 400,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as globalThis.Response;
}

/** Token exchange + userinfo for Google; token only for Intuit. Discovery 404s (tolerated). */
const providerFetch = vi.fn(async (input: string | URL | globalThis.Request) => {
  const url = String(input);
  if (url.includes('oauth2.googleapis.com/token') || url.includes('/oauth2/v1/tokens/bearer')) {
    return jsonRes({ access_token: 'AT', refresh_token: 'RT', expires_in: 3600 });
  }
  if (url.includes('userinfo')) return jsonRes({ email: 'person@example.com' });
  return jsonRes({}, 404);
});

/** Test auth: the caller names its user/tenant in headers (the connect routes need a session). */
function testAuth(req: Request, _res: Response, next: NextFunction) {
  const userId = req.header('x-test-user');
  const tenantId = req.header('x-test-tenant');
  if (userId && tenantId) {
    (req as AuthenticatedRequest).auth = { userId, sessionId: `sess-${userId}`, tenantId, role: 'owner' };
  }
  next();
}

interface Harness {
  app: express.Express;
  connectPath: string;
  callbackPath: string;
  extraQuery: Record<string, string>;
  cookiePrefix: string;
  /** Whether a connection now exists for (tenant, user). */
  connected(tenantId: string, userId: string): Promise<boolean>;
}

function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction) {
  const { statusCode, body } = toErrorResponse(err);
  res.status(statusCode).json(body);
}

function calendarHarness(): Harness {
  const integrationRepo = new InMemoryCalendarIntegrationRepository();
  const deps = {
    integrationRepo,
    stateRepo: new InMemoryOAuthStateRepository(),
    googleConfig: { clientId: 'cid', clientSecret: 'cs', redirectUri: `https://${API_HOST}/cb` },
    googleFetch: providerFetch as unknown as typeof fetch,
    appBaseUrl: WEB,
  };
  const app = express();
  app.use(express.json());
  app.use('/api/calendar-integrations', createCalendarOAuthCallbackRouter(deps));
  app.use(testAuth);
  app.use('/api/calendar-integrations', createCalendarIntegrationsRouter(deps));
  return {
    app,
    connectPath: '/api/calendar-integrations/google/connect',
    callbackPath: '/api/calendar-integrations/google/callback',
    extraQuery: {},
    cookiePrefix: '__Host-rivet_oauth_google=',
    connected: async (t, u) => (await integrationRepo.findByUser(t, u, 'google')) !== null,
  };
}

function googleBusinessHarness(): Harness {
  const integrationRepo = new InMemoryGoogleBusinessIntegrationRepository();
  const deps = {
    integrationRepo,
    stateRepo: new InMemoryOAuthStateRepository(),
    googleConfig: { clientId: 'cid', clientSecret: 'cs', redirectUri: `https://${API_HOST}/cb` },
    googleFetch: providerFetch as unknown as typeof fetch,
    appBaseUrl: WEB,
  };
  const app = express();
  app.use(express.json());
  app.use('/api/googlebusiness-integrations', createGoogleBusinessOAuthCallbackRouter(deps));
  app.use(testAuth);
  app.use('/api/googlebusiness-integrations', createGoogleBusinessIntegrationsRouter(deps));
  return {
    app,
    connectPath: '/api/googlebusiness-integrations/google/connect',
    callbackPath: '/api/googlebusiness-integrations/google/callback',
    extraQuery: {},
    cookiePrefix: '__Host-rivet_oauth_google_business=',
    // Per-tenant integration: the user is not part of the key.
    connected: async (t) => (await integrationRepo.get(t)) !== null,
  };
}

function quickBooksHarness(): Harness {
  const integrationRepo = new InMemoryAccountingIntegrationRepository();
  const deps = {
    integrationRepo,
    syncLogRepo: new InMemoryAccountingSyncLogRepository(),
    oauthStateRepo: new InMemoryAccountingOAuthStateRepository(),
    invoiceRepo: {},
    customerRepo: {},
    jobRepo: {},
    qboConfig: {
      clientId: 'qbo',
      clientSecret: 'qbo-secret',
      redirectUri: `https://${API_HOST}/cb`,
      environment: 'sandbox',
    },
    fetchFn: providerFetch as unknown as typeof fetch,
    appBaseUrl: WEB,
  } as unknown as IntegrationsRouteDeps;
  const app = express();
  app.use(express.json());
  app.use('/api/integrations', createIntegrationsOAuthCallbackRouter(deps));
  app.use(testAuth);
  app.use('/api/integrations', createIntegrationsRouter(deps));
  app.use(errorHandler);
  return {
    app,
    connectPath: '/api/integrations/quickbooks/connect',
    callbackPath: '/api/integrations/quickbooks/callback',
    extraQuery: { realmId: 'realm-1' },
    cookiePrefix: '__Host-rivet_oauth_quickbooks=',
    connected: async (t) => (await integrationRepo.findByTenant(t, 'quickbooks')) !== null,
  };
}

async function connectAs(h: Harness, userId: string, tenantId: string) {
  const res = await request(h.app)
    .post(h.connectPath)
    .set('x-test-user', userId)
    .set('x-test-tenant', tenantId)
    .send({});
  expect(res.status).toBe(200);
  const state = new URL(res.body.url as string).searchParams.get('state');
  expect(state).toBeTruthy();
  const setCookie = ([] as string[]).concat(res.headers['set-cookie'] ?? []);
  const binding = setCookie.find((c) => c.startsWith(h.cookiePrefix));
  return { state: state as string, setCookie: binding, cookie: binding?.split(';')[0] };
}

function callback(h: Harness, state: string, opts: { host?: string; cookie?: string; relayed?: boolean } = {}) {
  let req = request(h.app)
    .get(h.callbackPath)
    .query({ code: 'auth-code', state, ...h.extraQuery, ...(opts.relayed ? { [OAUTH_RELAY_PARAM]: '1' } : {}) })
    .set('Host', opts.host ?? WEB_HOST);
  if (opts.cookie) req = req.set('Cookie', opts.cookie);
  return req;
}

describe.each([
  ['Google Calendar', calendarHarness],
  ['Google Business', googleBusinessHarness],
  ['QuickBooks', quickBooksHarness],
])('%s OAuth callback — state bound to the browser that started it', (_name, makeHarness) => {
  let originalKey: string | undefined;
  beforeAll(() => {
    originalKey = process.env.TENANT_ENCRYPTION_KEY;
    process.env.TENANT_ENCRYPTION_KEY = '0'.repeat(64);
  });
  afterAll(() => {
    if (originalKey === undefined) delete process.env.TENANT_ENCRYPTION_KEY;
    else process.env.TENANT_ENCRYPTION_KEY = originalKey;
  });

  it('connect sets a host-only HttpOnly SameSite=Lax cookie carrying the state', async () => {
    const h = makeHarness();
    const { state, setCookie } = await connectAs(h, USER_A, TENANT_A);
    expect(setCookie).toBeDefined();
    expect(setCookie).toContain(`${h.cookiePrefix}${state}`);
    expect(setCookie).toMatch(/HttpOnly/i);
    expect(setCookie).toMatch(/Secure/i);
    expect(setCookie).toMatch(/SameSite=Lax/i);
    expect(setCookie).not.toMatch(/Domain=/i);
  });

  it('the browser that started the flow completes it, and the cookie is cleared', async () => {
    const h = makeHarness();
    const { state, cookie } = await connectAs(h, USER_A, TENANT_A);
    const res = await callback(h, state, { cookie });
    expect(res.status).toBe(302);
    expect(res.headers.location).toMatch(/_connected=1/);
    expect(await h.connected(TENANT_A, USER_A)).toBe(true);
    const cleared = ([] as string[]).concat(res.headers['set-cookie'] ?? []);
    expect(cleared.some((c) => c.startsWith(`${h.cookiePrefix};`))).toBe(true);
  });

  it("another tenant's user cannot complete it with their own browser; the state survives for its owner", async () => {
    const h = makeHarness();
    const a = await connectAs(h, USER_A, TENANT_A);
    const b = await connectAs(h, USER_B, TENANT_B);

    const refused = await callback(h, a.state, { cookie: b.cookie });
    expect(refused.status).toBe(403);
    expect(refused.body.error).toBe('FORBIDDEN');
    expect(await h.connected(TENANT_A, USER_A)).toBe(false);
    expect(await h.connected(TENANT_B, USER_B)).toBe(false);

    // Not consumed by the refusal: the browser that started it still can.
    const ok = await callback(h, a.state, { cookie: a.cookie });
    expect(ok.status).toBe(302);
    expect(await h.connected(TENANT_A, USER_A)).toBe(true);
    expect(await h.connected(TENANT_B, USER_B)).toBe(false);
  });

  it('another user of the same tenant cannot complete it either', async () => {
    const h = makeHarness();
    const a = await connectAs(h, USER_A, TENANT_A);
    const a2 = await connectAs(h, USER_A2, TENANT_A);
    const res = await callback(h, a.state, { cookie: a2.cookie });
    expect(res.status).toBe(403);
    expect(await h.connected(TENANT_A, USER_A)).toBe(false);
  });

  it('a callback with no binding cookie is refused on the web host', async () => {
    const h = makeHarness();
    const { state } = await connectAs(h, USER_A, TENANT_A);
    const res = await callback(h, state);
    expect(res.status).toBe(403);
    expect(await h.connected(TENANT_A, USER_A)).toBe(false);
  });

  it('a cookie-less callback on the API host is relayed once to the web origin, then completes there', async () => {
    const h = makeHarness();
    const { state, cookie } = await connectAs(h, USER_A, TENANT_A);

    const relayed = await callback(h, state, { host: API_HOST });
    expect(relayed.status).toBe(302);
    const location = new URL(relayed.headers.location as string);
    expect(location.origin).toBe(WEB);
    expect(location.pathname).toBe(h.callbackPath);
    expect(location.searchParams.get('state')).toBe(state);
    expect(location.searchParams.get(OAUTH_RELAY_PARAM)).toBe('1');
    expect(await h.connected(TENANT_A, USER_A)).toBe(false);

    // Arriving relayed without the cookie (another browser) is refused, never relayed again.
    const noCookie = await callback(h, state, { host: API_HOST, relayed: true });
    expect(noCookie.status).toBe(403);

    const done = await request(h.app)
      .get(`${location.pathname}${location.search}`)
      .set('Host', WEB_HOST)
      .set('Cookie', cookie as string);
    expect(done.status).toBe(302);
    expect(await h.connected(TENANT_A, USER_A)).toBe(true);
  });
});
