import { Router, Response } from 'express';
import { AuthenticatedRequest } from '../auth/clerk';
import { requireAuth, requireTenant } from '../middleware/auth';
import { toErrorResponse } from '../shared/errors';
import { RegisterDeviceSchema } from '@ai-service-os/shared';
import { DeviceTokenRepository } from '../devices/device-token-repository';
import { AuditRepository, createAuditEvent } from '../audit/audit';

export interface DevicesRouteDeps {
  deviceTokenRepo: DeviceTokenRepository;
  auditRepo: AuditRepository;
}

/**
 * Mobile push device registration. Tenant + user come from `req.auth` —
 * NEVER the body. Token selection for sends is RLS-scoped (see
 * `device-token-repository`), so registering here is all the tenant
 * binding push needs.
 */
export function createDevicesRouter(deps: DevicesRouteDeps): Router {
  const router = Router();

  // Register / refresh this device's push token for the current user+tenant.
  router.post('/', requireAuth, requireTenant, async (req: AuthenticatedRequest, res: Response) => {
    try {
      const { platform, token } = RegisterDeviceSchema.parse(req.body);
      const device = await deps.deviceTokenRepo.register({
        tenantId: req.auth!.tenantId,
        userId: req.auth!.userId,
        platform,
        token,
      });
      await deps.auditRepo.create(
        createAuditEvent({
          tenantId: req.auth!.tenantId,
          actorId: req.auth!.userId,
          actorRole: req.auth!.role,
          eventType: 'device.registered',
          entityType: 'device_token',
          entityId: device.id,
          metadata: { platform },
        }),
      );
      res.status(201).json({ id: device.id, platform: device.platform });
    } catch (err) {
      const { statusCode, body } = toErrorResponse(err);
      res.status(statusCode).json(body);
    }
  });

  // Unregister this device's token (logout / uninstall hygiene). The client
  // must URL-encode the token (FCM tokens contain ':' and '-' but no '/').
  router.delete(
    '/:token',
    requireAuth,
    requireTenant,
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        const token = req.params.token;
        const removed = await deps.deviceTokenRepo.deleteToken(req.auth!.tenantId, token);
        if (removed) {
          await deps.auditRepo.create(
            createAuditEvent({
              tenantId: req.auth!.tenantId,
              actorId: req.auth!.userId,
              actorRole: req.auth!.role,
              eventType: 'device.unregistered',
              entityType: 'device_token',
              entityId: token,
            }),
          );
        }
        res.status(removed ? 204 : 404).end();
      } catch (err) {
        const { statusCode, body } = toErrorResponse(err);
        res.status(statusCode).json(body);
      }
    },
  );

  return router;
}
