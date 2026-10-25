/**
 * Postgres integration — the public page header reads run under the RLS
 * runtime role (raw-pg audit 2026-10-23 §4 P2.6).
 *
 * The unauthenticated intake header (GET /public/intake/:tenantId) read
 * business_hours FROM tenant_settings and the review AVG/COUNT FROM
 * google_reviews as two bare pool.query calls, and resolvePublicBusinessPhone
 * (that page, the hosted tenant site, and /api/tenant-site/preview + /publish)
 * read the tenant_integrations phone the same way: as the privileged
 * principal, each on a pooled connection of its own, with `WHERE tenant_id =
 * $1` (the UUID-validated, tenantRepo-checked URL tenant) the only boundary.
 * With RLS_RUNTIME_ROLE on, this suite proves:
 *
 *   1. every tenant-row read on those pages reports `rls_app_runtime` with
 *      the page tenant's GUC, against the real columns;
 *   2. with the tenant pin widened to both seeded tenants, RLS alone keeps
 *      the other tenant's phone, hours and reviews off the page;
 *   3. control: the same widened statements as the connection principal DO
 *      put the other tenant's phone, hours and reviews on the page;
 *   4. the role keeps SELECT on the three tables after migration 219;
 *   5. the cost: the intake header is one tenant session for every tenant
 *      row (settings included), the tenant site's view one session for its
 *      settings + phone, and behind the /api request transaction the phone
 *      read rides the request client; the pack catalog's own read comes after
 *      the session, so no path holds two connections.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import express from 'express';
import request from 'supertest';
import type { Pool } from 'pg';
import { closeSharedTestDb, createTestTenant, getSharedTestDb, TENANT_CONTEXT_WITH_ROLE_SQL } from './shared';
import { probeStatementRoles } from './statement-role-probe';
import { countPoolTraffic, runtimeRoleGrantsMissingAfter219, widenTenantPredicates } from './tenant-predicate-probe';
import { createPublicIntakeRouter } from '../../src/routes/public-intake';
import { createTenantSiteRouter } from '../../src/routes/tenant-site';
import { loadTenantSiteView } from '../../src/tenant-site/view';
import { PgLeadRepository } from '../../src/leads/pg-lead';
import { PgAuditRepository } from '../../src/audit/pg-audit';
import { PgTenantRepository } from '../../src/auth/pg-tenant';
import { PgSettingsRepository } from '../../src/settings/pg-settings';
import { PgVerticalPackRegistry } from '../../src/shared/pg-vertical-pack-registry';
import { PgTenantSiteRepository } from '../../src/tenant-site/tenant-site';
import { PgTenantTransactionRunner } from '../../src/db/tenant-transaction';
import { withTenantTransaction } from '../../src/middleware/tenant-context';
import { clearUserModeCacheForTests, setUserModeLoader } from '../../src/middleware/auth';
import type { AuthenticatedRequest } from '../../src/auth/clerk';
import type { ProposalRepository } from '../../src/proposals/proposal';
import type { TenantSiteAboutTask } from '../../src/ai/tasks/tenant-site-about-task';

const ORIGINAL_FLAG = process.env.RLS_RUNTIME_ROLE;
/** Every tenant-row read the pages make: the settings row, the phone, the hours, the reviews. */
const PAGE_ROWS = /FROM tenant_settings|FROM tenant_integrations|FROM google_reviews/;
/** The statements that ran on the raw pool before this change. */
const RAW_READS = /FROM tenant_integrations|SELECT business_hours FROM tenant_settings|FROM google_reviews/;
const PACK_READ = /FROM vertical_packs/;
const WEB_ORIGIN = 'https://app.example.com';
const HOURS = {
  mon: { open: '08:00', close: '17:00' },
  tue: { open: '08:00', close: '17:00' },
  wed: { open: '08:00', close: '17:00' },
  thu: { open: '08:00', close: '17:00' },
  fri: { open: '08:00', close: '17:00' },
};

let pool: Pool;
const tenantIds: string[] = [];

async function seedTenant(): Promise<string> {
  const { tenantId } = await createTestTenant(pool);
  tenantIds.push(tenantId);
  return tenantId;
}

/** A DID no other file uses (migration 274 makes a twilio number unique across tenants). */
function freshDid(): string {
  return `+1512${String(crypto.randomInt(2_000_000, 9_999_999))}`;
}

interface PageRows {
  businessName?: string;
  businessPhone?: string | null;
  hours?: object;
  packs?: string[];
  twilioPhone?: string;
  ratings?: number[];
}

