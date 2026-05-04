import { Pool } from 'pg';
import { PgBaseRepository } from '../db/pg-base';
import { Appointment, AppointmentRepository } from './appointment';

function mapRow(row: Record<string, unknown>): Appointment {
  return {
    id: row.id as string,
    tenantId: row.tenant_id as string,
    jobId: row.job_id as string,
    scheduledStart: new Date(row.scheduled_start as string),
    scheduledEnd: new Date(row.scheduled_end as string),
    arrivalWindowStart: row.arrival_window_start
      ? new Date(row.arrival_window_start as string)
      : undefined,
    arrivalWindowEnd: row.arrival_window_end
      ? new Date(row.arrival_window_end as string)
      : undefined,
    timezone: row.timezone as string,
    status: row.status as Appointment['status'],
    notes: (row.notes as string) ?? undefined,
    createdBy: row.created_by as string,
    createdAt: new Date(row.created_at as string),
    updatedAt: new Date(row.updated_at as string),
  };
}

export class PgAppointmentRepository extends PgBaseRepository implements AppointmentRepository {
  constructor(pool: Pool) {
    super(pool);
  }

  async create(appointment: Appointment): Promise<Appointment> {
    return this.withTenant(appointment.tenantId, async (client) => {
      const result = await client.query(
        `INSERT INTO appointments (
          id, tenant_id, job_id, scheduled_start, scheduled_end,
          arrival_window_start, arrival_window_end, timezone, status,
          notes, created_by, created_at, updated_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
        RETURNING *`,
        [
          appointment.id,
          appointment.tenantId,
          appointment.jobId,
          appointment.scheduledStart,
          appointment.scheduledEnd,
          appointment.arrivalWindowStart ?? null,
          appointment.arrivalWindowEnd ?? null,
          appointment.timezone,
          appointment.status,
          appointment.notes ?? null,
          appointment.createdBy,
          appointment.createdAt,
          appointment.updatedAt,
        ]
      );
      return mapRow(result.rows[0]);
    });
  }

  async findById(tenantId: string, id: string): Promise<Appointment | null> {
    return this.withTenant(tenantId, async (client) => {
      const result = await client.query(
        'SELECT * FROM appointments WHERE tenant_id = $1 AND id = $2',
        [tenantId, id]
      );
      return result.rows.length > 0 ? mapRow(result.rows[0]) : null;
    });
  }

  async findByJob(tenantId: string, jobId: string): Promise<Appointment[]> {
    return this.withTenant(tenantId, async (client) => {
      const result = await client.query(
        'SELECT * FROM appointments WHERE tenant_id = $1 AND job_id = $2 ORDER BY scheduled_start ASC',
        [tenantId, jobId]
      );
      return result.rows.map(mapRow);
    });
  }

  async findByDateRange(tenantId: string, start: Date, end: Date): Promise<Appointment[]> {
    return this.withTenant(tenantId, async (client) => {
      const result = await client.query(
        `SELECT * FROM appointments
         WHERE tenant_id = $1 AND scheduled_start >= $2 AND scheduled_start <= $3
         ORDER BY scheduled_start ASC`,
        [tenantId, start, end]
      );
      return result.rows.map(mapRow);
    });
  }

  async update(tenantId: string, id: string, updates: Partial<Appointment>): Promise<Appointment | null> {
    return this.withTenant(tenantId, async (client) => {
      const fieldMap: Record<string, string> = {
        jobId: 'job_id',
        scheduledStart: 'scheduled_start',
        scheduledEnd: 'scheduled_end',
        arrivalWindowStart: 'arrival_window_start',
        arrivalWindowEnd: 'arrival_window_end',
        timezone: 'timezone',
        status: 'status',
        notes: 'notes',
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
        `UPDATE appointments SET ${setClauses.join(', ')}
         WHERE tenant_id = $${paramIndex} AND id = $${paramIndex + 1}
         RETURNING *`,
        params
      );
      return result.rows.length > 0 ? mapRow(result.rows[0]) : null;
    });
  }
}
