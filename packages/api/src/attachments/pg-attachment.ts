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
  AttachmentPairTargetNotFoundError,
  AttachmentRepository,
  AttachmentSource,
  CreateAttachmentInput,
  ListByEntityOptions,
  buildAttachment,
} from './attachment';

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
          attachment.uploadedBy ?? null,
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

  async findByFileId(
    tenantId: string,
    fileId: string,
    entityType: AttachmentEntityType,
    entityId: string
  ): Promise<Attachment | null> {
    return this.withTenant(tenantId, async (client) => {
      const result = await client.query(
        `SELECT * FROM attachments
         WHERE tenant_id = $1 AND file_id = $2 AND entity_type = $3 AND entity_id = $4
           AND archived_at IS NULL
         ORDER BY created_at DESC
         LIMIT 1`,
        [tenantId, fileId, entityType, entityId]
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
    const visibleFilter = options?.portalVisibleOnly ? 'AND portal_visible = true' : '';
    return this.withTenant(tenantId, async (client) => {
      const result = await client.query(
        `SELECT * FROM attachments
         WHERE tenant_id = $1 AND entity_type = $2 AND entity_id = $3
         ${archivedFilter}
         ${visibleFilter}
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

  async pair(
    tenantId: string,
    id: string,
    role: AttachmentPairRole,
    otherId: string,
    otherRole: AttachmentPairRole,
    pairGroupId: string
  ): Promise<{ attachment: Attachment; other: Attachment }> {
    return this.withTenantTransaction(tenantId, async (client) => {
      // Fetch current pair group ids inside the transaction before mutating.
      const oldGroupsRes = await client.query(
        `SELECT pair_group_id FROM attachments
         WHERE tenant_id = $1 AND id = ANY($2::uuid[]) AND pair_group_id IS NOT NULL`,
        [tenantId, [id, otherId]]
      );
      const oldGroupIds = (oldGroupsRes.rows as Array<{ pair_group_id: string }>)
        .map((r) => r.pair_group_id)
        .filter(Boolean);

      // Clear orphaned pair members that shared either old group (excluding the
      // two rows we are about to re-pair).
      if (oldGroupIds.length > 0) {
        await client.query(
          `UPDATE attachments
           SET pair_group_id = NULL, pair_role = NULL, updated_at = now()
           WHERE tenant_id = $1
             AND pair_group_id = ANY($2::uuid[])
             AND id <> ALL($3::uuid[])`,
          [tenantId, oldGroupIds, [id, otherId]]
        );
      }

      const r1 = await client.query(
        `UPDATE attachments
         SET pair_group_id = $3, pair_role = $4, updated_at = now()
         WHERE tenant_id = $1 AND id = $2
         RETURNING *`,
        [tenantId, id, pairGroupId, role]
      );
      if (r1.rowCount === 0) {
        throw new AttachmentPairTargetNotFoundError(id);
      }
      const r2 = await client.query(
        `UPDATE attachments
         SET pair_group_id = $3, pair_role = $4, updated_at = now()
         WHERE tenant_id = $1 AND id = $2
         RETURNING *`,
        [tenantId, otherId, pairGroupId, otherRole]
      );
      if (r2.rowCount === 0) {
        throw new AttachmentPairTargetNotFoundError(otherId);
      }
      return { attachment: mapRow(r1.rows[0]), other: mapRow(r2.rows[0]) };
    });
  }
}
