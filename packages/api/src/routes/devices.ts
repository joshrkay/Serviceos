/**
 * Device push-token registration — `POST /api/devices/push-token` and
 * `DELETE /api/devices/push-token`.
 *
 * The mobile app registers its Expo push token after sign-in so the owner can
 * be notified when a proposal executes ("push from day one") and when an E1
 * life-safety call comes in.
 *
 * Following the /api/me pattern, all DB I/O is delegated to the
 * DeviceTokenService seam (`devices/device-token.ts`): app.ts wires the Pg
 * repository; tests inject the in-memory impl. The route module has no Pg
 * dependency.
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
  DevicePlatform,
  DeviceTokenService,
  isExpoPushToken,
  VALID_DEVICE_PLATFORMS,
} from '../devices/device-token';

export function createDevicesRouter(
  service: DeviceTokenService,
  type DeviceTokenRepository,
  validateRegisterInput,
} from '../push/device-token-service';

export function createDevicesRouter(
  repo: DeviceTokenRepository,
  auditRepo: AuditRepository,
): Router {
  const router = Router();

  router.post(
    '/push-token',
    requireAuth,
    requireTenant,
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        const auth = req.auth!;
        const token = (req.body?.token ?? '') as string;
        const platform = (req.body?.platform ?? '') as string;

        if (!isExpoPushToken(token)) {
          res.status(400).json({ error: 'VALIDATION_ERROR', message: 'token must be a valid Expo push token' });
          return;
        }
        if (!VALID_DEVICE_PLATFORMS.includes(platform as DevicePlatform)) {
          res.status(400).json({
            error: 'VALIDATION_ERROR',
            message: `platform must be one of ${VALID_DEVICE_PLATFORMS.join(', ')}`,
          });
          return;
        }

        await service.upsert(auth.tenantId, auth.userId, token.trim(), platform as DevicePlatform);

        await auditRepo.create(
          createAuditEvent({
            tenantId: auth.tenantId,
            actorId: auth.userId,
            actorRole: auth.role,
            eventType: 'device_push_token_registered',
            entityType: 'device_push_token',
            entityId: auth.userId,
            metadata: { platform },
          }),
        );

        res.status(204).send();
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Failed to register push token';
        res.status(500).json({ error: 'INTERNAL_ERROR', message });
      }
    },
  );

  router.delete(
    '/push-token',
    requireAuth,
    requireTenant,
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        const auth = req.auth!;
        const token = (req.body?.token ?? '') as string;
        if (!isExpoPushToken(token)) {
          res.status(400).json({ error: 'VALIDATION_ERROR', message: 'token must be a valid Expo push token' });
          return;
        }

        await service.remove(auth.tenantId, auth.userId, token.trim());

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
            eventType: 'device_push_token_removed',
            entityType: 'device_push_token',
            entityId: auth.userId,
            metadata: {},
          }),
        );

        res.status(204).send();
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Failed to remove push token';
        res.status(500).json({ error: 'INTERNAL_ERROR', message });
      }
    },
  );
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
