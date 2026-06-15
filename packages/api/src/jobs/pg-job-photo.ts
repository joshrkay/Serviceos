import { Pool } from 'pg';
import { PgBaseRepository } from '../db/pg-base';
import {
  CreateJobPhotoInput,
  JobPhoto,
  JobPhotoCategory,
  JobPhotoRepository,
  buildJobPhoto,
} from './job-photo';

function mapRow(row: Record<string, unknown>): JobPhoto {
  return {
    id: row.id as string,
    tenantId: row.tenant_id as string,
    jobId: row.job_id as string,
    uploadedByUserId: row.uploaded_by_user_id as string,
    fileId: row.file_id as string,
    category: row.category as JobPhotoCategory,
    notes: (row.notes as string | null) ?? undefined,
    takenAt: row.taken_at ? new Date(row.taken_at as string) : undefined,
    clientVisible: row.client_visible === true,
    createdAt: new Date(row.created_at as string),
  };
}

export class PgJobPhotoRepository extends PgBaseRepository implements JobPhotoRepository {
  constructor(pool: Pool) {
    super(pool);
  }

  async create(input: CreateJobPhotoInput): Promise<JobPhoto> {
    const photo = buildJobPhoto(input);
    return this.withTenant(photo.tenantId, async (client) => {
      const result = await client.query(
        `INSERT INTO job_photos
           (id, tenant_id, job_id, uploaded_by_user_id, file_id, category, notes, taken_at, client_visible, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, false, $9)
         RETURNING *`,
        [
          photo.id,
          photo.tenantId,
          photo.jobId,
          photo.uploadedByUserId,
          photo.fileId,
          photo.category,
          photo.notes ?? null,
          photo.takenAt ?? null,
          photo.createdAt,
        ]
      );
      return mapRow(result.rows[0]);
    });
  }

  async findById(tenantId: string, id: string): Promise<JobPhoto | null> {
    return this.withTenant(tenantId, async (client) => {
      const result = await client.query(
        `SELECT * FROM job_photos WHERE id = $1 AND tenant_id = $2`,
        [id, tenantId]
      );
      if (result.rows.length === 0) return null;
      return mapRow(result.rows[0]);
    });
  }

  async listByJob(tenantId: string, jobId: string): Promise<JobPhoto[]> {
    return this.withTenant(tenantId, async (client) => {
      const result = await client.query(
        `SELECT * FROM job_photos
         WHERE tenant_id = $1 AND job_id = $2
         ORDER BY created_at DESC`,
        [tenantId, jobId]
      );
      return result.rows.map(mapRow);
    });
  }

  async delete(tenantId: string, id: string): Promise<boolean> {
    return this.withTenant(tenantId, async (client) => {
      const result = await client.query(
        `DELETE FROM job_photos WHERE id = $1 AND tenant_id = $2`,
        [id, tenantId]
      );
      return (result.rowCount ?? 0) > 0;
    });
  }

  async updateClientVisible(
    tenantId: string,
    id: string,
    clientVisible: boolean,
  ): Promise<JobPhoto | null> {
    return this.withTenant(tenantId, async (client) => {
      const result = await client.query(
        `UPDATE job_photos SET client_visible = $3
         WHERE id = $1 AND tenant_id = $2
         RETURNING *`,
        [id, tenantId, clientVisible],
      );
      if (result.rows.length === 0) return null;
      return mapRow(result.rows[0]);
    });
  }
}
