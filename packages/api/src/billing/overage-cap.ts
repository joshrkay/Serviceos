/**
 * The owner's AI-minute overage cap. Unset means the default of one plan
 * price per period; an owner may raise or lower it, or remove it entirely.
 * Read by settlement (what is charged) and the voice gate (when calls start
 * forwarding to the owner).
 */
import type { Pool } from 'pg';
import { PgBaseRepository } from '../db/pg-base';

/** undefined = plan-price default, null = no cap, number = cap in cents. */
export type OverageCapCents = number | null | undefined;

export interface OverageCapStore {
  get(tenantId: string): Promise<OverageCapCents>;
}

export class PgOverageCapStore extends PgBaseRepository implements OverageCapStore {
  constructor(pool: Pool) {
    super(pool);
  }

  async get(tenantId: string): Promise<OverageCapCents> {
    return this.withTenant(tenantId, async (client) => {
      const res = await client.query<{
        ai_overage_cap_cents: number | null;
        ai_overage_uncapped: boolean | null;
      }>(
        `SELECT ai_overage_cap_cents, ai_overage_uncapped FROM tenant_settings WHERE tenant_id = $1`,
        [tenantId],
      );
      const row = res.rows[0];
      if (row?.ai_overage_uncapped) return null;
      return row?.ai_overage_cap_cents ?? undefined;
    });
  }

  /** A non-negative integer cap in cents, or null to remove the cap. */
  async set(tenantId: string, capCents: number | null): Promise<void> {
    if (capCents !== null && (!Number.isSafeInteger(capCents) || capCents < 0)) {
      throw new RangeError('capCents must be a non-negative integer or null');
    }
    await this.withTenant(tenantId, async (client) => {
      const updated = await client.query(
        `UPDATE tenant_settings
            SET ai_overage_cap_cents = $2, ai_overage_uncapped = $3, updated_at = NOW()
          WHERE tenant_id = $1`,
        [tenantId, capCents, capCents === null],
      );
      if (!updated.rowCount) {
        throw new Error(`No tenant_settings row for tenant ${tenantId}`);
      }
    });
  }
}
