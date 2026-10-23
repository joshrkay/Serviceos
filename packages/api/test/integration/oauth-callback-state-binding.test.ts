/**
 * Postgres integration — OAuth callbacks accept a state only from the browser
 * that started the flow, through the production Pg repositories.
 *
 * The callbacks (Google Calendar, Google Business, QuickBooks) run with no app
 * session; before the binding the oauth_states nonce alone decided which
 * tenant and user a new connection landed in. Now the authenticated connect
 * route sets an HttpOnly cookie holding the state, and the callback refuses a
 * state the browser's cookie does not hold, before consume() spends it.
 *
 * Pinned here against real Postgres under RLS_RUNTIME_ROLE=true:
 *   - the starting browser still completes the flow: the credential row lands
 *     in its own tenant (FORCE-RLS tables written under the runtime role) and
 *     the oauth_states row is spent;
 *   - another tenant's browser, another user of the same tenant, and a
 *     browser with no binding cookie are refused: no credential row in either
 *     tenant and the oauth_states row is left unspent for its owner;
 *   - a cookie-less callback on the API host is relayed to the web origin and
 *     completes there with the cookie.
 */
import crypto from 'node:crypto';
import express, { NextFunction, Request, Response } from 'express';
import request from 'supertest';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createTestTenant, getSharedTestDb } from './shared';
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
  type IntegrationsRouteDeps,
} from '../../src/routes/integrations';
import {
  PgCalendarIntegrationRepository,
  PgOAuthStateRepository,
} from '../../src/integrations/calendar-integration';
import { PgGoogleBusinessIntegrationRepository } from '../../src/reputation/google-business-integration';
import {
  PgAccountingIntegrationRepository,
  PgAccountingOAuthStateRepository,
  PgAccountingSyncLogRepository,
} from '../../src/integrations/accounting/repository';
import { OAUTH_RELAY_PARAM } from '../../src/integrations/oauth-state-binding';
import type { AuthenticatedRequest } from '../../src/auth/clerk';
import { toErrorResponse } from '../../src/shared/errors';

const WEB = 'https://app.example.com';
const WEB_HOST = 'app.example.com';
const API_HOST = 'api.example.com';
const ENC_KEY = '0011223344556677889900112233445566778899001122334455667788990011';

const ORIGINAL_FLAG = process.env.RLS_RUNTIME_ROLE;
const ORIGINAL_KEY = process.env.TENANT_ENCRYPTION_KEY;

let pool: Pool;
let tenantA: string;
let tenantB: string;
let userA: string;
let userB: string;
/** A second member of tenant A. */
let userA2: string;

function jsonRes(body: unknown, status = 200): globalThis.Response {
  return {
    ok: status < 400,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as globalThis.Response;
}

/** Google token + userinfo, Intuit token; Google Business discovery 404s (tolerated). */
const providerFetch = vi.fn(async (input: string | URL | globalThis.Request) => {
  const url = String(input);
  if (url.includes('oauth2.googleapis.com/token') || url.includes('/oauth2/v1/tokens/bearer')) {
    return jsonRes({ access_token: 'AT', refresh_token: 'RT', expires_in: 3600 });
  }
  if (url.includes('userinfo')) return jsonRes({ email: 'person@example.com' });
  return jsonRes({}, 404);
});

/** Stands in for Clerk on the authenticated connect routes. */
function testAuth(req: Request, _res: Response, next: NextFunction) {
  const userId = req.header('x-test-user');
  const tenantId = req.header('x-test-tenant');
  if (userId && tenantId) {
    (req as AuthenticatedRequest).auth = { userId, sessionId: `sess-${userId}`, tenantId, role: 'owner' };
  }
  next();
}

function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction) {
  const { statusCode, body } = toErrorResponse(err);
  res.status(statusCode).json(body);
}

interface Harness {
  app: express.Express;
  connectPath: string;
  callbackPath: string;
  extraQuery: Record<string, string>;
  cookiePrefix: string;
  /** Credential rows this flow wrote for (tenant, user), read as the superuser. */
  credentialRows(tenantId: string, userId: string): Promise<number>;
}

function calendarHarness(): Harness {
  const deps = {
    integrationRepo: new PgCalendarIntegrationRepository(pool),
    stateRepo: new PgOAuthStateRepository(pool),
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
    credentialRows: async (tenantId, userId) => {
      const { rows } = await pool.query(
        `SELECT 1 FROM user_calendar_integrations WHERE tenant_id = $1 AND user_id = $2`,
        [tenantId, userId],
      );
      return rows.length;
    },
  };
}

function googleBusinessHarness(): Harness {
  const deps = {
    integrationRepo: new PgGoogleBusinessIntegrationRepository(pool),
    stateRepo: new PgOAuthStateRepository(pool),
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
    // Per-tenant credential: the user is not part of the key.
    credentialRows: async (tenantId) => {
      const { rows } = await pool.query(
        `SELECT 1 FROM tenant_integrations WHERE tenant_id = $1 AND provider = 'google_business'`,
        [tenantId],
      );
      return rows.length;
    },
  };
}

function quickBooksHarness(): Harness {
  const deps = {
    integrationRepo: new PgAccountingIntegrationRepository(pool),
    syncLogRepo: new PgAccountingSyncLogRepository(pool),
    oauthStateRepo: new PgAccountingOAuthStateRepository(pool),
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
    credentialRows: async (tenantId) => {
      const { rows } = await pool.query(
        `SELECT 1 FROM accounting_integrations WHERE tenant_id = $1 AND provider = 'quickbooks'`,
        [tenantId],
      );
      return rows.length;
    },
  };
}

