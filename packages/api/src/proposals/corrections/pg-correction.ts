/**
 * Story 3.9 — Postgres-backed `corrections` repository (migration 209).
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
import type { Correction, CorrectionRepeatWindow, CorrectionRepository } from './correction';

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
  // node-postgres already parses jsonb columns into JS values (objects, arrays,
  // strings, numbers, booleans, null) via its default type parser — the rest of
  // this codebase reads jsonb directly (e.g. mapConversationRow uses row.metadata
  // as an object). Return the value as-is; re-running JSON.parse on a primitive
  // jsonb string (e.g. "A" -> JS 'A') would throw "not valid JSON".
  return raw === undefined ? null : raw;
}

export class PgCorrectionRepository extends PgBaseRepository implements CorrectionRepository {
  constructor(pool: Pool) {
    super(pool);
  }

  async recordMany(corrections: Correction[]): Promise<Correction[]> {
    if (corrections.length === 0) return [];
    // All rows in a batch share the tenant (one edit, one proposal). Insert them
    // under that tenant's RLS context in a single round-trip. The batch is sent
    // as ONE jsonb param and expanded with jsonb_array_elements — node-postgres
    // serializes a JS array of JSON strings into a Postgres array literal that
    // cannot be cast to jsonb[] (malformed-literal / invalid-json), so jsonb[]
    // bind params are avoided. before/after ride as nested jsonb so any value
    // shape (incl. JSON null) round-trips losslessly.
    const tenantId = corrections[0].tenantId;
    const batch = corrections.map((c) => ({
      id: c.id,
      tenantId: c.tenantId,
      proposalId: c.proposalId,
      intent: c.intent,
      field: c.field,
      beforeValue: c.beforeValue ?? null,
      afterValue: c.afterValue ?? null,
      actorId: c.actorId,
      createdAt: c.createdAt,
    }));
    return this.withTenant(tenantId, async (client) => {
      const result = await client.query(
        `INSERT INTO corrections
           (id, tenant_id, proposal_id, intent, field, before_value, after_value, actor_id, created_at)
         SELECT
           (elem->>'id')::uuid,
           (elem->>'tenantId')::uuid,
           (elem->>'proposalId')::uuid,
           elem->>'intent',
           elem->>'field',
           elem->'beforeValue',
           elem->'afterValue',
           elem->>'actorId',
           (elem->>'createdAt')::timestamptz
         FROM jsonb_array_elements($1::jsonb) AS elem
         RETURNING *`,
        [JSON.stringify(batch)],
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

  /**
   * WS22 — "same mistake twice" weekly rate. Ranks EVERY tenant correction
   * (not just the window) chronologically within its (intent, field)
   * partition via ROW_NUMBER(); a row ranked > 1 has an earlier row in the
   * same partition (in-window or not) — that's a "repeat". The window only
   * bounds which rows get COUNTED, not which rows establish the ranking, so
   * a repeat of a mistake first made last month still counts correctly this
   * week. `id` breaks ties on identical `created_at` for determinism.
   */
  async countRepeatsInWindow(tenantId: string, from: Date, to: Date): Promise<CorrectionRepeatWindow> {
    return this.withTenant(tenantId, async (client) => {
      const result = await client.query<{ total: string; repeats: string }>(
        `WITH ranked AS (
           SELECT created_at,
                  ROW_NUMBER() OVER (PARTITION BY intent, field ORDER BY created_at ASC, id ASC) AS rn
             FROM corrections
            WHERE tenant_id = $1
         )
         SELECT
           COUNT(*) FILTER (WHERE created_at >= $2 AND created_at < $3)::int AS total,
           COUNT(*) FILTER (WHERE created_at >= $2 AND created_at < $3 AND rn > 1)::int AS repeats
         FROM ranked`,
        [tenantId, from, to],
      );
      const row = result.rows[0];
      return { total: Number(row?.total ?? 0), repeats: Number(row?.repeats ?? 0) };
    });
  }
}
