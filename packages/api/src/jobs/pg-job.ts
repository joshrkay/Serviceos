import { Pool, PoolClient } from 'pg';
import { PgBaseRepository } from '../db/pg-base';
import {
  Job,
  JobListOptions,
  JobListResult,
  JobRepository,
  DEFAULT_JOB_LIMIT,
  MAX_JOB_LIMIT,
} from './job';

function mapRow(row: Record<string, unknown>): Job {
  return {
    id: row.id as string,
    tenantId: row.tenant_id as string,
    customerId: row.customer_id as string,
    locationId: row.location_id as string,
    jobNumber: row.job_number as string,
    summary: row.summary as string,
    problemDescription: (row.problem_description as string) ?? undefined,
    status: row.status as Job['status'],
    priority: row.priority as Job['priority'],
    assignedTechnicianId: (row.assigned_technician_id as string) ?? undefined,
    createdBy: row.created_by as string,
    createdAt: new Date(row.created_at as string),
    updatedAt: new Date(row.updated_at as string),
  };
}

export class PgJobRepository extends PgBaseRepository implements JobRepository {
  constructor(pool: Pool) {
    super(pool);
  }

  async create(job: Job): Promise<Job> {
    return this.withTenant(job.tenantId, async (client) => {
      const result = await client.query(
        `INSERT INTO jobs (
          id, tenant_id, customer_id, location_id, job_number, summary,
          problem_description, status, priority, assigned_technician_id,
          created_by, created_at, updated_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
        RETURNING *`,
        [
          job.id,
          job.tenantId,
          job.customerId,
          job.locationId,
          job.jobNumber,
          job.summary,
          job.problemDescription ?? null,
          job.status,
          job.priority,
          job.assignedTechnicianId ?? null,
          job.createdBy,
          job.createdAt,
          job.updatedAt,
        ]
      );
      return mapRow(result.rows[0]);
    });
  }

  async findById(tenantId: string, id: string): Promise<Job | null> {
    return this.withTenant(tenantId, async (client) => {
      const result = await client.query(
        'SELECT * FROM jobs WHERE tenant_id = $1 AND id = $2',
        [tenantId, id]
      );
      return result.rows.length > 0 ? mapRow(result.rows[0]) : null;
    });
  }

  /**
   * Build the parameterized WHERE clause shared by the data and total-count
   * queries. tenant_id is the FIRST predicate (defense-in-depth alongside
   * RLS); all other filters are layered on with parameterized placeholders.
   */
  private buildListWhere(tenantId: string, options?: JobListOptions): {
    where: string;
    params: unknown[];
  } {
    const conditions: string[] = ['tenant_id = $1'];
    const params: unknown[] = [tenantId];
    let paramIndex = 2;

    if (options?.status) {
      conditions.push(`status = $${paramIndex}`);
      params.push(options.status);
      paramIndex++;
    }

    if (options?.customerId) {
      conditions.push(`customer_id = $${paramIndex}`);
      params.push(options.customerId);
      paramIndex++;
    }

    if (options?.technicianId) {
      conditions.push(`assigned_technician_id = $${paramIndex}`);
      params.push(options.technicianId);
      paramIndex++;
    }

    if (options?.search) {
      const searchParam = `%${options.search}%`;
      conditions.push(
        `(summary ILIKE $${paramIndex} OR job_number ILIKE $${paramIndex})`
      );
      params.push(searchParam);
      paramIndex++;
    }

    return { where: `WHERE ${conditions.join(' AND ')}`, params };
  }

  async findByTenant(tenantId: string, options?: JobListOptions): Promise<Job[]> {
    return this.withTenant(tenantId, async (client) => {
      return this.queryListRows(client, tenantId, options);
    });
  }

  private async queryListRows(
    client: PoolClient,
    tenantId: string,
    options?: JobListOptions
  ): Promise<Job[]> {
    const { where, params } = this.buildListWhere(tenantId, options);
    // P1-018: jobs default to created_at DESC.
    const sortDirection = options?.sort === 'asc' ? 'ASC' : 'DESC';
    const usePagination = options?.limit !== undefined || options?.offset !== undefined;
    let sql = `SELECT * FROM jobs ${where} ORDER BY created_at ${sortDirection}`;
    let queryParams = params;
    if (usePagination) {
      const limit = Math.min(options?.limit ?? DEFAULT_JOB_LIMIT, MAX_JOB_LIMIT);
      const offset = options?.offset ?? 0;
      sql += ` LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
      queryParams = [...params, limit, offset];
    }
    const result = await client.query(sql, queryParams);
    return result.rows.map(mapRow);
  }

  async listWithMeta(tenantId: string, options?: JobListOptions): Promise<JobListResult> {
    return this.withTenant(tenantId, async (client) => {
      const limit = Math.min(options?.limit ?? DEFAULT_JOB_LIMIT, MAX_JOB_LIMIT);
      const offset = options?.offset ?? 0;
      const data = await this.queryListRows(client, tenantId, { ...options, limit, offset });
      const { where, params } = this.buildListWhere(tenantId, options);
      const countResult = await client.query(
        `SELECT COUNT(*)::int AS total FROM jobs ${where}`,
        params
      );
      return { data, total: countResult.rows[0].total as number };
    });
  }

  async update(tenantId: string, id: string, updates: Partial<Job>): Promise<Job | null> {
    return this.withTenant(tenantId, async (client) => {
      const fieldMap: Record<string, string> = {
        customerId: 'customer_id',
        locationId: 'location_id',
        jobNumber: 'job_number',
        summary: 'summary',
        problemDescription: 'problem_description',
        status: 'status',
        priority: 'priority',
        assignedTechnicianId: 'assigned_technician_id',
        updatedAt: 'updated_at',
      };

      const setClauses: string[] = [];
      const params: unknown[] = [];
      let paramIndex = 1;

      for (const [key, value] of Object.entries(updates)) {
        const column = fieldMap[key];
        if (column) {
          setClauses.push(`${column} = $${paramIndex}`);
          params.push(value ?? null);
          paramIndex++;
        }
      }

      if (setClauses.length === 0) return this.findById(tenantId, id);

      params.push(tenantId, id);
      const result = await client.query(
        `UPDATE jobs SET ${setClauses.join(', ')}
         WHERE tenant_id = $${paramIndex} AND id = $${paramIndex + 1}
         RETURNING *`,
        params
      );
      return result.rows.length > 0 ? mapRow(result.rows[0]) : null;
    });
  }

  async getNextJobNumber(tenantId: string): Promise<number> {
    return this.withTenant(tenantId, async (client) => {
      const result = await client.query(
        'SELECT COUNT(*)::int + 1 AS next_number FROM jobs WHERE tenant_id = $1',
        [tenantId]
      );
      return result.rows[0].next_number as number;
    });
  }
}