async function seedPageRows(tenantId: string, rows: PageRows): Promise<void> {
  if (rows.businessName !== undefined) {
    await pool.query(
      `INSERT INTO tenant_settings (tenant_id, business_name, business_phone, timezone, business_hours, terminology_preferences)
       VALUES ($1, $2, $3, 'America/Chicago', $4::jsonb, $5::jsonb)`,
      [
        tenantId,
        rows.businessName,
        rows.businessPhone ?? null,
        JSON.stringify(rows.hours ?? {}),
        JSON.stringify(rows.packs ? { _activeVerticalPacks: rows.packs } : {}),
      ],
    );
  }
  if (rows.twilioPhone) {
    await pool.query(
      `INSERT INTO tenant_integrations (tenant_id, provider, status, provider_data)
       VALUES ($1, 'twilio', 'full_readiness', $2::jsonb)`,
      [tenantId, JSON.stringify({ phoneE164: rows.twilioPhone })],
    );
  }
  for (const [i, rating] of (rows.ratings ?? []).entries()) {
    await pool.query(
      `INSERT INTO google_reviews (id, tenant_id, external_review_id, location_id, rating,
         review_create_time, first_fetched_at, last_fetched_at)
       VALUES ($1, $2, $3, 'locations/1', $4, NOW(), NOW(), NOW())`,
      [crypto.randomUUID(), tenantId, `review-${tenantId}-${i}`, rating],
    );
  }
}

/** The intake router as app.ts mounts it: the real Pg repositories, on `p`. */
function intakeApp(p: Pool): express.Express {
  const app = express();
  app.use(express.json());
  app.use(
    '/public/intake',
    createPublicIntakeRouter(
      new PgLeadRepository(p),
      new PgTenantRepository(p),
      new PgAuditRepository(p),
      new PgSettingsRepository(p),
      new PgVerticalPackRegistry(p),
      p,
    ),
  );
  return app;
}

function viewDeps(p: Pool) {
  return {
    settingsRepo: new PgSettingsRepository(p),
    packRegistry: new PgVerticalPackRegistry(p),
    pool: p,
    webOrigin: WEB_ORIGIN,
  };
}

const cost = (traffic: ReturnType<typeof countPoolTraffic>) => ({
  checkouts: traffic.checkouts(),
  statements: traffic.statements().length,
  maxOpen: traffic.maxOpen(),
});

beforeAll(async () => {
  pool = await getSharedTestDb();
});

beforeEach(() => {
  process.env.RLS_RUNTIME_ROLE = 'true';
  setUserModeLoader(null);
  clearUserModeCacheForTests();
});

afterEach(() => {
  if (ORIGINAL_FLAG === undefined) delete process.env.RLS_RUNTIME_ROLE;
  else process.env.RLS_RUNTIME_ROLE = ORIGINAL_FLAG;
});

afterAll(async () => {
  for (const id of tenantIds) {
    for (const table of ['google_reviews', 'tenant_integrations', 'tenant_settings', 'audit_events', 'users']) {
      await pool.query(`DELETE FROM ${table} WHERE tenant_id = $1`, [id]).catch(() => undefined);
    }
    await pool.query('DELETE FROM tenants WHERE id = $1', [id]).catch(() => undefined);
  }
  await closeSharedTestDb();
});

describe('public page header reads — every tenant-row read under the RLS runtime role (real Postgres)', () => {
  it('GET /public/intake/:tenantId: the settings row, the phone, the hours and the reviews run as rls_app_runtime for the URL tenant', async () => {
    const tenantId = await seedTenant();
    const phone = freshDid();
    await seedPageRows(tenantId, { businessName: 'Header Heating', hours: HOURS, twilioPhone: phone, ratings: [5, 4, 4] });
    const probe = probeStatementRoles(pool, PAGE_ROWS);

    const res = await request(intakeApp(probe.pool)).get(`/public/intake/${tenantId}`);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      businessName: 'Header Heating',
      businessPhone: phone,
      businessHoursSummary: 'Mon–Fri 8 AM – 5 PM (America/Chicago)',
      averageRating: 4.3,
      reviewCount: 3,
    });
    expect(probe.seen.map((s) => s.sql.replace(/\s+/g, ' ').trim().slice(0, 34))).toEqual([
      'SELECT * FROM tenant_settings WHER',
      "SELECT provider_data->>'phoneE164'",
      'SELECT business_hours FROM tenant_',
      'SELECT AVG(rating)::float AS avg, ',
    ]);
    for (const s of probe.seen) expect(s).toMatchObject({ role: 'rls_app_runtime', tenantGuc: tenantId });
  });

  it('the hosted tenant site (loadTenantSiteView off any request): the settings row and the phone run as rls_app_runtime', async () => {
    const tenantId = await seedTenant();
    const phone = freshDid();
    await seedPageRows(tenantId, { businessName: 'Site Plumbing', twilioPhone: phone });
    const probe = probeStatementRoles(pool, PAGE_ROWS);

    const view = await loadTenantSiteView(viewDeps(probe.pool), tenantId);

    expect(view).toMatchObject({ businessName: 'Site Plumbing', phone });
    expect(probe.seen).toHaveLength(2);
    for (const s of probe.seen) expect(s).toMatchObject({ role: 'rls_app_runtime', tenantGuc: tenantId });
  });
});

