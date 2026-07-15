import crypto from 'crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { closeSharedTestDb, createTestTenant, getSharedTestDb } from './shared';
import { PgTechnicianLocationPingRepository } from '../../src/telemetry/pg-technician-location-ping';
import { createTechnicianLocationPing } from '../../src/telemetry/technician-location-ping';

describe('Postgres integration — technician location ping idempotency', () => {
  let pool: Pool;
  let repo: PgTechnicianLocationPingRepository;

  beforeAll(async () => {
    pool = await getSharedTestDb();
    repo = new PgTechnicianLocationPingRepository(pool);
  });

  afterAll(async () => {
    await closeSharedTestDb();
  });

  it('deduplicates a retried batch by tenant and client ping id', async () => {
    const tenant = await createTestTenant(pool);
    const recordedAt = new Date();
    const batch = [
      createTechnicianLocationPing({
        tenantId: tenant.tenantId,
        technicianId: tenant.userId,
        clientPingId: crypto.randomUUID(),
        lat: 37.7,
        lng: -122.4,
        recordedAt,
        source: 'gps',
      }),
      createTechnicianLocationPing({
        tenantId: tenant.tenantId,
        technicianId: tenant.userId,
        clientPingId: crypto.randomUUID(),
        lat: 37.8,
        lng: -122.5,
        recordedAt: new Date(recordedAt.getTime() + 1_000),
        source: 'gps',
      }),
    ];

    await expect(repo.insertMany(tenant.tenantId, batch)).resolves.toHaveLength(2);
    await expect(repo.insertMany(tenant.tenantId, batch)).resolves.toHaveLength(0);
    await expect(
      repo.listByTechnician(tenant.tenantId, tenant.userId),
    ).resolves.toHaveLength(2);
  });

  it('allows the same client ping id in separate tenants without leaking rows', async () => {
    const tenantA = await createTestTenant(pool);
    const tenantB = await createTestTenant(pool);
    const clientPingId = crypto.randomUUID();
    const makePing = (tenantId: string, technicianId: string) =>
      createTechnicianLocationPing({
        tenantId,
        technicianId,
        clientPingId,
        lat: 37.7,
        lng: -122.4,
        recordedAt: new Date(),
        source: 'gps',
      });

    await expect(
      repo.insertMany(tenantA.tenantId, [makePing(tenantA.tenantId, tenantA.userId)]),
    ).resolves.toHaveLength(1);
    await expect(
      repo.insertMany(tenantB.tenantId, [makePing(tenantB.tenantId, tenantB.userId)]),
    ).resolves.toHaveLength(1);

    const rowsA = await repo.listByTechnician(tenantA.tenantId, tenantA.userId);
    const rowsB = await repo.listByTechnician(tenantB.tenantId, tenantB.userId);
    expect(rowsA).toHaveLength(1);
    expect(rowsB).toHaveLength(1);
    expect(rowsA[0].tenantId).toBe(tenantA.tenantId);
    expect(rowsB[0].tenantId).toBe(tenantB.tenantId);
  });
});
