import { Router, Response } from 'express';
import { z } from 'zod';
import { AuthenticatedRequest } from '../auth/clerk';
import { requireAuth, requireTenant, requirePermission } from '../middleware/auth';
import {
  createJobSchema,
  scheduleJobSchema,
  reassignJobSchema,
  unscheduleJobSchema,
} from '../shared/contracts';
import { toErrorResponse, ValidationError } from '../shared/errors';
import { syncJobSchedule, JobAppointmentSyncDeps } from '../jobs/job-appointment-sync';
import { notifyDispatchBoardChanged } from '../dispatch/board-notify';
import { AppointmentRepository } from '../appointments/appointment';
import { AssignmentRepository } from '../appointments/assignment';
import { UserRepository } from '../users/user';
import {
  convertEstimateToScheduledJob,
  ConvertEstimateToScheduledJobDeps,
} from '../jobs/from-estimate';
import { TenantOwnership } from '../shared/tenant-ownership';
import { Customer, CustomerRepository } from '../customers/customer';
import {
  createJob,
  getJob,
  updateJob,
  listJobs,
  listJobsWithMeta,
  JobRepository,
  DEFAULT_JOB_LIMIT,
  MAX_JOB_LIMIT,
} from '../jobs/job';
import {
  transitionJobStatus,
  JobTimelineRepository,
} from '../jobs/job-lifecycle';
import { AuditRepository } from '../audit/audit';
import { Queue } from '../queues/queue';
import { FeedbackDispatcher } from '../feedback/dispatcher';
import { LocationRepository, ServiceLocation } from '../locations/location';
import {
  maybeAutoInvoiceOnCompletion,
  AutoInvoiceOnCompletionDeps,
} from '../invoices/auto-invoice-on-completion';
import { mintCompletionMilestones } from '../invoices/schedule-completion';
import { InvoiceScheduleRepository } from '../invoices/invoice-schedule';
import { createLogger } from '../logging/logger';

const logger = createLogger({
  service: 'jobs-route',
  environment: process.env.NODE_ENV || 'development',
});

