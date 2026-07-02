/**
 * UB-D / D-015 (D1) — Postgres integration for migration 231.
 *
 * Pins the autonomous booking lane columns against a REAL database
 * (CLAUDE.md: DB-touching changes must prove real column names with an
 * integration test; mocked Pools have shipped nonexistent columns before):
 *   - autonomous_booking_enabled / autonomous_booking_threshold round-trip
 *     through PgSettingsRepository.update + findByTenant, including the
 *     NUMERIC(3,2)-comes-back-as-a-string conversion in mapRow.
 *   - Column defaults: a fresh row reads enabled=false, threshold=0.95.
 *   - The DB CHECK rejects thresholds outside [0.90, 0.99] (raw UPDATE,
 *     bypassing app-layer validation so the constraint itself is proven).
 *
 * Docker-gated: requires a Postgres test DB (getSharedTestDb; the
 * EXTERNAL_TEST_DB_URL escape hatch in global-setup covers blocked
 * registries). Runs in PR CI.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { getSharedTestDb, createTestTenant, closeSharedTestDb } from './shared';
import { PgSettingsRepository } from '../../src/settings/pg-settings';

async function seedSettings(pool: Pool, repo: PgSettingsRepository, businessName: string) {
  const tenant = await createTestTenant(pool);
  const now = new Date();
  await repo.create({
    id: crypto.randomUUID(),
    tenantId: tenant.tenantId,
    businessName,
    timezone: 'America/New_York',
    estimatePrefix: 'EST',
    invoicePrefix: 'INV',
    nextEstimateNumber: 1,
    nextInvoiceNumber: 1,
    defaultPaymentTermDays: 30,
    createdAt: now,
    updatedAt: now,
  });
  return tenant;
}

describe('Postgres integration — autonomous booking settings (UB-D / migration 231)', () => {
  let pool: Pool;
  let settingsRepo: PgSettingsRepository;

  beforeAll(async () => {
    pool = await getSharedTestDb();
    settingsRepo = new PgSettingsRepository(pool);
  });

  afterAll(async () => {
    await closeSharedTestDb();
  });

  it('fresh row reads the migration defaults (enabled=false, threshold=0.95)', async () => {
    const tenant = await seedSettings(pool, settingsRepo, 'Defaults Co');
    const found = await settingsRepo.findByTenant(tenant.tenantId);
    expect(found!.autonomousBookingEnabled).toBe(false);
    // NUMERIC(3,2) — node-pg returns a string; mapRow must convert.
    expect(found!.autonomousBookingThreshold).toBe(0.95);
    expect(typeof found!.autonomousBookingThreshold).toBe('number');
  });

  it('round-trips enabled + threshold through the repo (real column names)', async () => {
    const tenant = await seedSettings(pool, settingsRepo, 'Lane Co');

    const updated = await settingsRepo.update(tenant.tenantId, {
      autonomousBookingEnabled: true,
      autonomousBookingThreshold: 0.97,
    });
    expect(updated).not.toBeNull();
    expect(updated!.autonomousBookingEnabled).toBe(true);
    expect(updated!.autonomousBookingThreshold).toBe(0.97);

    const found = await settingsRepo.findByTenant(tenant.tenantId);
    expect(found!.autonomousBookingEnabled).toBe(true);
    expect(found!.autonomousBookingThreshold).toBe(0.97);

    // Pin the snake_case column names directly (mocked Pools have shipped
    // nonexistent columns before — this query fails loudly if 231 drifted).
    const client = await pool.connect();
    try {
      await client.query(`SET LOCAL app.current_tenant_id = '${tenant.tenantId}'`);
      const { rows } = await client.query(
        `SELECT autonomous_booking_enabled, autonomous_booking_threshold
           FROM tenant_settings WHERE tenant_id = $1`,
        [tenant.tenantId],
      );
      expect(rows[0].autonomous_booking_enabled).toBe(true);
      expect(Number(rows[0].autonomous_booking_threshold)).toBe(0.97);
    } finally {
      client.release();
    }
  });

  it('DB CHECK rejects a threshold below 0.90 (raw UPDATE, app validation bypassed)', async () => {
    const tenant = await seedSettings(pool, settingsRepo, 'Under Floor Co');
    const client = await pool.connect();
    try {
      await client.query(`SET LOCAL app.current_tenant_id = '${tenant.tenantId}'`);
      await expect(
        client.query(
          `UPDATE tenant_settings SET autonomous_booking_threshold = 0.89 WHERE tenant_id = $1`,
          [tenant.tenantId],
        ),
      ).rejects.toThrow();
    } finally {
      client.release();
    }
  });

  it('DB CHECK rejects a threshold above 0.99 (raw UPDATE)', async () => {
    const tenant = await seedSettings(pool, settingsRepo, 'Over Cap Co');
    const client = await pool.connect();
    try {
      await client.query(`SET LOCAL app.current_tenant_id = '${tenant.tenantId}'`);
      await expect(
        client.query(
          `UPDATE tenant_settings SET autonomous_booking_threshold = 1.00 WHERE tenant_id = $1`,
          [tenant.tenantId],
        ),
      ).rejects.toThrow();
    } finally {
      client.release();
    }
  });
});
