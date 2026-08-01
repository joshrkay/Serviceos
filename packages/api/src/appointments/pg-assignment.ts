import { Pool } from 'pg';
import { PgBaseRepository } from '../db/pg-base';
import { ConflictError } from '../shared/errors';
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
 * Translate the DB-level conflict signals from migration 131 into the
 * application's ConflictError (which the route layer maps to HTTP 409).
 *
 *  - `no_double_booking` — exclusion_violation (SQLSTATE 23P01) from the
 *    EXCLUDE constraint on (tenant_id, technician_id, scheduled range).
 *  - `uq_assignment_primary_per_appointment` — unique_violation (23505)
 *    from the partial unique index that allows at most one primary
 *    assignment per appointment.
 *  - deadlock_detected (40P01) — two concurrent assignment INSERTs racing
 *    the `no_double_booking` EXCLUDE constraint can each hold an index lock
 *    the other needs, so Postgres aborts one with a deadlock instead of a
 *    clean exclusion_violation. On this write path a deadlock IS the
 *    double-booking race resolving itself, so it's a retryable conflict
 *    (409), not a server error (500) — otherwise a concurrent double-book
 *    would surface as a 500 depending purely on lock-acquisition timing.
 *
 * Everything else is rethrown unchanged.
 */
function mapAssignmentDbError(err: unknown): Error {
  if (err && typeof err === 'object') {
    const e = err as { code?: string; constraint?: string; message?: string };
    if (e.code === '23P01' && e.constraint === 'no_double_booking') {
      return new ConflictError(
        'Technician is already booked at this time (overlaps an existing assignment).',
      );
    }
    if (e.code === '23505' && e.constraint === 'uq_assignment_primary_per_appointment') {
      return new ConflictError('Another primary technician is already assigned to this appointment.');
    }
    if (e.code === '40P01') {
      return new ConflictError(
        'Technician assignment conflicted with a concurrent booking for the same slot; please retry.',
      );
    }
  }
  return err instanceof Error ? err : new Error(String(err));
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
      try {
        const result = await client.query(
          `INSERT INTO appointment_assignments (
            id, tenant_id, appointment_id, technician_id,
            is_primary, assigned_by, assigned_at
          ) VALUES ($1, $2, $3, $4, $5, $6, $7)
          RETURNING *`,
          [
            assignment.id,
            assignment.tenantId,
            assignment.appointmentId,
            assignment.technicianId,
            assignment.isPrimary,
            assignment.assignedBy,
            assignment.assignedAt,
          ]
        );
        return mapRow(result.rows[0]);
      } catch (err) {
        throw mapAssignmentDbError(err);
      }
    });
  }

  async update(assignment: AppointmentAssignment): Promise<AppointmentAssignment> {
    return this.withTenant(assignment.tenantId, async (client) => {
      try {
        const result = await client.query(
          `UPDATE appointment_assignments SET
            appointment_id = $3,
            technician_id = $4,
            is_primary = $5,
            assigned_by = $6,
            assigned_at = $7
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
          ]
        );
        if (result.rows.length === 0) {
          // Mirror InMemory semantics: update of a non-existent row is unusual,
          // but we throw rather than fabricate state so callers can detect it.
          throw new Error(`Assignment ${assignment.id} not found for tenant ${assignment.tenantId}`);
        }
        return mapRow(result.rows[0]);
      } catch (err) {
        throw mapAssignmentDbError(err);
      }
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
