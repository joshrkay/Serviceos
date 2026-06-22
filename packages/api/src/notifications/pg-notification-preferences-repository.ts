import { Pool } from 'pg';
import { PgBaseRepository } from '../db/pg-base';
import { type NotificationType } from '@ai-service-os/shared';
import {
  type NotificationPreference,
  type NotificationPreferenceRepository,
} from './notification-preferences-service';

interface PreferenceRow {
  tenant_id: string;
  user_id: string;
  notification_type: string;
  enabled: boolean;
}

function mapRow(row: PreferenceRow): NotificationPreference {
  return {
    tenantId: row.tenant_id,
    userId: row.user_id,
    notificationType: row.notification_type as NotificationType,
    enabled: row.enabled,
  };
}

export class PgNotificationPreferenceRepository
  extends PgBaseRepository
  implements NotificationPreferenceRepository
{
  constructor(pool: Pool) {
    super(pool);
  }

  async listByUser(tenantId: string, userId: string): Promise<NotificationPreference[]> {
    return this.withTenant(tenantId, async (client) => {
      const res = await client.query<PreferenceRow>(
        `SELECT tenant_id, user_id, notification_type, enabled
         FROM notification_preferences
         WHERE tenant_id = $1 AND user_id = $2`,
        [tenantId, userId],
      );
      return res.rows.map(mapRow);
    });
  }

  async set(
    tenantId: string,
    userId: string,
    notificationType: NotificationType,
    enabled: boolean,
  ): Promise<NotificationPreference> {
    return this.withTenant(tenantId, async (client) => {
      const res = await client.query<PreferenceRow>(
        `INSERT INTO notification_preferences (tenant_id, user_id, notification_type, enabled)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (tenant_id, user_id, notification_type)
         DO UPDATE SET enabled = EXCLUDED.enabled, updated_at = NOW()
         RETURNING tenant_id, user_id, notification_type, enabled`,
        [tenantId, userId, notificationType, enabled],
      );
      return mapRow(res.rows[0]);
    });
  }

  async listMutedUserIds(
    tenantId: string,
    notificationType: NotificationType,
  ): Promise<Set<string>> {
    return this.withTenant(tenantId, async (client) => {
      const res = await client.query<{ user_id: string }>(
        `SELECT user_id FROM notification_preferences
         WHERE tenant_id = $1 AND notification_type = $2 AND enabled = false`,
        [tenantId, notificationType],
      );
      return new Set(res.rows.map((r) => r.user_id));
    });
  }
}
