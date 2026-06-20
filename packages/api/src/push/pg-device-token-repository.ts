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
    return this.withTenant(input.tenantId, async (client) => {
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
