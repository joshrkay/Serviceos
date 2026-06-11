import { Pool } from 'pg';
import { PgBaseRepository } from '../db/pg-base';
import { FilePipelineUpdate, FileRecord, FileRepository } from './file-service';

function mapRow(row: Record<string, unknown>): FileRecord {
  return {
    id: row.id as string,
    tenantId: row.tenant_id as string,
    filename: row.filename as string,
    contentType: row.content_type as string,
    sizeBytes: Number(row.size_bytes),
    storageBucket: row.s3_bucket as string,
    storageKey: row.s3_key as string,
    entityType: row.entity_type as string | undefined,
    entityId: row.entity_id as string | undefined,
    uploadedBy: row.uploaded_by as string,
    width: row.width == null ? undefined : Number(row.width),
    height: row.height == null ? undefined : Number(row.height),
    thumbnailS3Key: (row.thumbnail_s3_key as string | null) ?? undefined,
    exifStripped: Boolean(row.exif_stripped),
    contentHash: (row.content_hash as string | null) ?? undefined,
    createdAt: new Date(row.created_at as string),
    updatedAt: new Date(row.updated_at as string),
  };
}

export class PgFileRepository extends PgBaseRepository implements FileRepository {
  constructor(pool: Pool) {
    super(pool);
  }

  async create(record: FileRecord): Promise<FileRecord> {
    return this.withTenant(record.tenantId, async (client) => {
      const result = await client.query(
        `INSERT INTO files (id, tenant_id, filename, content_type, size_bytes, s3_bucket, s3_key, entity_type, entity_id, uploaded_by, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
         RETURNING *`,
        [
          record.id,
          record.tenantId,
          record.filename,
          record.contentType,
          record.sizeBytes,
          record.storageBucket,
          record.storageKey,
          record.entityType ?? null,
          record.entityId ?? null,
          record.uploadedBy,
          record.createdAt,
          record.updatedAt,
        ]
      );
      return mapRow(result.rows[0]);
    });
  }

  async findById(tenantId: string, id: string): Promise<FileRecord | null> {
    return this.withTenant(tenantId, async (client) => {
      const result = await client.query(
        `SELECT * FROM files WHERE id = $1 AND tenant_id = $2`,
        [id, tenantId]
      );
      if (result.rows.length === 0) return null;
      return mapRow(result.rows[0]);
    });
  }

  async findByEntity(tenantId: string, entityType: string, entityId: string): Promise<FileRecord[]> {
    return this.withTenant(tenantId, async (client) => {
      const result = await client.query(
        `SELECT * FROM files WHERE tenant_id = $1 AND entity_type = $2 AND entity_id = $3 ORDER BY created_at DESC`,
        [tenantId, entityType, entityId]
      );
      return result.rows.map(mapRow);
    });
  }

  async updateSize(tenantId: string, id: string, sizeBytes: number): Promise<FileRecord | null> {
    return this.withTenant(tenantId, async (client) => {
      const result = await client.query(
        `UPDATE files SET size_bytes = $1, updated_at = NOW()
         WHERE id = $2 AND tenant_id = $3
         RETURNING *`,
        [sizeBytes, id, tenantId]
      );
      if (result.rows.length === 0) return null;
      return mapRow(result.rows[0]);
    });
  }

  async updatePipelineResults(
    tenantId: string,
    id: string,
    update: FilePipelineUpdate
  ): Promise<FileRecord | null> {
    return this.withTenant(tenantId, async (client) => {
      // COALESCE keeps existing values when an optional field is omitted
      // (e.g. the document hash-only path leaves dims/thumbnail NULL).
      const result = await client.query(
        `UPDATE files SET
           content_hash = $1,
           width = COALESCE($2, width),
           height = COALESCE($3, height),
           thumbnail_s3_key = COALESCE($4, thumbnail_s3_key),
           exif_stripped = COALESCE($5, exif_stripped),
           content_type = COALESCE($6, content_type),
           size_bytes = COALESCE($7, size_bytes),
           updated_at = NOW()
         WHERE id = $8 AND tenant_id = $9
         RETURNING *`,
        [
          update.contentHash,
          update.width ?? null,
          update.height ?? null,
          update.thumbnailS3Key ?? null,
          update.exifStripped ?? null,
          update.contentType ?? null,
          update.sizeBytes ?? null,
          id,
          tenantId,
        ]
      );
      if (result.rows.length === 0) return null;
      return mapRow(result.rows[0]);
    });
  }

  async findByContentHash(tenantId: string, contentHash: string): Promise<FileRecord[]> {
    return this.withTenant(tenantId, async (client) => {
      const result = await client.query(
        `SELECT * FROM files WHERE tenant_id = $1 AND content_hash = $2 ORDER BY created_at DESC`,
        [tenantId, contentHash]
      );
      return result.rows.map(mapRow);
    });
  }

  async delete(tenantId: string, id: string): Promise<boolean> {
    return this.withTenant(tenantId, async (client) => {
      const result = await client.query(
        `DELETE FROM files WHERE id = $1 AND tenant_id = $2`,
        [id, tenantId]
      );
      return (result.rowCount ?? 0) > 0;
    });
  }
}
