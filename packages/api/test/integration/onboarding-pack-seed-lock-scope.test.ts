/**
 * Docker-gated integration test — NOT run in web sessions. Requires the
 * testcontainer Postgres started by `npm run test:integration`.
 *
 * #1083 — under CI load, the loser of the pack-seed race surfaced a raw
 * Postgres `duplicate key value violates unique constraint
 * "tenant_settings_tenant_id_key"` (23505) instead of the guard's
 * `PACK_ACTIVATION_IN_PROGRESS:<pack>`. The difference for the caller is
 * "try again" vs. a 500.
 *
 * Mechanism this file pins: `activatePackWithSeed`'s tenant_settings write
 * (read-then-update-or-INSERT) runs BEFORE the advisory-lock guard, so the
 * loser of the lock still performs a real, unguarded write to a per-tenant
 * table on its way to being told "in progress". Two concurrent first-ever
 * activations therefore both observe "no settings row" and both INSERT; the
 * loser trips tenant_settings' unique constraint and throws out of
 * `activatePackWithSeed` before the guard is ever reached.
 *
 * Both tests below are DETERMINISTIC — no sleeps, no racing promises. A
 * second session holds the exact (tenant, pack) advisory lock
 * `activatePackWithSeed` takes, so the handler under test is the guaranteed
 * loser; what is asserted is what the loser does on its way out.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { Pool, PoolClient } from 'pg';
import { getSharedTestDb, createTestTenant, closeSharedTestDb } from './shared';
import { PgSettingsRepository } from '../../src/settings/pg-settings';
import { PgPackActivationRepository } from '../../src/settings/pg-pack-activation';
import { PgAuditRepository } from '../../src/audit/pg-audit';
import { PgCatalogItemRepository } from '../../src/catalog/pg-catalog-item';
import { PgEstimateTemplateRepository } from '../../src/templates/pg-estimate-template';
import { OnboardingServiceCategoryExecutionHandler } from '../../src/proposals/execution/onboarding-handlers';
import { createProposal, type Proposal } from '../../src/proposals/proposal';

/** Same lock space `activatePackWithSeed` uses (both the xact and session paths). */
const packLockKey = (tenantId: string, packId: string) => `pack:${tenantId}:${packId}`;

