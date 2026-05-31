import { Pool } from 'pg';
import { PgBaseRepository } from '../db/pg-base';
import {
  TechnicianWorkingHours,
  WorkingHoursRepository,
} from './working-hours';

/**
 * Pg-backed working-hours repository (migration 134:
 * `technician_working_hours`). Satisfies the same `WorkingHoursRepository`
 * interface as `InMemoryWorkingHoursRepository`; the in-memory impl stays
 * for unit tests and the feasibility composer's fakes.
 *
 * Tenant scoping is enforced via RLS (the migration's
 * `tenant_isolation_technician_working_hours` policy) AND an explicit
 * `tenant_id = $1` predicate on every query (defense-in-depth per
 * repository-conventions.md). Every query runs inside `withTenant`, which
 * sets `app.current_tenant_id`; we never concatenate tenantId into SQL and
 * never open a pool connection directly.
 */
function mapRow(row: Record<string, unknown>): TechnicianWorkingHours {
  return {
    id: row.id as string,
    tenantId: row.tenant_id as string,
    technicianId: row.technician_id as string,
    dayOfWeek: Number(row.day_of_week),
    startTime: row.start_time as string,
    endTime: row.end_time as string,
    isActive: row.is_active as boolean,
    createdAt: new Date(row.created_at as string),
    updatedAt: new Date(row.updated_at as string),
  };
}

export class PgWorkingHoursRepository
  extends PgBaseRepository
  implements WorkingHoursRepository
{
  constructor(pool: Pool) {
    super(pool);
  }

  async create(hours: TechnicianWorkingHours): Promise<TechnicianWorkingHours> {
    return this.withTenant(hours.tenantId, async (client) => {
      // Upsert on the (tenant, tech, day) uniqueness so re-saving a day's
      // hours replaces the prior window rather than violating the constraint.
      const result = await client.query(
        `INSERT INTO technician_working_hours (
          id, tenant_id, technician_id, day_of_week,
          start_time, end_time, is_active, created_at, updated_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        ON CONFLICT (tenant_id, technician_id, day_of_week)
        DO UPDATE SET
          start_time = EXCLUDED.start_time,
          end_time = EXCLUDED.end_time,
          is_active = EXCLUDED.is_active,
          updated_at = EXCLUDED.updated_at
        RETURNING *`,
        [
          hours.id,
          hours.tenantId,
          hours.technicianId,
          hours.dayOfWeek,
          hours.startTime,
          hours.endTime,
          hours.isActive,
          hours.createdAt,
          hours.updatedAt,
        ],
      );
      return mapRow(result.rows[0] as Record<string, unknown>);
    });
  }

  async findByTechnician(
    tenantId: string,
    technicianId: string,
  ): Promise<TechnicianWorkingHours[]> {
    return this.withTenant(tenantId, async (client) => {
      const result = await client.query(
        `SELECT * FROM technician_working_hours
         WHERE tenant_id = $1 AND technician_id = $2
         ORDER BY day_of_week ASC`,
        [tenantId, technicianId],
      );
      return result.rows.map((r) => mapRow(r as Record<string, unknown>));
    });
  }

  async findByTechnicianAndDay(
    tenantId: string,
    technicianId: string,
    dayOfWeek: number,
  ): Promise<TechnicianWorkingHours | null> {
    return this.withTenant(tenantId, async (client) => {
      const result = await client.query(
        `SELECT * FROM technician_working_hours
         WHERE tenant_id = $1 AND technician_id = $2 AND day_of_week = $3
         LIMIT 1`,
        [tenantId, technicianId, dayOfWeek],
      );
      const row = result.rows[0] as Record<string, unknown> | undefined;
      return row ? mapRow(row) : null;
    });
  }

  async update(
    tenantId: string,
    id: string,
    updates: Partial<TechnicianWorkingHours>,
  ): Promise<TechnicianWorkingHours | null> {
    return this.withTenant(tenantId, async (client) => {
      // Build a small dynamic SET list for the mutable columns only.
      const sets: string[] = [];
      const values: unknown[] = [tenantId, id];
      const push = (col: string, val: unknown) => {
        values.push(val);
        sets.push(`${col} = $${values.length}`);
      };
      if (updates.startTime !== undefined) push('start_time', updates.startTime);
      if (updates.endTime !== undefined) push('end_time', updates.endTime);
      if (updates.isActive !== undefined) push('is_active', updates.isActive);
      if (updates.dayOfWeek !== undefined) push('day_of_week', updates.dayOfWeek);
      // Always bump updated_at.
      push('updated_at', new Date());

      const result = await client.query(
        `UPDATE technician_working_hours
           SET ${sets.join(', ')}
         WHERE tenant_id = $1 AND id = $2
         RETURNING *`,
        values,
      );
      const row = result.rows[0] as Record<string, unknown> | undefined;
      return row ? mapRow(row) : null;
    });
  }

  async delete(tenantId: string, id: string): Promise<boolean> {
    return this.withTenant(tenantId, async (client) => {
      const result = await client.query(
        `DELETE FROM technician_working_hours
         WHERE tenant_id = $1 AND id = $2`,
        [tenantId, id],
      );
      return (result.rowCount ?? 0) > 0;
    });
  }
}
