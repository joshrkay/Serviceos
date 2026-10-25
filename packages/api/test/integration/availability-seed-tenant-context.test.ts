/**
 * Postgres integration — the Google OAuth callback's availability seed runs
 * under the RLS runtime role (raw-pg audit 2026-10-23 §4 P2.5).
 *
 * seedAvailabilityFromGoogle wrote `UPDATE tenant_settings SET
 * availability_template … WHERE tenant_id = $1` on the raw pool the
 * unauthenticated callback passed it, as the privileged principal: the tenant
 * is the server-minted, browser-bound OAuth state, and the WHERE clause was
 * the only boundary. With RLS_RUNTIME_ROLE on, this suite proves:
 *
 *   1. the UPDATE reports `rls_app_runtime` with the state's tenant GUC,
 *      through the real callback and on its own;
 *   2. with the tenant pin widened to both seeded tenants, RLS alone keeps the
 *      other tenant's template untouched;
 *   3. control: the same widened UPDATE as the connection principal DOES
 *      overwrite the other tenant's template;
 *   4. the role keeps SELECT + UPDATE on tenant_settings after migration 219;
 *   5. the callback keeps its behaviour and order: consume, token exchange,
 *      the credential upsert and its audit row, then the free/busy fetch and
 *      the seed, then the redirect; a free/busy failure still redirects with
 *      the calendar connected and the template untouched; the seed commits on
 *      its own, as the bare UPDATE did;
 *   6. the cost: the seed is one tenant session, never two connections.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import crypto from 'node:crypto';
import express, { NextFunction, Request, Response } from 'express';
import request from 'supertest';
import type { Pool } from 'pg';
import { closeSharedTestDb, createTestTenant, getSharedTestDb, TENANT_CONTEXT_WITH_ROLE_SQL } from './shared';
import { probeStatementRoles } from './statement-role-probe';
import { countPoolTraffic, runtimeRoleGrantsMissingAfter219, widenTenantPredicates } from './tenant-predicate-probe';
import { seedAvailabilityFromGoogle, type FreeBusyFetcher } from '../../src/availability/seed-from-google';
import {
  createCalendarIntegrationsRouter,
  createCalendarOAuthCallbackRouter,
} from '../../src/routes/calendar-integrations';
import { PgCalendarIntegrationRepository, PgOAuthStateRepository } from '../../src/integrations/calendar-integration';
import { PgAuditRepository } from '../../src/audit/pg-audit';
import type { AuthenticatedRequest } from '../../src/auth/clerk';

const ORIGINAL_FLAG = process.env.RLS_RUNTIME_ROLE;
const ORIGINAL_KEY = process.env.TENANT_ENCRYPTION_KEY;
const ENC_KEY = '0011223344556677889900112233445566778899001122334455667788990011';
const SEED = /UPDATE tenant_settings SET availability_template/;
const WEB = 'https://app.example.com';
const WEB_HOST = 'app.example.com';
const BUSY = [{ start: '2026-11-02T15:00:00Z', end: '2026-11-02T16:00:00Z' }];

let pool: Pool;
const tenantIds: string[] = [];

async function seedTenant(): Promise<{ tenantId: string; userId: string }> {
  const t = await createTestTenant(pool);
  tenantIds.push(t.tenantId);
  await pool.query(`INSERT INTO tenant_settings (tenant_id, business_name) VALUES ($1, 'Seed Heating')`, [t.tenantId]);
  return t;
}

/** The stored template's busy blocks (null: none seeded), read as the principal. */
async function templateOf(tenantId: string): Promise<unknown> {
  const { rows } = await pool.query(`SELECT availability_template FROM tenant_settings WHERE tenant_id = $1`, [tenantId]);
  return (rows[0]?.availability_template as { busy?: unknown } | null)?.busy ?? null;
}

const freeBusy: FreeBusyFetcher = async () => ({ busy: BUSY });

function jsonRes(body: unknown, status = 200): globalThis.Response {
  return { ok: status < 400, status, json: async () => body, text: async () => JSON.stringify(body) } as unknown as globalThis.Response;
}

/** Google's token + userinfo endpoints. */
const googleFetch = vi.fn(async (input: string | URL | globalThis.Request) => {
  const url = String(input);
  if (url.includes('oauth2.googleapis.com/token')) return jsonRes({ access_token: 'AT', refresh_token: 'RT', expires_in: 3600 });
  if (url.includes('userinfo')) return jsonRes({ email: 'owner@example.com' });
  return jsonRes({}, 404);
});

/**
 * The calendar routers as app.ts mounts them: the unauthenticated callback
 * first, then (behind a stand-in for Clerk) the connect route that mints the
 * state and its browser-binding cookie. `callbackPool` is what the callback's
 * repositories and seed run on.
 */
