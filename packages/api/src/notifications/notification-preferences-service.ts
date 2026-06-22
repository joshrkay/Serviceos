/**
 * U10 — per-user notification preferences (opt-out by category).
 *
 * Default-ON: the ABSENCE of a row means the category is enabled, so a fresh
 * user receives every push until they explicitly mute one. The
 * OwnerNotificationService consults `listMutedUserIds(tenant, type)` to drop
 * muted recipients before sending; the settings UI reads/writes via `listByUser`
 * / `set`.
 */
import {
  NOTIFICATION_TYPES,
  type NotificationType,
} from '@ai-service-os/shared';

export interface NotificationPreference {
  tenantId: string;
  userId: string;
  notificationType: NotificationType;
  enabled: boolean;
}

export interface NotificationPreferenceRepository {
  /** Every explicit preference row for a user (absent types are enabled). */
  listByUser(tenantId: string, userId: string): Promise<NotificationPreference[]>;
  /** Upsert one (tenant,user,type) preference; returns the stored row. */
  set(
    tenantId: string,
    userId: string,
    notificationType: NotificationType,
    enabled: boolean,
  ): Promise<NotificationPreference>;
  /** User ids (within the tenant) who have explicitly DISABLED `type`. */
  listMutedUserIds(tenantId: string, notificationType: NotificationType): Promise<Set<string>>;
}

export function isNotificationType(value: unknown): value is NotificationType {
  return typeof value === 'string' && (NOTIFICATION_TYPES as readonly string[]).includes(value);
}

/**
 * Merge a user's explicit rows over the default-on baseline into a full
 * `{ [type]: enabled }` map for the settings UI. Pure — unit-tested.
 */
export function toPreferenceMap(
  rows: NotificationPreference[],
): Record<NotificationType, boolean> {
  const map = {} as Record<NotificationType, boolean>;
  for (const type of NOTIFICATION_TYPES) map[type] = true; // default-on
  for (const row of rows) map[row.notificationType] = row.enabled;
  return map;
}

export class InMemoryNotificationPreferenceRepository
  implements NotificationPreferenceRepository
{
  /** key: `${tenantId}::${userId}::${type}` */
  private readonly rows = new Map<string, NotificationPreference>();

  private key(tenantId: string, userId: string, type: NotificationType): string {
    return `${tenantId}::${userId}::${type}`;
  }

  async listByUser(tenantId: string, userId: string): Promise<NotificationPreference[]> {
    return Array.from(this.rows.values())
      .filter((r) => r.tenantId === tenantId && r.userId === userId)
      .map((r) => ({ ...r }));
  }

  async set(
    tenantId: string,
    userId: string,
    notificationType: NotificationType,
    enabled: boolean,
  ): Promise<NotificationPreference> {
    const row: NotificationPreference = { tenantId, userId, notificationType, enabled };
    this.rows.set(this.key(tenantId, userId, notificationType), row);
    return { ...row };
  }

  async listMutedUserIds(
    tenantId: string,
    notificationType: NotificationType,
  ): Promise<Set<string>> {
    const muted = new Set<string>();
    for (const r of this.rows.values()) {
      if (r.tenantId === tenantId && r.notificationType === notificationType && !r.enabled) {
        muted.add(r.userId);
      }
    }
    return muted;
  }
}
