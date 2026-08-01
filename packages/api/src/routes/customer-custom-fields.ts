import { Router, Response } from 'express';
import { AuthenticatedRequest } from '../auth/clerk';
import { asyncRoute } from '../middleware/async-route';
import { requireAuth, requireTenant, requirePermission } from '../middleware/auth';
import { AuditRepository } from '../audit/audit';
import {
  CustomFieldRepository,
  createCustomFieldDef,
} from '../customers/custom-field';
import { createCustomFieldDefSchema } from '../shared/contracts';

/**
 * U2 (CRM Jobber parity) — tenant-level custom-field *definition* management.
 *
 * Mounted at /api/customer-custom-fields (separate from /api/customers/:id so
 * the field-def collection path can't collide with the customer `/:id` route).
 * Per-customer *values* live on the customer router at
 * /api/customers/:id/custom-fields.
 */
export function createCustomerCustomFieldRouter(
  customFieldRepo: CustomFieldRepository,
  auditRepo: AuditRepository
): Router {
  const router = Router();

  router.get(
    '/',
    requireAuth,
    requireTenant,
    requirePermission('customers:view'),
    asyncRoute(async (req: AuthenticatedRequest, res: Response) => {
      const includeArchived = req.query.includeArchived === 'true';
      const defs = await customFieldRepo.listDefs(req.auth!.tenantId, includeArchived);
      res.json(defs);
    })
  );

  router.post(
    '/',
    requireAuth,
    requireTenant,
    requirePermission('customers:update'),
    asyncRoute(async (req: AuthenticatedRequest, res: Response) => {
      const parsed = createCustomFieldDefSchema.parse(req.body);
      const def = await createCustomFieldDef(
        {
          ...parsed,
          tenantId: req.auth!.tenantId,
          createdBy: req.auth!.userId,
          actorRole: req.auth!.role,
        },
        customFieldRepo,
        auditRepo
      );
      res.status(201).json(def);
    })
  );

  router.post(
    '/:fieldDefId/archive',
    requireAuth,
    requireTenant,
    requirePermission('customers:update'),
    asyncRoute(async (req: AuthenticatedRequest, res: Response) => {
      const archived = await customFieldRepo.archiveDef(
        req.auth!.tenantId,
        req.params.fieldDefId
      );
      if (!archived) {
        res.status(404).json({ error: 'NOT_FOUND', message: 'Custom field not found' });
        return;
      }
      res.json(archived);
    })
  );

  return router;
}
