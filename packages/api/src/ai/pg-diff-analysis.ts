import { Pool } from 'pg';
import { PgBaseRepository } from '../db/pg-base';
import {
  DiffAnalysis,
  DiffAnalysisRepository,
  DiffEntry,
  DiffStatus,
} from './diff-analysis';

/**
 * Map a `diff_analyses` row to the DiffAnalysis domain type.
 *
 * `pg` decodes JSONB to JS values automatically, so `row.diff` is already a
 * parsed `DiffEntry[]` array — no JSON.parse needed.
 */
function mapRow(row: Record<string, unknown>): DiffAnalysis {
  return {
    id: row.id as string,
    tenantId: row.tenant_id as string,
    documentType: row.document_type as string,
    documentId: row.document_id as string,
    fromRevisionId: row.from_revision_id as string,
    toRevisionId: row.to_revision_id as string,
    diff: (row.diff as DiffEntry[] | null) ?? [],
    summary: (row.summary as string | null) ?? undefined,
    status: row.status as DiffStatus,
    errorMessage: (row.error_message as string | null) ?? undefined,
    createdAt: new Date(row.created_at as string),
  };
}

/**
 * Postgres-backed repository for diff analyses (P0-021).
 *
 * Append-only with one mutating operation: `updateStatus` advances a row
 * through the worker's state machine (pending -> processing ->
 * completed | failed) and may attach the computed diff/summary/error.
 *
 * The `id` column is TEXT — diff analyses use a deterministic id
 * (`diffAnalysisIdFor`) so re-enqueueing the same revision pair is
 * end-to-end idempotent. The InsertOnConflict path is intentionally NOT
 * used: callers (`enqueueDiffAnalysis`) check `findById` first, so the
 * insert path can assume "new row" semantics; if a duplicate id ever
 * reaches `create()` directly, a UNIQUE-violation error is the right
 * signal.
 *
 * Tenant isolation: RLS via `app.current_tenant_id` (set by `withTenant`)
 * + defense-in-depth `WHERE tenant_id = $N` in every query.
 */
export class PgDiffAnalysisRepository
  extends PgBaseRepository
  implements DiffAnalysisRepository
{
  constructor(pool: Pool) {
    super(pool);
  }

  async create(analysis: DiffAnalysis): Promise<DiffAnalysis> {
    return this.withTenant(analysis.tenantId, async (client) => {
      const result = await client.query(
        `INSERT INTO diff_analyses
           (id, tenant_id, document_type, document_id, from_revision_id,
            to_revision_id, diff, summary, status, error_message, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
         RETURNING *`,
        [
          analysis.id,
          analysis.tenantId,
          analysis.documentType,
          analysis.documentId,
          analysis.fromRevisionId,
          analysis.toRevisionId,
          JSON.stringify(analysis.diff ?? []),
          analysis.summary ?? null,
          analysis.status,
          analysis.errorMessage ?? null,
          analysis.createdAt,
        ]
      );
      return mapRow(result.rows[0]);
    });
  }

  async findById(tenantId: string, id: string): Promise<DiffAnalysis | null> {
    return this.withTenant(tenantId, async (client) => {
      const result = await client.query(
        `SELECT * FROM diff_analyses
         WHERE tenant_id = $1 AND id = $2
         LIMIT 1`,
        [tenantId, id]
      );
      if (result.rows.length === 0) return null;
      return mapRow(result.rows[0]);
    });
  }

  async findByDocument(
    tenantId: string,
    documentType: string,
    documentId: string
  ): Promise<DiffAnalysis[]> {
    return this.withTenant(tenantId, async (client) => {
      const result = await client.query(
        `SELECT * FROM diff_analyses
         WHERE tenant_id = $1 AND document_type = $2 AND document_id = $3
         ORDER BY created_at DESC`,
        [tenantId, documentType, documentId]
      );
      return result.rows.map(mapRow);
    });
  }

  async updateStatus(
    tenantId: string,
    id: string,
    status: DiffStatus,
    result?: { diff?: DiffEntry[]; summary?: string; error?: string }
  ): Promise<DiffAnalysis | null> {
    return this.withTenant(tenantId, async (client) => {
      // Build dynamic SET clause so we only overwrite fields the caller
      // supplied — mirrors the InMemory behaviour where unset result
      // properties leave the existing column untouched.
      const sets: string[] = ['status = $3'];
      const params: unknown[] = [tenantId, id, status];
      if (result?.diff !== undefined) {
        sets.push(`diff = $${params.length + 1}::jsonb`);
        params.push(JSON.stringify(result.diff));
      }
      if (result?.summary !== undefined) {
        sets.push(`summary = $${params.length + 1}`);
        params.push(result.summary);
      }
      if (result?.error !== undefined) {
        sets.push(`error_message = $${params.length + 1}`);
        params.push(result.error);
      }

      const updateResult = await client.query(
        `UPDATE diff_analyses
         SET ${sets.join(', ')}
         WHERE tenant_id = $1 AND id = $2
         RETURNING *`,
        params
      );
      if (updateResult.rows.length === 0) return null;
      return mapRow(updateResult.rows[0]);
    });
  }
}
