import { Router, Response } from 'express';
import { AuthenticatedRequest } from '../auth/clerk';
import { requireAuth, requireTenant, requirePermission } from '../middleware/auth';
import { toErrorResponse } from '../shared/errors';
import { RevenueBySourceRepository } from '../reports/revenue-by-source';

/**
 * Tenant-scoped reporting endpoints. Currently exposes a single
 * revenue-by-source rollup for marketing attribution. Add new reports
 * here rather than spinning up a separate router per metric.
 */
export function createReportsRouter(
  revenueBySourceRepo: RevenueBySourceRepository,
): Router {
  const router = Router();

  router.get(
    '/revenue-by-source',
    requireAuth,
    requireTenant,
    // Reuses the invoices:view permission — anyone who can see invoices
    // can see how they were attributed.
    requirePermission('invoices:view'),
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        const fromRaw = req.query.from as string | undefined;
        const toRaw = req.query.to as string | undefined;
        const from = fromRaw ? new Date(fromRaw) : undefined;
        const to = toRaw ? new Date(toRaw) : undefined;
        if (fromRaw && (Number.isNaN(from!.getTime()))) {
          res.status(400).json({ error: 'VALIDATION_ERROR', message: 'Invalid `from` date' });
          return;
        }
        if (toRaw && (Number.isNaN(to!.getTime()))) {
          res.status(400).json({ error: 'VALIDATION_ERROR', message: 'Invalid `to` date' });
          return;
        }
        const rows = await revenueBySourceRepo.query(req.auth!.tenantId, { from, to });
        res.json({ data: rows });
      } catch (err) {
        const { statusCode, body } = toErrorResponse(err);
        res.status(statusCode).json(body);
      }
    }
  );

  return router;
}
