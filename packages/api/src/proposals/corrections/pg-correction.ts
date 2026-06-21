/**
 * Story 3.9 — Postgres-backed `corrections` repository (migration 204).
 *
 * Tenant-scoped via RLS (tenant_id + FORCE ROW LEVEL SECURITY). All
 * reads/writes go through `withTenant` so the `app.current_tenant_id` GUC
 * filters rows; tenant_id is ALSO the first predicate on every read
 * (defense-in-depth alongside RLS, matching the other repos here). A mocked
 * Pool is not proof the columns exist — the Docker-gated integration test
 * (test/integration/corrections.test.ts) pins the real schema.
 */
import { Pool } from 'pg';
import { PgBaseRepository } from '../../db/pg-base';
import type { Correction, CorrectionRepository } from './correction';

function mapRow(row: Record<string, unknown>): Correction {
  return {
    id: row.id as string,
    tenantId: row.tenant_id as string,
    proposalId: row.proposal_id as string,
    intent: row.intent as string,
    field: row.field as string,
    beforeValue: parseJsonb(row.before_value),
    afterValue: parseJsonb(row.after_value),
    actorId: row.actor_id as string,
    createdAt: new Date(row.created_at as string),
  };
}

function parseJsonb(raw: unknown): unknown {
  if (raw === null || raw === undefined) return null;
  return typeof raw === 'string' ? JSON.parse(raw) : raw;
}

export class PgCorrectionRepository extends PgBaseRepository implements CorrectionRepository {
  constructor(pool: Pool) {
    super(pool);
  }

  async recordMany(corrections: Correction[]): Promise<Correction[]> {
    if (corrections.length === 0) return [];
    // All rows in a batch share the tenant (one edit, one proposal). Insert them
    // under that tenant's RLS context in a single round-trip via UNNEST.
    const tenantId = corrections[0].tenantId;
    return this.withTenant(tenantId, async (client) => {
      const result = await client.query(
        `INSERT INTO corrections
           (id, tenant_id, proposal_id, intent, field, before_value, after_value, actor_id, created_at)
         SELECT * FROM UNNEST(
           $1::uuid[], $2::uuid[], $3::uuid[], $4::text[], $5::text[],
           $6::jsonb[], $7::jsonb[], $8::text[], $9::timestamptz[]
         )
         RETURNING *`,
        [
          corrections.map((c) => c.id),
          corrections.map((c) => c.tenantId),
          corrections.map((c) => c.proposalId),
          corrections.map((c) => c.intent),
          corrections.map((c) => c.field),
          corrections.map((c) => JSON.stringify(c.beforeValue ?? null)),
          corrections.map((c) => JSON.stringify(c.afterValue ?? null)),
          corrections.map((c) => c.actorId),
          corrections.map((c) => c.createdAt),
        ],
      );
      return result.rows.map(mapRow);
    });
  }

  async findByTenant(tenantId: string, limit = 100): Promise<Correction[]> {
    return this.withTenant(tenantId, async (client) => {
      const result = await client.query(
        `SELECT * FROM corrections
         WHERE tenant_id = $1
         ORDER BY created_at DESC
         LIMIT $2`,
        [tenantId, limit],
      );
      return result.rows.map(mapRow);
    });
  }

  async findByIntent(tenantId: string, intent: string, limit = 100): Promise<Correction[]> {
    return this.withTenant(tenantId, async (client) => {
      const result = await client.query(
        `SELECT * FROM corrections
         WHERE tenant_id = $1 AND intent = $2
         ORDER BY created_at DESC
         LIMIT $3`,
        [tenantId, intent, limit],
      );
      return result.rows.map(mapRow);
    });
  }

  async findByProposal(tenantId: string, proposalId: string): Promise<Correction[]> {
    return this.withTenant(tenantId, async (client) => {
      const result = await client.query(
        `SELECT * FROM corrections
         WHERE tenant_id = $1 AND proposal_id = $2
         ORDER BY created_at DESC`,
        [tenantId, proposalId],
      );
      return result.rows.map(mapRow);
    });
  }
}
