import { Router, Response } from 'express';
import { z } from 'zod';
import { AuthenticatedRequest } from '../auth/clerk';
import { requireAuth, requireTenant, requireRole } from '../middleware/auth';
import { toErrorResponse } from '../shared/errors';
import { validate } from '../shared/validation';
import {
  FeatureFlag,
  FeatureFlagStore,
  FeatureFlagRepository,
} from '../flags/feature-flags';

const upsertSchema = z.object({
  name: z.string().min(1),
  enabled: z.boolean(),
  environments: z.array(z.string()).optional(),
  tenantIds: z.array(z.string()).optional(),
  description: z.string().optional(),
});

/**
 * P7-015 — admin API for feature flags.
 *
 * Restricted to the owner role. All mutations persist through the
 * FeatureFlagRepository so they survive process restarts, and the
 * synchronous store is updated in the same transaction so subsequent
 * isFeatureEnabled() calls see the new value immediately.
 */
export function createFeatureFlagsRouter(
  repo: FeatureFlagRepository,
  store: FeatureFlagStore
): Router {
  const router = Router();

  router.get(
    '/',
    requireAuth,
    requireTenant,
    requireRole('owner'),
    async (_req: AuthenticatedRequest, res: Response) => {
      try {
        const flags = await repo.list();
        res.json({ data: flags });
      } catch (err) {
        const { statusCode, body } = toErrorResponse(err);
        res.status(statusCode).json(body);
      }
    }
  );

  router.get(
    '/:name',
    requireAuth,
    requireTenant,
    requireRole('owner'),
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        const flag = await repo.get(req.params.name);
        if (!flag) {
          res.status(404).json({ error: 'NOT_FOUND', message: 'Flag not found' });
          return;
        }
        res.json(flag);
      } catch (err) {
        const { statusCode, body } = toErrorResponse(err);
        res.status(statusCode).json(body);
      }
    }
  );

  router.put(
    '/:name',
    requireAuth,
    requireTenant,
    requireRole('owner'),
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        const parsed = validate(upsertSchema, { ...req.body, name: req.params.name });
        const flag: FeatureFlag = {
          name: parsed.name,
          enabled: parsed.enabled,
          environments: parsed.environments,
          tenantIds: parsed.tenantIds,
          description: parsed.description,
        };
        const saved = await repo.upsert(flag);
        store.setFlag(saved);
        res.json(saved);
      } catch (err) {
        const { statusCode, body } = toErrorResponse(err);
        res.status(statusCode).json(body);
      }
    }
  );

  router.delete(
    '/:name',
    requireAuth,
    requireTenant,
    requireRole('owner'),
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        const removed = await repo.delete(req.params.name);
        if (!removed) {
          res.status(404).json({ error: 'NOT_FOUND', message: 'Flag not found' });
          return;
        }
        store.removeFlag(req.params.name);
        res.status(204).send();
      } catch (err) {
        const { statusCode, body } = toErrorResponse(err);
        res.status(statusCode).json(body);
      }
    }
  );

  return router;
}
