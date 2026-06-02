/**
 * P21-001 — Pg-backed invoice schedule repository.
 *
 * Mirrors the dunning-config repo: tenant-scoped via PgBaseRepository.withTenant
 * (RLS enforced by `tenant_isolation_invoice_schedules`). Milestones ride in a
 * JSONB column; pg returns them already parsed.
 */
import { Pool } from 'pg';
import { PgBaseRepository } from '../db/pg-base';
import {
  InvoiceMilestone,
  InvoiceSchedule,
  InvoiceScheduleRepository,
} from './invoice-schedule';

function mapSchedule(row: Record<string, unknown>): InvoiceSchedule {
  const raw = row.milestones;
  const milestones: InvoiceMilestone[] = Array.isArray(raw)
    ? (raw as InvoiceMilestone[])
    : typeof raw === 'string'
      ? (JSON.parse(raw) as InvoiceMilestone[])
      : [];
  return {
    id: row.id as string,
    tenantId: row.tenant_id as string,
    jobId: row.job_id as string,
    estimateId: (row.estimate_id as string) ?? undefined,
    totalAmountCents: Number(row.total_amount_cents),
    milestones,
    createdBy: row.created_by as string,
    createdAt: new Date(row.created_at as string),
    updatedAt: new Date(row.updated_at as string),
  };
}

export class PgInvoiceScheduleRepository
  extends PgBaseRepository
  implements InvoiceScheduleRepository
{
  constructor(pool: Pool) {
    super(pool);
  }

  async create(schedule: InvoiceSchedule): Promise<InvoiceSchedule> {
    return this.withTenant(schedule.tenantId, async (client) => {
      const result = await client.query(
        `INSERT INTO invoice_schedules (
          id, tenant_id, job_id, estimate_id, total_amount_cents,
          milestones, created_by, created_at, updated_at
        ) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9)
        RETURNING *`,
        [
          schedule.id,
          schedule.tenantId,
          schedule.jobId,
          schedule.estimateId ?? null,
          schedule.totalAmountCents,
          JSON.stringify(schedule.milestones),
          schedule.createdBy,
          schedule.createdAt,
          schedule.updatedAt,
        ],
      );
      return mapSchedule(result.rows[0]);
    });
  }

  async findById(tenantId: string, id: string): Promise<InvoiceSchedule | null> {
    return this.withTenant(tenantId, async (client) => {
      const result = await client.query(
        'SELECT * FROM invoice_schedules WHERE tenant_id = $1 AND id = $2',
        [tenantId, id],
      );
      return result.rows.length > 0 ? mapSchedule(result.rows[0]) : null;
    });
  }

  async findByJob(tenantId: string, jobId: string): Promise<InvoiceSchedule[]> {
    return this.withTenant(tenantId, async (client) => {
      const result = await client.query(
        `SELECT * FROM invoice_schedules
         WHERE tenant_id = $1 AND job_id = $2
         ORDER BY created_at ASC`,
        [tenantId, jobId],
      );
      return result.rows.map(mapSchedule);
    });
  }
}
