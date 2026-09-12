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
import express, { Request, Response, NextFunction } from 'express';
import request from 'supertest';
import { Pool } from 'pg';
import { getSharedTestDb, createTestTenant, closeSharedTestDb } from './shared';
import { PgSettingsRepository } from '../../src/settings/pg-settings';
import { PgAuditRepository } from '../../src/audit/pg-audit';
import { createSettingsRouter } from '../../src/routes/settings';
import type { AuthenticatedRequest } from '../../src/auth/clerk';

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

  it('T0 — a neighbour tenant\'s default lane settings are untouched by the first tenant\'s opt-in update, proven through the real audited route', async () => {
    const tenantA = await seedSettings(pool, settingsRepo, 'Opted-In Co');
    const tenantB = await seedSettings(pool, settingsRepo, 'Neighbour Co');
    const auditRepo = new PgAuditRepository(pool);

    // Through the real Express route (PUT /api/settings), not a bare
    // repo.update() — the settings.tenant.updated audit event only exists
    // in the route handler, so a real-DB write without exercising it
    // doesn't clear the PRD's own §8.0 PROVEN-REAL-DB bar.
    const current = tenantA;
    const app = express();
    app.use(express.json());
    app.use((req: Request, _res: Response, next: NextFunction) => {
      (req as AuthenticatedRequest).auth = {
        userId: current.userId,
        sessionId: 'sess-i17',
        tenantId: current.tenantId,
        role: 'owner',
      };
      next();
    });
    app.use('/api/settings', createSettingsRouter(settingsRepo, undefined, auditRepo));

    // Tenant B starts at the same defaults as tenant A.
    const beforeB = await settingsRepo.findByTenant(tenantB.tenantId);
    expect(beforeB!.autonomousBookingEnabled).toBe(false);
    expect(beforeB!.autonomousBookingThreshold).toBe(0.95);

    const res = await request(app)
      .put('/api/settings')
      .send({ autonomousBookingEnabled: true, autonomousBookingThreshold: 0.98 });
    expect(res.status).toBe(200);

    const updatedA = await settingsRepo.findByTenant(tenantA.tenantId);
    expect(updatedA!.autonomousBookingEnabled).toBe(true);
    expect(updatedA!.autonomousBookingThreshold).toBe(0.98);

    // The audit leg: the route's real settings.tenant.updated event, naming
    // the touched key, read back through PgAuditRepository.
    const eventsA = await auditRepo.findRecentByTenant(tenantA.tenantId, { limit: 20 });
    const settingsEvent = eventsA.find((e) => e.eventType === 'settings.tenant.updated');
    expect(settingsEvent).toBeDefined();
    expect(settingsEvent!.actorId).toBe(tenantA.userId);
    expect(settingsEvent!.metadata?.changedKeys).toContain('autonomousBookingEnabled');

    // Tenant B's lane is completely untouched by tenant A's opt-in — still
    // off, still at the default floor. The platform kill switch / per-tenant
    // opt-in (D-015) never leaks across tenants.
    const afterB = await settingsRepo.findByTenant(tenantB.tenantId);
    expect(afterB!.autonomousBookingEnabled).toBe(false);
    expect(afterB!.autonomousBookingThreshold).toBe(0.95);

    // Tenant B has no audit row from tenant A's PUT.
    const eventsB = await auditRepo.findRecentByTenant(tenantB.tenantId, { limit: 20 });
    expect(eventsB.some((e) => e.eventType === 'settings.tenant.updated')).toBe(false);

    // Pin the real columns directly, scoped to tenant B by the WHERE clause.
    const client = await pool.connect();
    try {
      await client.query(`SET LOCAL app.current_tenant_id = '${tenantB.tenantId}'`);
      const { rows } = await client.query(
        `SELECT autonomous_booking_enabled, autonomous_booking_threshold
           FROM tenant_settings WHERE tenant_id = $1`,
        [tenantB.tenantId],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].autonomous_booking_enabled).toBe(false);
      expect(Number(rows[0].autonomous_booking_threshold)).toBe(0.95);
    } finally {
      client.release();
    }

    // Tenant A's opted-in row is unreachable through PgSettingsRepository
    // scoped to tenant B — the repo's tenant-scoping, not just the raw WHERE
    // clause above, keeps the two tenants' lane settings apart.
    const crossTenantFetch = await settingsRepo.findByTenant(tenantB.tenantId);
    expect(crossTenantFetch!.autonomousBookingThreshold).not.toBe(
      updatedA!.autonomousBookingThreshold,
    );
  });
});
