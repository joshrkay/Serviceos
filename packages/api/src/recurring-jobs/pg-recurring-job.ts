import { Pool } from 'pg';
import { PgBaseRepository } from '../db/pg-base';
import { RecurrenceRule } from './recurrence';
import { RecurringJob, RecurringJobRepository } from './recurring-job';

/**
 * R-JOB (Jobber parity) — Postgres-backed recurring job series.
 *
 * tenant_id is the first WHERE predicate on every query (defense-in-depth
 * alongside FORCE RLS, migration 222). The recurrence rule is stored as JSONB;
 * anchor_date is a DATE (calendar day, no time/zone).
 */
function mapRow(row: Record<string, unknown>): RecurringJob {
  return {
    id: row.id as string,
    tenantId: row.tenant_id as string,
    customerId: row.customer_id as string,
    title: row.title as string,
    anchorDate: toDateString(row.anchor_date),
    rule: (row.rule as RecurrenceRule) ?? { frequency: 'monthly', interval: 1 },
    notes: (row.notes as string | null) ?? null,
    isArchived: row.is_archived as boolean,
    createdAt: new Date(row.created_at as string),
    updatedAt: new Date(row.updated_at as string),
  };
}

/** pg returns DATE as a Date (local midnight) or string; normalize to YYYY-MM-DD. */
function toDateString(value: unknown): string {
  if (typeof value === 'string') return value.slice(0, 10);
  if (value instanceof Date) {
    const y = value.getUTCFullYear();
    const m = String(value.getUTCMonth() + 1).padStart(2, '0');
    const d = String(value.getUTCDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }
  return String(value);
}

export class PgRecurringJobRepository extends PgBaseRepository implements RecurringJobRepository {
  constructor(pool: Pool) {
    super(pool);
  }

  async create(job: RecurringJob): Promise<RecurringJob> {
    return this.withTenant(job.tenantId, async (client) => {
      const result = await client.query(
        `INSERT INTO recurring_jobs (
          id, tenant_id, customer_id, title, anchor_date, rule, notes,
          is_archived, created_at, updated_at
        ) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, $10)
        RETURNING *`,
        [
          job.id,
          job.tenantId,
          job.customerId,
          job.title,
          job.anchorDate,
          JSON.stringify(job.rule),
          job.notes,
          job.isArchived,
          job.createdAt,
          job.updatedAt,
        ]
      );
      return mapRow(result.rows[0]);
    });
  }

  async findById(tenantId: string, id: string): Promise<RecurringJob | null> {
    return this.withTenant(tenantId, async (client) => {
      const result = await client.query(
        'SELECT * FROM recurring_jobs WHERE tenant_id = $1 AND id = $2',
        [tenantId, id]
      );
      return result.rows.length > 0 ? mapRow(result.rows[0]) : null;
    });
  }

  async list(
    tenantId: string,
    opts: { customerId?: string; includeArchived?: boolean } = {}
  ): Promise<RecurringJob[]> {
    return this.withTenant(tenantId, async (client) => {
      const conditions = ['tenant_id = $1'];
      const params: unknown[] = [tenantId];
      if (!opts.includeArchived) conditions.push('is_archived = false');
      if (opts.customerId) {
        params.push(opts.customerId);
        conditions.push(`customer_id = $${params.length}`);
      }
      const result = await client.query(
        `SELECT * FROM recurring_jobs
         WHERE ${conditions.join(' AND ')}
         ORDER BY anchor_date ASC, title ASC`,
        params
      );
      return result.rows.map(mapRow);
    });
  }

  async update(job: RecurringJob): Promise<RecurringJob> {
    return this.withTenant(job.tenantId, async (client) => {
      const result = await client.query(
        `UPDATE recurring_jobs
         SET title = $3, anchor_date = $4, rule = $5::jsonb, notes = $6,
             is_archived = $7, updated_at = $8
         WHERE tenant_id = $1 AND id = $2
         RETURNING *`,
        [
          job.tenantId,
          job.id,
          job.title,
          job.anchorDate,
          JSON.stringify(job.rule),
          job.notes,
          job.isArchived,
          job.updatedAt,
        ]
      );
      if (result.rows.length === 0) throw new Error('Recurring job not found');
      return mapRow(result.rows[0]);
    });
  }

  async archive(tenantId: string, id: string): Promise<RecurringJob | null> {
    return this.withTenant(tenantId, async (client) => {
      const result = await client.query(
        `UPDATE recurring_jobs
         SET is_archived = true, updated_at = NOW()
         WHERE tenant_id = $1 AND id = $2
         RETURNING *`,
        [tenantId, id]
      );
      return result.rows.length > 0 ? mapRow(result.rows[0]) : null;
    });
  }
}
