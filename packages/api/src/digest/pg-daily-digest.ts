/**
 * RV-060 — Postgres-backed DailyDigestRepository (migration 162).
 *
 * Tenant-scoped via PgBaseRepository (RLS GUC) with explicit tenant_id
 * predicates on every statement, per repo convention. `digest_date` is a
 * DATE column; we always read it back as text (`::text`) so node-pg never
 * coerces it into a local-midnight JS Date (which shifts across timezones).
 *
 * Idempotency lives in SQL:
 *   - `upsert`        → ON CONFLICT (tenant_id, digest_date) DO UPDATE
 *   - `insertIfAbsent`→ ON CONFLICT DO NOTHING (the worker's send guard)
 *   - `setSmsDispatchId` → UPDATE … WHERE sms_dispatch_id IS NULL
 */
import type { Pool } from 'pg';
import { PgBaseRepository } from '../db/pg-base';
import type {
  DailyDigestPayload,
  DailyDigestRecord,
  DailyDigestRepository,
} from './digest-service';

const COLUMNS =
  'id, tenant_id, digest_date::text AS digest_date, payload, narrative, sms_dispatch_id, generated_at';

function mapRow(row: Record<string, unknown>): DailyDigestRecord {
  return {
    id: row.id as string,
    tenantId: row.tenant_id as string,
    digestDate: row.digest_date as string,
    payload: row.payload as DailyDigestPayload,
    ...(row.narrative != null ? { narrative: row.narrative as string } : {}),
    ...(row.sms_dispatch_id != null ? { smsDispatchId: row.sms_dispatch_id as string } : {}),
    generatedAt: new Date(row.generated_at as string),
  };
}

export class PgDailyDigestRepository extends PgBaseRepository implements DailyDigestRepository {
  constructor(pool: Pool) {
    super(pool);
  }

  async upsert(
    tenantId: string,
    digestDate: string,
    payload: DailyDigestPayload,
    narrative?: string,
  ): Promise<DailyDigestRecord> {
    return this.withTenant(tenantId, async (client) => {
      const { rows } = await client.query(
        `INSERT INTO daily_digests (tenant_id, digest_date, payload, narrative)
         VALUES ($1, $2::date, $3::jsonb, $4)
         ON CONFLICT (tenant_id, digest_date)
         DO UPDATE SET payload = EXCLUDED.payload,
                       narrative = EXCLUDED.narrative,
                       generated_at = now()
         RETURNING ${COLUMNS}`,
        [tenantId, digestDate, JSON.stringify(payload), narrative ?? null],
      );
      return mapRow(rows[0]);
    });
  }

  async insertIfAbsent(
    tenantId: string,
    digestDate: string,
    payload: DailyDigestPayload,
    narrative?: string,
  ): Promise<{ digest: DailyDigestRecord; inserted: boolean }> {
    return this.withTenant(tenantId, async (client) => {
      const { rows } = await client.query(
        `INSERT INTO daily_digests (tenant_id, digest_date, payload, narrative)
         VALUES ($1, $2::date, $3::jsonb, $4)
         ON CONFLICT (tenant_id, digest_date) DO NOTHING
         RETURNING ${COLUMNS}`,
        [tenantId, digestDate, JSON.stringify(payload), narrative ?? null],
      );
      if (rows.length > 0) return { digest: mapRow(rows[0]), inserted: true };
      const { rows: existing } = await client.query(
        `SELECT ${COLUMNS} FROM daily_digests
         WHERE tenant_id = $1 AND digest_date = $2::date`,
        [tenantId, digestDate],
      );
      if (existing.length === 0) {
        // Should be unreachable: the conflicting row is visible to this
        // tenant context. Surface loudly rather than inventing a record.
        throw new Error(
          `daily_digests insertIfAbsent: conflict but no row for tenant ${tenantId} date ${digestDate}`,
        );
      }
      return { digest: mapRow(existing[0]), inserted: false };
    });
  }

  async findByTenantAndDate(tenantId: string, digestDate: string): Promise<DailyDigestRecord | null> {
    return this.withTenant(tenantId, async (client) => {
      const { rows } = await client.query(
        `SELECT ${COLUMNS} FROM daily_digests
         WHERE tenant_id = $1 AND digest_date = $2::date`,
        [tenantId, digestDate],
      );
      return rows.length > 0 ? mapRow(rows[0]) : null;
    });
  }

  async findLatest(tenantId: string): Promise<DailyDigestRecord | null> {
    return this.withTenant(tenantId, async (client) => {
      const { rows } = await client.query(
        `SELECT ${COLUMNS} FROM daily_digests
         WHERE tenant_id = $1
         ORDER BY digest_date DESC
         LIMIT 1`,
        [tenantId],
      );
      return rows.length > 0 ? mapRow(rows[0]) : null;
    });
  }

  async setSmsDispatchId(
    tenantId: string,
    digestDate: string,
    smsDispatchId: string,
  ): Promise<DailyDigestRecord | null> {
    return this.withTenant(tenantId, async (client) => {
      const { rows } = await client.query(
        `UPDATE daily_digests
         SET sms_dispatch_id = $3
         WHERE tenant_id = $1 AND digest_date = $2::date AND sms_dispatch_id IS NULL
         RETURNING ${COLUMNS}`,
        [tenantId, digestDate, smsDispatchId],
      );
      return rows.length > 0 ? mapRow(rows[0]) : null;
    });
  }
}
