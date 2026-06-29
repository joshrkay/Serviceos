import { Router, Response } from 'express';
import { AuthenticatedRequest } from '../auth/clerk';
import { asyncRoute } from '../middleware/async-route';
import { requireAuth, requireTenant, requirePermission } from '../middleware/auth';
import { AuditRepository } from '../audit/audit';
import {
  CustomerGroupRepository,
  addCustomerToGroup,
  archiveCustomerGroup,
  createCustomerGroup,
  removeCustomerFromGroup,
  updateCustomerGroup,
} from '../customers/customer-group';
import { createCustomerGroupSchema, updateCustomerGroupSchema } from '../shared/contracts';

/**
 * U8 (CRM Jobber parity) — customer groups / segmentation.
 *
 * Mounted at /api/customer-groups. Group management + membership use the
 * customer permission set. `/for-customer/:id` powers the membership panel on
 * the customer detail.
 */
export function createCustomerGroupRouter(
  repo: CustomerGroupRepository,
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
      res.json(await repo.listGroups(req.auth!.tenantId, includeArchived));
    })
  );

  router.post(
    '/',
    requireAuth,
    requireTenant,
    requirePermission('customers:update'),
    asyncRoute(async (req: AuthenticatedRequest, res: Response) => {
      const parsed = createCustomerGroupSchema.parse(req.body);
      const group = await createCustomerGroup(
        {
          ...parsed,
          tenantId: req.auth!.tenantId,
          createdBy: req.auth!.userId,
          actorRole: req.auth!.role,
        },
        repo,
        auditRepo
      );
      res.status(201).json(group);
    })
  );

  router.patch(
    '/:id',
    requireAuth,
    requireTenant,
    requirePermission('customers:update'),
    asyncRoute(async (req: AuthenticatedRequest, res: Response) => {
      const parsed = updateCustomerGroupSchema.parse(req.body);
      const group = await updateCustomerGroup(
        req.auth!.tenantId,
        req.params.id,
        parsed,
        repo,
        req.auth!.userId,
        auditRepo,
        req.auth!.role
      );
      res.json(group);
    })
  );

  router.post(
    '/:id/archive',
    requireAuth,
    requireTenant,
    requirePermission('customers:update'),
    asyncRoute(async (req: AuthenticatedRequest, res: Response) => {
      const archived = await archiveCustomerGroup(
        req.auth!.tenantId,
        req.params.id,
        repo,
        req.auth!.userId,
        auditRepo,
        req.auth!.role
      );
      if (!archived) {
        res.status(404).json({ error: 'NOT_FOUND', message: 'Customer group not found' });
        return;
      }
      res.json(archived);
    })
  );

  router.get(
    '/for-customer/:customerId',
    requireAuth,
    requireTenant,
    requirePermission('customers:view'),
    asyncRoute(async (req: AuthenticatedRequest, res: Response) => {
      res.json(await repo.listGroupsForCustomer(req.auth!.tenantId, req.params.customerId));
    })
  );

  router.get(
    '/:id/members',
    requireAuth,
    requireTenant,
    requirePermission('customers:view'),
    asyncRoute(async (req: AuthenticatedRequest, res: Response) => {
      res.json({ customerIds: await repo.listMemberIds(req.auth!.tenantId, req.params.id) });
    })
  );

  router.put(
    '/:id/members/:customerId',
    requireAuth,
    requireTenant,
    requirePermission('customers:update'),
    asyncRoute(async (req: AuthenticatedRequest, res: Response) => {
      const added = await addCustomerToGroup(
        req.auth!.tenantId,
        req.params.id,
        req.params.customerId,
        repo,
        req.auth!.userId,
        auditRepo
      );
      res.status(added ? 201 : 200).json({ added });
    })
  );

  router.delete(
    '/:id/members/:customerId',
    requireAuth,
    requireTenant,
    requirePermission('customers:update'),
    asyncRoute(async (req: AuthenticatedRequest, res: Response) => {
      await removeCustomerFromGroup(
        req.auth!.tenantId,
        req.params.id,
        req.params.customerId,
        repo,
        req.auth!.userId,
        auditRepo
      );
      res.json({ removed: true });
    })
  );

  return router;
}
