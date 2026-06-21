/**
 * `GET /api/notification-preferences` — the authenticated user's effective
 * mute settings (every notification type with its enabled flag; absent = on).
 * `PUT /api/notification-preferences` — set one category enabled/disabled.
 *
 * Per-user + tenant-scoped (RLS). A mutation emits a
 * `notification.preferences.updated` audit event. The owner-notification
 * fan-out reads these at send time to drop muted recipients (U10).
 */
import { Router, Response } from 'express';
import { NOTIFICATION_TYPES, type NotificationType } from '@ai-service-os/shared';
import { AuthenticatedRequest } from '../auth/clerk';
import { requireAuth, requireTenant } from '../middleware/auth';
import { AuditRepository, createAuditEvent } from '../audit/audit';
import {
  effectivePreferences,
  type NotificationPreferenceRepository,
} from '../notifications/notification-preferences-service';

function isNotificationType(value: unknown): value is NotificationType {
  return typeof value === 'string' && (NOTIFICATION_TYPES as readonly string[]).includes(value);
}

export function createNotificationPreferencesRouter(
  repo: NotificationPreferenceRepository,
  auditRepo: AuditRepository,
): Router {
  const router = Router();

  router.get('/', requireAuth, requireTenant, async (req: AuthenticatedRequest, res: Response) => {
    try {
      const auth = req.auth!;
      const preferences = await effectivePreferences(repo, auth.tenantId, auth.userId);
      res.status(200).json({ preferences });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to load preferences';
      res.status(500).json({ error: 'INTERNAL_ERROR', message });
    }
  });

  router.put('/', requireAuth, requireTenant, async (req: AuthenticatedRequest, res: Response) => {
    try {
      const auth = req.auth!;
      const body = (req.body ?? {}) as { notificationType?: unknown; enabled?: unknown };
      if (!isNotificationType(body.notificationType)) {
        res.status(400).json({
          error: 'VALIDATION_ERROR',
          message: `notificationType must be one of: ${NOTIFICATION_TYPES.join(', ')}`,
        });
        return;
      }
      if (typeof body.enabled !== 'boolean') {
        res.status(400).json({ error: 'VALIDATION_ERROR', message: 'enabled must be a boolean' });
        return;
      }

      await repo.setEnabled(auth.tenantId, auth.userId, body.notificationType, body.enabled);
      await auditRepo.create(
        createAuditEvent({
          tenantId: auth.tenantId,
          actorId: auth.userId,
          actorRole: auth.role,
          eventType: 'notification.preferences.updated',
          entityType: 'notification_preference',
          entityId: `${auth.userId}:${body.notificationType}`,
          metadata: { notificationType: body.notificationType, enabled: body.enabled },
        }),
      );

      const preferences = await effectivePreferences(repo, auth.tenantId, auth.userId);
      res.status(200).json({ preferences });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to update preferences';
      res.status(500).json({ error: 'INTERNAL_ERROR', message });
    }
  });

  return router;
}
