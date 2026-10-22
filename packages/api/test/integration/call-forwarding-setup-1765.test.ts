/**
 * Docker-gated integration test for #1765 (D-044) — the owner's call
 * forwarding setup lives in tenant_settings.call_forwarding_carrier /
 * call_forwarding_mode / call_forwarding_verified_at (migration 332).
 *
 * Pins the real columns, the CHECK constraints, and that changing the carrier
 * or mode clears the last passing check while re-saving the same choice keeps
 * it, against a real Postgres under RLS.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { closeSharedTestDb, createTestTenant, getSharedTestDb } from './shared';
import { PgSettingsRepository } from '../../src/settings/pg-settings';
import { PgCallForwardingRepository } from '../../src/onboarding/call-forwarding';

describe('#1765 call forwarding setup (real Postgres)', () => {
  let pool: Pool;

  beforeAll(async () => {
    pool = await getSharedTestDb();
  });
  afterAll(async () => {
    await closeSharedTestDb();
  });

  it('has nothing until a carrier is saved, and no row to save onto without settings', async () => {
    const { tenantId } = await createTestTenant(pool);
    const repo = new PgCallForwardingRepository(pool);
    expect(await repo.get(tenantId)).toBeNull();
    expect(await repo.save(tenantId, { carrier: 'att', mode: 'all' })).toBeUndefined();
    expect(await repo.recordCheckPassed(tenantId, new Date())).toBe(false);
  });

  it('round-trips carrier and mode and returns the previous setup', async () => {
    const { tenantId } = await createTestTenant(pool);
    await new PgSettingsRepository(pool).upsertIdentityFields(tenantId, { businessName: 'Acme' });
    const repo = new PgCallForwardingRepository(pool);

    expect(await repo.save(tenantId, { carrier: 'verizon', mode: 'missed' })).toBeNull();
    expect(await repo.get(tenantId)).toEqual({ carrier: 'verizon', mode: 'missed', checkPassedAt: null });
    expect(await repo.save(tenantId, { carrier: 'tmobile', mode: 'all' })).toEqual({
      carrier: 'verizon',
      mode: 'missed',
      checkPassedAt: null,
    });
  });

  it('a passing check survives re-saving the same choice and is cleared by a carrier or mode change', async () => {
    const { tenantId } = await createTestTenant(pool);
    await new PgSettingsRepository(pool).upsertIdentityFields(tenantId, { businessName: 'Acme' });
    const repo = new PgCallForwardingRepository(pool);
    const at = new Date('2026-10-22T10:00:00.000Z');

    await repo.save(tenantId, { carrier: 'att', mode: 'missed' });
    expect(await repo.recordCheckPassed(tenantId, at)).toBe(true);
    expect((await repo.get(tenantId))?.checkPassedAt).toEqual(at);

    await repo.save(tenantId, { carrier: 'att', mode: 'missed' });
    expect((await repo.get(tenantId))?.checkPassedAt).toEqual(at);

    await repo.save(tenantId, { carrier: 'att', mode: 'all' });
    expect((await repo.get(tenantId))?.checkPassedAt).toBeNull();

    await repo.recordCheckPassed(tenantId, at);
    await repo.save(tenantId, { carrier: 'other', mode: 'all' });
    expect((await repo.get(tenantId))?.checkPassedAt).toBeNull();
  });

  it('rejects a carrier or mode outside the allowed set', async () => {
    const { tenantId } = await createTestTenant(pool);
    await new PgSettingsRepository(pool).upsertIdentityFields(tenantId, { businessName: 'Acme' });
    await expect(
      pool.query(`UPDATE tenant_settings SET call_forwarding_carrier = 'sprint' WHERE tenant_id = $1`, [tenantId]),
    ).rejects.toThrow();
    await expect(
      pool.query(`UPDATE tenant_settings SET call_forwarding_mode = 'sometimes' WHERE tenant_id = $1`, [tenantId]),
    ).rejects.toThrow();
  });
});
