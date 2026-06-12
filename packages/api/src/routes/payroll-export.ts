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
      if (!start || !end) {
        res.status(400).json({ error: 'start and end query params required (YYYY-MM-DD)' });
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
