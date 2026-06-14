/**
 * Ledger for the weekly HFCR owner summary (hfcr_weekly_sends).
 *
 * One row per (tenant, week_starting_date) — the DB UNIQUE constraint is the
 * idempotency source of truth, so a re-run of the weekly sweep (or two
 * concurrent app instances) sends exactly one owner SMS per week. A losing
 * insert surfaces as PG code 23505, which the worker treats as "already sent".
 */
import { Pool } from 'pg';
import { PgBaseRepository } from '../db/pg-base';

export interface HfcrWeeklySend {
  id: string;
  tenantId: string;
  /** UTC Monday the summarized week started, as 'YYYY-MM-DD'. */
  weekStartingDate: string;
  hfcrCents: number;
  recoveredCallCount: number;
  sentAt: Date;
}

export interface HfcrWeeklySendRepository {
  findByWeek(tenantId: string, weekStartingDate: string): Promise<HfcrWeeklySend | null>;
  /**
   * Insert a weekly-send row. Throws an error with `code === '23505'` when a
   * row already exists for (tenantId, weekStartingDate), so the worker can
   * treat the race as a no-op exactly like the dunning ledger.
   */
  create(row: HfcrWeeklySend): Promise<HfcrWeeklySend>;
}

/** Normalize a DB date value (node-pg may hand back a Date or a string) to 'YYYY-MM-DD'. */
function toDateString(value: unknown): string {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).slice(0, 10);
}

function mapRow(row: Record<string, unknown>): HfcrWeeklySend {
  return {
    id: row.id as string,
    tenantId: row.tenant_id as string,
    weekStartingDate: toDateString(row.week_starting_date),
    hfcrCents: Number(row.hfcr_cents),
    recoveredCallCount: Number(row.recovered_call_count),
    sentAt: new Date(row.sent_at as string),
  };
}

export class PgHfcrWeeklySendRepository
  extends PgBaseRepository
  implements HfcrWeeklySendRepository
{
  constructor(pool: Pool) {
    super(pool);
  }

  async findByWeek(
    tenantId: string,
    weekStartingDate: string,
  ): Promise<HfcrWeeklySend | null> {
    return this.withTenant(tenantId, async (client) => {
      const result = await client.query(
        'SELECT * FROM hfcr_weekly_sends WHERE tenant_id = $1 AND week_starting_date = $2',
        [tenantId, weekStartingDate],
      );
      return result.rows.length > 0 ? mapRow(result.rows[0]) : null;
    });
  }

  async create(row: HfcrWeeklySend): Promise<HfcrWeeklySend> {
    return this.withTenant(row.tenantId, async (client) => {
      const result = await client.query(
        `INSERT INTO hfcr_weekly_sends (
          id, tenant_id, week_starting_date, hfcr_cents, recovered_call_count, sent_at
        ) VALUES ($1, $2, $3, $4, $5, $6)
        RETURNING *`,
        [
          row.id,
          row.tenantId,
          row.weekStartingDate,
          row.hfcrCents,
          row.recoveredCallCount,
          row.sentAt,
        ],
      );
      return mapRow(result.rows[0]);
    });
  }
}

export class InMemoryHfcrWeeklySendRepository implements HfcrWeeklySendRepository {
  private rows = new Map<string, HfcrWeeklySend>();

  private key(tenantId: string, weekStartingDate: string): string {
    return `${tenantId}::${weekStartingDate}`;
  }

  async findByWeek(
    tenantId: string,
    weekStartingDate: string,
  ): Promise<HfcrWeeklySend | null> {
    const r = this.rows.get(this.key(tenantId, weekStartingDate));
    return r ? { ...r } : null;
  }

  async create(row: HfcrWeeklySend): Promise<HfcrWeeklySend> {
    const k = this.key(row.tenantId, row.weekStartingDate);
    if (this.rows.has(k)) {
      const err: Error & { code?: string } = new Error(
        `duplicate hfcr_weekly_send for ${k}`,
      );
      err.code = '23505'; // PG unique_violation
      throw err;
    }
    this.rows.set(k, { ...row });
    return { ...row };
  }
}
