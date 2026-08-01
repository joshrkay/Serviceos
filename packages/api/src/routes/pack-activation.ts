import { Router, Response } from 'express';
import { AuthenticatedRequest } from '../auth/clerk';
import { asyncRoute } from '../middleware/async-route';
import { requireAuth, requirePermission, requireTenant } from '../middleware/auth';
import {
  activatePack,
  deactivatePack,
  getActivePacks,
  syncActiveVerticalPacksMirror,
  PackActivationRepository,
  validateActivationInput,
} from '../settings/pack-activation';
import type { SettingsRepository } from '../settings/settings';
import { VerticalPackRegistry } from '../shared/vertical-pack-registry';
import { AuditRepository } from '../audit/audit';

export function createPackActivationRouter(
  packActivationRepo: PackActivationRepository,
  verticalPackRegistry: VerticalPackRegistry,
  auditRepo: AuditRepository,
  settingsRepo: Pick<SettingsRepository, 'update'>
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
      // pack_activations is authoritative; keep the tenant_settings
      // `_activeVerticalPacks` mirror (Templates page + public intake) in
      // sync in the same request transaction so the two never drift.
      await syncActiveVerticalPacksMirror(tenantId, packActivationRepo, settingsRepo);
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

      // Mirror the deactivation into tenant_settings so the Templates page
      // and public intake drop the pack too (authoritative → mirror).
      await syncActiveVerticalPacksMirror(tenantId, packActivationRepo, settingsRepo);
      res.json(result);
    })
  );

  return router;
}
