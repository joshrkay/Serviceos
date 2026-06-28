import { Pool } from 'pg';
import { AppointmentTypeValue } from '@ai-service-os/shared';
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
    anchorTime: (row.anchor_time as string) ?? '09:00',
    durationMinutes: (row.duration_minutes as number) ?? 60,
    appointmentType: (row.appointment_type as AppointmentTypeValue | null) ?? null,
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
          id, tenant_id, customer_id, title, anchor_date, anchor_time,
          duration_minutes, appointment_type, rule, notes,
          is_archived, created_at, updated_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11, $12, $13)
        RETURNING *`,
        [
          job.id,
          job.tenantId,
          job.customerId,
          job.title,
          job.anchorDate,
          job.anchorTime,
          job.durationMinutes,
          job.appointmentType,
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
         SET title = $3, anchor_date = $4, anchor_time = $5, duration_minutes = $6,
             appointment_type = $7, rule = $8::jsonb, notes = $9,
             is_archived = $10, updated_at = $11
         WHERE tenant_id = $1 AND id = $2
         RETURNING *`,
        [
          job.tenantId,
          job.id,
          job.title,
          job.anchorDate,
          job.anchorTime,
          job.durationMinutes,
          job.appointmentType,
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

  async claimOccurrence(
    tenantId: string,
    recurringJobId: string,
    occurrenceDate: string
  ): Promise<string | null> {
    return this.withTenant(tenantId, async (client) => {
      // ON CONFLICT DO NOTHING on the UNIQUE(tenant, series, date) makes the
      // claim atomic: a losing concurrent caller gets zero rows back.
      const result = await client.query(
        `INSERT INTO recurring_job_occurrences (tenant_id, recurring_job_id, occurrence_date)
         VALUES ($1, $2, $3)
         ON CONFLICT (tenant_id, recurring_job_id, occurrence_date) DO NOTHING
         RETURNING id`,
        [tenantId, recurringJobId, occurrenceDate]
      );
      return result.rows.length > 0 ? (result.rows[0].id as string) : null;
    });
  }

  async linkOccurrence(
    tenantId: string,
    ledgerId: string,
    jobId: string,
    appointmentId: string
  ): Promise<void> {
    await this.withTenant(tenantId, async (client) => {
      await client.query(
        `UPDATE recurring_job_occurrences
         SET job_id = $3, appointment_id = $4
         WHERE tenant_id = $1 AND id = $2`,
        [tenantId, ledgerId, jobId, appointmentId]
      );
    });
  }

  async listMaterializedDates(tenantId: string, recurringJobId: string): Promise<string[]> {
    return this.withTenant(tenantId, async (client) => {
      const result = await client.query(
        `SELECT occurrence_date FROM recurring_job_occurrences
         WHERE tenant_id = $1 AND recurring_job_id = $2
         ORDER BY occurrence_date ASC`,
        [tenantId, recurringJobId]
      );
      return result.rows.map((r) => {
        const v = r.occurrence_date;
        if (typeof v === 'string') return v.slice(0, 10);
        const d = v as Date;
        const y = d.getUTCFullYear();
        const m = String(d.getUTCMonth() + 1).padStart(2, '0');
        const day = String(d.getUTCDate()).padStart(2, '0');
        return `${y}-${m}-${day}`;
      });
    });
  }
}
