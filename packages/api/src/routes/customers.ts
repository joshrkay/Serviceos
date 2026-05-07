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
  listCustomersWithMeta,
  archiveCustomer,
  CustomerRepository,
  MAX_LIST_LIMIT,
  DEFAULT_LIST_LIMIT,
} from '../customers/customer';
import { AuditRepository } from '../audit/audit';
import {
  getCustomerTimeline,
  type CustomerTimelineDeps,
} from '../customers/timeline-service';
import { timelineQuerySchema } from '../customers/timeline';

/**
 * P9-002 — Optional dependencies for the customer timeline endpoint.
 * When omitted the timeline route is omitted from the router (leaving the
 * mount point quietly 404 so existing callers and tests are unaffected).
 */
export type CustomerRouterTimelineDeps = CustomerTimelineDeps;

export function createCustomerRouter(
  customerRepo: CustomerRepository,
  auditRepo: AuditRepository,
  timelineDeps?: CustomerRouterTimelineDeps
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
        const sort: 'asc' | 'desc' = req.query.sort === 'desc' ? 'desc' : 'asc';

        // P1-018: when `paginated=true` (or limit/offset are present) we
        // return `{ data, total }` so the frontend can drive UI pagination.
        // Without those query params we keep the legacy bare-array shape so
        // existing list consumers don't need changes.
        const wantsPaginated =
          req.query.paginated === 'true' ||
          req.query.limit !== undefined ||
          req.query.offset !== undefined;

        const limitRaw = req.query.limit as string | undefined;
        const offsetRaw = req.query.offset as string | undefined;
        const limit = limitRaw !== undefined ? parseInt(limitRaw, 10) : DEFAULT_LIST_LIMIT;
        const offset = offsetRaw !== undefined ? parseInt(offsetRaw, 10) : 0;
        if (limitRaw !== undefined && (Number.isNaN(limit) || limit < 1 || limit > MAX_LIST_LIMIT)) {
          res.status(400).json({
            error: 'VALIDATION_ERROR',
            message: `limit must be between 1 and ${MAX_LIST_LIMIT}`,
          });
          return;
        }
        if (offsetRaw !== undefined && (Number.isNaN(offset) || offset < 0)) {
          res.status(400).json({
            error: 'VALIDATION_ERROR',
            message: 'offset must be a non-negative integer',
          });
          return;
        }

        if (wantsPaginated) {
          const result = await listCustomersWithMeta(req.auth!.tenantId, customerRepo, {
            includeArchived,
            search,
            limit,
            offset,
            sort,
          });
          res.json(result);
          return;
        }

        const result = await listCustomers(req.auth!.tenantId, customerRepo, {
          includeArchived,
          search,
          sort,
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

  // P9-002 — Unified communication timeline. Read-only aggregator across
  // notes, jobs, estimates, invoices, payments, conversations, and
  // appointments. Tenant scoping is enforced inside `getCustomerTimeline`
  // via each source repo's existing tenant-scoped methods.
  if (timelineDeps) {
    router.get(
      '/:id/timeline',
      requireAuth,
      requireTenant,
      requirePermission('customers:view'),
      async (req: AuthenticatedRequest, res: Response) => {
        try {
          const customer = await getCustomer(
            req.auth!.tenantId,
            req.params.id,
            customerRepo
          );
          if (!customer) {
            res.status(404).json({ error: 'NOT_FOUND', message: 'Customer not found' });
            return;
          }
          const parsed = timelineQuerySchema.parse(req.query);
          const result = await getCustomerTimeline(
            req.auth!.tenantId,
            req.params.id,
            timelineDeps,
            {
              before: parsed.before,
              limit: parsed.limit,
              kinds: parsed.kinds,
            }
          );
          res.json(result);
        } catch (err) {
          const { statusCode, body } = toErrorResponse(err);
          res.status(statusCode).json(body);
        }
      }
    );
  }

  return router;
}
