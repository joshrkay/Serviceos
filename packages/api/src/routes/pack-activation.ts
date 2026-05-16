import { Router, Response } from 'express';
import { AuthenticatedRequest } from '../auth/clerk';
import { asyncRoute } from '../middleware/async-route';
import { requireAuth, requirePermission, requireTenant } from '../middleware/auth';
import {
  activatePack,
  deactivatePack,
  getActivePacks,
  PackActivationRepository,
  validateActivationInput,
} from '../settings/pack-activation';
import { VerticalPackRegistry } from '../shared/vertical-pack-registry';
import { AuditRepository } from '../audit/audit';

export function createPackActivationRouter(
  packActivationRepo: PackActivationRepository,
  verticalPackRegistry: VerticalPackRegistry,
  auditRepo: AuditRepository
): Router {
  const router = Router();

  router.get(
    '/',
    requireAuth,
    requireTenant,
    requirePermission('settings:update'),
    asyncRoute(async (req: AuthenticatedRequest, res: Response) => {
      const activePacks = await getActivePacks(req.auth!.tenantId, packActivationRepo);
      res.json(activePacks);
    })
  );

  router.put(
    '/:packId/activate',
    requireAuth,
    requireTenant,
    requirePermission('settings:update'),
    asyncRoute(async (req: AuthenticatedRequest, res: Response) => {
      const tenantId = req.auth!.tenantId;
      const packId = req.params.packId;

      const validationErrors = validateActivationInput({ tenantId, packId });
      if (validationErrors.length > 0) {
        res.status(400).json({
          error: 'VALIDATION_ERROR',
          message: validationErrors.join(', '),
        });
        return;
      }

      const canonicalPack = await verticalPackRegistry.getByPackId(packId);
      if (!canonicalPack || canonicalPack.status !== 'active') {
        res.status(404).json({
          error: 'NOT_FOUND',
          message: `Active pack not found: ${packId}`,
        });
        return;
      }

      const activation = await activatePack(
        { tenantId, packId },
        packActivationRepo,
        auditRepo,
        { actorId: req.auth!.userId, actorRole: req.auth!.role }
      );
      res.status(201).json(activation);
    })
  );

  router.delete(
    '/:packId',
    requireAuth,
    requireTenant,
    requirePermission('settings:update'),
    asyncRoute(async (req: AuthenticatedRequest, res: Response) => {
      const tenantId = req.auth!.tenantId;
      const packId = req.params.packId;

      const result = await deactivatePack(
        tenantId,
        packId,
        packActivationRepo,
        auditRepo,
        { actorId: req.auth!.userId, actorRole: req.auth!.role }
      );
      if (!result) {
        res.status(404).json({ error: 'NOT_FOUND', message: 'Pack activation not found' });
        return;
      }

      res.json(result);
    })
  );

  return router;
}
