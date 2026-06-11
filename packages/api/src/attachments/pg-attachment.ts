/**
 * RV-005 — Postgres-backed attachments repository.
 *
 * Mirrors pg-job-photo.ts: every query runs inside withTenant (RLS) AND
 * carries an explicit `tenant_id = $n` predicate — belt-and-braces, house
 * style.
 */
import { Pool } from 'pg';
import { PgBaseRepository } from '../db/pg-base';
import {
  Attachment,
  AttachmentCategory,
  AttachmentEntityType,
  AttachmentKind,
  AttachmentPairRole,
  AttachmentRepository,
  AttachmentSource,
  CreateAttachmentInput,
  ListByEntityOptions,
  buildAttachment,
} from './attachment';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function mapRow(row: Record<string, unknown>): Attachment {
  return {
    id: row.id as string,
    tenantId: row.tenant_id as string,
    fileId: row.file_id as string,
    entityType: row.entity_type as AttachmentEntityType,
    entityId: row.entity_id as string,
    kind: row.kind as AttachmentKind,
    caption: (row.caption as string | null) ?? undefined,
    category: (row.category as AttachmentCategory | null) ?? undefined,
    pairGroupId: (row.pair_group_id as string | null) ?? undefined,
    pairRole: (row.pair_role as AttachmentPairRole | null) ?? undefined,
    portalVisible: row.portal_visible as boolean,
    annotatedFileId: (row.annotated_file_id as string | null) ?? undefined,
    uploadedBy: (row.uploaded_by as string | null) ?? undefined,
    source: row.source as AttachmentSource,
    sortOrder: Number(row.sort_order),
    archivedAt: row.archived_at ? new Date(row.archived_at as string) : undefined,
    createdAt: new Date(row.created_at as string),
    updatedAt: new Date(row.updated_at as string),
  };
}

export class PgAttachmentRepository extends PgBaseRepository implements AttachmentRepository {
  constructor(pool: Pool) {
    super(pool);
  }

  async create(tenantId: string, input: CreateAttachmentInput): Promise<Attachment> {
    const attachment = buildAttachment(tenantId, input);
    // attachments.uploaded_by is a UUID column, but auth user ids come from
    // Clerk (`payload.sub`, e.g. "user_2ab…") and are NOT UUIDs. Persist the
    // uploader only when it is UUID-shaped; otherwise store NULL rather than
    // failing the insert. The full id is still in the audit trail
    // (attachment.uploaded carries actorId).
    const uploadedByForDb =
      attachment.uploadedBy && UUID_REGEX.test(attachment.uploadedBy)
        ? attachment.uploadedBy
        : null;
    return this.withTenant(tenantId, async (client) => {
      const result = await client.query(
        `INSERT INTO attachments (
           id, tenant_id, file_id, entity_type, entity_id, kind, caption,
           category, uploaded_by, source, sort_order, created_at, updated_at
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
         RETURNING *`,
        [
          attachment.id,
          tenantId,
          attachment.fileId,
          attachment.entityType,
          attachment.entityId,
          attachment.kind,
          attachment.caption ?? null,
          attachment.category ?? null,
          uploadedByForDb,
          attachment.source,
          attachment.sortOrder,
          attachment.createdAt,
          attachment.updatedAt,
        ]
      );
      return mapRow(result.rows[0]);
    });
  }

  async findById(tenantId: string, id: string): Promise<Attachment | null> {
    return this.withTenant(tenantId, async (client) => {
      const result = await client.query(
        `SELECT * FROM attachments WHERE tenant_id = $1 AND id = $2`,
        [tenantId, id]
      );
      if (result.rows.length === 0) return null;
      return mapRow(result.rows[0]);
    });
  }

  async listByEntity(
    tenantId: string,
    entityType: AttachmentEntityType,
    entityId: string,
    options?: ListByEntityOptions
  ): Promise<Attachment[]> {
    const archivedFilter = options?.includeArchived ? '' : 'AND archived_at IS NULL';
    return this.withTenant(tenantId, async (client) => {
      const result = await client.query(
        `SELECT * FROM attachments
         WHERE tenant_id = $1 AND entity_type = $2 AND entity_id = $3
         ${archivedFilter}
         ORDER BY sort_order ASC, created_at ASC`,
        [tenantId, entityType, entityId]
      );
      return result.rows.map(mapRow);
    });
  }

  async archive(tenantId: string, id: string): Promise<Attachment | null> {
    return this.withTenant(tenantId, async (client) => {
      // COALESCE keeps re-archiving idempotent (first archive timestamp wins).
      const result = await client.query(
        `UPDATE attachments
         SET archived_at = COALESCE(archived_at, now()), updated_at = now()
         WHERE tenant_id = $1 AND id = $2
         RETURNING *`,
        [tenantId, id]
      );
      if (result.rows.length === 0) return null;
      return mapRow(result.rows[0]);
    });
  }

  async setPortalVisibility(
    tenantId: string,
    id: string,
    visible: boolean
  ): Promise<Attachment | null> {
    return this.withTenant(tenantId, async (client) => {
      const result = await client.query(
        `UPDATE attachments
         SET portal_visible = $3, updated_at = now()
         WHERE tenant_id = $1 AND id = $2
         RETURNING *`,
        [tenantId, id, visible]
      );
      if (result.rows.length === 0) return null;
      return mapRow(result.rows[0]);
    });
  }

  async setPair(
    tenantId: string,
    id: string,
    pairGroupId: string,
    pairRole: AttachmentPairRole
  ): Promise<Attachment | null> {
    return this.withTenant(tenantId, async (client) => {
      const result = await client.query(
        `UPDATE attachments
         SET pair_group_id = $3, pair_role = $4, updated_at = now()
         WHERE tenant_id = $1 AND id = $2
         RETURNING *`,
        [tenantId, id, pairGroupId, pairRole]
      );
      if (result.rows.length === 0) return null;
      return mapRow(result.rows[0]);
    });
  }
}
