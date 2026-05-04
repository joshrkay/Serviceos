import { Pool } from 'pg';
import { PgBaseRepository } from '../db/pg-base';
import {
  DocumentRevision,
  DocumentRevisionRepository,
  DocumentType,
} from './document-revision';

/**
 * Map a `document_revisions` row to the DocumentRevision domain type.
 * `pg` returns JSONB columns as already-parsed JS values — no JSON.parse needed.
 */
function mapRow(row: Record<string, unknown>): DocumentRevision {
  return {
    id: row.id as string,
    tenantId: row.tenant_id as string,
    documentType: row.document_type as DocumentType,
    documentId: row.document_id as string,
    version: Number(row.version),
    snapshot: row.snapshot as Record<string, unknown>,
    source: row.source as DocumentRevision['source'],
    actorId: row.actor_id as string,
    actorRole: row.actor_role as string,
    aiRunId: (row.ai_run_id as string | null) ?? undefined,
    metadata: (row.metadata as Record<string, unknown> | null) ?? undefined,
    createdAt: new Date(row.created_at as string),
  };
}

/**
 * Postgres-backed repository for AI document revisions (P0-021).
 *
 * Append-only by design: only `create`, `findById`, `findByDocument`, and
 * `getNextVersion` are exposed. There is no update or delete — revisions
 * form an immutable audit trail of the snapshots that produced each
 * downstream document state.
 *
 * Tenant isolation is enforced two ways:
 *   1. RLS via `app.current_tenant_id` (set by `withTenant`).
 *   2. Defense-in-depth `WHERE tenant_id = $N` in every query.
 */
export class PgDocumentRevisionRepository
  extends PgBaseRepository
  implements DocumentRevisionRepository
{
  constructor(pool: Pool) {
    super(pool);
  }

  async create(revision: DocumentRevision): Promise<DocumentRevision> {
    return this.withTenant(revision.tenantId, async (client) => {
      const result = await client.query(
        `INSERT INTO document_revisions
           (id, tenant_id, document_type, document_id, version, snapshot,
            source, actor_id, actor_role, ai_run_id, metadata, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
         RETURNING *`,
        [
          revision.id,
          revision.tenantId,
          revision.documentType,
          revision.documentId,
          revision.version,
          JSON.stringify(revision.snapshot),
          revision.source,
          revision.actorId,
          revision.actorRole,
          revision.aiRunId ?? null,
          revision.metadata ? JSON.stringify(revision.metadata) : null,
          revision.createdAt,
        ]
      );
      return mapRow(result.rows[0]);
    });
  }

  async findById(tenantId: string, id: string): Promise<DocumentRevision | null> {
    return this.withTenant(tenantId, async (client) => {
      const result = await client.query(
        `SELECT * FROM document_revisions
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
    documentType: DocumentType,
    documentId: string
  ): Promise<DocumentRevision[]> {
    return this.withTenant(tenantId, async (client) => {
      const result = await client.query(
        `SELECT * FROM document_revisions
         WHERE tenant_id = $1 AND document_type = $2 AND document_id = $3
         ORDER BY version DESC`,
        [tenantId, documentType, documentId]
      );
      return result.rows.map(mapRow);
    });
  }

  async getNextVersion(
    tenantId: string,
    documentType: DocumentType,
    documentId: string
  ): Promise<number> {
    return this.withTenant(tenantId, async (client) => {
      const result = await client.query(
        `SELECT COALESCE(MAX(version), 0) AS max_version
         FROM document_revisions
         WHERE tenant_id = $1 AND document_type = $2 AND document_id = $3`,
        [tenantId, documentType, documentId]
      );
      const max = Number(result.rows[0]?.max_version ?? 0);
      return max + 1;
    });
  }
}
