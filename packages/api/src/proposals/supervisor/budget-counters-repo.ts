/**
 * Rivet P2 F-1 — tenant_budget_counters repository (migration 167).
 *
 * Fixed-window accumulators backing the supervisor budget caps:
 *   - DAILY_SPEND_COUNTER_KEY    : executed money-class spend, integer
 *     cents, one row per UTC day (window_start = utcDayWindowStart).
 *   - AUTO_APPROVALS_COUNTER_KEY : machine auto-approvals, one row per
 *     UTC hour (window_start = utcHourWindowStart).
 *
 * Windows are UTC truncations in v1 — deliberately NOT tenant-local
 * (the codebase stores UTC; rendering in tenant tz is a display
 * concern). A tenant-tz day boundary can land mid-window; revisit only
 * if owners report cap surprise around midnight. Increments use
 * INSERT .. ON CONFLICT value = value + delta so concurrent writers
 * across instances never lose updates.
 */
import { Pool } from 'pg';
import { PgBaseRepository } from '../../db/pg-base';

/** Executed money-class spend per UTC day, integer cents. */
export const DAILY_SPEND_COUNTER_KEY = 'daily_spend_cents';
/** Machine auto-approvals per UTC hour. */
export const AUTO_APPROVALS_COUNTER_KEY = 'auto_approvals';

/** Truncate to 00:00:00.000 UTC of the same UTC calendar day. */
export function utcDayWindowStart(now: Date): Date {
  const d = new Date(now.getTime());
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

/** Truncate to the top of the current UTC hour. */
export function utcHourWindowStart(now: Date): Date {
  const d = new Date(now.getTime());
  d.setUTCMinutes(0, 0, 0);
  return d;
}

export interface TenantBudgetCounterRepository {
  /** Add `by` to the (tenant, key, window) counter, creating it at `by` when absent. */
  increment(tenantId: string, counterKey: string, windowStart: Date, by: number): Promise<void>;
  /** Current value of the (tenant, key, window) counter; 0 when absent. */
  read(tenantId: string, counterKey: string, windowStart: Date): Promise<number>;
}

export class PgTenantBudgetCounterRepository
  extends PgBaseRepository
  implements TenantBudgetCounterRepository
{
  constructor(pool: Pool) {
    super(pool);
  }

  async increment(
    tenantId: string,
    counterKey: string,
    windowStart: Date,
    by: number,
  ): Promise<void> {
    await this.withTenant(tenantId, async (client) => {
      await client.query(
        `INSERT INTO tenant_budget_counters (tenant_id, counter_key, window_start, value)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (tenant_id, counter_key, window_start)
         DO UPDATE SET value = tenant_budget_counters.value + EXCLUDED.value`,
        [tenantId, counterKey, windowStart, by],
      );
    });
  }

  async read(tenantId: string, counterKey: string, windowStart: Date): Promise<number> {
    return this.withTenant(tenantId, async (client) => {
      const result = await client.query(
        `SELECT value
           FROM tenant_budget_counters
          WHERE tenant_id = $1 AND counter_key = $2 AND window_start = $3`,
        [tenantId, counterKey, windowStart],
      );
      if (result.rows.length === 0) return 0;
      // BIGINT comes back from pg as a string.
      return Number(result.rows[0].value);
    });
  }
}

export class InMemoryTenantBudgetCounterRepository implements TenantBudgetCounterRepository {
  private counters = new Map<string, number>();

  private key(tenantId: string, counterKey: string, windowStart: Date): string {
    return `${tenantId}:${counterKey}:${windowStart.toISOString()}`;
  }

  async increment(
    tenantId: string,
    counterKey: string,
    windowStart: Date,
    by: number,
  ): Promise<void> {
    const k = this.key(tenantId, counterKey, windowStart);
    this.counters.set(k, (this.counters.get(k) ?? 0) + by);
  }

  async read(tenantId: string, counterKey: string, windowStart: Date): Promise<number> {
    return this.counters.get(this.key(tenantId, counterKey, windowStart)) ?? 0;
  }
}
