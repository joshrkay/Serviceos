import { Router, Response } from 'express';
import { AuthenticatedRequest } from '../auth/clerk';
import { requireAuth, requireTenant, requirePermission } from '../middleware/auth';

/**
 * Phase 4 — CSV payroll export for time entries in a pay period.
 */
export function createPayrollExportRouter(): Router {
  const router = Router();

  router.get(
    '/export',
    requireAuth,
    requireTenant,
    requirePermission('reports:view'),
    async (req: AuthenticatedRequest, res: Response) => {
      const start = String(req.query.start ?? '');
      const end = String(req.query.end ?? '');
      const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
      if (!dateRegex.test(start) || !dateRegex.test(end)) {
        res.status(400).json({ error: 'start and end query params must be in YYYY-MM-DD format' });
        return;
      }
      const header = 'employee_id,date,minutes,job_id,notes\n';
      res.setHeader('content-type', 'text/csv');
      res.setHeader('content-disposition', `attachment; filename="payroll-${start}-${end}.csv"`);
      res.send(header);
    },
  );

  return router;
}
