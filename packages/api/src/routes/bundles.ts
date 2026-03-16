import { Router, Response } from 'express';
import { AuthenticatedRequest } from '../auth/clerk';
import { requireAuth, requireTenant, requirePermission } from '../middleware/auth';
import { toErrorResponse } from '../shared/errors';
import { createBundleSchema, verticalTypeSchema } from '../shared/contracts';
import {
  ServiceBundleRepository,
  createBundle,
  matchBundles,
} from '../verticals/bundles';

export function createBundleRouter(bundleRepo: ServiceBundleRepository): Router {
  const router = Router();

  // List bundles for current tenant
  router.get(
    '/',
    requireAuth,
    requireTenant,
    requirePermission('estimates:view'),
    async (req: AuthenticatedRequest, res: Response) => {
      try {
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
      } catch (err) {
        const { statusCode, body } = toErrorResponse(err);
        res.status(statusCode).json(body);
      }
    }
  );

  // Get bundle by ID
  router.get(
    '/:id',
    requireAuth,
    requireTenant,
    requirePermission('estimates:view'),
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        const bundle = await bundleRepo.findById(req.auth!.tenantId, req.params.id);
        if (!bundle) {
          res.status(404).json({ error: 'NOT_FOUND', message: 'Bundle not found' });
          return;
        }
        res.json(bundle);
      } catch (err) {
        const { statusCode, body } = toErrorResponse(err);
        res.status(statusCode).json(body);
      }
    }
  );

  // Create bundle
  router.post(
    '/',
    requireAuth,
    requireTenant,
    requirePermission('estimates:create'),
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        const parsed = createBundleSchema.parse(req.body);
        const result = await createBundle(
          {
            ...parsed,
            tenantId: req.auth!.tenantId,
          },
          bundleRepo
        );
        res.status(201).json(result);
      } catch (err) {
        const { statusCode, body } = toErrorResponse(err);
        res.status(statusCode).json(body);
      }
    }
  );

  // Match bundles by text
  router.post(
    '/match',
    requireAuth,
    requireTenant,
    requirePermission('estimates:view'),
    async (req: AuthenticatedRequest, res: Response) => {
      try {
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
      } catch (err) {
        const { statusCode, body } = toErrorResponse(err);
        res.status(statusCode).json(body);
      }
    }
  );

  // Update bundle
  router.put(
    '/:id',
    requireAuth,
    requireTenant,
    requirePermission('estimates:update'),
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        const { name, description, categoryIds, lineItemTemplates, triggerKeywords, isActive } = req.body;
        const result = await bundleRepo.update(req.auth!.tenantId, req.params.id, {
          ...(name !== undefined && { name }),
          ...(description !== undefined && { description }),
          ...(categoryIds !== undefined && { categoryIds }),
          ...(lineItemTemplates !== undefined && { lineItemTemplates }),
          ...(triggerKeywords !== undefined && { triggerKeywords }),
          ...(isActive !== undefined && { isActive }),
          updatedAt: new Date(),
        });
        if (!result) {
          res.status(404).json({ error: 'NOT_FOUND', message: 'Bundle not found' });
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
