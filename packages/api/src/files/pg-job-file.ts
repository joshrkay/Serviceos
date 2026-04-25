import { Pool } from 'pg';
import { PgBaseRepository } from '../db/pg-base';
import { JobFileRecord, JobFileRepository } from './job-file-repository';

function mapRow(row: Record<string, unknown>): JobFileRecord {
  return {
    id: row.id as string,
    tenantId: row.tenant_id as string,
    filename: row.filename as string,
    contentType: row.content_type as string,
    sizeBytes: Number(row.size_bytes),
    storageBucket: row.s3_bucket as string,
    storageKey: row.s3_key as string,
    entityType: 'job',
    entityId: row.entity_id as string,
    uploadedBy: row.uploaded_by as string,
    createdAt: new Date(row.created_at as string),
    updatedAt: new Date(row.updated_at as string),
  };
}

export class PgJobFileRepository extends PgBaseRepository implements JobFileRepository {
  constructor(pool: Pool) {
    super(pool);
  }

  async create(record: JobFileRecord): Promise<JobFileRecord> {
    return this.withTenant(record.tenantId, async (client) => {
      const result = await client.query(
        `INSERT INTO files (id, tenant_id, filename, content_type, size_bytes, s3_bucket, s3_key, entity_type, entity_id, uploaded_by, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'job', $8, $9, $10, $11)
         RETURNING *`,
        [
          record.id,
          record.tenantId,
          record.filename,
          record.contentType,
          record.sizeBytes,
          record.storageBucket,
          record.storageKey,
          record.entityId,
          record.uploadedBy,
          record.createdAt,
          record.updatedAt,
        ]
      );
      return mapRow(result.rows[0]);
    });
  }

  async findById(tenantId: string, id: string): Promise<JobFileRecord | null> {
    return this.withTenant(tenantId, async (client) => {
      const result = await client.query(
        `SELECT * FROM files WHERE id = $1 AND tenant_id = $2 AND entity_type = 'job'`,
        [id, tenantId]
      );
      if (result.rows.length === 0) return null;
      return mapRow(result.rows[0]);
    });
  }

  async findByJob(tenantId: string, jobId: string): Promise<JobFileRecord[]> {
    return this.withTenant(tenantId, async (client) => {
      const result = await client.query(
        `SELECT * FROM files WHERE tenant_id = $1 AND entity_type = 'job' AND entity_id = $2 ORDER BY created_at DESC`,
        [tenantId, jobId]
      );
      return result.rows.map(mapRow);
    });
  }

  async updateSize(tenantId: string, id: string, sizeBytes: number): Promise<JobFileRecord | null> {
    return this.withTenant(tenantId, async (client) => {
      const result = await client.query(
        `UPDATE files
         SET size_bytes = $1, updated_at = NOW()
         WHERE id = $2 AND tenant_id = $3 AND entity_type = 'job'
         RETURNING *`,
        [sizeBytes, id, tenantId]
      );
      if (result.rows.length === 0) return null;
      return mapRow(result.rows[0]);
    });
  }

  async delete(tenantId: string, id: string): Promise<boolean> {
    return this.withTenant(tenantId, async (client) => {
      const result = await client.query(
        `DELETE FROM files WHERE id = $1 AND tenant_id = $2 AND entity_type = 'job'`,
        [id, tenantId]
      );
      return (result.rowCount ?? 0) > 0;
    });
  }
}
