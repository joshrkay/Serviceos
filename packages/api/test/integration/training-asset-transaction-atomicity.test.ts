import { describe, it, expect, beforeAll } from 'vitest';
import { Pool, PoolClient } from 'pg';
import { getSharedTestDb, createTestTenant } from './shared';
import { PgBaseRepository } from '../../src/db/pg-base';
import {
  PgPrivacyAuditRepository,
  PgTrainingAssetRepository,
} from '../../src/verticals/pg-training-assets';
import { PgAuditRepository } from '../../src/audit/pg-audit';
import { AuditEvent, AuditRepository } from '../../src/audit/audit';
import { TrainingAssetRedactionService } from '../../src/verticals/training-asset-redaction';
import { TrainingAssetService } from '../../src/verticals/training-asset-service';
import type { CreateTrainingAssetRequest } from '../../src/verticals/training-asset-service';

/**
 * WS5 — training-asset persistence atomicity against REAL Postgres.
 *
 * `TrainingAssetService.create` (pool wired) writes the asset row, the
 * privacy_audit row, and the normal audit_events row inside ONE tenant-scoped
 * transaction. This suite proves against a live DB:
 *
 *   1. Happy path: one asset + one privacy_audit + one audit row commit
 *      atomically — real columns pinned.
 *   2. Audit-insert failure: a DB-level failure in the audit write rolls back
 *      the WHOLE unit — NEITHER the asset NOR the privacy_audit row exists.
 *   3. Retry after a rolled-back failure does not duplicate rows or events
 *      (idempotency-key dedupe), and a second successful retry returns the
 *      original asset with no new rows.
 */

/**
 * An audit repository whose INSERT fails at the DATABASE level (NOT NULL /
 * RLS violation on tenant_id), on the ambient tenant-context client — so
 * inside the service's transaction the failure aborts the whole unit, exactly
 * like a real bad write. Mirrors the WS11 executor-audit-atomicity pattern.
 */
class DbFailingAuditRepository extends PgBaseRepository implements AuditRepository {
  async create(event: AuditEvent): Promise<AuditEvent> {
    return this.withTenant(event.tenantId, async (client) => {
      await client.query(
        `INSERT INTO audit_events (id, tenant_id, actor_id, actor_role, event_type, entity_type, entity_id)
         VALUES ($1, NULL, $2, $3, $4, $5, $6)`,
        [event.id, event.actorId, event.actorRole, event.eventType, event.entityType, event.entityId],
      );
      return event;
    });
  }
  async findByEntity(): Promise<AuditEvent[]> {
    return [];
  }
  async findByCorrelation(): Promise<AuditEvent[]> {
    return [];
  }
}

async function countScoped(
  pool: Pool,
  tenantId: string,
  sql: string,
  params: unknown[] = [],
): Promise<number> {
  const client: PoolClient = await pool.connect();
  try {
    await client.query("SELECT set_config('app.current_tenant_id', $1, false)", [tenantId]);
    const res = await client.query<{ n: number }>(sql, [tenantId, ...params]);
    return res.rows[0].n;
  } finally {
    await client.query('RESET app.current_tenant_id').catch(() => undefined);
    client.release();
  }
}

const countAssets = (pool: Pool, t: string) =>
  countScoped(pool, t, 'SELECT count(*)::int AS n FROM vertical_training_assets WHERE tenant_id = $1');
const countPrivacyAudit = (pool: Pool, t: string) =>
  countScoped(pool, t, 'SELECT count(*)::int AS n FROM privacy_audit WHERE tenant_id = $1');
const countCreatedAudit = (pool: Pool, t: string) =>
  countScoped(
    pool,
    t,
    `SELECT count(*)::int AS n FROM audit_events
     WHERE tenant_id = $1 AND event_type = 'vertical_training_asset.created'`,
  );

function baseRequest(tenantId: string, userId: string): CreateTrainingAssetRequest {
  return {
    tenantId,
    actorId: userId,
    idempotencyKey: `ws5-atomicity-${userId}`,
    input: {
      verticalType: 'hvac',
      assetKind: 'prompt_context',
      title: 'Atomicity case',
      rawText: 'Ask whether the water is shut off before dispatch.',
      labels: { intent: 'emergency_dispatch' },
      provenance: { source: 'tenant_admin', sourceVersion: '1' },
    },
  };
}

describe('TrainingAssetService — WS5 transactional persistence (real Postgres)', () => {
  let pool: Pool;

  function makeService(auditRepo: AuditRepository): TrainingAssetService {
    return new TrainingAssetService({
      assetRepo: new PgTrainingAssetRepository(pool),
      privacyAuditRepo: new PgPrivacyAuditRepository(pool),
      auditRepo,
      redaction: new TrainingAssetRedactionService(),
      pool,
    });
  }

  beforeAll(async () => {
    pool = await getSharedTestDb();
  });

  it('happy path: asset + privacy_audit + audit commit atomically', async () => {
    const tenant = await createTestTenant(pool);
    const service = makeService(new PgAuditRepository(pool));

    const saved = await service.create(baseRequest(tenant.tenantId, tenant.userId));

    expect(saved.status).toBe('redacted');
    expect(await countAssets(pool, tenant.tenantId)).toBe(1);
    expect(await countPrivacyAudit(pool, tenant.tenantId)).toBe(1);
    expect(await countCreatedAudit(pool, tenant.tenantId)).toBe(1);
  });

  it('audit-insert failure rolls back the WHOLE unit: no asset, no privacy_audit, no audit', async () => {
    const tenant = await createTestTenant(pool);
    const service = makeService(new DbFailingAuditRepository(pool));

    await expect(service.create(baseRequest(tenant.tenantId, tenant.userId))).rejects.toThrow(
      /null value|not-null|row-level security/i,
    );

    expect(await countAssets(pool, tenant.tenantId)).toBe(0);
    expect(await countPrivacyAudit(pool, tenant.tenantId)).toBe(0);
    expect(await countCreatedAudit(pool, tenant.tenantId)).toBe(0);
  });

  it('retry after a rolled-back failure creates exactly one row-set and dedupes on the idempotency key', async () => {
    const tenant = await createTestTenant(pool);

    // Attempt 1: audit write fails at the DB level → whole unit rolls back.
    const failing = makeService(new DbFailingAuditRepository(pool));
    await expect(failing.create(baseRequest(tenant.tenantId, tenant.userId))).rejects.toThrow();
    expect(await countAssets(pool, tenant.tenantId)).toBe(0);

    // Attempt 2: same request, working audit repo → succeeds exactly once.
    const working = makeService(new PgAuditRepository(pool));
    const first = await working.create(baseRequest(tenant.tenantId, tenant.userId));
    expect(await countAssets(pool, tenant.tenantId)).toBe(1);
    expect(await countPrivacyAudit(pool, tenant.tenantId)).toBe(1);
    expect(await countCreatedAudit(pool, tenant.tenantId)).toBe(1);

    // Attempt 3: replay with the same idempotency key → returns the original,
    // no new rows or events.
    const replay = await working.create(baseRequest(tenant.tenantId, tenant.userId));
    expect(replay.id).toBe(first.id);
    expect(await countAssets(pool, tenant.tenantId)).toBe(1);
    expect(await countPrivacyAudit(pool, tenant.tenantId)).toBe(1);
    expect(await countCreatedAudit(pool, tenant.tenantId)).toBe(1);
  });
});
