import { Router, Response } from 'express';
import { AuthenticatedRequest } from '../auth/clerk';
import { asyncRoute } from '../middleware/async-route';
import { requireAuth, requireTenant, requirePermission } from '../middleware/auth';
import { createBundleSchema, verticalTypeSchema } from '../shared/contracts';
import {
  ServiceBundleRepository,
  createBundle,
  matchBundles,
  updateBundle,
} from '../verticals/bundles';
import { AuditRepository } from '../audit/audit';

export function createBundleRouter(
  bundleRepo: ServiceBundleRepository,
  auditRepo?: AuditRepository,
): Router {
  const router = Router();

  router.get(
    '/',
    requireAuth,
    requireTenant,
    requirePermission('estimates:view'),
    asyncRoute(async (req: AuthenticatedRequest, res: Response) => {
      const verticalType = req.query.verticalType as string | undefined;
      if (verticalType) {
        const parsed = verticalTypeSchema.safeParse(verticalType);
        if (!parsed.success) {
          res.status(400).json({ error: 'VALIDATION_ERROR', message: 'Invalid verticalType' });
          return;
        }
      }
      let bundles;
      if (verticalType) {
        bundles = await bundleRepo.findByVertical(
          req.auth!.tenantId,
          verticalType as 'hvac' | 'plumbing'
        );
      } else {
        bundles = await bundleRepo.findByTenant(req.auth!.tenantId);
      }
      res.json(bundles);
    })
  );

  router.get(
    '/:id',
    requireAuth,
    requireTenant,
    requirePermission('estimates:view'),
    asyncRoute(async (req: AuthenticatedRequest, res: Response) => {
      const bundle = await bundleRepo.findById(req.auth!.tenantId, req.params.id);
      if (!bundle) {
        res.status(404).json({ error: 'NOT_FOUND', message: 'Bundle not found' });
        return;
      }
      res.json(bundle);
    })
  );

  router.post(
    '/',
    requireAuth,
    requireTenant,
    requirePermission('estimates:create'),
    asyncRoute(async (req: AuthenticatedRequest, res: Response) => {
      const parsed = createBundleSchema.parse(req.body);
      const result = await createBundle(
        {
          ...parsed,
          tenantId: req.auth!.tenantId,
        },
        bundleRepo,
        { userId: req.auth!.userId, role: req.auth!.role },
        auditRepo,
      );
      res.status(201).json(result);
    })
  );

  router.post(
    '/match',
    requireAuth,
    requireTenant,
    requirePermission('estimates:view'),
    asyncRoute(async (req: AuthenticatedRequest, res: Response) => {
      const { text, verticalType } = req.body;
      if (!text) {
        res.status(400).json({ error: 'VALIDATION_ERROR', message: 'text is required' });
        return;
      }
      let allBundles;
      if (verticalType) {
        allBundles = await bundleRepo.findByVertical(req.auth!.tenantId, verticalType);
      } else {
        allBundles = await bundleRepo.findByTenant(req.auth!.tenantId);
      }
      const matched = matchBundles(allBundles, text);
      res.json(matched);
    })
  );

  router.put(
    '/:id',
    requireAuth,
    requireTenant,
    requirePermission('estimates:update'),
    asyncRoute(async (req: AuthenticatedRequest, res: Response) => {
      const { name, description, categoryIds, lineItemTemplates, triggerKeywords, isActive } = req.body;
      const result = await updateBundle(
        bundleRepo,
        req.auth!.tenantId,
        req.params.id,
        {
          ...(name !== undefined && { name }),
          ...(description !== undefined && { description }),
          ...(categoryIds !== undefined && { categoryIds }),
          ...(lineItemTemplates !== undefined && { lineItemTemplates }),
          ...(triggerKeywords !== undefined && { triggerKeywords }),
          ...(isActive !== undefined && { isActive }),
          updatedAt: new Date(),
        },
        { userId: req.auth!.userId, role: req.auth!.role },
        auditRepo,
      );
      if (!result) {
        res.status(404).json({ error: 'NOT_FOUND', message: 'Bundle not found' });
        return;
      }
      res.json(result);
    })
  );

  return router;
}