function calendarApp(callbackPool: Pool, events: string[], fb: FreeBusyFetcher = freeBusy) {
  const audit = new PgAuditRepository(callbackPool);
  const deps = {
    integrationRepo: new PgCalendarIntegrationRepository(callbackPool),
    stateRepo: new PgOAuthStateRepository(callbackPool),
    googleConfig: { clientId: 'cid', clientSecret: 'cs', redirectUri: 'https://api.example.com/cb' },
    googleFetch: googleFetch as unknown as typeof fetch,
    appBaseUrl: WEB,
    auditRepo: {
      create: async (e: Parameters<PgAuditRepository['create']>[0]) => {
        events.push(`audit:${e.eventType}`);
        return audit.create(e);
      },
    } as unknown as PgAuditRepository,
    pool: callbackPool,
    googleFreeBusy: (async (input) => {
      events.push('freeBusy');
      return fb(input);
    }) as FreeBusyFetcher,
  };
  const app = express();
  app.use(express.json());
  app.use('/api/calendar-integrations', createCalendarOAuthCallbackRouter(deps));
  app.use((req: Request, _res: Response, next: NextFunction) => {
    const userId = req.header('x-test-user');
    const tenantId = req.header('x-test-tenant');
    if (userId && tenantId) (req as AuthenticatedRequest).auth = { userId, sessionId: `sess-${userId}`, tenantId, role: 'owner' };
    next();
  });
  app.use('/api/calendar-integrations', createCalendarIntegrationsRouter({ ...deps, stateRepo: new PgOAuthStateRepository(pool), auditRepo: undefined }));
  return app;
}

/** Start the flow as the tenant's owner (on the plain pool) and return the callback request's inputs. */
async function connect(app: express.Express, t: { tenantId: string; userId: string }) {
  const res = await request(app)
    .post('/api/calendar-integrations/google/connect')
    .set('Host', WEB_HOST)
    .set('x-test-user', t.userId)
    .set('x-test-tenant', t.tenantId)
    .send({});
  expect(res.status).toBe(200);
  const state = new URL(res.body.url as string).searchParams.get('state') as string;
  const cookie = ([] as string[]).concat(res.headers['set-cookie'] ?? []).find((c) => c.startsWith('__Host-rivet_oauth_google='));
  return { state, cookie: (cookie as string).split(';')[0] };
}

function callback(app: express.Express, flow: { state: string; cookie: string }) {
  return request(app)
    .get('/api/calendar-integrations/google/callback')
    .query({ code: 'auth-code', state: flow.state })
    .set('Host', WEB_HOST)
    .set('Cookie', flow.cookie);
}

beforeAll(async () => {
  pool = await getSharedTestDb();
});

beforeEach(() => {
  process.env.RLS_RUNTIME_ROLE = 'true';
  process.env.TENANT_ENCRYPTION_KEY = ENC_KEY;
});

afterEach(() => {
  if (ORIGINAL_FLAG === undefined) delete process.env.RLS_RUNTIME_ROLE;
  else process.env.RLS_RUNTIME_ROLE = ORIGINAL_FLAG;
  if (ORIGINAL_KEY === undefined) delete process.env.TENANT_ENCRYPTION_KEY;
  else process.env.TENANT_ENCRYPTION_KEY = ORIGINAL_KEY;
});

afterAll(async () => {
  for (const id of tenantIds) {
    for (const table of ['user_calendar_integrations', 'oauth_states', 'audit_events', 'tenant_settings', 'users']) {
      await pool.query(`DELETE FROM ${table} WHERE tenant_id = $1`, [id]).catch(() => undefined);
    }
    await pool.query('DELETE FROM tenants WHERE id = $1', [id]).catch(() => undefined);
  }
  await closeSharedTestDb();
});

describe('availability seed — the UPDATE under the RLS runtime role (real Postgres)', () => {
  it('through the real Google OAuth callback, the seed runs as rls_app_runtime for the state\'s tenant', async () => {
    const t = await seedTenant();
    const probe = probeStatementRoles(pool, SEED);
    const app = calendarApp(probe.pool, []);

    const res = await callback(app, await connect(app, t));

    expect(res.status).toBe(302);
    expect(await templateOf(t.tenantId)).toEqual(BUSY);
    expect(probe.seen).toHaveLength(1);
    expect(probe.seen[0]).toMatchObject({ role: 'rls_app_runtime', tenantGuc: t.tenantId });
  });

  it('called on its own, the UPDATE runs as rls_app_runtime with the tenant GUC', async () => {
    const t = await seedTenant();
    const probe = probeStatementRoles(pool, SEED);

    const { busyCount } = await seedAvailabilityFromGoogle({ pool: probe.pool, freeBusy, accessToken: 'AT' }, { tenantId: t.tenantId });

    expect(busyCount).toBe(1);
    expect(probe.seen).toEqual([expect.objectContaining({ role: 'rls_app_runtime', tenantGuc: t.tenantId })]);
  });
});

