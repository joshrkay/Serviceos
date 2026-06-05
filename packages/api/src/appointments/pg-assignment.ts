import { Pool } from 'pg';
import { PgBaseRepository } from '../db/pg-base';
import { AppointmentAssignment, AssignmentRepository } from './assignment';

function mapRow(row: Record<string, unknown>): AppointmentAssignment {
  return {
    id: row.id as string,
    tenantId: row.tenant_id as string,
    appointmentId: row.appointment_id as string,
    technicianId: row.technician_id as string,
    isPrimary: row.is_primary as boolean,
    assignedBy: row.assigned_by as string,
    assignedAt: new Date(row.assigned_at as string),
    // Denormalised window columns (added by migration 129).
    // May be NULL for rows created before the migration.
    scheduledStart: row.scheduled_start ? new Date(row.scheduled_start as string) : undefined,
    scheduledEnd: row.scheduled_end ? new Date(row.scheduled_end as string) : undefined,
  };
}

/**
 * Postgres-backed implementation of {@link AssignmentRepository}.
 *
 * Defense-in-depth: every query includes `tenant_id = $1` even though
 * RLS already enforces tenant isolation via `current_setting('app.current_tenant_id')`.
 * Tenant context is set on the connection via `withTenant` in `PgBaseRepository`.
 *
 * All queries are parameterized — no string interpolation.
 */
export class PgAssignmentRepository
  extends PgBaseRepository
  implements AssignmentRepository
{
  constructor(pool: Pool) {
    super(pool);
  }

  async create(assignment: AppointmentAssignment): Promise<AppointmentAssignment> {
    return this.withTenant(assignment.tenantId, async (client) => {
      const result = await client.query(
        `INSERT INTO appointment_assignments (
          id, tenant_id, appointment_id, technician_id,
          is_primary, assigned_by, assigned_at,
          scheduled_start, scheduled_end
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        RETURNING *`,
        [
          assignment.id,
          assignment.tenantId,
          assignment.appointmentId,
          assignment.technicianId,
          assignment.isPrimary,
          assignment.assignedBy,
          assignment.assignedAt,
          assignment.scheduledStart ?? null,
          assignment.scheduledEnd ?? null,
        ]
      );
      return mapRow(result.rows[0]);
    });
  }

  async update(assignment: AppointmentAssignment): Promise<AppointmentAssignment> {
    return this.withTenant(assignment.tenantId, async (client) => {
      const result = await client.query(
        `UPDATE appointment_assignments SET
          appointment_id = $3,
          technician_id = $4,
          is_primary = $5,
          assigned_by = $6,
          assigned_at = $7,
          scheduled_start = $8,
          scheduled_end = $9
         WHERE tenant_id = $1 AND id = $2
         RETURNING *`,
        [
          assignment.tenantId,
          assignment.id,
          assignment.appointmentId,
          assignment.technicianId,
          assignment.isPrimary,
          assignment.assignedBy,
          assignment.assignedAt,
          assignment.scheduledStart ?? null,
          assignment.scheduledEnd ?? null,
        ]
      );
      if (result.rows.length === 0) {
        // Mirror InMemory semantics: update of a non-existent row is unusual,
        // but we throw rather than fabricate state so callers can detect it.
        throw new Error(`Assignment ${assignment.id} not found for tenant ${assignment.tenantId}`);
      }
      return mapRow(result.rows[0]);
    });
  }

  async findByAppointment(
    tenantId: string,
    appointmentId: string
  ): Promise<AppointmentAssignment[]> {
    return this.withTenant(tenantId, async (client) => {
      const result = await client.query(
        `SELECT * FROM appointment_assignments
         WHERE tenant_id = $1 AND appointment_id = $2
         ORDER BY assigned_at ASC`,
        [tenantId, appointmentId]
      );
      return result.rows.map(mapRow);
    });
  }

  async findByTechnician(
    tenantId: string,
    technicianId: string
  ): Promise<AppointmentAssignment[]> {
    return this.withTenant(tenantId, async (client) => {
      const result = await client.query(
        `SELECT * FROM appointment_assignments
         WHERE tenant_id = $1 AND technician_id = $2
         ORDER BY assigned_at DESC`,
        [tenantId, technicianId]
      );
      return result.rows.map(mapRow);
    });
  }

  async delete(tenantId: string, id: string): Promise<boolean> {
    return this.withTenant(tenantId, async (client) => {
      const result = await client.query(
        `DELETE FROM appointment_assignments
         WHERE tenant_id = $1 AND id = $2`,
        [tenantId, id]
      );
      return (result.rowCount ?? 0) > 0;
    });
  }
}
