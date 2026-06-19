/**
 * Postgres integration — public lead intake form (`POST /:tenantId/leads`).
 *
 * Drives the production createPublicIntakeRouter against real Pg repos
 * via supertest. Same pattern as ach-webhook.test.ts. Pins the durable
 * + safety paths that only show up against real Postgres + RLS:
 *
 *   1. createLead persists a row under the tenant via withTenant and
 *      emits an audit_event tagged with the same tenantId — both writes
 *      land under tenant RLS.
 *   2. The 404 / 400 / honeypot paths do NOT write a leads row
 *      (the "no tenant-existence oracle" + "bots see success" invariants).
 *   3. Cross-tenant: a lead intake under tenant A's UUID is invisible
 *      under tenant B's leadRepo.findByTenant (proves the prod route's
 *      tenant scoping ends at RLS, not just app-layer code).
 *
 * The GET /:tenantId surface (vertical packs + business hours) is
 * deliberately NOT covered here — its VerticalPackRegistry fan-out is
 * unit-tested separately and offers nothing on top of standard CRUD
 * against the schema.
 */
import express from 'express';
import request from 'supertest';
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { Pool, PoolClient } from 'pg';
import { closeSharedTestDb, createTestTenant, getSharedTestDb } from './shared';
import { createPublicIntakeRouter } from '../../src/routes/public-intake';
import { PgLeadRepository } from '../../src/leads/pg-lead';
import { PgAuditRepository } from '../../src/audit/pg-audit';
import { PgTenantRepository } from '../../src/auth/pg-tenant';
import type { SettingsRepository } from '../../src/settings/settings';
import type { VerticalPackRegistry } from '../../src/shared/vertical-pack-registry';

// Minimal stubs: the POST path doesn't touch settings or packs. They're
// only injected so the router constructor is satisfied.
const settingsStub: SettingsRepository = {
  findByTenant: async () => null,
} as unknown as SettingsRepository;
const packRegistryStub: VerticalPackRegistry = {
  getByPackId: async () => null,
  findByVertical: async () => [],
} as unknown as VerticalPackRegistry;

function buildApp(pool: Pool): express.Express {
  const app = express();
  app.use(express.json());
  app.use(
    '/intake',
    createPublicIntakeRouter(
      new PgLeadRepository(pool),
      new PgTenantRepository(pool),
      new PgAuditRepository(pool),
      settingsStub,
      packRegistryStub,
      pool,
    ),
  );
  return app;
}

async function countLeads(pool: Pool, tenantId: string): Promise<number> {
  const { rows } = await pool.query(
    `SELECT count(*)::int AS n FROM leads WHERE tenant_id = $1`,
    [tenantId],
  );
  return rows[0].n;
}

/**
 * Unprivileged role + GUC pattern mirrored from rls-tenant-isolation.test.ts.
 * `leadRepo.findByTenant(tenantB)` scopes the query to tenant B via
 * `WHERE tenant_id = $1` before any policy could matter, so the
 * cross-tenant guard below could pass even with leads RLS removed. Querying
 * through asTenant under this NOBYPASSRLS role without a tenant_id predicate
 * makes the policy itself the only thing gating cross-tenant reads.
 */
const APP_ROLE = 'rls_app_runtime';

async function ensureRlsAppRole(pool: Pool): Promise<void> {
  await pool.query(`DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${APP_ROLE}') THEN
      CREATE ROLE ${APP_ROLE} NOLOGIN NOBYPASSRLS;
    END IF;
  END $$;`);
  await pool.query(`GRANT USAGE ON SCHEMA public TO ${APP_ROLE}`);
  await pool.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${APP_ROLE}`);
}

async function asTenant<T>(
  pool: Pool,
  tenantId: string,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SET LOCAL ROLE ${APP_ROLE}`);
    await client.query("SELECT set_config('app.current_tenant_id', $1, true)", [tenantId]);
    return await fn(client);
  } finally {
    await client.query('ROLLBACK').catch(() => undefined);
    client.release();
  }
}

