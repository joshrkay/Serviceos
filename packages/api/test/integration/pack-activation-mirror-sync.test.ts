/**
 * Postgres integration — the tenant_settings `_activeVerticalPacks` mirror
 * stays in lock-step with the authoritative `pack_activations` table.
 *
 * Active vertical packs were tracked in two places with nothing keeping them
 * in sync: the `pack_activations` table (source for the Vertical Packs
 * settings sheet) and `tenant_settings.terminology_preferences.
 * _activeVerticalPacks` (source for the Templates page + public intake form).
 * Every activate/deactivate through the settings sheet wrote only the table,
 * so the mirror drifted and those two read paths showed the wrong packs.
 *
 * The fix makes pack_activations authoritative and re-derives the mirror on
 * every write (syncActiveVerticalPacksMirror — exactly what the
 * pack-activation route calls). These tests drive that path against real
 * Postgres and assert BOTH sources agree, prove a settings terminology write
 * does not silently diverge them, and prove the one-time backfill migration
 * (236) reconciles rows that drifted before the fix shipped.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Pool } from 'pg';
import { getSharedTestDb, createTestTenant, closeSharedTestDb } from './shared';
import { PgPackActivationRepository } from '../../src/settings/pg-pack-activation';
import { PgSettingsRepository } from '../../src/settings/pg-settings';
import {
  activatePack,
  deactivatePack,
  syncActiveVerticalPacksMirror,
} from '../../src/settings/pack-activation';
import type { TenantSettings } from '../../src/settings/settings';
import { MIGRATIONS } from '../../src/db/schema';

async function readTableActivePacks(pool: Pool, tenantId: string): Promise<string[]> {
  const r = await pool.query<{ pack_id: string }>(
    `SELECT pack_id FROM pack_activations
      WHERE tenant_id = $1 AND status = 'active'
      ORDER BY activated_at DESC`,
    [tenantId],
  );
  return r.rows.map((row) => row.pack_id);
}

async function readMirrorPacks(pool: Pool, tenantId: string): Promise<string[]> {
  const r = await pool.query<{ terminology_preferences: Record<string, unknown> | null }>(
    `SELECT terminology_preferences FROM tenant_settings WHERE tenant_id = $1`,
    [tenantId],
  );
  const tp = r.rows[0]?.terminology_preferences ?? null;
  const packs = tp?._activeVerticalPacks;
  return Array.isArray(packs) ? (packs as string[]) : [];
}

/** Both sources agree iff they hold the same SET of pack ids. */
function expectAgree(tablePacks: string[], mirrorPacks: string[]): void {
  expect([...mirrorPacks].sort()).toEqual([...tablePacks].sort());
}