describe('Postgres integration — the pack-seed guard holds across the tenant_settings write (#1083)', () => {
  let pool: Pool;
  let tenant: { tenantId: string; userId: string };
  let holder: PoolClient | null = null;

  beforeAll(async () => {
    pool = await getSharedTestDb();
  });
  afterAll(async () => {
    await closeSharedTestDb();
  });
  beforeEach(async () => {
    tenant = await createTestTenant(pool);
  });
  afterEach(async () => {
    if (holder) {
      try {
        await holder.query(`SELECT pg_advisory_unlock(hashtextextended($1::text, 0))`, [
          packLockKey(tenant.tenantId, 'hvac'),
        ]);
      } catch {
        // falls through to the destroy below
      }
      // Destroy rather than return to the pool: a pooled client that still
      // held a session-level advisory lock would block every later holder.
      holder.release(true);
      holder = null;
    }
  });

  /**
   * Take the SESSION-level advisory lock on the exact key
   * `activatePackWithSeed`'s `lockPool` branch tries, and hold it for the
   * duration of the test. The handler under test is then the deterministic
   * loser — no timing involved.
   */
  async function holdPackLock(tenantId: string, packId: string): Promise<PoolClient> {
    const client = await pool.connect();
    const res = await client.query<{ locked: boolean }>(
      `SELECT pg_try_advisory_lock(hashtextextended($1::text, 0)) AS locked`,
      [packLockKey(tenantId, packId)],
    );
    expect(res.rows[0].locked).toBe(true);
    return client;
  }

  function buildDeps() {
    const settingsRepo = new PgSettingsRepository(pool);
    const packActivationRepo = new PgPackActivationRepository(pool);
    const auditRepo = new PgAuditRepository(pool);
    const packSeedDeps = {
      catalogRepo: new PgCatalogItemRepository(pool),
      templateRepo: new PgEstimateTemplateRepository(pool),
    };
    return { settingsRepo, packActivationRepo, auditRepo, packSeedDeps };
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

  it('the loser of the (tenant, pack) lock writes NOTHING to tenant_settings — the whole settings write is behind the guard', async () => {
    const { settingsRepo, packActivationRepo, auditRepo, packSeedDeps } = buildDeps();
    holder = await holdPackLock(tenant.tenantId, 'hvac');

    const handler = new OnboardingServiceCategoryExecutionHandler(
      settingsRepo,
      packActivationRepo,
      auditRepo,
      packSeedDeps,
      pool,
    );
    const result = await handler.execute(serviceCategoryProposal(tenant.tenantId), {
      tenantId: tenant.tenantId,
      executedBy: tenant.userId,
      executedByRole: 'owner',
    });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/PACK_ACTIVATION_IN_PROGRESS/);

    // The loser must not have touched a per-tenant table on its way out. A
    // row here is the unguarded write that #1083's 23505 comes from: a
    // concurrent sibling doing the same INSERT is what trips the unique
    // constraint.
    const settingsRows = await pool.query(
      `SELECT COUNT(*)::int AS n FROM tenant_settings WHERE tenant_id = $1`,
      [tenant.tenantId],
    );
    expect(settingsRows.rows[0].n).toBe(0);

    // Nor anything else: no pack row, no seeded catalog, no audit event.
    const packRows = await pool.query(
      `SELECT COUNT(*)::int AS n FROM pack_activations WHERE tenant_id = $1`,
      [tenant.tenantId],
    );
    expect(packRows.rows[0].n).toBe(0);
    const catalogRows = await pool.query(
      `SELECT COUNT(*)::int AS n FROM catalog_items WHERE tenant_id = $1`,
      [tenant.tenantId],
    );
    expect(catalogRows.rows[0].n).toBe(0);
  });

  it('the loser reports PACK_ACTIVATION_IN_PROGRESS, never a raw 23505, when the winner creates the tenant_settings row first', async () => {
    const { settingsRepo, packActivationRepo, auditRepo, packSeedDeps } = buildDeps();
    holder = await holdPackLock(tenant.tenantId, 'hvac');

    // Reproduce CI's interleaving deterministically: the winner's
    // tenant_settings INSERT commits between the loser's "does a settings row
    // exist?" read and its own INSERT. That is exactly the window the CI
    // failure hit — with the settings write behind the lock, this hook can
    // never fire, because the loser returns at the guard before reading.
    let interleaved = false;
    const realFindByTenant = settingsRepo.findByTenant.bind(settingsRepo);
    settingsRepo.findByTenant = async (tenantId: string) => {
      const found = await realFindByTenant(tenantId);
      if (!interleaved) {
        interleaved = true;
        await holder!.query(
          `INSERT INTO tenant_settings (id, tenant_id, business_name, estimate_prefix, invoice_prefix, next_estimate_number, next_invoice_number, default_payment_term_days)
           VALUES (gen_random_uuid(), $1, 'Winner Co', 'EST-', 'INV-', 1001, 1001, 30)`,
          [tenantId],
        );
      }
      return found;
    };

    const handler = new OnboardingServiceCategoryExecutionHandler(
      settingsRepo,
      packActivationRepo,
      auditRepo,
      packSeedDeps,
      pool,
    );
    const result = await handler.execute(serviceCategoryProposal(tenant.tenantId), {
      tenantId: tenant.tenantId,
      executedBy: tenant.userId,
      executedByRole: 'owner',
    });

    expect(result.success).toBe(false);
    expect(result.error).not.toMatch(/duplicate key value/);
    expect(result.error).toMatch(/PACK_ACTIVATION_IN_PROGRESS/);
    // The guard fired before the settings read — the loser never got far
    // enough to race anyone.
    expect(interleaved).toBe(false);
  });
});
