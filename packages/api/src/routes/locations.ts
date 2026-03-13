import { Router, Response } from 'express';
import { AuthenticatedRequest } from '../auth/clerk';
import { requireAuth, requireTenant, requirePermission } from '../middleware/auth';
import { createServiceLocationSchema } from '../shared/contracts';
import { toErrorResponse } from '../shared/errors';
import {
  createLocation,
  getLocation,
  updateLocation,
  archiveLocation,
  listByCustomer,
  setPrimary,
  LocationRepository,
} from '../locations/location';

export function createLocationRouter(locationRepo: LocationRepository): Router {
  const router = Router();

  router.post(
    '/',
    requireAuth,
    requireTenant,
    requirePermission('locations:create'),
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        const parsed = createServiceLocationSchema.parse(req.body);
        const result = await createLocation(
          { ...parsed, tenantId: req.auth!.tenantId },
          locationRepo
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
    requirePermission('locations:view'),
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        const customerId = req.query.customerId as string;
        if (!customerId) {
          res.status(400).json({ error: 'VALIDATION_ERROR', message: 'customerId query parameter is required' });
          return;
        }
        const result = await listByCustomer(req.auth!.tenantId, customerId, locationRepo);
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
    requirePermission('locations:view'),
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        const result = await getLocation(req.auth!.tenantId, req.params.id, locationRepo);
        if (!result) {
          res.status(404).json({ error: 'NOT_FOUND', message: 'Location not found' });
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
    requirePermission('locations:update'),
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        const result = await updateLocation(req.auth!.tenantId, req.params.id, req.body, locationRepo);
        if (!result) {
          res.status(404).json({ error: 'NOT_FOUND', message: 'Location not found' });
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
    requirePermission('locations:delete'),
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        const result = await archiveLocation(req.auth!.tenantId, req.params.id, locationRepo);
        if (!result) {
          res.status(404).json({ error: 'NOT_FOUND', message: 'Location not found' });
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
    '/:id/set-primary',
    requireAuth,
    requireTenant,
    requirePermission('locations:update'),
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        const result = await setPrimary(req.auth!.tenantId, req.params.id, locationRepo);
        if (!result) {
          res.status(404).json({ error: 'NOT_FOUND', message: 'Location not found' });
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