describe('public page header reads — RLS alone keeps the other tenant off the page (real Postgres)', () => {
  /**
   * The caller has no phone, no hours and no reviews; the other tenant has
   * all three. Every raw read's tenant pin is widened to both tenants, so the
   * WHERE clause no longer tells them apart.
   */
  async function runWidened(asPrincipal: boolean) {
    const caller = await seedTenant();
    const other = await seedTenant();
    const otherPhone = freshDid();
    await seedPageRows(other, { businessName: 'Other Co', hours: HOURS, twilioPhone: otherPhone, ratings: [5, 3] });
    const widened = widenTenantPredicates(pool, { target: RAW_READS, tenants: [caller, other], asPrincipal });

    const res = await request(intakeApp(widened.pool)).get(`/public/intake/${caller}`);
    const view = await loadTenantSiteView(
      { ...viewDeps(widened.pool), settingsRepo: { findByTenant: async () => ({ businessName: 'Caller Co' }) as never } },
      caller,
    );

    expect(res.status).toBe(200);
    expect(widened.rewritten).toHaveLength(4);
    return {
      phone: res.body.businessPhone,
      hours: res.body.businessHoursSummary,
      rating: res.body.averageRating ?? null,
      reviewCount: res.body.reviewCount ?? null,
      sitePhone: view?.phone,
      otherPhone,
    };
  }

  it('with the tenant pin widened to both tenants, the page shows none of the other tenant\'s phone, hours or reviews', async () => {
    expect(await runWidened(false)).toMatchObject({ phone: null, hours: null, rating: null, reviewCount: null, sitePhone: null });
  });

  it('control: the same widened statements run as the connection principal put the other tenant\'s phone, hours and reviews on the page', async () => {
    const r = await runWidened(true);
    expect(r).toMatchObject({ hours: 'Mon–Fri 8 AM – 5 PM', rating: 4, reviewCount: 2 });
    expect(r.phone).toBe(r.otherPhone);
    expect(r.sitePhone).toBe(r.otherPhone);
  });
});

describe('grants: rls_app_runtime keeps what the page header reads after migration 219', () => {
  it('tenant_settings, tenant_integrations and google_reviews stay readable', async () => {
    expect(
      await runtimeRoleGrantsMissingAfter219(pool, [
        ['tenant_settings', 'SELECT'],
        ['tenant_integrations', 'SELECT'],
        ['google_reviews', 'SELECT'],
      ]),
    ).toEqual([]);
  });
});