describe('Postgres integration — active vertical packs single source of truth', () => {
  let pool: Pool;
  let packRepo: PgPackActivationRepository;
  let settingsRepo: PgSettingsRepository;
  let tenant: { tenantId: string; userId: string };

  beforeAll(async () => {
    pool = await getSharedTestDb();
    packRepo = new PgPackActivationRepository(pool);
    settingsRepo = new PgSettingsRepository(pool);
  });

  afterAll(async () => {
    await closeSharedTestDb();
  });

  beforeEach(async () => {
    tenant = await createTestTenant(pool);
    const now = new Date();
    const seed: TenantSettings = {
      id: crypto.randomUUID(),
      tenantId: tenant.tenantId,
      businessName: 'Sync Co',
      timezone: 'America/New_York',
      estimatePrefix: 'EST-',
      invoicePrefix: 'INV-',
      nextEstimateNumber: 1001,
      nextInvoiceNumber: 1001,
      defaultPaymentTermDays: 30,
      createdAt: now,
      updatedAt: now,
    };
    await settingsRepo.create(seed);
  });

  it('activate through the pack-activation path keeps table and mirror in sync', async () => {
    await activatePack({ tenantId: tenant.tenantId, packId: 'hvac' }, packRepo);
    await syncActiveVerticalPacksMirror(tenant.tenantId, packRepo, settingsRepo);

    let table = await readTableActivePacks(pool, tenant.tenantId);
    let mirror = await readMirrorPacks(pool, tenant.tenantId);
    expect(table).toEqual(['hvac']);
    expectAgree(table, mirror);

    await activatePack({ tenantId: tenant.tenantId, packId: 'plumbing' }, packRepo);
    await syncActiveVerticalPacksMirror(tenant.tenantId, packRepo, settingsRepo);

    table = await readTableActivePacks(pool, tenant.tenantId);
    mirror = await readMirrorPacks(pool, tenant.tenantId);
    expect([...table].sort()).toEqual(['hvac', 'plumbing']);
    expectAgree(table, mirror);
  });

  it('deactivate through the pack-activation path drops the pack from the mirror too', async () => {
    await activatePack({ tenantId: tenant.tenantId, packId: 'hvac' }, packRepo);
    await activatePack({ tenantId: tenant.tenantId, packId: 'plumbing' }, packRepo);
    await syncActiveVerticalPacksMirror(tenant.tenantId, packRepo, settingsRepo);

    await deactivatePack(tenant.tenantId, 'hvac', packRepo);
    await syncActiveVerticalPacksMirror(tenant.tenantId, packRepo, settingsRepo);

    let table = await readTableActivePacks(pool, tenant.tenantId);
    let mirror = await readMirrorPacks(pool, tenant.tenantId);
    expect(table).toEqual(['plumbing']);
    expectAgree(table, mirror);

    // Deactivate the last pack — the mirror empties, not go stale.
    await deactivatePack(tenant.tenantId, 'plumbing', packRepo);
    await syncActiveVerticalPacksMirror(tenant.tenantId, packRepo, settingsRepo);

    table = await readTableActivePacks(pool, tenant.tenantId);
    mirror = await readMirrorPacks(pool, tenant.tenantId);
    expect(table).toEqual([]);
    expect(mirror).toEqual([]);
    expectAgree(table, mirror);
  });

  it('a settings terminology write does not silently diverge the two sources', async () => {
    await activatePack({ tenantId: tenant.tenantId, packId: 'hvac' }, packRepo);
    await syncActiveVerticalPacksMirror(tenant.tenantId, packRepo, settingsRepo);

    // Unrelated settings write that touches terminology preferences (the same
    // JSONB column that stores the mirror). It must preserve _activeVerticalPacks.
    await settingsRepo.update(tenant.tenantId, {
      terminologyPreferences: { job: 'Project' },
    });

    const table = await readTableActivePacks(pool, tenant.tenantId);
    const mirror = await readMirrorPacks(pool, tenant.tenantId);
    expect(table).toEqual(['hvac']);
    expectAgree(table, mirror);

    // And the terminology preference co-exists with the mirror in the column.
    const row = await pool.query<{ terminology_preferences: Record<string, unknown> }>(
      `SELECT terminology_preferences FROM tenant_settings WHERE tenant_id = $1`,
      [tenant.tenantId],
    );
    expect(row.rows[0].terminology_preferences.job).toBe('Project');
  });

  it('migration 236 backfill reconciles a row that drifted before the fix', async () => {
    // Simulate pre-fix drift: the authoritative table has hvac active and
    // plumbing deactivated, but the mirror is stale (still lists both, and
    // even a ghost pack that was never in the table).
    await activatePack({ tenantId: tenant.tenantId, packId: 'hvac' }, packRepo);
    await activatePack({ tenantId: tenant.tenantId, packId: 'plumbing' }, packRepo);
    await deactivatePack(tenant.tenantId, 'plumbing', packRepo);

    await pool.query(
      `UPDATE tenant_settings
         SET terminology_preferences = jsonb_build_object(
           'job', 'Project',
           '_activeVerticalPacks', '["hvac","plumbing","ghost"]'::jsonb)
       WHERE tenant_id = $1`,
      [tenant.tenantId],
    );

    // Sanity: the mirror is drifted before the backfill.
    const before = await readMirrorPacks(pool, tenant.tenantId);
    expect([...before].sort()).toEqual(['ghost', 'hvac', 'plumbing']);

    // Run the one-time backfill migration (idempotent, cross-tenant).
    await pool.query(MIGRATIONS['236_reconcile_active_vertical_packs_mirror']);

    const table = await readTableActivePacks(pool, tenant.tenantId);
    const mirror = await readMirrorPacks(pool, tenant.tenantId);
    expect(table).toEqual(['hvac']);
    expectAgree(table, mirror);

    // Unrelated terminology keys survive the reconciliation.
    const row = await pool.query<{ terminology_preferences: Record<string, unknown> }>(
      `SELECT terminology_preferences FROM tenant_settings WHERE tenant_id = $1`,
      [tenant.tenantId],
    );
    expect(row.rows[0].terminology_preferences.job).toBe('Project');

    // Idempotent: a second run changes nothing.
    await pool.query(MIGRATIONS['236_reconcile_active_vertical_packs_mirror']);
    const mirror2 = await readMirrorPacks(pool, tenant.tenantId);
    expectAgree(table, mirror2);
  });
});
