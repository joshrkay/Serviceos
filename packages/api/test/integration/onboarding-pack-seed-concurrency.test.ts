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
  });
});