async function stateSpent(state: string): Promise<boolean> {
  const { rows } = await pool.query(`SELECT consumed_at FROM oauth_states WHERE id = $1`, [state]);
  expect(rows).toHaveLength(1);
  return rows[0].consumed_at !== null;
}

async function connectAs(h: Harness, userId: string, tenantId: string) {
  const res = await request(h.app)
    .post(h.connectPath)
    .set('Host', WEB_HOST)
    .set('x-test-user', userId)
    .set('x-test-tenant', tenantId)
    .send({});
  expect(res.status).toBe(200);
  const state = new URL(res.body.url as string).searchParams.get('state');
  expect(state).toBeTruthy();
  const setCookie = ([] as string[]).concat(res.headers['set-cookie'] ?? []);
  const binding = setCookie.find((c) => c.startsWith(h.cookiePrefix));
  expect(binding).toBeDefined();
  return { state: state as string, cookie: (binding as string).split(';')[0] };
}

function callback(h: Harness, state: string, opts: { host?: string; cookie?: string } = {}) {
  let req = request(h.app)
    .get(h.callbackPath)
    .query({ code: 'auth-code', state, ...h.extraQuery })
    .set('Host', opts.host ?? WEB_HOST);
  if (opts.cookie) req = req.set('Cookie', opts.cookie);
  return req;
}

beforeAll(async () => {
  process.env.RLS_RUNTIME_ROLE = 'true';
  process.env.TENANT_ENCRYPTION_KEY = ENC_KEY;
  pool = await getSharedTestDb();
  ({ tenantId: tenantA, userId: userA } = await createTestTenant(pool));
  ({ tenantId: tenantB, userId: userB } = await createTestTenant(pool));
  userA2 = crypto.randomUUID();
  await pool.query(
    `INSERT INTO users (id, tenant_id, clerk_user_id, email, role) VALUES ($1, $2, $3, 'a2@example.com', 'owner')`,
    [userA2, tenantA, userA2],
  );
});

afterAll(() => {
  if (ORIGINAL_FLAG === undefined) delete process.env.RLS_RUNTIME_ROLE;
  else process.env.RLS_RUNTIME_ROLE = ORIGINAL_FLAG;
  if (ORIGINAL_KEY === undefined) delete process.env.TENANT_ENCRYPTION_KEY;
  else process.env.TENANT_ENCRYPTION_KEY = ORIGINAL_KEY;
});

describe.each([
  ['Google Calendar', calendarHarness],
  ['Google Business', googleBusinessHarness],
  ['QuickBooks', quickBooksHarness],
])('%s OAuth callback — state bound to the starting browser (Postgres)', (_name, makeHarness) => {
  // Each provider's rows are keyed by tenant, so the cases run in order on
  // one pair of tenants: refusals first, then the owner completes.
  let h: Harness;
  let a: { state: string; cookie: string };
  let a2: { state: string; cookie: string };
  let b: { state: string; cookie: string };

  beforeAll(async () => {
    h = makeHarness();
    a = await connectAs(h, userA, tenantA);
    a2 = await connectAs(h, userA2, tenantA);
    b = await connectAs(h, userB, tenantB);
  });

  it("refuses another tenant's browser: no credential in either tenant, the state stays unspent", async () => {
    const res = await callback(h, a.state, { cookie: b.cookie });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('FORBIDDEN');
    expect(await h.credentialRows(tenantA, userA)).toBe(0);
    expect(await h.credentialRows(tenantB, userB)).toBe(0);
    expect(await stateSpent(a.state)).toBe(false);
    expect(await stateSpent(b.state)).toBe(false);
  });

  it('refuses another user of the same tenant', async () => {
    const res = await callback(h, a.state, { cookie: a2.cookie });
    expect(res.status).toBe(403);
    expect(await h.credentialRows(tenantA, userA)).toBe(0);
    expect(await h.credentialRows(tenantA, userA2)).toBe(0);
    expect(await stateSpent(a.state)).toBe(false);
  });

  it('refuses a browser with no binding cookie', async () => {
    const res = await callback(h, a.state);
    expect(res.status).toBe(403);
    expect(await h.credentialRows(tenantA, userA)).toBe(0);
    expect(await stateSpent(a.state)).toBe(false);
  });

  it('relays a cookie-less callback from the API host, and the starting browser completes it there', async () => {
    const relayed = await callback(h, a.state, { host: API_HOST });
    expect(relayed.status).toBe(302);
    const location = new URL(relayed.headers.location as string);
    expect(location.origin).toBe(WEB);
    expect(location.pathname).toBe(h.callbackPath);
    expect(location.searchParams.get(OAUTH_RELAY_PARAM)).toBe('1');
    expect(await stateSpent(a.state)).toBe(false);

    const done = await request(h.app)
      .get(`${location.pathname}${location.search}`)
      .set('Host', WEB_HOST)
      .set('Cookie', a.cookie);
    expect(done.status).toBe(302);
    expect(done.headers.location).toMatch(/_connected=1/);
    expect(await h.credentialRows(tenantA, userA)).toBe(1);
    expect(await h.credentialRows(tenantB, userB)).toBe(0);
    expect(await stateSpent(a.state)).toBe(true);
    expect(await stateSpent(b.state)).toBe(false);
  });

  it("then the other tenant's browser completes its own flow into its own tenant only", async () => {
    const res = await callback(h, b.state, { cookie: b.cookie });
    expect(res.status).toBe(302);
    expect(await h.credentialRows(tenantB, userB)).toBe(1);
    expect(await stateSpent(b.state)).toBe(true);
    // A's spent state cannot be replayed even by its own browser.
    const replay = await callback(h, a.state, { cookie: a.cookie });
    expect(replay.status).toBe(400);
  });
});
