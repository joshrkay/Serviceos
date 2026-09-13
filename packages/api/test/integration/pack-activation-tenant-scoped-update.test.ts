/**
 * Docker-gated integration test — NOT run in web sessions. Requires the
 * testcontainer Postgres started by `npm run test:integration`.
 *
 * #1095 — `PgPackActivationRepository.update` ran
 * `UPDATE pack_activations … WHERE id = $N` under `withClient`: no tenant
 * predicate and no `app.current_tenant_id` GUC, so neither SQL nor RLS
 * scoped the write. Both callers happen to source the id from a
 * tenant-scoped read today, but the repository itself accepted any id from
 * any tenant — the class #1092 closed.
 *
 * These tests exercise the repository at real Postgres (a mocked Pool cannot
 * prove a predicate or a GUC), plus the two domain callers end to end with
 * their audit legs read back through PgAuditRepository.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Pool } from 'pg';
import { getSharedTestDb, createTestTenant, closeSharedTestDb } from './shared';
import { PgPackActivationRepository } from '../../src/settings/pg-pack-activation';
import { PgAuditRepository } from '../../src/audit/pg-audit';
import { activatePack, deactivatePack } from '../../src/settings/pack-activation';

describe('Postgres integration — pack_activations updates are tenant-scoped (#1095)', () => {
  let pool: Pool;
  let tenantA: { tenantId: string; userId: string };
  let tenantB: { tenantId: string; userId: string };

  beforeAll(async () => {
    pool = await getSharedTestDb();
  });
  afterAll(async () => {
    await closeSharedTestDb();
  });
  beforeEach(async () => {
    tenantA = await createTestTenant(pool);
    tenantB = await createTestTenant(pool);
  });

  async function readRow(id: string) {
    const res = await pool.query(
      `SELECT tenant_id, pack_id, status, deactivated_at FROM pack_activations WHERE id = $1`,
      [id],
    );
    return res.rows[0];
  }

  it('tenant A cannot update tenant B\'s activation row, and B still can', async () => {
    const repo = new PgPackActivationRepository(pool);
    const bRow = await activatePack({ tenantId: tenantB.tenantId, packId: 'hvac' }, repo);

    // Cross-tenant: the id is valid, the tenant is not. Nothing changes and
    // the repository reports "no such row for this tenant".
    const crossTenant = await repo.update(tenantA.tenantId, bRow.id, {
      status: 'deactivated',
      deactivatedAt: new Date('2026-01-01T00:00:00Z'),
    });
    expect(crossTenant).toBeNull();

    const afterCrossTenant = await readRow(bRow.id);
    expect(afterCrossTenant.tenant_id).toBe(tenantB.tenantId);
    expect(afterCrossTenant.status).toBe('active');
    expect(afterCrossTenant.deactivated_at).toBeNull();

    // In-tenant: the same write, under the owning tenant, applies.
    const inTenant = await repo.update(tenantB.tenantId, bRow.id, {
      status: 'deactivated',
      deactivatedAt: new Date('2026-02-02T00:00:00Z'),
    });
    expect(inTenant).not.toBeNull();
    expect(inTenant!.status).toBe('deactivated');
    expect(inTenant!.tenantId).toBe(tenantB.tenantId);

    const afterInTenant = await readRow(bRow.id);
    expect(afterInTenant.status).toBe('deactivated');
    expect(afterInTenant.deactivated_at).not.toBeNull();
  });

  it('an empty update under the wrong tenant returns null rather than reading the row back', async () => {
    const repo = new PgPackActivationRepository(pool);
    const bRow = await activatePack({ tenantId: tenantB.tenantId, packId: 'plumbing' }, repo);

    // The no-set-clauses branch is a read-back; it must be tenant-scoped too,
    // or it leaks another tenant's row through the return value.
    const leaked = await repo.update(tenantA.tenantId, bRow.id, {});
    expect(leaked).toBeNull();

    const own = await repo.update(tenantB.tenantId, bRow.id, {});
    expect(own).not.toBeNull();
    expect(own!.id).toBe(bRow.id);
  });

  it('deactivatePack and the reactivation path still work in-tenant, with their audit rows', async () => {
    const repo = new PgPackActivationRepository(pool);
    const auditRepo = new PgAuditRepository(pool);
    const auditCtx = { actorId: tenantB.userId, actorRole: 'owner' };

    const created = await activatePack(
      { tenantId: tenantB.tenantId, packId: 'electrical' },
      repo,
      auditRepo,
      auditCtx,
    );

    const deactivated = await deactivatePack(
      tenantB.tenantId,
      'electrical',
      repo,
      auditRepo,
      auditCtx,
    );
    expect(deactivated).not.toBeNull();
    expect(deactivated!.status).toBe('deactivated');
    expect((await readRow(created.id)).status).toBe('deactivated');

    // Reactivation goes through the same `update` (the `existing.status ===
    // 'deactivated'` branch of activatePack).
    const reactivated = await activatePack(
      { tenantId: tenantB.tenantId, packId: 'electrical' },
      repo,
      auditRepo,
      auditCtx,
    );
    expect(reactivated.id).toBe(created.id);
    expect(reactivated.status).toBe('active');
    const afterReactivate = await readRow(created.id);
    expect(afterReactivate.status).toBe('active');
    expect(afterReactivate.deactivated_at).toBeNull();

    // Audit leg, read back through the tenant-scoped repository: activate,
    // deactivate, reactivate — three events on this activation row.
    const events = await auditRepo.findByEntity(tenantB.tenantId, 'pack_activation', created.id);
    const types = events.map((e) => e.eventType).sort();
    expect(types).toEqual([
      'pack_activation.activated',
      'pack_activation.activated',
      'pack_activation.deactivated',
    ]);
    expect(events.every((e) => e.tenantId === tenantB.tenantId)).toBe(true);

    // And none of it is visible under tenant A.
    const leakedEvents = await auditRepo.findByEntity(
      tenantA.tenantId,
      'pack_activation',
      created.id,
    );
    expect(leakedEvents).toEqual([]);
  });
});
