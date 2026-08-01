import { Router, Response } from 'express';
import { DateTime } from 'luxon';
import { AuthenticatedRequest } from '../auth/clerk';
import { asyncRoute } from '../middleware/async-route';
import { requireAuth, requireTenant, requirePermission } from '../middleware/auth';
import { AuditRepository } from '../audit/audit';
import { CustomerRepository } from '../customers/customer';
import { JobRepository } from '../jobs/job';
import { AppointmentRepository } from '../appointments/appointment';
import { LocationRepository } from '../locations/location';
import {
  RecurringJobRepository,
  archiveRecurringJob,
  createRecurringJob,
  updateRecurringJob,
  upcomingOccurrences,
} from '../recurring-jobs/recurring-job';
import { materializeRecurringJob } from '../recurring-jobs/materialize';
import { describeRecurrence } from '../recurring-jobs/recurrence';
import { createRecurringJobSchema, updateRecurringJobSchema } from '../shared/contracts';

/** Extra deps for materializing a series into real jobs + appointments. */
export interface RecurringJobMaterializeDeps {
  jobRepo: JobRepository;
  appointmentRepo: AppointmentRepository;
  locationRepo: LocationRepository;
  /** Resolve the tenant's IANA timezone (falls back to a default upstream). */
  resolveTimezone: (tenantId: string) => Promise<string>;
}

/**
 * R-JOB (Jobber parity) — recurring job series.
 *
 * Mounted at /api/recurring-jobs. Series management uses the jobs permission
 * set. `GET /:id/occurrences` returns the computed upcoming visit dates so the
 * UI can show "the next 5 visits" without materializing them.
 */
export function createRecurringJobRouter(
  repo: RecurringJobRepository,
  auditRepo: AuditRepository,
  materializeDeps: RecurringJobMaterializeDeps,
  customerRepo: CustomerRepository
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
      // The customer FK is not tenant-scoped, so a guessed/foreign customerId
      // would otherwise attach a series to another tenant's customer. Verify
      // ownership under the caller's tenant before creating.
      const customer = await customerRepo.findById(req.auth!.tenantId, parsed.customerId);
      if (!customer) {
        res.status(404).json({ error: 'NOT_FOUND', message: 'Customer not found' });
        return;
      }
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
      res.status(201).json({ ...job, scheduleSummary: describeRecurrence(job.rule) });
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
      // Default the window start to today (tenant-local) so the panel shows
      // *upcoming* visits, not historical ones from the series anchor. Callers
      // can still pass an explicit `from` to see past occurrences.
      const tz = await materializeDeps.resolveTimezone(req.auth!.tenantId);
      const today = DateTime.now().setZone(tz).toISODate() ?? new Date().toISOString().slice(0, 10);
      const from = typeof req.query.from === 'string' ? req.query.from : today;
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

  // Materialize due occurrences (within an optional horizon) into real jobs +
  // appointments. Idempotent — already-generated occurrences are skipped.
  router.post(
    '/:id/generate',
    requireAuth,
    requireTenant,
    requirePermission('jobs:create'),
    asyncRoute(async (req: AuthenticatedRequest, res: Response) => {
      const job = await repo.findById(req.auth!.tenantId, req.params.id);
      if (!job) {
        res.status(404).json({ error: 'NOT_FOUND', message: 'Recurring job not found' });
        return;
      }
      // A stopped/archived series must not generate new visits — guard against a
      // stale tab or direct API call after the owner archived it.
      if (job.isArchived) {
        res.status(409).json({ error: 'ARCHIVED', message: 'This recurring job is stopped' });
        return;
      }
      const tz = await materializeDeps.resolveTimezone(req.auth!.tenantId);
      const today = DateTime.now().setZone(tz).toISODate() ?? new Date().toISOString().slice(0, 10);
      const rawHorizon = Number(req.body?.horizonDays);
      const horizonDays =
        Number.isInteger(rawHorizon) && rawHorizon > 0 ? Math.min(rawHorizon, 365) : 30;
      const result = await materializeRecurringJob(
        job,
        { today, horizonDays, timezone: tz, actorId: req.auth!.userId },
        {
          recurringJobRepo: repo,
          jobRepo: materializeDeps.jobRepo,
          appointmentRepo: materializeDeps.appointmentRepo,
          locationRepo: materializeDeps.locationRepo,
          auditRepo,
        }
      );
      res.json(result);
    })
  );

  return router;
}
