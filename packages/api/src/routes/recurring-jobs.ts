import { Router, Response } from 'express';
import { AuthenticatedRequest } from '../auth/clerk';
import { asyncRoute } from '../middleware/async-route';
import { requireAuth, requireTenant, requirePermission } from '../middleware/auth';
import { AuditRepository } from '../audit/audit';
import {
  RecurringJobRepository,
  archiveRecurringJob,
  createRecurringJob,
  updateRecurringJob,
  upcomingOccurrences,
} from '../recurring-jobs/recurring-job';
import { describeRecurrence } from '../recurring-jobs/recurrence';
import { createRecurringJobSchema, updateRecurringJobSchema } from '../shared/contracts';

/**
 * R-JOB (Jobber parity) — recurring job series.
 *
 * Mounted at /api/recurring-jobs. Series management uses the jobs permission
 * set. `GET /:id/occurrences` returns the computed upcoming visit dates so the
 * UI can show "the next 5 visits" without materializing them.
 */
export function createRecurringJobRouter(
  repo: RecurringJobRepository,
  auditRepo: AuditRepository
): Router {
  const router = Router();

  router.get(
    '/',
    requireAuth,
    requireTenant,
    requirePermission('jobs:view'),
    asyncRoute(async (req: AuthenticatedRequest, res: Response) => {
      const customerId = typeof req.query.customerId === 'string' ? req.query.customerId : undefined;
      const includeArchived = req.query.includeArchived === 'true';
      const jobs = await repo.list(req.auth!.tenantId, { customerId, includeArchived });
      res.json(jobs.map((j) => ({ ...j, scheduleSummary: describeRecurrence(j.rule) })));
    })
  );

  router.post(
    '/',
    requireAuth,
    requireTenant,
    requirePermission('jobs:create'),
    asyncRoute(async (req: AuthenticatedRequest, res: Response) => {
      const parsed = createRecurringJobSchema.parse(req.body);
      const job = await createRecurringJob(
        {
          ...parsed,
          tenantId: req.auth!.tenantId,
          createdBy: req.auth!.userId,
          actorRole: req.auth!.role,
        },
        repo,
        auditRepo
      );
      res.status(201).json(job);
    })
  );

  router.get(
    '/:id',
    requireAuth,
    requireTenant,
    requirePermission('jobs:view'),
    asyncRoute(async (req: AuthenticatedRequest, res: Response) => {
      const job = await repo.findById(req.auth!.tenantId, req.params.id);
      if (!job) {
        res.status(404).json({ error: 'NOT_FOUND', message: 'Recurring job not found' });
        return;
      }
      res.json({ ...job, scheduleSummary: describeRecurrence(job.rule) });
    })
  );

  router.get(
    '/:id/occurrences',
    requireAuth,
    requireTenant,
    requirePermission('jobs:view'),
    asyncRoute(async (req: AuthenticatedRequest, res: Response) => {
      const job = await repo.findById(req.auth!.tenantId, req.params.id);
      if (!job) {
        res.status(404).json({ error: 'NOT_FOUND', message: 'Recurring job not found' });
        return;
      }
      const from = typeof req.query.from === 'string' ? req.query.from : undefined;
      const rawLimit = Number(req.query.limit);
      const limit = Number.isInteger(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 100) : 10;
      res.json({ occurrences: upcomingOccurrences(job, from, limit) });
    })
  );

  router.patch(
    '/:id',
    requireAuth,
    requireTenant,
    requirePermission('jobs:update'),
    asyncRoute(async (req: AuthenticatedRequest, res: Response) => {
      const parsed = updateRecurringJobSchema.parse(req.body);
      const job = await updateRecurringJob(
        req.auth!.tenantId,
        req.params.id,
        parsed,
        repo,
        req.auth!.userId,
        auditRepo,
        req.auth!.role
      );
      res.json(job);
    })
  );

  router.post(
    '/:id/archive',
    requireAuth,
    requireTenant,
    requirePermission('jobs:update'),
    asyncRoute(async (req: AuthenticatedRequest, res: Response) => {
      const archived = await archiveRecurringJob(
        req.auth!.tenantId,
        req.params.id,
        repo,
        req.auth!.userId,
        auditRepo,
        req.auth!.role
      );
      if (!archived) {
        res.status(404).json({ error: 'NOT_FOUND', message: 'Recurring job not found' });
        return;
      }
      res.json(archived);
    })
  );

  return router;
}
