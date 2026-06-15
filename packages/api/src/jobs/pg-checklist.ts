import { Pool } from 'pg';
import { PgBaseRepository } from '../db/pg-base';
import {
  ChecklistItem,
  CreateJobChecklistInput,
  JobChecklist,
  JobChecklistRepository,
  buildJobChecklist,
} from './checklist';

function mapRow(row: Record<string, unknown>): JobChecklist {
  return {
    id: row.id as string,
    tenantId: row.tenant_id as string,
    jobId: row.job_id as string,
    title: row.title as string,
    items: (row.items as ChecklistItem[]) ?? [],
    completedAt: row.completed_at ? new Date(row.completed_at as string) : undefined,
    createdAt: new Date(row.created_at as string),
  };
}

export class PgJobChecklistRepository extends PgBaseRepository implements JobChecklistRepository {
  constructor(pool: Pool) {
    super(pool);
  }

  async create(input: CreateJobChecklistInput): Promise<JobChecklist> {
    const row = buildJobChecklist(input);
    return this.withTenant(row.tenantId, async (client) => {
      const result = await client.query(
        `INSERT INTO job_checklists (id, tenant_id, job_id, title, items, created_at)
         VALUES ($1,$2,$3,$4,$5,$6)
         RETURNING *`,
        [row.id, row.tenantId, row.jobId, row.title, JSON.stringify(row.items), row.createdAt],
      );
      return mapRow(result.rows[0]);
    });
  }

  async findById(tenantId: string, id: string): Promise<JobChecklist | null> {
    return this.withTenant(tenantId, async (client) => {
      const result = await client.query(
        `SELECT * FROM job_checklists WHERE id = $1 AND tenant_id = $2`,
        [id, tenantId],
      );
      if (result.rows.length === 0) return null;
      return mapRow(result.rows[0]);
    });
  }

  async listByJob(tenantId: string, jobId: string): Promise<JobChecklist[]> {
    return this.withTenant(tenantId, async (client) => {
      const result = await client.query(
        `SELECT * FROM job_checklists WHERE tenant_id = $1 AND job_id = $2 ORDER BY created_at DESC`,
        [tenantId, jobId],
      );
      return result.rows.map(mapRow);
    });
  }

  async updateItems(tenantId: string, id: string, items: ChecklistItem[]): Promise<JobChecklist | null> {
    return this.withTenant(tenantId, async (client) => {
      const result = await client.query(
        `UPDATE job_checklists SET items = $3 WHERE id = $1 AND tenant_id = $2 RETURNING *`,
        [id, tenantId, JSON.stringify(items)],
      );
      if (result.rows.length === 0) return null;
      return mapRow(result.rows[0]);
    });
  }

  async markComplete(tenantId: string, id: string): Promise<JobChecklist | null> {
    return this.withTenant(tenantId, async (client) => {
      const result = await client.query(
        `UPDATE job_checklists SET completed_at = NOW() WHERE id = $1 AND tenant_id = $2 RETURNING *`,
        [id, tenantId],
      );
      if (result.rows.length === 0) return null;
      return mapRow(result.rows[0]);
    });
  }
}
