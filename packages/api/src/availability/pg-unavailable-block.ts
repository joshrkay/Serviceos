import { Pool } from 'pg';
import { PgBaseRepository } from '../db/pg-base';
import { UnavailableBlock, UnavailableBlockRepository } from './unavailable-block';

/**
 * P6-028 — Pg-backed unavailable_blocks repository (migration 116:
 * `tech_unavailable_blocks`). Satisfies the same `UnavailableBlockRepository`
 * interface as `InMemoryUnavailableBlockRepository`; the in-memory impl stays
 * for unit tests and the feasibility composer's fakes.
 *
 * Tenant scoping is enforced via RLS (the migration's
 * `tenant_isolation_tech_unavailable_blocks` policy) AND an explicit
 * `tenant_id = $1` predicate on every query (defense-in-depth per
 * repository-conventions.md). Every query runs inside `withTenant`, which
 * sets `app.current_tenant_id`; we never concatenate tenantId into SQL and
 * never open a pool connection directly.
 */
function mapRow(row: Record<string, unknown>): UnavailableBlock {
  return {
    id: row.id as string,
    tenantId: row.tenant_id as string,
    technicianId: row.technician_id as string,
    startTime: new Date(row.start_time as string),
    endTime: new Date(row.end_time as string),
    reason: (row.reason as string) ?? undefined,
    createdBy: row.created_by as string,
    createdAt: new Date(row.created_at as string),
  };
}

export class PgUnavailableBlockRepository
  extends PgBaseRepository
  implements UnavailableBlockRepository
{
  constructor(pool: Pool) {
    super(pool);
  }

  async create(block: UnavailableBlock): Promise<UnavailableBlock> {
    return this.withTenant(block.tenantId, async (client) => {
      const result = await client.query(
        `INSERT INTO tech_unavailable_blocks (
          id, tenant_id, technician_id, start_time, end_time,
          reason, created_by, created_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        RETURNING *`,
        [
          block.id,
          block.tenantId,
          block.technicianId,
          block.startTime,
          block.endTime,
          block.reason ?? null,
          block.createdBy,
          block.createdAt,
        ],
      );
      return mapRow(result.rows[0] as Record<string, unknown>);
    });
  }

  async findByTechnician(
    tenantId: string,
    technicianId: string,
  ): Promise<UnavailableBlock[]> {
    return this.withTenant(tenantId, async (client) => {
      const result = await client.query(
        `SELECT * FROM tech_unavailable_blocks
         WHERE tenant_id = $1 AND technician_id = $2
         ORDER BY start_time ASC`,
        [tenantId, technicianId],
      );
      return result.rows.map((r) => mapRow(r as Record<string, unknown>));
    });
  }

  async findByTechnicianAndDateRange(
    tenantId: string,
    technicianId: string,
    start: Date,
    end: Date,
  ): Promise<UnavailableBlock[]> {
    return this.withTenant(tenantId, async (client) => {
      // Overlap predicate mirrors the in-memory impl: a block overlaps the
      // window when it starts before the window ends AND ends after the
      // window starts.
      const result = await client.query(
        `SELECT * FROM tech_unavailable_blocks
         WHERE tenant_id = $1 AND technician_id = $2
           AND start_time < $4 AND end_time > $3
         ORDER BY start_time ASC`,
        [tenantId, technicianId, start, end],
      );
      return result.rows.map((r) => mapRow(r as Record<string, unknown>));
    });
  }

  async delete(tenantId: string, id: string): Promise<boolean> {
    return this.withTenant(tenantId, async (client) => {
      const result = await client.query(
        `DELETE FROM tech_unavailable_blocks
         WHERE tenant_id = $1 AND id = $2`,
        [tenantId, id],
      );
      return (result.rowCount ?? 0) > 0;
    });
  }
}
