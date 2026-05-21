import { Pool } from 'pg';
import { PgBaseRepository } from '../../db/pg-base';
import type { TechStatus } from '@ai-service-os/shared';

/**
 * P6-028 — daily idempotency key for the tech "I'm out today" SMS
 * (migration 117: `tech_status_today`).
 *
 * The PK is (tenant_id, technician_id, local_date) where `local_date` is the
 * tech's TENANT-LOCAL calendar date. Two consequences fall out of the PK with
 * zero extra machinery:
 *
 *   • Idempotency — a second OUT reply on the same local day conflicts on the
 *     PK, so `claimToday` returns `false` and the handler short-circuits (no
 *     duplicate unavailable-block, no duplicate proposals).
 *   • "Midnight clear" — a new tenant-local day simply has no row for that
 *     `local_date`, so `claimToday` succeeds again. No cron, no sweep.
 */

export interface TechStatusTodayRow {
  tenantId: string;
  technicianId: string;
  /** Tenant-local calendar date, YYYY-MM-DD. */
  localDate: string;
  status: TechStatus;
  sourceMessageSid: string;
  recordedAt: Date;
}

export interface ClaimTodayInput {
  tenantId: string;
  technicianId: string;
  localDate: string;
  status: TechStatus;
  sourceMessageSid: string;
}

export interface TechStatusTodayRepository {
  /**
   * Attempt to claim the day for this technician. Returns `true` when this is
   * the first claim for (tenant, technician, local_date) — the caller should
   * proceed with the side-effects. Returns `false` when a row already exists
   * (a repeat OUT the same day) — the caller must treat it as a no-op.
   *
   * The claim is atomic: in Postgres it is a single INSERT ... ON CONFLICT DO
   * NOTHING, so concurrent inbound messages for the same day cannot both win.
   */
  claimToday(input: ClaimTodayInput): Promise<boolean>;
  /** Read the current claim, if any. Used by tests + diagnostics. */
  findToday(
    tenantId: string,
    technicianId: string,
    localDate: string,
  ): Promise<TechStatusTodayRow | null>;
}

export class InMemoryTechStatusTodayRepository
  implements TechStatusTodayRepository
{
  private rows = new Map<string, TechStatusTodayRow>();

  private key(tenantId: string, technicianId: string, localDate: string): string {
    return `${tenantId}::${technicianId}::${localDate}`;
  }

  async claimToday(input: ClaimTodayInput): Promise<boolean> {
    const k = this.key(input.tenantId, input.technicianId, input.localDate);
    if (this.rows.has(k)) return false;
    this.rows.set(k, {
      tenantId: input.tenantId,
      technicianId: input.technicianId,
      localDate: input.localDate,
      status: input.status,
      sourceMessageSid: input.sourceMessageSid,
      recordedAt: new Date(),
    });
    return true;
  }

  async findToday(
    tenantId: string,
    technicianId: string,
    localDate: string,
  ): Promise<TechStatusTodayRow | null> {
    return this.rows.get(this.key(tenantId, technicianId, localDate)) ?? null;
  }
}

function mapRow(row: Record<string, unknown>): TechStatusTodayRow {
  return {
    tenantId: row.tenant_id as string,
    technicianId: row.technician_id as string,
    localDate: row.local_date instanceof Date
      ? (row.local_date as Date).toISOString().slice(0, 10)
      : String(row.local_date),
    status: row.status as TechStatus,
    sourceMessageSid: row.source_message_sid as string,
    recordedAt: new Date(row.recorded_at as string),
  };
}

export class PgTechStatusTodayRepository
  extends PgBaseRepository
  implements TechStatusTodayRepository
{
  constructor(pool: Pool) {
    super(pool);
  }

  async claimToday(input: ClaimTodayInput): Promise<boolean> {
    return this.withTenantTransaction(input.tenantId, async (client) => {
      // INSERT ... ON CONFLICT DO NOTHING is the atomic claim: the PK
      // (tenant_id, technician_id, local_date) makes the second OUT-of-day a
      // no-op. rowCount === 1 means we won the claim; 0 means an existing row.
      const result = await client.query(
        `INSERT INTO tech_status_today (
          tenant_id, technician_id, local_date, status, source_message_sid
        ) VALUES ($1, $2, $3, $4, $5)
        ON CONFLICT (tenant_id, technician_id, local_date) DO NOTHING`,
        [
          input.tenantId,
          input.technicianId,
          input.localDate,
          input.status,
          input.sourceMessageSid,
        ],
      );
      return (result.rowCount ?? 0) > 0;
    });
  }

  async findToday(
    tenantId: string,
    technicianId: string,
    localDate: string,
  ): Promise<TechStatusTodayRow | null> {
    return this.withTenant(tenantId, async (client) => {
      const result = await client.query(
        `SELECT * FROM tech_status_today
         WHERE tenant_id = $1 AND technician_id = $2 AND local_date = $3`,
        [tenantId, technicianId, localDate],
      );
      if (result.rows.length === 0) return null;
      return mapRow(result.rows[0] as Record<string, unknown>);
    });
  }
}