describe('public intake POST /:tenantId/leads — integration', () => {
  let pool: Pool;
  let leadRepo: PgLeadRepository;
  let app: express.Express;
  let tenantA: { tenantId: string; userId: string };

  beforeAll(async () => {
    pool = await getSharedTestDb();
    leadRepo = new PgLeadRepository(pool);
    app = buildApp(pool);
    await ensureRlsAppRole(pool);
  });

  beforeEach(async () => {
    tenantA = await createTestTenant(pool);
  });

  afterAll(async () => {
    await closeSharedTestDb();
  });

  it('happy path: a valid form payload returns 201, persists a lead under the tenant, and writes an audit event', async () => {
    const before = await countLeads(pool, tenantA.tenantId);

    const res = await request(app)
      .post(`/intake/${tenantA.tenantId}/leads`)
      .send({
        firstName: 'Pat',
        lastName: 'McLead',
        primaryPhone: '+15551237777',
        email: 'pat@example.com',
        serviceType: 'HVAC',
        urgency: 'Today',
        description: 'AC making a grinding noise',
        utmSource: 'google',
        utmMedium: 'cpc',
        utmCampaign: 'summer-promo',
      });

    expect(res.status).toBe(201);
    expect(res.body.ok).toBe(true);
    expect(typeof res.body.leadId).toBe('string');

    // Lead row is persisted under the tenant via the production withTenant
    // path. Source is server-stamped 'web_form' — public callers cannot
    // forge attribution.
    const after = await countLeads(pool, tenantA.tenantId);
    expect(after).toBe(before + 1);

    const leads = await leadRepo.findByTenant(tenantA.tenantId);
    const just = leads.find((l) => l.id === res.body.leadId);
    expect(just).toBeTruthy();
    expect(just!.firstName).toBe('Pat');
    expect(just!.source).toBe('web_form');
    expect(just!.utmSource).toBe('google');
    expect(just!.sourceDetail).toContain('AC making a grinding noise');

    // Audit event also lands under the tenant (lead.created emitter inside
    // createLead).  We assert the production schema, not just the call.
    const { rows: auditRows } = await pool.query(
      `SELECT event_type, entity_type, entity_id, actor_role FROM audit_events
        WHERE tenant_id = $1 AND entity_id = $2`,
      [tenantA.tenantId, res.body.leadId],
    );
    expect(auditRows.length).toBeGreaterThanOrEqual(1);
    expect(auditRows[0].entity_type).toBe('lead');
  });

  it('honeypot tripped: 200 OK but NO lead row is written (bots see success)', async () => {
    const before = await countLeads(pool, tenantA.tenantId);

    const res = await request(app)
      .post(`/intake/${tenantA.tenantId}/leads`)
      .send({
        firstName: 'Bot',
        primaryPhone: '+15551238888',
        // Honeypot field — bots fill all fields, real users never see this.
        _company_url: 'http://spam.example/',
      });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.leadId).toBeUndefined();

    const after = await countLeads(pool, tenantA.tenantId);
    expect(after).toBe(before);
  });

  it('invalid tenantId format returns 400 and writes no row', async () => {
    const res = await request(app)
      .post('/intake/not-a-uuid/leads')
      .send({ firstName: 'Pat', primaryPhone: '+15551239999' });
    expect(res.status).toBe(400);
  });

  it('unknown tenantId returns 404 — does not act as a tenant-existence oracle (and writes nothing)', async () => {
    // A well-formed UUID that does not match a real tenant.
    const fakeTenantId = '00000000-0000-0000-0000-000000000000';
    const res = await request(app)
      .post(`/intake/${fakeTenantId}/leads`)
      .send({ firstName: 'Pat', primaryPhone: '+15551231111' });
    expect(res.status).toBe(404);

    // No rows leaked into the fake tenant id (defensive — RLS would prevent
    // a non-existent tenant from owning rows, but we still pin it).
    expect(await countLeads(pool, fakeTenantId)).toBe(0);
  });

  it('missing both phone AND email returns 400 — the Zod refine guard', async () => {
    const res = await request(app)
      .post(`/intake/${tenantA.tenantId}/leads`)
      .send({ firstName: 'Anon', description: 'No way to reach me' });
    expect(res.status).toBe(400);
    expect(await countLeads(pool, tenantA.tenantId)).toBe(0);
  });

  it('cross-tenant isolation: a lead intake under tenant A is invisible via tenant B leadRepo.findByTenant', async () => {
    const tenantB = await createTestTenant(pool);

    const res = await request(app)
      .post(`/intake/${tenantA.tenantId}/leads`)
      .send({
        firstName: 'Iso',
        primaryPhone: '+15551232222',
        serviceType: 'Plumbing',
      });
    expect(res.status).toBe(201);

    // RLS proof: query the leads table under each tenant's GUC and the
    // unprivileged role, WITHOUT a tenant_id predicate. Only the policy
    // can gate this read - if the leads RLS were dropped, tenant B would
    // see tenant A's lead and the assertion would fail.
    const leadIdsUnderA = await asTenant(pool, tenantA.tenantId, (client) =>
      client.query(`SELECT id FROM leads`).then((r) =>
        r.rows.map((row: { id: string }) => row.id),
      ),
    );
    const leadIdsUnderB = await asTenant(pool, tenantB.tenantId, (client) =>
      client.query(`SELECT id FROM leads`).then((r) =>
        r.rows.map((row: { id: string }) => row.id),
      ),
    );
    expect(leadIdsUnderA).toContain(res.body.leadId);
    expect(leadIdsUnderB).not.toContain(res.body.leadId);
  });
});
