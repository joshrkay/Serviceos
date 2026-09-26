/**
 * #1031 — `PgSettingsRepository.update()` had no upsert: a tenant with no
 * `tenant_settings` row yet silently wrote nothing (`UPDATE ... WHERE
 * tenant_id = $N RETURNING *` matches zero rows and the method returns
 * `null`; the terminology-merge branch had its own early `return null` on
 * the same missing-row precondition).
 *
 * Production callers that discard the return value and would have silently
 * lost a write: `src/learning/corrections/pg-config-ports.ts` (correction-
 * lesson labor-rate / banned-phrase cascades), `src/app.ts`'s equivalent
 * inline ports, `src/onboarding/activate-pack-with-seed.ts`. This is latent
 * rather than live today because every tenant-creation path seeds the row —
 * `createTestTenant` in this suite deliberately does NOT, so it reproduces
 * exactly the "tenant exists, tenant_settings does not (yet)" gap.
 *
 * Docker-gated: requires a Postgres test DB (getSharedTestDb). Runs in PR CI.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { getSharedTestDb, createTestTenant, closeSharedTestDb } from './shared';
import { PgSettingsRepository } from '../../src/settings/pg-settings';

describe('Postgres integration — #1031 PgSettingsRepository.update() upserts a missing tenant_settings row', () => {
  let pool: Pool;
  let settingsRepo: PgSettingsRepository;

  beforeAll(async () => {
    pool = await getSharedTestDb();
    settingsRepo = new PgSettingsRepository(pool);
  });

  afterAll(async () => {
    await closeSharedTestDb();
  });

  it('a plain field update on a tenant with NO settings row creates one instead of returning null', async () => {
    const tenant = await createTestTenant(pool);

    // Sanity: createTestTenant seeds only tenants/users, never tenant_settings.
    expect(await settingsRepo.findByTenant(tenant.tenantId)).toBeNull();

    const updated = await settingsRepo.update(tenant.tenantId, {
      businessName: 'Acme Plumbing',
      laborRateCentsPerHour: 4500,
    });

    expect(updated).not.toBeNull();
    expect(updated!.businessName).toBe('Acme Plumbing');
    expect(updated!.laborRateCentsPerHour).toBe(4500);

    // Not just an in-memory illusion — a real row now exists.
    const persisted = await settingsRepo.findByTenant(tenant.tenantId);
    expect(persisted).not.toBeNull();
    expect(persisted!.businessName).toBe('Acme Plumbing');
    expect(persisted!.laborRateCentsPerHour).toBe(4500);
  });

  it('the terminology-merge branch (its own early return-null path) also upserts on a missing row', async () => {
    const tenant = await createTestTenant(pool);
    expect(await settingsRepo.findByTenant(tenant.tenantId)).toBeNull();

    const updated = await settingsRepo.update(tenant.tenantId, {
      terminologyPreferences: { customer: 'client' },
      activeVerticalPacks: ['plumbing'],
    });

    expect(updated).not.toBeNull();
    expect(updated!.terminologyPreferences).toEqual({ customer: 'client' });
    expect(updated!.activeVerticalPacks).toEqual(['plumbing']);

    const persisted = await settingsRepo.findByTenant(tenant.tenantId);
    expect(persisted!.terminologyPreferences).toEqual({ customer: 'client' });
  });

  it('a second update on the now-existing row behaves as a normal partial update (no duplicate-row / conflict error)', async () => {
    const tenant = await createTestTenant(pool);
    await settingsRepo.update(tenant.tenantId, { businessName: 'First Write' });
    const second = await settingsRepo.update(tenant.tenantId, { businessName: 'Second Write' });

    expect(second!.businessName).toBe('Second Write');
    const rows = await pool.query('SELECT count(*)::int AS n FROM tenant_settings WHERE tenant_id = $1', [
      tenant.tenantId,
    ]);
    expect(rows.rows[0].n).toBe(1);
  });
});
