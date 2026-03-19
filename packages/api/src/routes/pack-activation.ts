import { Router, Response } from 'express';
import { AuthenticatedRequest } from '../auth/clerk';
import { requireAuth, requirePermission, requireTenant } from '../middleware/auth';
import {
  activatePack,
  deactivatePack,
  getActivePacks,
  PackActivationRepository,
  validateActivationInput,
} from '../settings/pack-activation';
import { toErrorResponse } from '../shared/errors';
import { VerticalPackRegistry } from '../shared/vertical-pack-registry';

export function createPackActivationRouter(
  packActivationRepo: PackActivationRepository,
  verticalPackRegistry: VerticalPackRegistry
): Router {
  const router = Router();

  router.get(
    '/',
    requireAuth,
    requireTenant,
    requirePermission('settings:update'),
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        const activePacks = await getActivePacks(req.auth!.tenantId, packActivationRepo);
        res.json(activePacks);
      } catch (err) {
        const { statusCode, body } = toErrorResponse(err);
        res.status(statusCode).json(body);
      }
    }
  );

  router.put(
    '/:packId/activate',
    requireAuth,
    requireTenant,
    requirePermission('settings:update'),
    async (req: AuthenticatedRequest, res: Response) => {
      try {
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

        const activation = await activatePack({ tenantId, packId }, packActivationRepo);
        res.status(201).json(activation);
      } catch (err) {
        const { statusCode, body } = toErrorResponse(err);
        res.status(statusCode).json(body);
      }
    }
  );

  router.delete(
    '/:packId',
    requireAuth,
    requireTenant,
    requirePermission('settings:update'),
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        const tenantId = req.auth!.tenantId;
        const packId = req.params.packId;

        const result = await deactivatePack(tenantId, packId, packActivationRepo);
        if (!result) {
          res.status(404).json({ error: 'NOT_FOUND', message: 'Pack activation not found' });
          return;
        }

        res.json(result);
      } catch (err) {
        const { statusCode, body } = toErrorResponse(err);
        res.status(statusCode).json(body);
      }
    }
  );

  return router;
}
