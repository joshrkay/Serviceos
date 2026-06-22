import { Router, Response } from 'express';
import { AuthenticatedRequest } from '../auth/clerk';
import { requireAuth, requireTenant, requirePermission } from '../middleware/auth';
import { toErrorResponse } from '../shared/errors';
import type { ActivityFeedReporter } from './activity-feed';

/**
 * Epic 12.7 — GET /api/analytics/activity
 *
 * Tenant-wide chronological activity feed (agent + human + system actions),
 * newest first, with emergency flags and entity refs for deep-linking.
 * Reuses `jobs:view` (broad operational read). 503s when not wired.
 */
export interface ActivityFeedRouterDeps {
  activityFeedReporter?: ActivityFeedReporter;
}

const DEFAULT_LIMIT = 30;
const MAX_LIMIT = 100;

export function createActivityFeedRouter(deps: ActivityFeedRouterDeps): Router {
  const router = Router();

  router.get(
    '/',
    requireAuth,
    requireTenant,
    requirePermission('jobs:view'),
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        if (!deps.activityFeedReporter) {
          res.status(503).json({ error: 'NOT_CONFIGURED', message: 'Activity feed unavailable' });
          return;
        }
        let limit = DEFAULT_LIMIT;
        const limitRaw = req.query.limit as string | undefined;
        if (limitRaw !== undefined) {
          const parsed = Number(limitRaw);
          if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_LIMIT) {
            res.status(400).json({
              error: 'VALIDATION_ERROR',
              message: `\`limit\` must be an integer in [1, ${MAX_LIMIT}]`,
            });
            return;
          }
          limit = parsed;
        }
        const data = await deps.activityFeedReporter.query(req.auth!.tenantId, { limit });
        res.json({ data });
      } catch (err) {
        const { statusCode, body } = toErrorResponse(err);
        res.status(statusCode).json(body);
      }
    },
  );

  return router;
}
