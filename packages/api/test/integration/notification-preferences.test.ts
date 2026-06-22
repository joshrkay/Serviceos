/**
 * Postgres integration — notification_preferences (U10).
 *
 * Pins the real columns, the upsert, default-on semantics, and cross-tenant
 * RLS isolation against real Postgres (the unit tests use the in-memory repo,
 * which can't prove the SQL or RLS).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { getSharedTestDb, createTestTenant, closeSharedTestDb, type TestTenant } from './shared';
import { PgNotificationPreferenceRepository } from '../../src/notifications/pg-notification-preferences-repository';

describe('Postgres integration — notification_preferences', () => {
  let pool: Pool;
  let repo: PgNotificationPreferenceRepository;
  let tenant: TestTenant;
  let other: TestTenant;

  beforeAll(async () => {
    pool = await getSharedTestDb();
    repo = new PgNotificationPreferenceRepository(pool);
    tenant = await createTestTenant(pool);
    other = await createTestTenant(pool);
  });

  afterAll(async () => {
    await closeSharedTestDb();
  });

  it('defaults to enabled (no rows) and upserts a toggle', async () => {
    expect(await repo.listByUser(tenant.tenantId, 'u1')).toEqual([]);
    expect((await repo.listMutedUserIds(tenant.tenantId, 'payment_received')).size).toBe(0);

    await repo.set(tenant.tenantId, 'u1', 'payment_received', false);
    let muted = await repo.listMutedUserIds(tenant.tenantId, 'payment_received');
    expect(muted.has('u1')).toBe(true);

    // Upsert (not duplicate insert) on the unique (tenant,user,type).
    await repo.set(tenant.tenantId, 'u1', 'payment_received', true);
    muted = await repo.listMutedUserIds(tenant.tenantId, 'payment_received');
    expect(muted.has('u1')).toBe(false);
    const rows = await repo.listByUser(tenant.tenantId, 'u1');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ notificationType: 'payment_received', enabled: true });
  });

  it('isolates preferences across tenants (FORCE RLS)', async () => {
    await repo.set(tenant.tenantId, 'shared-user', 'emergency', false);
    // Same user id, different tenant — must not see the other tenant's row.
    expect(await repo.listByUser(other.tenantId, 'shared-user')).toEqual([]);
    expect((await repo.listMutedUserIds(other.tenantId, 'emergency')).size).toBe(0);
  });
});
