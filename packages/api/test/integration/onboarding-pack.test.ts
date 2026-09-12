import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import express, { Request, Response, NextFunction } from 'express';
import request from 'supertest';
import { Pool } from 'pg';
import { getSharedTestDb, createTestTenant, closeSharedTestDb } from './shared';
import { createOnboardingRouter } from '../../src/routes/onboarding';
import { PgSettingsRepository } from '../../src/settings/pg-settings';
import { PgPackActivationRepository } from '../../src/settings/pg-pack-activation';
import { PgAuditRepository } from '../../src/audit/pg-audit';
import { PgCatalogItemRepository } from '../../src/catalog/pg-catalog-item';
import { PgEstimateTemplateRepository } from '../../src/templates/pg-estimate-template';
import type { AuthenticatedRequest } from '../../src/auth/clerk';

// Provisioned globally by test/integration/global-setup.ts's
// ensureRlsRuntimeRole — used to actually exercise catalog_items' RLS
// policy (the superuser pool bypasses RLS unconditionally, FORCE or not).
const APP_ROLE = 'rls_app_runtime';

describe('POST /api/onboarding/pack', () => {
  let pool: Pool;
  let app: express.Express;
  let auditRepo: PgAuditRepository;
  // Two-tenant auth shim — the middleware below reads `activeTenant` at
  // request time so a single Express app can serve requests "as" either
  // tenant within the same test (T1/T3 below), instead of one app per tenant.
  let activeTenant: { tenantId: string; userId: string };
  let currentTenant: { tenantId: string; userId: string };

  beforeAll(async () => {
    pool = await getSharedTestDb();
    const settingsRepo = new PgSettingsRepository(pool);
    const packActivationRepo = new PgPackActivationRepository(pool);
    auditRepo = new PgAuditRepository(pool);
    // 1.3 (§8.1) — without packSeedDeps, /pack activates the pack but never
    // seeds catalog_items/estimate_templates, so "a price book I didn't have
    // to build" (the row's own story) was previously unverifiable from this
    // file. Wiring it is what makes the T3 case below (two tenants, two
    // DIFFERENT packs, two DIFFERENT price books) possible to assert.
    const catalogRepo = new PgCatalogItemRepository(pool);
    const templateRepo = new PgEstimateTemplateRepository(pool);

    app = express();
    app.use(express.json());
    app.use((req: Request, _res: Response, next: NextFunction) => {
      (req as AuthenticatedRequest).auth = {
        userId: activeTenant.userId,
        sessionId: 'sess-test',
        tenantId: activeTenant.tenantId,
        role: 'owner',
      };
      next();
    });
    app.use(
      '/api/onboarding',
      createOnboardingRouter({
        settingsRepo,
        packActivationRepo,
        auditRepo,
        pool,
        packSeedDeps: { catalogRepo, templateRepo },
      }),
    );
  });

  beforeEach(async () => {
    currentTenant = await createTestTenant(pool);
    activeTenant = currentTenant;
  });

  afterAll(async () => {
    await closeSharedTestDb();
  });

  it('rejects unknown packId with 400 VALIDATION_ERROR', async () => {
    const res = await request(app).post('/api/onboarding/pack').send({
      packId: 'electrical',
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('VALIDATION_ERROR');
  });

  it('activates hvac pack and step 3 becomes done', async () => {
    const res = await request(app).post('/api/onboarding/pack').send({
      packId: 'hvac',
    });
    expect(res.status).toBe(200);
    expect(res.body.packId).toBe('hvac');

    // Verify pack status in GET /status
    const status = await request(app).get('/api/onboarding/status');
    expect(status.body.steps.find((s: any) => s.id === 'pack').status).toBe('done');

    // Verify activeVerticalPacks in DB
    const dbRow = await pool.query(
      'SELECT terminology_preferences FROM tenant_settings WHERE tenant_id=$1',
      [currentTenant.tenantId]
    );
    expect(dbRow.rows[0].terminology_preferences._activeVerticalPacks).toEqual(['hvac']);

    const packRow = await pool.query(
      `SELECT pack_id, status FROM pack_activations WHERE tenant_id=$1 AND pack_id=$2`,
      [currentTenant.tenantId, 'hvac'],
    );
    expect(packRow.rows).toHaveLength(1);
    expect(packRow.rows[0].status).toBe('active');

    // The write is AUDITED against real Postgres, not a mocked repo — read
    // it back through PgAuditRepository.findByEntity (activate-pack-with-
    // seed.ts stamps entityType='tenant_packs', entityId=packId).
    const auditRows = await auditRepo.findByEntity(currentTenant.tenantId, 'tenant_packs', 'hvac');
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0].eventType).toBe('tenant.pack_activated');
    expect(auditRows[0].actorId).toBe(currentTenant.userId);
    expect(auditRows[0].metadata?.packId).toBe('hvac');
  });

  it('is idempotent: activating hvac twice results in single entry', async () => {
    // First activation
    await request(app).post('/api/onboarding/pack').send({ packId: 'hvac' });
    // Second activation
    await request(app).post('/api/onboarding/pack').send({ packId: 'hvac' });

    const dbRow = await pool.query(
      'SELECT terminology_preferences FROM tenant_settings WHERE tenant_id=$1',
      [currentTenant.tenantId]
    );
    expect(dbRow.rows[0].terminology_preferences._activeVerticalPacks).toEqual(['hvac']);
    expect(dbRow.rows[0].terminology_preferences._activeVerticalPacks.length).toBe(1);
  });

  it('T1 — a second tenant activating a pack neither sees nor is seen by the first tenant\'s pack rows or audit trail', async () => {
    // Tenant A activates hvac (as the normal flow above).
    await request(app).post('/api/onboarding/pack').send({ packId: 'hvac' });

    // Tenant B — switch the shared app's auth context and activate a
    // DIFFERENT pack, exactly as a second real tenant hitting the same
    // deployed router would.
    const tenantB = await createTestTenant(pool);
    activeTenant = tenantB;
    const resB = await request(app).post('/api/onboarding/pack').send({ packId: 'plumbing' });
    expect(resB.status).toBe(200);
    activeTenant = currentTenant;

    // Tenant A's pack row is invisible under tenant B's id, and vice versa.
    const aPacksUnderB = await pool.query(
      `SELECT pack_id FROM pack_activations WHERE tenant_id=$1 AND pack_id=$2`,
      [tenantB.tenantId, 'hvac'],
    );
    expect(aPacksUnderB.rows).toHaveLength(0);
    const bPacksUnderA = await pool.query(
      `SELECT pack_id FROM pack_activations WHERE tenant_id=$1 AND pack_id=$2`,
      [currentTenant.tenantId, 'plumbing'],
    );
    expect(bPacksUnderA.rows).toHaveLength(0);

    // Tenant A's audit trail does not leak into tenant B's, and vice versa.
    const aAuditUnderB = await auditRepo.findByEntity(tenantB.tenantId, 'tenant_packs', 'hvac');
    expect(aAuditUnderB).toHaveLength(0);
    const bAuditUnderA = await auditRepo.findByEntity(currentTenant.tenantId, 'tenant_packs', 'plumbing');
    expect(bAuditUnderA).toHaveLength(0);

    // Each tenant's OWN audit row is exactly where it should be.
    const aAudit = await auditRepo.findByEntity(currentTenant.tenantId, 'tenant_packs', 'hvac');
    expect(aAudit).toHaveLength(1);
    const bAudit = await auditRepo.findByEntity(tenantB.tenantId, 'tenant_packs', 'plumbing');
    expect(bAudit).toHaveLength(1);
  });

  it('T3 — two tenants activating DIFFERENT packs each get their own price book in the same run', async () => {
    // Tenant A (already seeded via beforeEach as currentTenant) picks hvac.
    const resA = await request(app).post('/api/onboarding/pack').send({ packId: 'hvac' });
    expect(resA.status).toBe(200);

    // Tenant B, in the SAME run, picks the OTHER available pack.
    const tenantB = await createTestTenant(pool);
    activeTenant = tenantB;
    const resB = await request(app).post('/api/onboarding/pack').send({ packId: 'plumbing' });
    expect(resB.status).toBe(200);
    activeTenant = currentTenant;

    const catalogA = await pool.query<{ name: string; unit_price_cents: number }>(
      `SELECT name, unit_price_cents FROM catalog_items WHERE tenant_id=$1 ORDER BY name`,
      [currentTenant.tenantId],
    );
    const catalogB = await pool.query<{ name: string; unit_price_cents: number }>(
      `SELECT name, unit_price_cents FROM catalog_items WHERE tenant_id=$1 ORDER BY name`,
      [tenantB.tenantId],
    );
    // Both tenants actually got a non-empty price book...
    expect(catalogA.rows.length).toBeGreaterThan(0);
    expect(catalogB.rows.length).toBeGreaterThan(0);
    // ...and the two price books are NOT the same set of items — each
    // pack's own catalog defaults (HVAC_LINE_ITEM_DEFAULTS vs.
    // PLUMBING_LINE_ITEM_DEFAULTS), not a shared/templated one.
    const namesA = new Set(catalogA.rows.map((r) => r.name));
    const namesB = new Set(catalogB.rows.map((r) => r.name));
    const overlap = [...namesA].filter((n) => namesB.has(n));
    expect(overlap).toEqual([]);

    // The row's own acceptance criterion is "the pack's SKUs at the pack's
    // prices" — not just disjoint names. Pin the canonical dollar figures
    // from verticals/packs/{hvac,plumbing}.ts so a regression that zeroes
    // out or swaps HVAC/plumbing prices fails here.
    const priceByName = (rows: { name: string; unit_price_cents: number }[]) =>
      Object.fromEntries(rows.map((r) => [r.name, r.unit_price_cents]));
    const pricesA = priceByName(catalogA.rows);
    const pricesB = priceByName(catalogB.rows);
    expect(pricesA['HVAC Labor']).toBe(12500); // $125/hr, HVAC_LINE_ITEM_DEFAULTS.laborRatePerHourCents
    expect(pricesA['HVAC Diagnostic Fee']).toBe(8900); // $89
    expect(pricesB['Plumbing Labor']).toBe(11500); // $115/hr, PLUMBING_LINE_ITEM_DEFAULTS.laborRatePerHourCents
    expect(pricesB['Plumbing Diagnostic Fee']).toBe(7500); // $75

    const templatesA = await pool.query<{ name: string }>(
      `SELECT name FROM estimate_templates WHERE tenant_id=$1`,
      [currentTenant.tenantId],
    );
    const templatesB = await pool.query<{ name: string }>(
      `SELECT name FROM estimate_templates WHERE tenant_id=$1`,
      [tenantB.tenantId],
    );
    expect(templatesA.rows.length).toBeGreaterThan(0);
    expect(templatesB.rows.length).toBeGreaterThan(0);

    // Neither tenant's price book is visible under the other's id — proven
    // under RLS enforcement (rls_app_runtime + tenant B's GUC), not the
    // superuser pool. A raw `WHERE tenant_id = tenantB` query through the
    // superuser connection would return empty here regardless of whether
    // RLS/tenant scoping actually works (it's an explicit filter, not an
    // access-control proof) — querying WITHOUT that filter, but under
    // tenant B's RLS context, is what actually exercises the policy.
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SET LOCAL ROLE ${APP_ROLE}`);
      await client.query("SELECT set_config('app.current_tenant_id', $1, true)", [tenantB.tenantId]);
      const visibleToB = await client.query<{ id: string; name: string }>(
        `SELECT id, name FROM catalog_items WHERE name = ANY($1::text[])`,
        [[...namesA]],
      );
      expect(visibleToB.rows).toHaveLength(0);
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
      client.release();
    }
  });
});
