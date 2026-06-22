/**
 * `POST /api/devices` (register) and `DELETE /api/devices` (unregister) — the
 * mobile app's push-token registration. Stored tenant-scoped so the owner can
 * be notified when a proposal executes. Any authenticated tenant member may
 * register their own device; every mutation emits an audit event.
 */
import { Router, Response } from 'express';
import { AuthenticatedRequest } from '../auth/clerk';
import { requireAuth, requireTenant } from '../middleware/auth';
import { AuditRepository, createAuditEvent } from '../audit/audit';
import {
  type DeviceTokenRepository,
  validateRegisterInput,
} from '../push/device-token-service';

export function createDevicesRouter(
  repo: DeviceTokenRepository,
  auditRepo: AuditRepository,
): Router {
  const router = Router();

  router.post('/', requireAuth, requireTenant, async (req: AuthenticatedRequest, res: Response) => {
    try {
      const auth = req.auth!;
      const body = (req.body ?? {}) as { expoPushToken?: string; platform?: string };
      const input = {
        tenantId: auth.tenantId,
        userId: auth.userId,
        expoPushToken: body.expoPushToken ?? '',
        platform: body.platform ?? '',
      };
      const errors = validateRegisterInput(input);
      if (errors.length > 0) {
        res.status(400).json({ error: 'VALIDATION_ERROR', message: errors.join(', ') });
        return;
      }

      const device = await repo.register(input);
      await auditRepo.create(
        createAuditEvent({
          tenantId: auth.tenantId,
          actorId: auth.userId,
          actorRole: auth.role,
          eventType: 'device.registered',
          entityType: 'device_token',
          entityId: device.id,
          metadata: { platform: device.platform },
        }),
      );
      res.status(201).json({ device });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to register device';
      res.status(500).json({ error: 'INTERNAL_ERROR', message });
    }
  });

  router.delete('/', requireAuth, requireTenant, async (req: AuthenticatedRequest, res: Response) => {
    try {
      const auth = req.auth!;
      const expoPushToken = (req.body?.expoPushToken ?? '') as string;
      if (!expoPushToken) {
        res.status(400).json({ error: 'VALIDATION_ERROR', message: 'expoPushToken is required' });
        return;
      }

      const removed = await repo.remove(auth.tenantId, expoPushToken);
      if (removed) {
        await auditRepo.create(
          createAuditEvent({
            tenantId: auth.tenantId,
            actorId: auth.userId,
            actorRole: auth.role,
            eventType: 'device.unregistered',
            entityType: 'device_token',
            entityId: expoPushToken,
            metadata: {},
          }),
        );
      }
      res.status(204).send();
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to unregister device';
      res.status(500).json({ error: 'INTERNAL_ERROR', message });
    }
  });

  return router;
}