export function createJobRouter(
  jobRepo: JobRepository,
  timelineRepo: JobTimelineRepository,
  auditRepo: AuditRepository,
  ownership: TenantOwnership,
  queue: Queue,
  feedbackDispatcher: FeedbackDispatcher,
  customerRepo?: CustomerRepository,
  locationRepo?: LocationRepository,
  /**
   * P20-001 — when present, completing a job may auto-draft an invoice.
   * `scheduleRepo` (P21) additionally mints on_completion schedule milestones.
   */
  autoInvoiceDeps?: AutoInvoiceOnCompletionDeps & { scheduleRepo?: InvoiceScheduleRepository },
  /**
   * Feature 5 — when present, enables POST /from-estimate/:estimateId to
   * schedule + assign the job an accepted/sent estimate belongs to. Optional so
   * existing callers/tests that don't wire scheduling deps stay valid (the
   * route returns 503 NOT_CONFIGURED when absent).
   */
  fromEstimateDeps?: ConvertEstimateToScheduledJobDeps,
  /**
   * Direct job scheduling — when present, enables schedule-on-create and the
   * POST /:id/schedule, /reassign, /unschedule endpoints. Supplies the
   * appointment/assignment/technician repos the sync needs;
   * jobRepo/timelineRepo/auditRepo are reused from the router's own params.
   * Optional so callers that don't wire scheduling stay valid (schedule
   * fields are ignored on create and the endpoints return 503 NOT_CONFIGURED).
   */
  scheduleSyncDeps?: {
    appointmentRepo: AppointmentRepository;
    assignmentRepo: AssignmentRepository;
    userRepo: UserRepository;
  },
): Router {
  const router = Router();

  // Assemble the full sync deps from the router's repos + the scheduling repos.
  const buildScheduleSyncDeps = (): JobAppointmentSyncDeps | null => {
    if (!scheduleSyncDeps) return null;
    return {
      jobRepo,
      timelineRepo,
      auditRepo,
      appointmentRepo: scheduleSyncDeps.appointmentRepo,
      assignmentRepo: scheduleSyncDeps.assignmentRepo,
      userRepo: scheduleSyncDeps.userRepo,
    };
  };

  const fromEstimateBodySchema = z
    .object({
      durationMin: z.number().int().positive().optional(),
      technicianId: z.string().uuid().optional(),
      scheduledStart: z.string().datetime().optional(),
      timezone: z.string().min(1).optional(),
    })
    .strict();
  // Dispatcher is intentionally passed through router wiring so this API
  // surface aligns with app-level dependency injection for feedback_send.
  void feedbackDispatcher;
  // `queue` is retained in the signature (app-level DI) but the on-completion
  // review-request enqueue moved to the 24h review-request sweep (US-345).
  void queue;

  // Embed a lightweight customer summary on job list rows so the UI can show
  // the customer name without a second round-trip. Jobs whose customer can't
  // be resolved (deleted / cross-tenant) stay unenriched.
  const attachCustomerSummaries = async <T extends { customerId: string }>(
    tenantId: string,
    jobs: T[],
  ): Promise<Array<T & { customer?: Record<string, unknown> }>> => {
    if (!customerRepo || jobs.length === 0) return jobs;
    const customerIds = [...new Set(jobs.map((j) => j.customerId).filter(Boolean))];
    const customers = await Promise.all(
      customerIds.map((id) => customerRepo.findById(tenantId, id).catch(() => null)),
    );
    const customerById = new Map(
      customers.filter((c): c is Customer => c !== null).map((c) => [c.id, c]),
    );
    return jobs.map((j) => {
      const c = customerById.get(j.customerId);
      return c
        ? {
            ...j,
            customer: {
              id: c.id,
              displayName: c.displayName,
              firstName: c.firstName,
              lastName: c.lastName,
            },
          }
        : j;
    });
  };

  router.post(
    '/',
    requireAuth,
    requireTenant,
    requirePermission('jobs:create'),
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        const parsed = createJobSchema.parse(req.body);
        // requireExistsAndLoad returns the row so we don't refetch it
        // below to read originatingLeadId for attribution propagation.
        const customer = (await ownership.requireExistsAndLoad(
          req.auth!.tenantId,
          'customer',
          parsed.customerId
        )) as Customer | undefined;
        const location = (await ownership.requireExistsAndLoad(
          req.auth!.tenantId,
          'location',
          parsed.locationId
        )) as ServiceLocation | undefined;
        if (location && location.customerId !== parsed.customerId) {
          throw new ValidationError('Service location does not belong to customer');
        }

        // Resolve source attribution: explicit body override wins;
        // otherwise inherit from the customer.
        let originatingLeadId = parsed.originatingLeadId;
        if (originatingLeadId) {
          await ownership.requireExists(req.auth!.tenantId, 'lead', originatingLeadId);
        } else {
          originatingLeadId = customer?.originatingLeadId;
        }

        // Split the optional schedule block off the job fields — createJob
        // ignores them; the sync projects them onto an appointment below.
        const { scheduledStart, technicianId, durationMin, timezone, ...jobFields } = parsed;

        // Resolve scheduling deps BEFORE creating the job, so a scheduling
        // request against an unconfigured deployment fails closed (503) rather
        // than leaving an orphan unscheduled job behind.
        const scheduleDeps = scheduledStart ? buildScheduleSyncDeps() : null;
        if (scheduledStart && !scheduleDeps) {
          res.status(503).json({
            error: 'NOT_CONFIGURED',
            message: 'Job scheduling is not configured',
          });
          return;
        }

        const result = await createJob(
          {
            ...jobFields,
            originatingLeadId,
            tenantId: req.auth!.tenantId,
            createdBy: req.auth!.userId,
            actorRole: req.auth!.role,
          },
          jobRepo,
          auditRepo
        );

        // Schedule-on-create: project the schedule intent onto a linked
        // appointment in the SAME request transaction (atomic — a conflict
        // 409s and rolls the job back). Board notify only on success.
        if (scheduledStart && scheduleDeps) {
          const { appointment } = await syncJobSchedule(scheduleDeps, {
            operation: 'schedule',
            tenantId: req.auth!.tenantId,
            jobId: result.id,
            actorId: req.auth!.userId,
            actorRole: req.auth!.role,
            scheduledStart: new Date(scheduledStart),
            technicianId,
            durationMin,
            timezone,
          });
          if (appointment) notifyDispatchBoardChanged(req.auth!.tenantId, appointment.scheduledStart);
          const scheduledJob = await getJob(req.auth!.tenantId, result.id, jobRepo);
          res.status(201).json(scheduledJob ?? result);
          return;
        }

        res.status(201).json(result);
      } catch (err) {
        const { statusCode, body } = toErrorResponse(err);
        res.status(statusCode).json(body);
      }
    }
  );

  // Feature 5 — schedule + assign the job an accepted/sent estimate belongs to,
  // and flip the estimate to accepted. Reuses the estimate's existing job.
  router.post(
    '/from-estimate/:estimateId',
    requireAuth,
    requireTenant,
    requirePermission('jobs:create'),
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        if (!fromEstimateDeps) {
          res.status(503).json({
            error: 'NOT_CONFIGURED',
            message: 'Estimate-to-job scheduling is not configured',
          });
          return;
        }
        const body = fromEstimateBodySchema.parse(req.body ?? {});
        const result = await convertEstimateToScheduledJob(fromEstimateDeps, {
          tenantId: req.auth!.tenantId,
          estimateId: req.params.estimateId,
          actorId: req.auth!.userId,
          actorRole: req.auth!.role,
          durationMin: body.durationMin,
          technicianId: body.technicianId,
          scheduledStart: body.scheduledStart ? new Date(body.scheduledStart) : undefined,
          timezone: body.timezone,
        });
        res.status(201).json(result);
      } catch (err) {
        if (err instanceof z.ZodError) {
          const { statusCode, body } = toErrorResponse(
            new ValidationError(`Validation failed: ${err.issues.map((i) => i.message).join(', ')}`),
          );
          res.status(statusCode).json(body);
          return;
        }
        const { statusCode, body } = toErrorResponse(err);
        res.status(statusCode).json(body);
      }
    }
  );

  // Direct job scheduling lifecycle. /:id/schedule covers the initial
  // schedule AND a reschedule (idempotent upsert of the canonical
  // job-schedule appointment); /:id/reassign changes or clears (null) the
  // primary technician; /:id/unschedule cancels the appointment and reverts
  // the job scheduled → new. All run inside the request transaction, so a
  // double-booking 409s atomically with no partial writes.
  const handleScheduleError = (res: Response, err: unknown): void => {
    if (err instanceof z.ZodError) {
      const { statusCode, body } = toErrorResponse(
        new ValidationError(`Validation failed: ${err.issues.map((i) => i.message).join(', ')}`),
      );
      res.status(statusCode).json(body);
      return;
    }
    const { statusCode, body } = toErrorResponse(err);
    res.status(statusCode).json(body);
  };

  router.post(
    '/:id/schedule',
    requireAuth,
    requireTenant,
    // Scheduling a job books an appointment on the dispatch board. Gate on the
    // appointment-create permission (owner/dispatcher) rather than jobs:update —
    // a technician holds jobs:update but must not be able to book/move work.
    requirePermission('appointments:create'),
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        const syncDeps = buildScheduleSyncDeps();
        if (!syncDeps) {
          res.status(503).json({ error: 'NOT_CONFIGURED', message: 'Job scheduling is not configured' });
          return;
        }
        const body = scheduleJobSchema.parse(req.body ?? {});
        const result = await syncJobSchedule(syncDeps, {
          operation: 'schedule',
          tenantId: req.auth!.tenantId,
          jobId: req.params.id,
          actorId: req.auth!.userId,
          actorRole: req.auth!.role,
          scheduledStart: new Date(body.scheduledStart),
          technicianId: body.technicianId,
          durationMin: body.durationMin,
          timezone: body.timezone,
        });
        // New day always; the old day too on a reschedule.
        if (result.appointment) notifyDispatchBoardChanged(req.auth!.tenantId, result.appointment.scheduledStart);
        if (result.previousScheduledStart) {
          notifyDispatchBoardChanged(req.auth!.tenantId, result.previousScheduledStart);
        }
        const job = await getJob(req.auth!.tenantId, req.params.id, jobRepo);
        res.status(200).json(job);
      } catch (err) {
        handleScheduleError(res, err);
      }
    },
  );

  router.post(
    '/:id/reassign',
    requireAuth,
    requireTenant,
    // Reassigning moves an existing appointment to another technician — an
    // appointment mutation, not a job edit. Owner/dispatcher only.
    requirePermission('appointments:update'),
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        const syncDeps = buildScheduleSyncDeps();
        if (!syncDeps) {
          res.status(503).json({ error: 'NOT_CONFIGURED', message: 'Job scheduling is not configured' });
          return;
        }
        const body = reassignJobSchema.parse(req.body ?? {});
        const result = await syncJobSchedule(syncDeps, {
          operation: 'reassign',
          tenantId: req.auth!.tenantId,
          jobId: req.params.id,
          actorId: req.auth!.userId,
          actorRole: req.auth!.role,
          technicianId: body.technicianId,
        });
        if (result.appointment) notifyDispatchBoardChanged(req.auth!.tenantId, result.appointment.scheduledStart);
        const job = await getJob(req.auth!.tenantId, req.params.id, jobRepo);
        res.status(200).json(job);
      } catch (err) {
        handleScheduleError(res, err);
      }
    },
  );

  router.post(
    '/:id/unschedule',
    requireAuth,
    requireTenant,
    // Unscheduling cancels the appointment and clears the dispatch slot — an
    // appointment mutation. Owner/dispatcher only.
    requirePermission('appointments:update'),
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        const syncDeps = buildScheduleSyncDeps();
        if (!syncDeps) {
          res.status(503).json({ error: 'NOT_CONFIGURED', message: 'Job scheduling is not configured' });
          return;
        }
        const body = unscheduleJobSchema.parse(req.body ?? {});
        const result = await syncJobSchedule(syncDeps, {
          operation: 'unschedule',
          tenantId: req.auth!.tenantId,
          jobId: req.params.id,
          actorId: req.auth!.userId,
          actorRole: req.auth!.role,
          reason: body.reason,
        });
        if (result.previousScheduledStart) {
          notifyDispatchBoardChanged(req.auth!.tenantId, result.previousScheduledStart);
        }
        const job = await getJob(req.auth!.tenantId, req.params.id, jobRepo);
        res.status(200).json(job);
      } catch (err) {
        handleScheduleError(res, err);
      }
    },
  );

  router.get(
    '/',
    requireAuth,
    requireTenant,
    requirePermission('jobs:view'),
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        const sort: 'asc' | 'desc' = req.query.sort === 'asc' ? 'asc' : 'desc';

        // P1-018: opt-in to `{ data, total }` shape via paginated/limit/offset.
        // Default keeps the legacy bare-array contract for older consumers.
        const wantsPaginated =
          req.query.paginated === 'true' ||
          req.query.limit !== undefined ||
          req.query.offset !== undefined;

        const limitRaw = req.query.limit as string | undefined;
        const offsetRaw = req.query.offset as string | undefined;
        const limit = limitRaw !== undefined ? parseInt(limitRaw, 10) : DEFAULT_JOB_LIMIT;
        const offset = offsetRaw !== undefined ? parseInt(offsetRaw, 10) : 0;
        if (limitRaw !== undefined && (Number.isNaN(limit) || limit < 1 || limit > MAX_JOB_LIMIT)) {
          res.status(400).json({
            error: 'VALIDATION_ERROR',
            message: `limit must be between 1 and ${MAX_JOB_LIMIT}`,
          });
          return;
        }
        if (offsetRaw !== undefined && (Number.isNaN(offset) || offset < 0)) {
          res.status(400).json({
            error: 'VALIDATION_ERROR',
            message: 'offset must be a non-negative integer',
          });
          return;
        }

        const baseOptions = {
          status: req.query.status as any,
          customerId: req.query.customerId as string,
          technicianId: req.query.technicianId as string,
          search: req.query.search as string,
          sort,
        };

        if (wantsPaginated) {
          const result = await listJobsWithMeta(req.auth!.tenantId, jobRepo, {
            ...baseOptions,
            limit,
            offset,
          });
          res.json({
            ...result,
            data: await attachCustomerSummaries(req.auth!.tenantId, result.data),
          });
          return;
        }

        const result = await listJobs(req.auth!.tenantId, jobRepo, baseOptions);
        res.json(await attachCustomerSummaries(req.auth!.tenantId, result));
      } catch (err) {
        const { statusCode, body } = toErrorResponse(err);
        res.status(statusCode).json(body);
      }
    }
  );

  router.get(
    '/:id',
    requireAuth,
    requireTenant,
    requirePermission('jobs:view'),
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        const result = await getJob(req.auth!.tenantId, req.params.id, jobRepo);
        if (!result) {
          res.status(404).json({ error: 'NOT_FOUND', message: 'Job not found' });
          return;
        }

        // Enrich with customer and location data when repos are available
        let customer: Customer | null = null;
        let locations: Array<Record<string, unknown>> = [];
        if (result.customerId) {
          const [cust, locs] = await Promise.all([
            customerRepo ? customerRepo.findById(req.auth!.tenantId, result.customerId) : Promise.resolve(null),
            locationRepo ? locationRepo.findByCustomer(req.auth!.tenantId, result.customerId) : Promise.resolve([]),
          ]);
          customer = cust;
          locations = locs.map(loc => ({
            id: loc.id,
            street1: loc.street1,
            street2: loc.street2,
            city: loc.city,
            state: loc.state,
            postalCode: loc.postalCode,
            isPrimary: loc.isPrimary,
            label: loc.label,
          }));
        }

        const response = {
          ...result,
          customer: customer ? {
            id: customer.id,
            displayName: customer.displayName,
            firstName: customer.firstName,
            lastName: customer.lastName,
            primaryPhone: customer.primaryPhone,
            email: customer.email,
            communicationNotes: customer.communicationNotes,
            locations,
          } : undefined,
          location: locations.find(l => l.id === result.locationId),
        };

        res.json(response);
      } catch (err) {
        const { statusCode, body } = toErrorResponse(err);
        res.status(statusCode).json(body);
      }
    }
  );

  router.put(
    '/:id',
    requireAuth,
    requireTenant,
    requirePermission('jobs:update'),
    async (req: AuthenticatedRequest, res: Response) => {
      try {
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
      } catch (err) {
        const { statusCode, body } = toErrorResponse(err);
        res.status(statusCode).json(body);
      }
    }
  );

  router.post(
    '/:id/transition',
    requireAuth,
    requireTenant,
    requirePermission('jobs:update'),
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        const { status, reason } = req.body;
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
          auditRepo,
          // §5.8 — required for backward moves; the lifecycle gates it.
          typeof reason === 'string' ? reason : undefined
        );

        if (status === 'completed') {
          // PRD US-345 — the review/feedback request now fires 24h after
          // completion via the leader-locked review-request sweep
          // (workers/review-request-worker.ts), not immediately here, so the
          // ask lands the day after the visit. The sweep enqueues feedback_send
          // with the same idempotency key the immediate enqueue used.

          // P20-001 — auto-draft an invoice (opt-in, gated inside). Best-effort:
          // a drafting failure must never fail the completion the owner just made.
          if (autoInvoiceDeps) {
            try {
              await maybeAutoInvoiceOnCompletion(autoInvoiceDeps, result.job);
            } catch (autoErr) {
              logger.error('auto-invoice on completion failed', {
                tenantId: req.auth!.tenantId,
                jobId: req.params.id,
                error: autoErr instanceof Error ? autoErr.message : String(autoErr),
              });
            }
          }

          // P21 — mint on_completion milestones for any invoice schedule on this
          // job (e.g. the balance of a deposit/balance plan). Best-effort, same
          // as above; an approved schedule needs no re-approval to bill its plan.
          if (autoInvoiceDeps?.scheduleRepo) {
            try {
              await mintCompletionMilestones(
                {
                  scheduleRepo: autoInvoiceDeps.scheduleRepo,
                  invoiceRepo: autoInvoiceDeps.invoiceRepo,
                  settingsRepo: autoInvoiceDeps.settingsRepo,
                  auditRepo: autoInvoiceDeps.auditRepo,
                },
                result.job,
              );
            } catch (milestoneErr) {
              logger.error('schedule completion milestone minting failed', {
                tenantId: req.auth!.tenantId,
                jobId: req.params.id,
                error: milestoneErr instanceof Error ? milestoneErr.message : String(milestoneErr),
              });
            }
          }
        }

        // Cancel propagation: a canceled job must not leave a live appointment
        // on the dispatch board. Runs in the same request transaction as the
        // status change (NOT best-effort) so the two stay consistent — a
        // failed cancel rolls the transition back. No-op when nothing is
        // scheduled or scheduling isn't wired.
        if (status === 'canceled') {
          const syncDeps = buildScheduleSyncDeps();
          if (syncDeps) {
            const sync = await syncJobSchedule(syncDeps, {
              operation: 'cancelForJob',
              tenantId: req.auth!.tenantId,
              jobId: req.params.id,
              actorId: req.auth!.userId,
              actorRole: req.auth!.role,
            });
            if (sync.previousScheduledStart) {
              notifyDispatchBoardChanged(req.auth!.tenantId, sync.previousScheduledStart);
            }
          }
        }

        res.json(result);
      } catch (err) {
        const { statusCode, body } = toErrorResponse(err);
        res.status(statusCode).json(body);
      }
    }
  );

  return router;
}
