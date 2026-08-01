import { Router, Response } from 'express';
import { AuthenticatedRequest } from '../auth/clerk';
import { requireAuth, requireTenant, requirePermission } from '../middleware/auth';
import { toErrorResponse } from '../shared/errors';
import type { JobsBookedReporter } from './jobs-booked';

/**
 * Epic 12.4 — GET /api/analytics/jobs-booked
 *
 * Jobs-booked count for a calendar month with a month-over-month comparison.
 * Reuses `jobs:view` (anyone who can see jobs can see how many were booked).
 * 503s when the reporter is not wired (in-memory boot path has no pool).
 */
export interface JobsBookedRouterDeps {
  jobsBookedReporter?: JobsBookedReporter;
}

function currentMonth(): string {
  const now = new Date();
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
}

export function createJobsBookedRouter(deps: JobsBookedRouterDeps): Router {
  const router = Router();

  router.get(
    '/',
    requireAuth,
    requireTenant,
    requirePermission('jobs:view'),
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        if (!deps.jobsBookedReporter) {
          res.status(503).json({ error: 'NOT_CONFIGURED', message: 'Jobs-booked report unavailable' });
          return;
        }
        const month = (req.query.month as string | undefined) || currentMonth();
        if (!/^\d{4}-\d{2}$/.test(month)) {
          res.status(400).json({ error: 'VALIDATION_ERROR', message: "`month` must be 'YYYY-MM'" });
          return;
        }
        const summary = await deps.jobsBookedReporter.query(req.auth!.tenantId, month);
        res.json({ data: summary });
      } catch (err) {
        const { statusCode, body } = toErrorResponse(err);
        res.status(statusCode).json(body);
      }
    },
  );

  return router;
}
