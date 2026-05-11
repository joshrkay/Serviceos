import { Router, Response } from 'express';
import { AuthenticatedRequest } from '../auth/clerk';
import { asyncRoute } from '../middleware/async-route';
import { requireAuth, requireTenant, requirePermission } from '../middleware/auth';
import { createServiceLocationSchema } from '../shared/contracts';
import { TenantOwnership } from '../shared/tenant-ownership';
import {
  createLocation,
  getLocation,
  updateLocation,
  archiveLocation,
  listByCustomer,
  setPrimary,
  LocationRepository,
} from '../locations/location';

export function createLocationRouter(
  locationRepo: LocationRepository,
  ownership: TenantOwnership
): Router {
  const router = Router();

  router.post(
    '/',
    requireAuth,
    requireTenant,
    requirePermission('locations:create'),
    asyncRoute(async (req: AuthenticatedRequest, res: Response) => {
      const parsed = createServiceLocationSchema.parse(req.body);
      await ownership.requireExists(req.auth!.tenantId, 'customer', parsed.customerId);
      const result = await createLocation(
        { ...parsed, tenantId: req.auth!.tenantId },
        locationRepo
      );
      res.status(201).json(result);
    })
  );

  router.get(
    '/',
    requireAuth,
    requireTenant,
    requirePermission('locations:view'),
    asyncRoute(async (req: AuthenticatedRequest, res: Response) => {
      const customerId = req.query.customerId as string;
      if (!customerId) {
        res.status(400).json({ error: 'VALIDATION_ERROR', message: 'customerId query parameter is required' });
        return;
      }
      const result = await listByCustomer(req.auth!.tenantId, customerId, locationRepo);
      res.json(result);
    })
  );

  router.get(
    '/:id',
    requireAuth,
    requireTenant,
    requirePermission('locations:view'),
    asyncRoute(async (req: AuthenticatedRequest, res: Response) => {
      const result = await getLocation(req.auth!.tenantId, req.params.id, locationRepo);
      if (!result) {
        res.status(404).json({ error: 'NOT_FOUND', message: 'Location not found' });
        return;
      }
      res.json(result);
    })
  );

  router.put(
    '/:id',
    requireAuth,
    requireTenant,
    requirePermission('locations:update'),
    asyncRoute(async (req: AuthenticatedRequest, res: Response) => {
      const result = await updateLocation(req.auth!.tenantId, req.params.id, req.body, locationRepo);
      if (!result) {
        res.status(404).json({ error: 'NOT_FOUND', message: 'Location not found' });
        return;
      }
      res.json(result);
    })
  );

  router.post(
    '/:id/archive',
    requireAuth,
    requireTenant,
    requirePermission('locations:delete'),
    asyncRoute(async (req: AuthenticatedRequest, res: Response) => {
      const result = await archiveLocation(req.auth!.tenantId, req.params.id, locationRepo);
      if (!result) {
        res.status(404).json({ error: 'NOT_FOUND', message: 'Location not found' });
        return;
      }
      res.json(result);
    })
  );

  router.post(
    '/:id/set-primary',
    requireAuth,
    requireTenant,
    requirePermission('locations:update'),
    asyncRoute(async (req: AuthenticatedRequest, res: Response) => {
      const result = await setPrimary(req.auth!.tenantId, req.params.id, locationRepo);
      if (!result) {
        res.status(404).json({ error: 'NOT_FOUND', message: 'Location not found' });
        return;
      }
      res.json(result);
    })
  );

  return router;
}
