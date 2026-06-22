import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { getSharedTestDb, createTestTenant, closeSharedTestDb } from './shared';
import { PgNotificationPreferenceRepository } from '../../src/notifications/pg-notification-preferences-repository';
import { effectivePreferences } from '../../src/notifications/notification-preferences-service';

describe('Postgres integration — notification preferences (U10)', () => {
  let pool: Pool;
  let repo: PgNotificationPreferenceRepository;
  let tenant: { tenantId: string; userId: string };
  let other: { tenantId: string; userId: string };

  beforeAll(async () => {
    pool = await getSharedTestDb();
    repo = new PgNotificationPreferenceRepository(pool);
    tenant = await createTestTenant(pool);
    other = await createTestTenant(pool);
  });

  afterAll(async () => {
    await closeSharedTestDb();
  });

  it('no rows → effective preferences default every type to enabled (real columns)', async () => {
    const prefs = await effectivePreferences(repo, tenant.tenantId, tenant.userId);
    expect(prefs.incoming_call).toBe(true);
    expect(prefs.payment_received).toBe(true);
  });

  it('setEnabled persists a real row and listForUser reads it back', async () => {
    await repo.setEnabled(tenant.tenantId, tenant.userId, 'inbound_sms', false);
    const rows = await repo.listForUser(tenant.tenantId, tenant.userId);
    const row = rows.find((r) => r.notificationType === 'inbound_sms');
    expect(row).toBeDefined();
    expect(row!.enabled).toBe(false);
    expect(row!.tenantId).toBe(tenant.tenantId);
    expect(row!.userId).toBe(tenant.userId);
  });

  it('upserts on (tenant, user, type) — toggling updates, never duplicates', async () => {
    await repo.setEnabled(tenant.tenantId, tenant.userId, 'inbound_sms', false);
    await repo.setEnabled(tenant.tenantId, tenant.userId, 'inbound_sms', true);
    const rows = await repo.listForUser(tenant.tenantId, tenant.userId);
    expect(rows.filter((r) => r.notificationType === 'inbound_sms')).toHaveLength(1);
    expect(rows.find((r) => r.notificationType === 'inbound_sms')!.enabled).toBe(true);
  });

  it('listMutedUserIds returns only users who muted the type', async () => {
    await repo.setEnabled(tenant.tenantId, 'owner-x', 'payment_received', false);
    await repo.setEnabled(tenant.tenantId, 'owner-y', 'payment_received', true);
    const muted = await repo.listMutedUserIds(tenant.tenantId, 'payment_received');
    expect(muted.has('owner-x')).toBe(true);
    expect(muted.has('owner-y')).toBe(false);
  });

  it('RLS isolates preferences across tenants', async () => {
    await repo.setEnabled(tenant.tenantId, 'shared-user', 'emergency', false);
    // The other tenant must not see tenant's rows (own current_tenant_id).
    const theirs = await repo.listMutedUserIds(other.tenantId, 'emergency');
    expect(theirs.has('shared-user')).toBe(false);
    const theirRows = await repo.listForUser(other.tenantId, 'shared-user');
    expect(theirRows).toHaveLength(0);
  });
});