describe('public page header reads — cost (real Postgres, RLS_RUNTIME_ROLE=true)', () => {
  it('GET /public/intake/:tenantId with the phone fallback: the tenants check, then ONE session for every tenant row (base: 5 checkouts / 10 statements)', async () => {
    const tenantId = await seedTenant();
    await seedPageRows(tenantId, { businessName: 'Cost Cooling', hours: HOURS, twilioPhone: freshDid(), ratings: [5] });
    const traffic = countPoolTraffic(pool);

    const res = await request(intakeApp(traffic.pool)).get(`/public/intake/${tenantId}`);

    expect(res.status).toBe(200);
    expect(cost(traffic)).toEqual({ checkouts: 2, statements: 8, maxOpen: 1 });
    const ran = traffic.statements().map((s) => s.replace(/\s+/g, ' ').trim());
    expect(ran[0]).toMatch(/^SELECT .* FROM tenants WHERE id = \$1/);
    expect(ran.slice(1, 3)).toEqual(['BEGIN', TENANT_CONTEXT_WITH_ROLE_SQL]);
    expect(ran[3]).toMatch(/^SELECT \* FROM tenant_settings/);
    expect(ran[4]).toMatch(/FROM tenant_integrations/);
    expect(ran[5]).toMatch(/^SELECT business_hours FROM tenant_settings/);
    expect(ran[6]).toMatch(/FROM google_reviews/);
    expect(ran[7]).toBe('COMMIT');
  });

  it('GET /public/intake/:tenantId with a settings phone and an active pack: the catalog read comes after the session (base: 5 checkouts / 10 statements)', async () => {
    const tenantId = await seedTenant();
    await seedPageRows(tenantId, { businessName: 'Pack Plumbing', businessPhone: '+15125550142', packs: [`no-such-pack-${tenantId}`] });
    const traffic = countPoolTraffic(pool);

    const res = await request(intakeApp(traffic.pool)).get(`/public/intake/${tenantId}`);

    expect(res.status).toBe(200);
    expect(res.body.businessPhone).toBe('+15125550142');
    expect(cost(traffic)).toEqual({ checkouts: 3, statements: 8, maxOpen: 1 });
    const ran = traffic.statements();
    expect(ran.findIndex((s) => PACK_READ.test(s))).toBe(ran.lastIndexOf('COMMIT') + 1);
  });

  it('an unknown tenant: the tenants check only, no session (unchanged: 1 checkout / 1 statement)', async () => {
    const traffic = countPoolTraffic(pool);

    const res = await request(intakeApp(traffic.pool)).get(`/public/intake/${crypto.randomUUID()}`);

    expect(res.status).toBe(404);
    expect(cost(traffic)).toEqual({ checkouts: 1, statements: 1, maxOpen: 1 });
  });

  it('the hosted tenant site view: ONE session for the settings row and the phone, then the catalog read, never two connections (base: 3 checkouts / 8 statements)', async () => {
    const tenantId = await seedTenant();
    await seedPageRows(tenantId, { businessName: 'Site Cooling', twilioPhone: freshDid(), packs: [`no-such-pack-${tenantId}`] });
    const traffic = countPoolTraffic(pool);

    const view = await loadTenantSiteView(viewDeps(traffic.pool), tenantId);

    expect(view?.phone).toMatch(/^\+1512/);
    expect(cost(traffic)).toEqual({ checkouts: 2, statements: 6, maxOpen: 1 });
    const ran = traffic.statements().map((s) => s.replace(/\s+/g, ' ').trim());
    expect(ran.slice(0, 2)).toEqual(['BEGIN', TENANT_CONTEXT_WITH_ROLE_SQL]);
    expect(ran[2]).toMatch(/^SELECT \* FROM tenant_settings/);
    expect(ran[3]).toMatch(/FROM tenant_integrations/);
    expect(ran[4]).toBe('COMMIT');
    expect(ran[5]).toMatch(PACK_READ);
  });

  /** The /api order of app.ts: the verified session (stubbed), the request transaction, the router. */
  function tenantSiteApi(traffic: ReturnType<typeof countPoolTraffic>, tenantId: string): express.Express {
    const settingsRepo = new PgSettingsRepository(traffic.pool);
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as AuthenticatedRequest).auth = { userId: `owner-${tenantId}`, sessionId: 'sess-site', tenantId, role: 'owner' };
      next();
    });
    app.use('/api', withTenantTransaction(traffic.pool));
    app.use(
      '/api/tenant-site',
      createTenantSiteRouter({
        baseDomain: 'sites.example.com',
        siteRepo: new PgTenantSiteRepository(traffic.pool),
        settingsRepo,
        viewDeps: { ...viewDeps(traffic.pool), settingsRepo },
        auditRepo: new PgAuditRepository(traffic.pool),
        aboutTask: {} as Pick<TenantSiteAboutTask, 'draft'>,
        proposalRepo: {} as ProposalRepository,
        transactionRunner: new PgTenantTransactionRunner(traffic.pool),
      }),
    );
    return app;
  }

  it('GET /api/tenant-site/preview: the settings row and the phone ride the request client (base: 2 checkouts / 6 statements, 2 open at once)', async () => {
    const tenantId = await seedTenant();
    await seedPageRows(tenantId, { businessName: 'Preview Plumbing', twilioPhone: freshDid() });
    const traffic = countPoolTraffic(pool);

    const res = await request(tenantSiteApi(traffic, tenantId)).get('/api/tenant-site/preview');

    expect(res.status).toBe(200);
    expect(res.body.data.html).toContain('Preview Plumbing');
    expect(cost(traffic)).toEqual({ checkouts: 1, statements: 6, maxOpen: 1 });
    const ran = traffic.statements();
    expect(ran.filter((s) => PAGE_ROWS.test(s))).toHaveLength(2);
    expect(ran[0]).toBe('BEGIN');
    expect(ran[ran.length - 1]).toBe('COMMIT');
  });
});
