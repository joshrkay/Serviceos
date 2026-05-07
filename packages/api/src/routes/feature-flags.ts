import { Router, Response, RequestHandler } from 'express';
import { z } from 'zod';
import { AuthenticatedRequest } from '../auth/clerk';
import { requireAuth, requireTenant } from '../middleware/auth';
import {
  PlatformAdminChecker,
  PgPlatformAdminChecker,
  requirePlatformAdmin,
} from '../auth/platform-admin';
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

export interface FeatureFlagsRouterOptions {
  /**
   * Authority gate for global feature-flag mutations. If omitted, the
   * router builds a default that always denies — explicit configuration
   * is preferred. App wiring should pass either a `requirePlatformAdmin`
   * middleware or a `PlatformAdminChecker` so this is not the prod path.
   */
  requirePlatformAdmin?: RequestHandler;
  platformAdminChecker?: PlatformAdminChecker;
}

/**
 * P7-015 — admin API for feature flags.
 * P0-034 — gated on platform-admin (cross-tenant) instead of tenant
 *         owner role. Tenant owners cannot mutate the global registry.
 *
 * Mutations persist through the FeatureFlagRepository and the synchronous
 * store is updated in the same call so subsequent isFeatureEnabled()
 * calls see the new value immediately.
 */
export function createFeatureFlagsRouter(
  repo: FeatureFlagRepository,
  store: FeatureFlagStore,
  options: FeatureFlagsRouterOptions = {}
): Router {
  const router = Router();

  const adminGate: RequestHandler =
    options.requirePlatformAdmin ??
    (options.platformAdminChecker
      ? requirePlatformAdmin(options.platformAdminChecker)
      : buildDefaultAdminGate());

  router.get(
    '/',
    requireAuth,
    requireTenant,
    adminGate,
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
    adminGate,
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
    adminGate,
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
    adminGate,
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

/**
 * Default gate when neither a middleware nor a checker is supplied:
 * if `DATABASE_URL` is set we lazily build a `PgPlatformAdminChecker`
 * against it; otherwise we fail closed (403 for everyone). Failing
 * closed is the safe default — granting global flag-mutation rights
 * by accident would be a serious authority leak.
 */
function buildDefaultAdminGate(): RequestHandler {
  let cachedHandler: RequestHandler | null = null;

  return async (req, res, next) => {
    if (!cachedHandler) {
      const databaseUrl = process.env.DATABASE_URL;
      if (databaseUrl) {
        // Lazy-load to avoid pulling pg into envs that don't need it.
        const { createPool } = await import('../db/pool');
        const pool = createPool();
        cachedHandler = requirePlatformAdmin(new PgPlatformAdminChecker(pool));
      } else {
        // Fail closed — no DB means no platform-admin table to consult.
        cachedHandler = (_r, response) => {
          response.status(403).json({
            error: 'platform_admin_required',
            message: 'Platform-admin authority required',
          });
        };
      }
    }
    return cachedHandler(req, res, next);
  };
}
