/**
 * D-044 / #1763 — when the owner dismissed the finished "Get found online"
 * checklist (`tenant_settings.get_found_online_dismissed_at`, migration 331).
 */
import type { Pool } from 'pg';
import { PgBaseRepository } from '../db/pg-base';

export interface GetFoundOnlineDismissalRepository {
  getDismissedAt(tenantId: string): Promise<Date | null>;
  /** False when the tenant has no settings row to record it on. */
  dismiss(tenantId: string, at: Date): Promise<boolean>;
}

export class InMemoryGetFoundOnlineDismissalRepository
  implements GetFoundOnlineDismissalRepository
{
  private readonly dismissed = new Map<string, Date>();

  async getDismissedAt(tenantId: string): Promise<Date | null> {
    return this.dismissed.get(tenantId) ?? null;
  }

  async dismiss(tenantId: string, at: Date): Promise<boolean> {
    this.dismissed.set(tenantId, at);
    return true;
  }
}

export class PgGetFoundOnlineDismissalRepository
  extends PgBaseRepository
  implements GetFoundOnlineDismissalRepository
{
  constructor(pool: Pool) {
    super(pool);
  }

  async getDismissedAt(tenantId: string): Promise<Date | null> {
    return this.withTenant(tenantId, async (client) => {
      const result = await client.query<{ get_found_online_dismissed_at: Date | null }>(
        `SELECT get_found_online_dismissed_at FROM tenant_settings WHERE tenant_id = $1`,
        [tenantId],
      );
      return result.rows[0]?.get_found_online_dismissed_at ?? null;
    });
  }

  async dismiss(tenantId: string, at: Date): Promise<boolean> {
    return this.withTenant(tenantId, async (client) => {
      const result = await client.query(
        `UPDATE tenant_settings
            SET get_found_online_dismissed_at = $2, updated_at = NOW()
          WHERE tenant_id = $1`,
        [tenantId, at],
      );
      return (result.rowCount ?? 0) > 0;
    });
  }
}
