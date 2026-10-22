/**
 * #1737 — per-tenant, per-UTC-day web chat usage (`webchat_usage_daily`,
 * migration 341). The public path is unauthenticated, so every turn spends the
 * tenant's money without a human having asked for it: the daily turn and cost
 * caps are enforced here, atomically, before the model is called.
 */
import type { Pool } from 'pg';
import { PgBaseRepository } from '../db/pg-base';

export interface WebchatUsage {
  turns: number;
  /** Integer cents. */
  costCents: number;
}

export interface WebchatUsageRepository {
  /**
   * Atomically take one turn from today's allowance. False (and nothing
   * recorded) when the turn cap or the cost cap is already reached.
   */
  reserveTurn(
    tenantId: string,
    day: string,
    caps: { turnCap: number; costCapCents: number },
  ): Promise<boolean>;
  addCost(tenantId: string, day: string, costCents: number): Promise<void>;
  get(tenantId: string, day: string): Promise<WebchatUsage>;
}

/** UTC calendar day, `YYYY-MM-DD`. */
export function usageDay(now: Date): string {
  return now.toISOString().slice(0, 10);
}

export class InMemoryWebchatUsageRepository implements WebchatUsageRepository {
  private readonly rows = new Map<string, WebchatUsage>();
  private key(tenantId: string, day: string): string {
    return `${tenantId}|${day}`;
  }

  async reserveTurn(
    tenantId: string,
    day: string,
    caps: { turnCap: number; costCapCents: number },
  ): Promise<boolean> {
    const row = this.rows.get(this.key(tenantId, day)) ?? { turns: 0, costCents: 0 };
    if (row.turns >= caps.turnCap || row.costCents >= caps.costCapCents) return false;
    this.rows.set(this.key(tenantId, day), { turns: row.turns + 1, costCents: row.costCents });
    return true;
  }

  async addCost(tenantId: string, day: string, costCents: number): Promise<void> {
    const row = this.rows.get(this.key(tenantId, day)) ?? { turns: 0, costCents: 0 };
    this.rows.set(this.key(tenantId, day), { ...row, costCents: row.costCents + costCents });
  }

  async get(tenantId: string, day: string): Promise<WebchatUsage> {
    return { ...(this.rows.get(this.key(tenantId, day)) ?? { turns: 0, costCents: 0 }) };
  }
}

export class PgWebchatUsageRepository extends PgBaseRepository implements WebchatUsageRepository {
  constructor(pool: Pool) {
    super(pool);
  }

  async reserveTurn(
    tenantId: string,
    day: string,
    caps: { turnCap: number; costCapCents: number },
  ): Promise<boolean> {
    return this.withTenant(tenantId, async (client) => {
      // One statement: insert today's row, or bump it only while under both caps.
      const result = await client.query(
        `INSERT INTO webchat_usage_daily (tenant_id, day, turns, cost_cents)
         SELECT $1::uuid, $2::date, 1, 0 WHERE $3::int > 0 AND $4::int > 0
         ON CONFLICT (tenant_id, day) DO UPDATE
           SET turns = webchat_usage_daily.turns + 1
           WHERE webchat_usage_daily.turns < $3::int AND webchat_usage_daily.cost_cents < $4::int
         RETURNING turns`,
        [tenantId, day, caps.turnCap, caps.costCapCents],
      );
      return (result.rowCount ?? 0) > 0;
    });
  }

  async addCost(tenantId: string, day: string, costCents: number): Promise<void> {
    if (costCents <= 0) return;
    await this.withTenant(tenantId, async (client) => {
      await client.query(
        `INSERT INTO webchat_usage_daily (tenant_id, day, turns, cost_cents)
         VALUES ($1, $2::date, 0, $3::int)
         ON CONFLICT (tenant_id, day) DO UPDATE
           SET cost_cents = webchat_usage_daily.cost_cents + $3::int`,
        [tenantId, day, costCents],
      );
    });
  }

  async get(tenantId: string, day: string): Promise<WebchatUsage> {
    return this.withTenant(tenantId, async (client) => {
      const result = await client.query<{ turns: number; cost_cents: number }>(
        `SELECT turns, cost_cents FROM webchat_usage_daily WHERE tenant_id = $1 AND day = $2::date`,
        [tenantId, day],
      );
      const row = result.rows[0];
      return { turns: row?.turns ?? 0, costCents: row?.cost_cents ?? 0 };
    });
  }
}
