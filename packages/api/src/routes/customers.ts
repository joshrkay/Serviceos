import { Router, Response } from 'express';
import { AuthenticatedRequest } from '../auth/clerk';
import { requireAuth, requireTenant, requirePermission } from '../middleware/auth';
import { createCustomerSchema } from '../shared/contracts';
import { toErrorResponse } from '../shared/errors';
import {
  createCustomer,
  getCustomer,
  updateCustomer,
  listCustomers,
  archiveCustomer,
  CustomerRepository,
} from '../customers/customer';
import { AuditRepository } from '../audit/audit';

export function createCustomerRouter(
  customerRepo: CustomerRepository,
  auditRepo: AuditRepository
): Router {
  const router = Router();

  router.post(
    '/',
    requireAuth,
    requireTenant,
    requirePermission('customers:create'),
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        const parsed = createCustomerSchema.parse(req.body);
        const result = await createCustomer(
          {
            ...parsed,
            tenantId: req.auth!.tenantId,
            createdBy: req.auth!.userId,
            actorRole: req.auth!.role,
          },
          customerRepo,
          auditRepo
        );
        res.status(201).json(result);
      } catch (err) {
        const { statusCode, body } = toErrorResponse(err);
        res.status(statusCode).json(body);
      }
    }
  );

  router.get(
    '/',
    requireAuth,
    requireTenant,
    requirePermission('customers:view'),
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        const includeArchived = req.query.includeArchived === 'true';
        const search = req.query.search as string | undefined;
        const result = await listCustomers(req.auth!.tenantId, customerRepo, {
          includeArchived,
          search,
        });
        res.json(result);
      } catch (err) {
        const { statusCode, body } = toErrorResponse(err);
        res.status(statusCode).json(body);
      }
    }
  );

  router.get(
    '/:id',
    requireAuth,
    requireTenant,
    requirePermission('customers:view'),
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        const result = await getCustomer(req.auth!.tenantId, req.params.id, customerRepo);
        if (!result) {
          res.status(404).json({ error: 'NOT_FOUND', message: 'Customer not found' });
          return;
        }
        res.json(result);
      } catch (err) {
        const { statusCode, body } = toErrorResponse(err);
        res.status(statusCode).json(body);
      }
    }
  );

  router.put(
    '/:id',
    requireAuth,
    requireTenant,
    requirePermission('customers:update'),
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        const result = await updateCustomer(
          req.auth!.tenantId,
          req.params.id,
          req.body,
          customerRepo,
          req.auth!.userId,
          auditRepo
        );
        if (!result) {
          res.status(404).json({ error: 'NOT_FOUND', message: 'Customer not found' });
          return;
        }
        res.json(result);
      } catch (err) {
        const { statusCode, body } = toErrorResponse(err);
        res.status(statusCode).json(body);
      }
    }
  );

  router.post(
    '/:id/archive',
    requireAuth,
    requireTenant,
    requirePermission('customers:delete'),
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        const result = await archiveCustomer(
          req.auth!.tenantId,
          req.params.id,
          customerRepo,
          req.auth!.userId,
          auditRepo
        );
        if (!result) {
          res.status(404).json({ error: 'NOT_FOUND', message: 'Customer not found' });
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
