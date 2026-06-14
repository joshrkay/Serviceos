/**
 * P2-036 V2 (Discount-policy engine — U1: data plane) — Postgres integration.
 *
 * Pins the migration-178 columns against a REAL database (the entity
 * resolver shipped with nonexistent column names because its Pool was
 * mocked; CLAUDE.md requires DB-touching changes to prove the columns
 * exist with an integration test):
 *   - discount_max_bps / discount_floor_cents / discount_never_below_catalog
 *     round-trip through PgSettingsRepository.update + findByTenant.
 *   - The DB CHECK rejects discount_max_bps > 10000 (raw INSERT/UPDATE,
 *     bypassing the app-layer validation so the constraint itself is proven).
 *
 * Docker-gated: requires a Postgres test DB (getSharedTestDb). Runs in PR CI.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { getSharedTestDb, createTestTenant, closeSharedTestDb } from './shared';
import { PgSettingsRepository } from '../../src/settings/pg-settings';

describe('Postgres integration — discount policy (P2-036 V2 U1)', () => {
  let pool: Pool;
  let settingsRepo: PgSettingsRepository;

  beforeAll(async () => {
    pool = await getSharedTestDb();
    settingsRepo = new PgSettingsRepository(pool);
  });

  afterAll(async () => {
    await closeSharedTestDb();
  });

  it('round-trips the discount columns through the repo', async () => {
    const tenant = await createTestTenant(pool);
    const now = new Date();
    await settingsRepo.create({
      id: crypto.randomUUID(),
      tenantId: tenant.tenantId,
      businessName: 'Discount Co',
      timezone: 'America/New_York',
      estimatePrefix: 'EST',
      invoicePrefix: 'INV',
      nextEstimateNumber: 1,
      nextInvoiceNumber: 1,
      defaultPaymentTermDays: 30,
      createdAt: now,
      updatedAt: now,
    });

    const updated = await settingsRepo.update(tenant.tenantId, {
      discountMaxBps: 1500,
      discountFloorCents: 5000,
      discountNeverBelowCatalog: false,
    });
    expect(updated).not.toBeNull();
    expect(updated!.discountMaxBps).toBe(1500);
    expect(updated!.discountFloorCents).toBe(5000);
    expect(updated!.discountNeverBelowCatalog).toBe(false);

    const found = await settingsRepo.findByTenant(tenant.tenantId);
    expect(found!.discountMaxBps).toBe(1500);
    expect(found!.discountFloorCents).toBe(5000);
    expect(found!.discountNeverBelowCatalog).toBe(false);
  });

  it('defaults the discount columns to undefined for a fresh row (pre-config shape)', async () => {
    const tenant = await createTestTenant(pool);
    const now = new Date();
    await settingsRepo.create({
      id: crypto.randomUUID(),
      tenantId: tenant.tenantId,
      businessName: 'Unconfigured Co',
      timezone: 'America/New_York',
      estimatePrefix: 'EST',
      invoicePrefix: 'INV',
      nextEstimateNumber: 1,
      nextInvoiceNumber: 1,
      defaultPaymentTermDays: 30,
      createdAt: now,
      updatedAt: now,
    });

    const found = await settingsRepo.findByTenant(tenant.tenantId);
    expect(found!.discountMaxBps).toBeUndefined();
    expect(found!.discountFloorCents).toBeUndefined();
    expect(found!.discountNeverBelowCatalog).toBeUndefined();
  });

  it('allows clearing a discount column back to NULL', async () => {
    const tenant = await createTestTenant(pool);
    const now = new Date();
    await settingsRepo.create({
      id: crypto.randomUUID(),
      tenantId: tenant.tenantId,
      businessName: 'Clearable Co',
      timezone: 'America/New_York',
      estimatePrefix: 'EST',
      invoicePrefix: 'INV',
      nextEstimateNumber: 1,
      nextInvoiceNumber: 1,
      defaultPaymentTermDays: 30,
      createdAt: now,
      updatedAt: now,
    });

    await settingsRepo.update(tenant.tenantId, { discountMaxBps: 1000 });
    const cleared = await settingsRepo.update(tenant.tenantId, {
      discountMaxBps: null,
    });
    expect(cleared!.discountMaxBps).toBeUndefined();
  });

  it('DB CHECK rejects discount_max_bps > 10000 (raw UPDATE, app validation bypassed)', async () => {
    const tenant = await createTestTenant(pool);
    const now = new Date();
    await settingsRepo.create({
      id: crypto.randomUUID(),
      tenantId: tenant.tenantId,
      businessName: 'Over Cap Co',
      timezone: 'America/New_York',
      estimatePrefix: 'EST',
      invoicePrefix: 'INV',
      nextEstimateNumber: 1,
      nextInvoiceNumber: 1,
      defaultPaymentTermDays: 30,
      createdAt: now,
      updatedAt: now,
    });

    // Write directly with tenant RLS context set, mirroring the repo's
    // withTenant() so RLS does not mask the CHECK we are trying to prove.
    const client = await pool.connect();
    try {
      await client.query(`SET LOCAL app.current_tenant_id = '${tenant.tenantId}'`);
      await expect(
        client.query(
          `UPDATE tenant_settings SET discount_max_bps = 10001 WHERE tenant_id = $1`,
          [tenant.tenantId],
        ),
      ).rejects.toThrow();
    } finally {
      client.release();
    }
  });

  it('DB CHECK rejects a negative discount_floor_cents (raw UPDATE)', async () => {
    const tenant = await createTestTenant(pool);
    const now = new Date();
    await settingsRepo.create({
      id: crypto.randomUUID(),
      tenantId: tenant.tenantId,
      businessName: 'Negative Floor Co',
      timezone: 'America/New_York',
      estimatePrefix: 'EST',
      invoicePrefix: 'INV',
      nextEstimateNumber: 1,
      nextInvoiceNumber: 1,
      defaultPaymentTermDays: 30,
      createdAt: now,
      updatedAt: now,
    });

    const client = await pool.connect();
    try {
      await client.query(`SET LOCAL app.current_tenant_id = '${tenant.tenantId}'`);
      await expect(
        client.query(
          `UPDATE tenant_settings SET discount_floor_cents = -1 WHERE tenant_id = $1`,
          [tenant.tenantId],
        ),
      ).rejects.toThrow();
    } finally {
      client.release();
    }
  });
});
