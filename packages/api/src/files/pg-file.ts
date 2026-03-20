import { Pool } from 'pg';
import { PgBaseRepository } from '../db/pg-base';
import { FileRecord, FileRepository } from './file-service';

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
