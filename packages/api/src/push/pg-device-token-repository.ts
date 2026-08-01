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
    // Both the upsert and the token-exclusive cross-tenant cleanup run on ONE
    // request-scoped transaction/client. Using a second pool checkout (the old
    // withClient path) deadlocked at DB_MAX_CONNECTIONS=1 — the request already
    // holds its client until res.finish, so the second connect() never
    // resolves. withTenantTransaction reuses the request client when present
    // (and sets app.current_tenant_id, so the RLS policy's UUID cast never sees
    // an empty GUC).
    return this.withTenantTransaction(input.tenantId, async (client) => {
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
      // Token-exclusive ownership: a physical device belongs to exactly one
      // tenant at a time, so drop this token from every OTHER tenant — otherwise
      // a later sign-out (a single tenant-scoped DELETE) leaves a stale row that
      // keeps pushing the former tenant's notifications to a signed-out device.
      // app.system_lookup (transaction-local) opens the cross-tenant DELETE via
      // the device_tokens RLS escape hatch and is auto-cleared at COMMIT; the
      // explicit reset keeps the rest of the request transaction tenant-scoped.
      await client.query("SELECT set_config('app.system_lookup', 'true', true)");
      try {
        await client.query(
          `DELETE FROM device_tokens WHERE expo_push_token = $1 AND tenant_id <> $2`,
          [input.expoPushToken, input.tenantId],
        );
      } finally {
        await client
          .query("SELECT set_config('app.system_lookup', '', true)")
          .catch(() => undefined);
      }
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

  async removeAllForUser(tenantId: string, userId: string): Promise<number> {
    return this.withTenant(tenantId, async (client) => {
      const res = await client.query(
        `DELETE FROM device_tokens WHERE tenant_id = $1 AND user_id = $2`,
        [tenantId, userId],
      );
      return res.rowCount ?? 0;
    });
  }
}
