import { Router, Response } from 'express';
import { AuthenticatedRequest } from '../auth/clerk';
import { asyncRoute } from '../middleware/async-route';
import { requireAuth, requireTenant, requirePermission } from '../middleware/auth';
import { createJobSchema } from '../shared/contracts';
import { TenantOwnership } from '../shared/tenant-ownership';
import { createJob, getJob, updateJob, listJobs, JobRepository } from '../jobs/job';
import {
  transitionJobStatus,
  JobTimelineRepository,
} from '../jobs/job-lifecycle';
import { AuditRepository } from '../audit/audit';

export function createJobRouter(
  jobRepo: JobRepository,
  timelineRepo: JobTimelineRepository,
  auditRepo: AuditRepository,
  ownership: TenantOwnership
): Router {
  const router = Router();

  router.post(
    '/',
    requireAuth,
    requireTenant,
    requirePermission('jobs:create'),
    asyncRoute(async (req: AuthenticatedRequest, res: Response) => {
      const parsed = createJobSchema.parse(req.body);
      await ownership.requireExists(req.auth!.tenantId, 'customer', parsed.customerId);
      await ownership.requireExists(req.auth!.tenantId, 'location', parsed.locationId);
      const result = await createJob(
        {
          ...parsed,
          tenantId: req.auth!.tenantId,
          createdBy: req.auth!.userId,
          actorRole: req.auth!.role,
        },
        jobRepo,
        auditRepo
      );
      res.status(201).json(result);
    })
  );

  router.get(
    '/',
    requireAuth,
    requireTenant,
    requirePermission('jobs:view'),
    asyncRoute(async (req: AuthenticatedRequest, res: Response) => {
      const result = await listJobs(req.auth!.tenantId, jobRepo, {
        status: req.query.status as any,
        customerId: req.query.customerId as string,
        technicianId: req.query.technicianId as string,
        search: req.query.search as string,
      });
      res.json(result);
    })
  );

  router.get(
    '/:id',
    requireAuth,
    requireTenant,
    requirePermission('jobs:view'),
    asyncRoute(async (req: AuthenticatedRequest, res: Response) => {
      const result = await getJob(req.auth!.tenantId, req.params.id, jobRepo);
      if (!result) {
        res.status(404).json({ error: 'NOT_FOUND', message: 'Job not found' });
        return;
      }
      res.json(result);
    })
  );

  router.put(
    '/:id',
    requireAuth,
    requireTenant,
    requirePermission('jobs:update'),
    asyncRoute(async (req: AuthenticatedRequest, res: Response) => {
      const result = await updateJob(
        req.auth!.tenantId,
        req.params.id,
        req.body,
        jobRepo,
        req.auth!.userId,
        auditRepo
      );
      if (!result) {
        res.status(404).json({ error: 'NOT_FOUND', message: 'Job not found' });
        return;
      }
      res.json(result);
    })
  );

  router.post(
    '/:id/transition',
    requireAuth,
    requireTenant,
    requirePermission('jobs:update'),
    asyncRoute(async (req: AuthenticatedRequest, res: Response) => {
      const { status } = req.body;
      if (!status) {
        res.status(400).json({ error: 'VALIDATION_ERROR', message: 'status is required' });
        return;
      }
      const result = await transitionJobStatus(
        req.auth!.tenantId,
        req.params.id,
        status,
        req.auth!.userId,
        req.auth!.role,
        jobRepo,
        timelineRepo,
        auditRepo
      );
      res.json(result);
    })
  );

  return router;
}
