/**
 * Docker-gated integration test — NOT run in web sessions. Requires the
 * testcontainer Postgres started by `npm run test:integration`.
 *
 * Review finding #3 — `proposals/execution/onboarding-handlers.ts` used to
 * call `activatePackWithSeed` with NO lock at all (unlike POST /pack's
 * request-scoped `pg_try_advisory_xact_lock`). Two DIFFERENT onboarding
 * proposals from the SAME conversation (`onboarding_tenant_settings` +
 * `onboarding_service_category`) targeting the SAME pack execute on their
 * OWN idempotency locks (keyed by proposal id, not by pack) in a
 * multi-worker deployment, so nothing serialized them against each other.
 * `seedPackDefaults` probes catalog/template names then inserts — not
 * atomic, no uniqueness constraint — so both handlers could pass the
 * "already seeded?" probe before either committed and both insert a full
 * duplicate set of catalog items and estimate templates.
 *
 * This test drives the REAL race: two execution handlers, each on its own
 * `PgCatalogItemRepository` / `PgEstimateTemplateRepository` connection
 * (real Postgres, real transactions), executing concurrently for the same
 * tenant + pack. It proves the fix (a session-level advisory lock on the
 * SAME (tenant, pack) key the HTTP route's xact lock uses, threaded through
 * as `lockPool`) — not merely that a lock argument was passed.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Pool } from 'pg';
import { getSharedTestDb, createTestTenant, closeSharedTestDb } from './shared';
import { PgSettingsRepository } from '../../src/settings/pg-settings';
import { PgPackActivationRepository } from '../../src/settings/pg-pack-activation';
import { PgAuditRepository } from '../../src/audit/pg-audit';
import { PgCatalogItemRepository } from '../../src/catalog/pg-catalog-item';
import { PgEstimateTemplateRepository } from '../../src/templates/pg-estimate-template';
import {
  OnboardingTenantSettingsExecutionHandler,
  OnboardingServiceCategoryExecutionHandler,
} from '../../src/proposals/execution/onboarding-handlers';
import { createProposal, type Proposal } from '../../src/proposals/proposal';

describe('Postgres integration — concurrent onboarding pack-seed execution (review finding #3)', () => {
  let pool: Pool;
  let tenant: { tenantId: string; userId: string };

  beforeAll(async () => {
    pool = await getSharedTestDb();
  });
  afterAll(async () => {
    await closeSharedTestDb();
  });
  beforeEach(async () => {
    tenant = await createTestTenant(pool);
  });

  function buildDeps() {
    const settingsRepo = new PgSettingsRepository(pool);
    const packActivationRepo = new PgPackActivationRepository(pool);
    const auditRepo = new PgAuditRepository(pool);
    const catalogRepo = new PgCatalogItemRepository(pool);
    const templateRepo = new PgEstimateTemplateRepository(pool);
    const packSeedDeps = { catalogRepo, templateRepo };
    return { settingsRepo, packActivationRepo, auditRepo, catalogRepo, templateRepo, packSeedDeps };
  }

  function tenantSettingsProposal(tenantId: string): Proposal {
    return createProposal({
      tenantId,
      proposalType: 'onboarding_tenant_settings',
      payload: {
        businessName: 'Concurrency HVAC Co',
        verticalPacks: ['hvac'],
        timezone: 'America/Phoenix',
      },
      summary: 'Set up business identity',
      createdBy: tenant.userId,
    });
  }

  function serviceCategoryProposal(tenantId: string): Proposal {
    return createProposal({
      tenantId,
      proposalType: 'onboarding_service_category',
      payload: {
        verticalType: 'hvac',
        categoryId: 'hvac-repair-ac',
        displayName: 'AC Repair',
      },
      summary: 'Activate category: AC Repair (hvac)',
      createdBy: tenant.userId,
    });
  }

  it('two sibling proposals executing concurrently for the SAME pack do NOT duplicate catalog items or templates', async () => {
    const { settingsRepo, packActivationRepo, auditRepo, packSeedDeps } = buildDeps();

    const tenantSettingsHandler = new OnboardingTenantSettingsExecutionHandler(
      settingsRepo,
      packActivationRepo,
      auditRepo,
      packSeedDeps,
      pool,
    );
    const serviceCategoryHandler = new OnboardingServiceCategoryExecutionHandler(
      settingsRepo,
      packActivationRepo,
      auditRepo,
      packSeedDeps,
      pool,
    );

    const context = { tenantId: tenant.tenantId, executedBy: tenant.userId, executedByRole: 'owner' };

    // Fire both concurrently — this is the exact shape of the race: two
    // DIFFERENT proposal ids, same tenant + pack, no shared idempotency key.
    const [settingsResult, categoryResult] = await Promise.all([
      tenantSettingsHandler.execute(tenantSettingsProposal(tenant.tenantId), context),
      serviceCategoryHandler.execute(serviceCategoryProposal(tenant.tenantId), context),
    ]);

    // Both should still succeed (one may briefly wait on the lock, but
    // pg_try_advisory_lock + the surrounding retry-free execute() means at
    // most one of these could report PACK_ACTIVATION_IN_PROGRESS if it lost
    // the race entirely; assert that whichever happened, no duplicate rows
    // resulted).
    for (const r of [settingsResult, categoryResult]) {
      if (!r.success) {
        expect(r.error).toMatch(/PACK_ACTIVATION_IN_PROGRESS/);
      }
    }

    const catalogRows = await pool.query(
      `SELECT name, COUNT(*) AS n FROM catalog_items WHERE tenant_id = $1 GROUP BY name HAVING COUNT(*) > 1`,
      [tenant.tenantId],
    );
    expect(catalogRows.rows).toEqual([]);

    const templateRows = await pool.query(
      `SELECT name, COUNT(*) AS n FROM estimate_templates WHERE tenant_id = $1 GROUP BY name HAVING COUNT(*) > 1`,
      [tenant.tenantId],
    );
    expect(templateRows.rows).toEqual([]);

    // Sanity: the HVAC seed actually ran (not both silently no-op'd).
    const totalCatalog = await pool.query(
      `SELECT COUNT(*)::int AS n FROM catalog_items WHERE tenant_id = $1`,
      [tenant.tenantId],
    );
    expect(totalCatalog.rows[0].n).toBeGreaterThan(0);
    const totalTemplates = await pool.query(
      `SELECT COUNT(*)::int AS n FROM estimate_templates WHERE tenant_id = $1`,
      [tenant.tenantId],
    );
    expect(totalTemplates.rows[0].n).toBeGreaterThan(0);

    // Real Postgres, both legs: the write AND its audit event. The loser of
    // the advisory lock (if any) short-circuits with PACK_ACTIVATION_IN_
    // PROGRESS before ever reaching activatePackWithSeed's audit write, so
    // exactly one 'tenant.pack_activated' row exists per handler that
    // actually reported success — never duplicated by the race.
    const successCount = [settingsResult, categoryResult].filter((r) => r.success).length;
    const auditRows = await auditRepo.findByEntity(tenant.tenantId, 'tenant_packs', 'hvac');
    expect(auditRows).toHaveLength(successCount);
    expect(auditRows.every((r) => r.eventType === 'tenant.pack_activated')).toBe(true);
  });

  it('T1 — a second tenant racing the SAME pack-seed concurrency scenario at the same time neither leaks into nor is affected by the first tenant\'s rows or audit trail', async () => {
    const tenantB = await createTestTenant(pool);
    const auditRepo = new PgAuditRepository(pool);

    // Pre-seed a minimal tenant_settings row for BOTH tenants. This isolates
    // the case under test (does the per-(tenant, pack) advisory lock stay
    // tenant-scoped under real concurrency?) from a separate, pre-existing
    // race in activatePackWithSeed: its settingsRepo upsert (INSERT when no
    // row exists) runs BEFORE the advisory lock is taken, so two concurrent
    // first-ever writes for the SAME brand-new tenant can both observe "no
    // row" and both INSERT, tripping tenant_settings' unique constraint.
    // That's a real, separate gap (also present, just less likely to fire,
    // in this file's single-tenant race above) — out of scope here (test-
    // only rows, no src changes) and orthogonal to what T1 is proving.
    for (const t of [tenant, tenantB]) {
      await pool.query(
        `INSERT INTO tenant_settings (id, tenant_id, business_name, estimate_prefix, invoice_prefix, next_estimate_number, next_invoice_number, default_payment_term_days)
         VALUES (gen_random_uuid(), $1, 'Concurrency Co', 'EST-', 'INV-', 1001, 1001, 30)`,
        [t.tenantId],
      );
    }

    function race(forTenant: { tenantId: string; userId: string }) {
      const { settingsRepo, packActivationRepo, auditRepo, packSeedDeps } = buildDeps();
      const tenantSettingsHandler = new OnboardingTenantSettingsExecutionHandler(
        settingsRepo,
        packActivationRepo,
        auditRepo,
        packSeedDeps,
        pool,
      );
      const serviceCategoryHandler = new OnboardingServiceCategoryExecutionHandler(
        settingsRepo,
        packActivationRepo,
        auditRepo,
        packSeedDeps,
        pool,
      );
      const context = { tenantId: forTenant.tenantId, executedBy: forTenant.userId, executedByRole: 'owner' };
      return Promise.all([
        tenantSettingsHandler.execute(tenantSettingsProposal(forTenant.tenantId), context),
        serviceCategoryHandler.execute(serviceCategoryProposal(forTenant.tenantId), context),
      ]);
    }

    // Both tenants' races run AT THE SAME TIME — the per-(tenant, pack)
    // advisory-lock key must be tenant-scoped, or tenant B's race would
    // contend with tenant A's lock and either duplicate or spuriously lock.
    const [[aSettings, aCategory], [bSettings, bCategory]] = await Promise.all([
      race(tenant),
      race(tenantB),
    ]);

    for (const r of [aSettings, aCategory, bSettings, bCategory]) {
      if (!r.success) {
        expect(r.error).toMatch(/PACK_ACTIVATION_IN_PROGRESS/);
      }
    }

    const catalogUnderB = await pool.query(
      `SELECT id FROM catalog_items WHERE tenant_id = $1`,
      [tenantB.tenantId],
    );
    const catalogUnderA = await pool.query(
      `SELECT id FROM catalog_items WHERE tenant_id = $1`,
      [tenant.tenantId],
    );
    expect(catalogUnderA.rows.length).toBeGreaterThan(0);
    expect(catalogUnderB.rows.length).toBeGreaterThan(0);

    // Each tenant's audit trail is exactly its own success count — the
    // other tenant's race never contributes to (or subtracts from) it.
    const auditA = await auditRepo.findByEntity(tenant.tenantId, 'tenant_packs', 'hvac');
    const auditB = await auditRepo.findByEntity(tenantB.tenantId, 'tenant_packs', 'hvac');
    expect(auditA).toHaveLength([aSettings, aCategory].filter((r) => r.success).length);
    expect(auditB).toHaveLength([bSettings, bCategory].filter((r) => r.success).length);

    // Neither tenant's pack row is visible under the other's id.
    const packUnderB = await pool.query(
      `SELECT pack_id FROM pack_activations WHERE tenant_id = $1 AND pack_id = 'hvac'`,
      [tenantB.tenantId],
    );
    expect(packUnderB.rows.length).toBeGreaterThan(0);
    const totalPackRows = await pool.query(
      `SELECT tenant_id FROM pack_activations WHERE pack_id = 'hvac' AND tenant_id IN ($1, $2)`,
      [tenant.tenantId, tenantB.tenantId],
    );
    // Exactly one row per tenant (activatePack no-ops on an already-active
    // pack rather than duplicating) — no cross-tenant bleed either way.
    expect(totalPackRows.rows).toHaveLength(2);
  });
});
