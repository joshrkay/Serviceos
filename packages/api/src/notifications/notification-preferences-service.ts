/**
 * U10 — per-user owner-notification preferences (opt-out by category).
 *
 * Opt-out model: the ABSENCE of a row means the notification is enabled, so a
 * fresh tenant receives everything and a row is written only when a user mutes
 * a category. The owner-notification fan-out consults `listMutedUserIds` at send
 * time to drop muted recipients; the settings UI reads/writes via the service.
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
  /** Explicit rows for a user (absence of a type = enabled). */
  listForUser(tenantId: string, userId: string): Promise<NotificationPreference[]>;
  /** Upsert a single (user, type) enabled flag. */
  setEnabled(
    tenantId: string,
    userId: string,
    type: NotificationType,
    enabled: boolean,
  ): Promise<void>;
  /** User ids in the tenant who have MUTED `type` (enabled = false). */
  listMutedUserIds(tenantId: string, type: NotificationType): Promise<Set<string>>;
}

/**
 * Effective preference for every notification type for one user — explicit
 * rows merged over the default-enabled baseline. Drives the settings UI so the
 * owner sees a full, toggleable list rather than only the categories they have
 * already touched.
 */
export async function effectivePreferences(
  repo: Pick<NotificationPreferenceRepository, 'listForUser'>,
  tenantId: string,
  userId: string,
): Promise<Record<NotificationType, boolean>> {
  const explicit = new Map<NotificationType, boolean>();
  for (const row of await repo.listForUser(tenantId, userId)) {
    explicit.set(row.notificationType, row.enabled);
  }
  const out = {} as Record<NotificationType, boolean>;
  for (const type of NOTIFICATION_TYPES) {
    out[type] = explicit.get(type) ?? true; // absent → enabled
  }
  return out;
}

export class InMemoryNotificationPreferenceRepository
  implements NotificationPreferenceRepository
{
  /** key = `${tenantId}|${userId}|${type}` */
  private readonly rows = new Map<string, NotificationPreference>();

  private key(tenantId: string, userId: string, type: NotificationType): string {
    return `${tenantId}|${userId}|${type}`;
  }

  async listForUser(tenantId: string, userId: string): Promise<NotificationPreference[]> {
    return [...this.rows.values()].filter(
      (r) => r.tenantId === tenantId && r.userId === userId,
    );
  }

  async setEnabled(
    tenantId: string,
    userId: string,
    type: NotificationType,
    enabled: boolean,
  ): Promise<void> {
    this.rows.set(this.key(tenantId, userId, type), {
      tenantId,
      userId,
      notificationType: type,
      enabled,
    });
  }

  async listMutedUserIds(tenantId: string, type: NotificationType): Promise<Set<string>> {
    const ids = new Set<string>();
    for (const r of this.rows.values()) {
      if (r.tenantId === tenantId && r.notificationType === type && !r.enabled) {
        ids.add(r.userId);
      }
    }
    return ids;
  }
}
