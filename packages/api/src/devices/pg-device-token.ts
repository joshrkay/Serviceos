/**
 * Postgres-backed device push-token repository (`device_push_tokens`,
 * migration 196). Tenant-scoped via RLS.
 *
 * Every statement runs through `withTenant`, so it joins the per-request
 * tenant transaction when one exists and sets `app.current_tenant_id` on its
 * own connection otherwise. The previous inline `pool.query` version claimed
 * to run inside that transaction but did not — it took a raw pool connection
 * with no GUC, which the table's FORCE ROW LEVEL SECURITY policy rejects.
 */
import { Pool } from 'pg';
import { PgBaseRepository } from '../db/pg-base';
import { DevicePlatform, DeviceToken, DeviceTokenService } from './device-token';

export class PgDeviceTokenRepository
  extends PgBaseRepository
  implements DeviceTokenService
{
  constructor(pool: Pool) {
    super(pool);
  }

  async upsert(
    tenantId: string,
    clerkUserId: string,
    expoPushToken: string,
    platform: DevicePlatform,
  ): Promise<void> {
    await this.withTenant(tenantId, async (client) => {
      await client.query(
        `INSERT INTO device_push_tokens (tenant_id, clerk_user_id, expo_push_token, platform)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (tenant_id, clerk_user_id, expo_push_token)
         DO UPDATE SET platform = EXCLUDED.platform, updated_at = NOW()`,
        [tenantId, clerkUserId, expoPushToken, platform],
      );
    });
  }

  async remove(tenantId: string, clerkUserId: string, expoPushToken: string): Promise<void> {
    await this.withTenant(tenantId, async (client) => {
      await client.query(
        `DELETE FROM device_push_tokens
         WHERE tenant_id = $1 AND clerk_user_id = $2 AND expo_push_token = $3`,
        [tenantId, clerkUserId, expoPushToken],
      );
    });
  }

  async listByTenant(tenantId: string): Promise<DeviceToken[]> {
    return this.withTenant(tenantId, async (client) => {
      const result = await client.query(
        `SELECT clerk_user_id, expo_push_token, platform
           FROM device_push_tokens
          WHERE tenant_id = $1
          ORDER BY updated_at DESC`,
        [tenantId],
      );
      return result.rows.map((row: Record<string, unknown>) => ({
        clerkUserId: row.clerk_user_id as string,
        expoPushToken: row.expo_push_token as string,
        platform: row.platform as DevicePlatform,
      }));
    });
  }

  async pruneStale(tenantId: string, olderThanDays: number): Promise<number> {
    return this.withTenant(tenantId, async (client) => {
      const result = await client.query(
        // make_interval over string concatenation: explicit int typing, immune
        // to a caller passing something non-numeric.
        `DELETE FROM device_push_tokens
          WHERE tenant_id = $1
            AND updated_at < NOW() - make_interval(days => $2::int)`,
        [tenantId, olderThanDays],
      );
      return result.rowCount ?? 0;
    });
  }
}
