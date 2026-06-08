import { Pool } from 'pg';
import { PgBaseRepository } from '../db/pg-base';
import {
  ActiveEntryConflictError,
  TimeEntry,
  TimeEntryListOptions,
  TimeEntryRepository,
} from './time-entry';

/**
 * P12-002 — Pg-backed time-entry repository. Tenant scoping is enforced
 * via RLS + an explicit `tenant_id = $1` predicate on every query
 * (defense-in-depth per repository-conventions.md).
 *
 * The partial UNIQUE index on (tenant_id, user_id) WHERE clocked_out_at
 * IS NULL surfaces concurrent clock-ins as Postgres error code 23505;
 * `create()` translates that into ActiveEntryConflictError so the
 * service layer can decide whether to retry (close-then-create).
 */
function mapRow(row: Record<string, unknown>): TimeEntry {
  return {
    id: row.id as string,
    tenantId: row.tenant_id as string,
    userId: row.user_id as string,
    jobId: (row.job_id as string) ?? undefined,
    entryType: row.entry_type as TimeEntry['entryType'],
    clockedInAt: new Date(row.clocked_in_at as string),
    clockedOutAt: row.clocked_out_at
      ? new Date(row.clocked_out_at as string)
      : undefined,
    durationMinutes:
      row.duration_minutes !== null && row.duration_minutes !== undefined
        ? (row.duration_minutes as number)
        : undefined,
    notes: (row.notes as string) ?? undefined,
    createdAt: new Date(row.created_at as string),
    updatedAt: new Date(row.updated_at as string),
  };
}

interface PgError {
  code?: string;
}

function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as PgError).code === '23505';
}

export class PgTimeEntryRepository extends PgBaseRepository implements TimeEntryRepository {
  constructor(pool: Pool) {
    super(pool);
  }

  async create(entry: TimeEntry): Promise<TimeEntry> {
    return this.withTenant(entry.tenantId, async (client) => {
      try {
        const result = await client.query(
          `INSERT INTO time_entries (
            id, tenant_id, user_id, job_id, entry_type,
            clocked_in_at, clocked_out_at, duration_minutes, notes,
            created_at, updated_at
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
          RETURNING *`,
          [
            entry.id,
            entry.tenantId,
            entry.userId,
            entry.jobId ?? null,
            entry.entryType,
            entry.clockedInAt,
            entry.clockedOutAt ?? null,
            entry.durationMinutes ?? null,
            entry.notes ?? null,
            entry.createdAt,
            entry.updatedAt,
          ]
        );
        return mapRow(result.rows[0]);
      } catch (err) {
        if (isUniqueViolation(err)) {
          throw new ActiveEntryConflictError(entry.userId);
        }
        throw err;
      }
    });
  }

  async findById(tenantId: string, id: string): Promise<TimeEntry | null> {
    return this.withTenant(tenantId, async (client) => {
      const result = await client.query(
        `SELECT * FROM time_entries WHERE tenant_id = $1 AND id = $2`,
        [tenantId, id]
      );
      return result.rows.length > 0 ? mapRow(result.rows[0]) : null;
    });
  }

  async findActiveByUser(tenantId: string, userId: string): Promise<TimeEntry | null> {
    return this.withTenant(tenantId, async (client) => {
      const result = await client.query(
        `SELECT * FROM time_entries
         WHERE tenant_id = $1 AND user_id = $2 AND clocked_out_at IS NULL
         LIMIT 1`,
        [tenantId, userId]
      );
      return result.rows.length > 0 ? mapRow(result.rows[0]) : null;
    });
  }

  async findByJob(tenantId: string, jobId: string): Promise<TimeEntry[]> {
    return this.withTenant(tenantId, async (client) => {
      const result = await client.query(
        `SELECT * FROM time_entries
         WHERE tenant_id = $1 AND job_id = $2
         ORDER BY clocked_in_at ASC`,
        [tenantId, jobId]
      );
      return result.rows.map(mapRow);
    });
  }

  async findByTenant(
    tenantId: string,
    options?: TimeEntryListOptions
  ): Promise<TimeEntry[]> {
    return this.withTenant(tenantId, async (client) => {
      const conditions: string[] = ['tenant_id = $1'];
      const params: unknown[] = [tenantId];
      let i = 2;
      if (options?.userId) {
        conditions.push(`user_id = $${i++}`);
        params.push(options.userId);
      }
      if (options?.activeOnly) {
        conditions.push('clocked_out_at IS NULL');
      }
      if (options?.weekStart) {
        conditions.push(`clocked_in_at >= $${i++}`);
        params.push(options.weekStart);
      }
      if (options?.weekEnd) {
        conditions.push(`clocked_in_at < $${i++}`);
        params.push(options.weekEnd);
      }
      let sql = `SELECT * FROM time_entries WHERE ${conditions.join(' AND ')}
        ORDER BY clocked_in_at DESC`;
      if (options?.limit !== undefined) {
        sql += ` LIMIT $${i++}`;
        params.push(options.limit);
      }
      const result = await client.query(sql, params);
      return result.rows.map(mapRow);
    });
  }

  async close(
    tenantId: string,
    id: string,
    update: { clockedOutAt: Date; durationMinutes: number; notes?: string }
  ): Promise<TimeEntry | null> {
    return this.withTenant(tenantId, async (client) => {
      // Atomic, idempotent close: the WHERE-clause guard on
      // clocked_out_at IS NULL means two concurrent closes can't both
      // win — only the first sees a non-zero row count. The second
      // close falls through to the SELECT and returns the already-
      // closed row.
      const result = await client.query(
        `UPDATE time_entries
         SET clocked_out_at = $3,
             duration_minutes = $4,
             notes = COALESCE($5, notes),
             updated_at = NOW()
         WHERE tenant_id = $1 AND id = $2 AND clocked_out_at IS NULL
         RETURNING *`,
        [tenantId, id, update.clockedOutAt, update.durationMinutes, update.notes ?? null]
      );
      if (result.rows.length > 0) return mapRow(result.rows[0]);

      const existing = await client.query(
        `SELECT * FROM time_entries WHERE tenant_id = $1 AND id = $2`,
        [tenantId, id]
      );
      return existing.rows.length > 0 ? mapRow(existing.rows[0]) : null;
    });
  }
}
