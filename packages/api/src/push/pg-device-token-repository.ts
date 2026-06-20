import { Pool } from 'pg';
import { PgBaseRepository } from '../db/pg-base';
import {
  type DevicePlatform,
  type DeviceToken,
  type DeviceTokenRepository,
  type RegisterDeviceTokenInput,
} from './device-token-service';

interface DeviceTokenRow {
  id: string;
  tenant_id: string;
  user_id: string;
  expo_push_token: string;
  platform: string;
  created_at: Date;
  updated_at: Date;
}

function mapRow(row: DeviceTokenRow): DeviceToken {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    userId: row.user_id,
    expoPushToken: row.expo_push_token,
    platform: row.platform as DevicePlatform,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class PgDeviceTokenRepository extends PgBaseRepository implements DeviceTokenRepository {
  constructor(pool: Pool) {
    super(pool);
  }

  async register(input: RegisterDeviceTokenInput): Promise<DeviceToken> {
    const token = await this.withTenant(input.tenantId, async (client) => {
      const res = await client.query<DeviceTokenRow>(
        `INSERT INTO device_tokens (tenant_id, user_id, expo_push_token, platform)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (tenant_id, expo_push_token)
         DO UPDATE SET user_id = EXCLUDED.user_id,
                       platform = EXCLUDED.platform,
                       updated_at = NOW()
         RETURNING *`,
        [input.tenantId, input.userId, input.expoPushToken, input.platform],
      );
      return mapRow(res.rows[0]);
    });
    // Token-exclusive ownership: a physical device belongs to exactly one tenant
    // at a time. Drop this token from any OTHER tenant so a later sign-out (a
    // single tenant-scoped DELETE) can't leave a stale row that keeps pushing
    // the former tenant's notifications to a signed-out device.
    await this.removeFromOtherTenants(input.tenantId, input.expoPushToken);
    return token;
  }

  /**
   * Cross-tenant delete of an Expo token under every tenant except `tenantId`.
   * Runs under `app.system_lookup = 'true'` (migration 197) in a LOCAL-scoped
   * transaction so the GUC cannot leak to other pooled connections.
   */
  private async removeFromOtherTenants(tenantId: string, expoPushToken: string): Promise<void> {
    await this.withClient(async (client) => {
      await client.query('BEGIN');
      try {
        await client.query("SELECT set_config('app.system_lookup', 'true', true)");
        await client.query(
          `DELETE FROM device_tokens WHERE expo_push_token = $1 AND tenant_id <> $2`,
          [expoPushToken, tenantId],
        );
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      }
    });
  }

  async listByTenant(tenantId: string): Promise<DeviceToken[]> {
    return this.withTenant(tenantId, async (client) => {
      const res = await client.query<DeviceTokenRow>(
        `SELECT * FROM device_tokens WHERE tenant_id = $1 ORDER BY updated_at DESC`,
        [tenantId],
      );
      return res.rows.map(mapRow);
    });
  }

  async remove(tenantId: string, expoPushToken: string): Promise<boolean> {
    return this.withTenant(tenantId, async (client) => {
      const res = await client.query(
        `DELETE FROM device_tokens WHERE tenant_id = $1 AND expo_push_token = $2`,
        [tenantId, expoPushToken],
      );
      return (res.rowCount ?? 0) > 0;
    });
  }
}
