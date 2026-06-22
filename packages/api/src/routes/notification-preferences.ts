/**
 * `GET /api/notification-preferences` — the authed user's per-category push
 * preferences (default-on; absent categories read as enabled).
 * `PUT /api/notification-preferences` — toggle one category; emits
 * `notification.preferences.updated`. Each user manages only their own
 * preferences (keyed on the JWT's userId), tenant-scoped by RLS.
 */
import { Router, Response } from 'express';
import { AuthenticatedRequest } from '../auth/clerk';
import { requireAuth, requireTenant } from '../middleware/auth';
import { AuditRepository, createAuditEvent } from '../audit/audit';
import {
  type NotificationPreferenceRepository,
  isNotificationType,
  toPreferenceMap,
} from '../notifications/notification-preferences-service';

export function createNotificationPreferencesRouter(
  repo: NotificationPreferenceRepository,
  auditRepo: AuditRepository,
): Router {
  const router = Router();

  router.get('/', requireAuth, requireTenant, async (req: AuthenticatedRequest, res: Response) => {
    try {
      const auth = req.auth!;
      const rows = await repo.listByUser(auth.tenantId, auth.userId);
      res.json({ preferences: toPreferenceMap(rows) });
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
        res
          .status(400)
          .json({ error: 'VALIDATION_ERROR', message: 'Unknown notificationType' });
        return;
      }
      if (typeof body.enabled !== 'boolean') {
        res.status(400).json({ error: 'VALIDATION_ERROR', message: '`enabled` must be a boolean' });
        return;
      }

      const pref = await repo.set(auth.tenantId, auth.userId, body.notificationType, body.enabled);
      await auditRepo.create(
        createAuditEvent({
          tenantId: auth.tenantId,
          actorId: auth.userId,
          actorRole: auth.role,
          eventType: 'notification.preferences.updated',
          entityType: 'notification_preference',
          entityId: `${auth.userId}:${pref.notificationType}`,
          metadata: { notificationType: pref.notificationType, enabled: pref.enabled },
        }),
      );

      const rows = await repo.listByUser(auth.tenantId, auth.userId);
      res.json({ preferences: toPreferenceMap(rows) });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to update preferences';
      res.status(500).json({ error: 'INTERNAL_ERROR', message });
    }
  });

  return router;
}
