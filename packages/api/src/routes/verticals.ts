import { Router, Response } from 'express';
import { AuthenticatedRequest } from '../auth/clerk';
import { requireAuth, requireTenant, requirePermission } from '../middleware/auth';
import { toErrorResponse } from '../shared/errors';
import {
  VerticalPackRepository,
  validateVerticalPack,
  createVerticalPack,
  resolveTerminology,
  getChildCategories,
  getCategoryHierarchy,
} from '../verticals/registry';

export function createVerticalRouter(verticalPackRepo: VerticalPackRepository): Router {
  const router = Router();

  // List all active vertical packs
  router.get(
    '/',
    requireAuth,
    requireTenant,
    async (_req: AuthenticatedRequest, res: Response) => {
      try {
        const packs = await verticalPackRepo.findActive();
        res.json(packs);
      } catch (err) {
        const { statusCode, body } = toErrorResponse(err);
        res.status(statusCode).json(body);
      }
    }
  );

  // Get a vertical pack by type
  router.get(
    '/:type',
    requireAuth,
    requireTenant,
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        const type = req.params.type as 'hvac' | 'plumbing';
        if (!['hvac', 'plumbing'].includes(type)) {
          res.status(400).json({ error: 'VALIDATION_ERROR', message: 'Invalid vertical type' });
          return;
        }
        const pack = await verticalPackRepo.findByType(type);
        if (!pack) {
          res.status(404).json({ error: 'NOT_FOUND', message: 'Vertical pack not found' });
          return;
        }
        res.json(pack);
      } catch (err) {
        const { statusCode, body } = toErrorResponse(err);
        res.status(statusCode).json(body);
      }
    }
  );

  // Get categories for a vertical
  router.get(
    '/:type/categories',
    requireAuth,
    requireTenant,
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        const type = req.params.type as 'hvac' | 'plumbing';
        const pack = await verticalPackRepo.findByType(type);
        if (!pack) {
          res.status(404).json({ error: 'NOT_FOUND', message: 'Vertical pack not found' });
          return;
        }
        const parentId = req.query.parentId as string | undefined;
        const categories = getChildCategories(pack, parentId);
        res.json(categories);
      } catch (err) {
        const { statusCode, body } = toErrorResponse(err);
        res.status(statusCode).json(body);
      }
    }
  );

  // Resolve terminology
  router.get(
    '/:type/terminology/:term',
    requireAuth,
    requireTenant,
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        const type = req.params.type as 'hvac' | 'plumbing';
        const pack = await verticalPackRepo.findByType(type);
        if (!pack) {
          res.status(404).json({ error: 'NOT_FOUND', message: 'Vertical pack not found' });
          return;
        }
        const resolved = resolveTerminology(pack, req.params.term);
        if (!resolved) {
          res.status(404).json({ error: 'NOT_FOUND', message: 'Term not found' });
          return;
        }
        res.json(resolved);
      } catch (err) {
        const { statusCode, body } = toErrorResponse(err);
        res.status(statusCode).json(body);
      }
    }
  );

  return router;
}