describe('availability seed — RLS alone keeps the other tenant\'s template untouched (real Postgres)', () => {
  async function runWidened(asPrincipal: boolean) {
    const caller = await seedTenant();
    const other = await seedTenant();
    const widened = widenTenantPredicates(pool, { target: SEED, tenants: [caller.tenantId, other.tenantId], asPrincipal });

    await seedAvailabilityFromGoogle({ pool: widened.pool, freeBusy, accessToken: 'AT' }, { tenantId: caller.tenantId });

    expect(widened.rewritten).toHaveLength(1);
    expect(await templateOf(caller.tenantId)).toEqual(BUSY);
    return templateOf(other.tenantId);
  }

  it('with the tenant pin widened to both tenants, the other tenant\'s template stays unset', async () => {
    expect(await runWidened(false)).toBeNull();
  });

  it('control: the same widened UPDATE run as the connection principal overwrites the other tenant\'s template', async () => {
    expect(await runWidened(true)).toEqual(BUSY);
  });
});

describe('grants: rls_app_runtime keeps what the seed needs after migration 219', () => {
  it('tenant_settings stays readable (the WHERE) and updatable', async () => {
    expect(await runtimeRoleGrantsMissingAfter219(pool, [['tenant_settings', 'SELECT'], ['tenant_settings', 'UPDATE']])).toEqual([]);
  });
});

describe('the Google OAuth callback — behaviour and order kept (real Postgres)', () => {
  it('consume, token exchange, the credential upsert and its audit row, then free/busy and the seed, then the redirect', async () => {
    const t = await seedTenant();
    const events: string[] = [];
    const probe = probeStatementRoles(pool, /oauth_states|INSERT INTO user_calendar_integrations|INSERT INTO audit_events|UPDATE tenant_settings/);
    const app = calendarApp(probe.pool, events);
    const flow = await connect(app, t);
    googleFetch.mockClear();

    const res = await callback(app, flow);

    expect(res.status).toBe(302);
    expect(res.headers.location).toBe(`${WEB}/settings?calendar_connected=1`);
    expect(googleFetch.mock.calls.map(([u]) => String(u))).toEqual([
      expect.stringContaining('oauth2.googleapis.com/token'),
      expect.stringContaining('userinfo'),
    ]);
    expect(events).toEqual(['audit:calendar_integration.callback_consumed', 'freeBusy']);
    expect(probe.seen.map((s) => s.sql.replace(/\s+/g, ' ').trim().split(' ').slice(0, 3).join(' '))).toEqual([
      'UPDATE oauth_states SET',
      'INSERT INTO user_calendar_integrations',
      'INSERT INTO audit_events',
      'UPDATE tenant_settings SET',
    ]);
  });

  it('a free/busy failure still redirects with the calendar connected; the template is left untouched', async () => {
    const t = await seedTenant();
    const app = calendarApp(pool, [], async () => {
      throw new Error('Google freeBusy failed (503)');
    });

    const res = await callback(app, await connect(app, t));

    expect(res.status).toBe(302);
    expect(res.headers.location).toBe(`${WEB}/settings?calendar_connected=1`);
    const { rows } = await pool.query(`SELECT status FROM user_calendar_integrations WHERE tenant_id = $1`, [t.tenantId]);
    expect(rows).toEqual([{ status: 'active' }]);
    expect(await templateOf(t.tenantId)).toBeNull();
  });

  it('the seed commits on its own: another connection sees the template as soon as the call returns', async () => {
    const t = await seedTenant();

    await seedAvailabilityFromGoogle({ pool, freeBusy, accessToken: 'AT' }, { tenantId: t.tenantId });

    expect(await templateOf(t.tenantId)).toEqual(BUSY);
  });
});

describe('availability seed — cost (real Postgres, RLS_RUNTIME_ROLE=true)', () => {
  it('the seed is one tenant session: BEGIN, the GUC + role, the UPDATE, COMMIT (base: 1 checkout / 1 statement)', async () => {
    const t = await seedTenant();
    const traffic = countPoolTraffic(pool);

    await seedAvailabilityFromGoogle({ pool: traffic.pool, freeBusy, accessToken: 'AT' }, { tenantId: t.tenantId });

    expect({ checkouts: traffic.checkouts(), statements: traffic.statements().length, maxOpen: traffic.maxOpen() }).toEqual({
      checkouts: 1,
      statements: 4,
      maxOpen: 1,
    });
    const ran = traffic.statements();
    expect(ran[0]).toBe('BEGIN');
    expect(ran[1]).toBe(TENANT_CONTEXT_WITH_ROLE_SQL);
    expect(ran[2]).toMatch(SEED);
    expect(ran[3]).toBe('COMMIT');
  });

  it('the whole callback: the seed adds its session after the repositories\' and never holds two connections (base: 4 checkouts / 14 statements)', async () => {
    const t = await seedTenant();
    const traffic = countPoolTraffic(pool);
    const app = calendarApp(traffic.pool, []);
    const flow = await connect(calendarApp(pool, []), t);

    const res = await callback(app, flow);

    expect(res.status).toBe(302);
    expect({ checkouts: traffic.checkouts(), statements: traffic.statements().length, maxOpen: traffic.maxOpen() }).toEqual({
      checkouts: 4,
      statements: 17,
      maxOpen: 1,
    });
  });
});
