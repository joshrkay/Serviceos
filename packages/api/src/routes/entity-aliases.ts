import { Router, Response } from 'express';
import { AuthenticatedRequest } from '../auth/clerk';
import { asyncRoute } from '../middleware/async-route';
import { requireAuth, requireTenant } from '../middleware/auth';
import { NotFoundError, ValidationError, ForbiddenError } from '../shared/errors';
import { uuidSchema } from '../shared/validation';
import type { EntityAliasRepository } from '../learning/entity-aliases/entity-alias';

/**
 * Owner-only revoke path for learned tenant aliases. Activation remains
 * proposal-gated; deactivation is an explicit owner action that preserves
 * provenance and audit history.
 */
export function createEntityAliasesRouter(
  repo: EntityAliasRepository,
): Router {
  const router = Router();

  router.patch(
    '/:id/deactivate',
    requireAuth,
    requireTenant,
    asyncRoute(async (req: AuthenticatedRequest, res: Response) => {
      if (req.auth!.role !== 'owner') {
        throw new ForbiddenError('Only an owner may deactivate an entity alias');
      }
      const deactivatedBy = req.auth!.canonicalUserId;
      if (!deactivatedBy) {
        throw new ForbiddenError('Canonical owner actor is required');
      }

      const aliasId = req.params.id;
      if (!uuidSchema.safeParse(aliasId).success) {
        throw new ValidationError('Entity alias ID must be a UUID');
      }

      const deactivated = await repo.deactivate({
        tenantId: req.auth!.tenantId,
        aliasId,
        deactivatedBy,
        actorRole: 'owner',
      });
      if (!deactivated) {
        throw new NotFoundError('Entity alias', aliasId);
      }
      res.json(deactivated);
    }),
  );

  return router;
}
