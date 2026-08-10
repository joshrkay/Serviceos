import { Router, Response } from 'express';
import { z } from 'zod';
import { AuthenticatedRequest } from '../auth/clerk';
import { requireAuth, requireTenant, requirePermission } from '../middleware/auth';
import { createAppointmentSchema, delayAcknowledgmentSchema } from '../shared/contracts';
import { toErrorResponse } from '../shared/errors';
import { TenantOwnership } from '../shared/tenant-ownership';
import {
  createAppointment,
  getAppointment,
  updateAppointment,
  listByJob,
  listAppointmentsWithMeta,
  AppointmentRepository,
  AppointmentStatus,
  DEFAULT_APPOINTMENT_LIMIT,
  MAX_APPOINTMENT_LIMIT,
} from '../appointments/appointment';
import { JobRepository } from '../jobs/job';
import {
  addDelayAcknowledgmentTimelineEntry,
  JobTimelineRepository,
  DelayAcknowledgmentMetadata,
  JOB_TIMELINE_EVENT_TYPES,
} from '../jobs/job-lifecycle';
import { AuditRepository, createAuditEvent } from '../audit/audit';
export interface DelayNotificationEnqueuer {
  enqueueDelayNotice(input: {
    tenantId: string;
    currentAppointmentId: string;
    delayVersion: number;
    delayMinutes: number;
    technicianName?: string;
    etaWindow?: { start: Date; end: Date; timezone?: string };
  }): Promise<string | null>;
}

interface AppointmentRouterOptions {
  delayNotificationCoordinator?: DelayNotificationEnqueuer;
}

// Body for POST /:id/running-late. Not the shared delayMinutesSchema
// (literal 10|15|20|60): the PUT virtual-status branch this shares a
// helper with has always accepted any positive value (the dispatcher
// NotifyDelayDialog offers 5/30/45), so the new front door matches.
const runningLateBodySchema = z.object({
  delayMinutes: z.number().int().positive().optional(),
});

/**
 * Read a string filter off `req.query`, treating a PRESENT-BUT-EMPTY value
 * (`?technicianId=`, the shape a UI emits when its filter select is cleared)
 * as ABSENT — "no filter", never "match the row whose column is the empty
 * string".
 *
 * Follow-up to PR #815. The repositories already agreed on this for the value
 * itself: `if (options?.technicianId)` / `if (options?.status)` are truthiness
 * tests in PgAppointmentRepository.buildListWhere, in
 * InMemoryAppointmentRepository.listWithMeta, and in listAppointmentsWithMeta's
 * no-listWithMeta fallback (where a falsy technicianId also correctly skips the
 * "cannot filter by technician" throw), so `''` never became a predicate.
 * The ROUTE was the one place that disagreed: a bare
 * `typeof req.query.x === 'string'` check kept `''`, which is `!== undefined`
 * and therefore flipped `wantsPaginated` on. The damage was to the response
 * ENVELOPE rather than the rows — `?jobId=x&technicianId=` silently traded the
 * legacy bare-array contract for `{ data, total }`, and a bare
 * `?technicianId=` turned the historical "jobId query parameter is required"
 * 400 into a 200 listing the whole tenant.
 *
 * Whitespace is NOT trimmed away: `?technicianId=%20` is a caller asserting a
 * value, and silently reinterpreting it as "no filter" would be the same class
 * of guess this helper exists to remove.
 */
function stringFilter(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

export function createAppointmentRouter(
  appointmentRepo: AppointmentRepository,
  ownership: TenantOwnership,
  jobRepo: JobRepository,
  timelineRepo: JobTimelineRepository,
  options?: AppointmentRouterOptions,
  auditRepo?: AuditRepository,
): Router {
  const router = Router();

  async function mayTriggerRunningLate(
    req: AuthenticatedRequest,
    jobId: string,
  ): Promise<boolean> {
    if (req.auth!.role !== 'technician') return true;
    if (!req.auth!.canonicalUserId) return false;
    const job = await jobRepo.findById(req.auth!.tenantId, jobId);
    return job?.assignedTechnicianId === req.auth!.canonicalUserId;
  }

  async function enqueueRunningLate(
    req: AuthenticatedRequest,
    appointmentId: string,
    delayVersion: number,
    delayMinutes: number,
  ): Promise<string | null> {
    try {
      return await options?.delayNotificationCoordinator?.enqueueDelayNotice({
        tenantId: req.auth!.tenantId,
        currentAppointmentId: appointmentId,
        delayVersion,
        delayMinutes,
      }) ?? null;
    } catch (notificationErr) {
      // eslint-disable-next-line no-console
      console.warn('Failed to enqueue delay notification for running-late notice', {
        appointmentId,
        error: notificationErr instanceof Error ? notificationErr.message : String(notificationErr),
      });
      return null;
    }
  }

  async function emitRunningLateAudit(
    req: AuthenticatedRequest,
    appointmentId: string,
    jobId: string,
    delayVersion: number,
    delayMinutes: number,
    idempotencyKey: string | null,
  ): Promise<void> {
    if (!auditRepo) return;
    await auditRepo.create(
      createAuditEvent({
        tenantId: req.auth!.tenantId,
        actorId: req.auth!.userId,
        actorRole: req.auth!.role,
        eventType: 'appointment.running_late_triggered',
        entityType: 'appointment',
        entityId: appointmentId,
        correlationId: idempotencyKey ?? undefined,
        metadata: { jobId, delayMinutes, delayVersion },
      }),
    );
  }

  // Shared by the PUT /:id virtual-status branch (dispatcher backcompat)
  // and POST /:id/running-late (technician path).
  async function handleRunningLate(
    req: AuthenticatedRequest,
    res: Response,
    delayMinutes: number,
  ): Promise<void> {
    const appointment = await getAppointment(req.auth!.tenantId, req.params.id, appointmentRepo);
    if (!appointment) {
      res.status(404).json({ error: 'NOT_FOUND', message: 'Appointment not found' });
      return;
    }
    // A technician may only send a running-late notice for their OWN visit.
    // The route gate is `appointments:view` (which every technician holds), so
    // without this an unassigned tech with any appointment id could trigger a
    // customer delay notification for someone else's work. Mirrors the
    // assignment check in the delay-ack flow. Dispatcher/owner (who reach this
    // via the appointments:update PUT branch) are unaffected.
    if (!(await mayTriggerRunningLate(req, appointment.jobId))) {
      res.status(403).json({
        error: 'FORBIDDEN',
        message: 'Only the assigned technician can send a running-late notice',
      });
      return;
    }
    const history = await timelineRepo.findByJob(req.auth!.tenantId, appointment.jobId);
    const delayVersion = history.filter(
      (e) => e.eventType === JOB_TIMELINE_EVENT_TYPES.DELAY_ACKNOWLEDGED && e.metadata?.isRunningBehind === true,
    ).length;
    const idempotencyKey = await enqueueRunningLate(
      req,
      appointment.id,
      delayVersion,
      delayMinutes,
    );
    await emitRunningLateAudit(
      req,
      appointment.id,
      appointment.jobId,
      delayVersion,
      delayMinutes,
      idempotencyKey,
    );
    res.json({ appointmentId: appointment.id, delayMinutes, queued: true });
  }

  router.post(
    '/',
    requireAuth,
    requireTenant,
    requirePermission('appointments:create'),
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        const parsed = createAppointmentSchema.parse(req.body);
        // Cross-entity tenant guard: jobId must belong to the requesting tenant.
        await ownership.requireExists(req.auth!.tenantId, 'job', parsed.jobId);
        const result = await createAppointment(
          {
            ...parsed,
            tenantId: req.auth!.tenantId,
            scheduledStart: new Date(parsed.scheduledStart),
            scheduledEnd: new Date(parsed.scheduledEnd),
            arrivalWindowStart: parsed.arrivalWindowStart ? new Date(parsed.arrivalWindowStart) : undefined,
            arrivalWindowEnd: parsed.arrivalWindowEnd ? new Date(parsed.arrivalWindowEnd) : undefined,
            createdBy: req.auth!.userId,
          },
          appointmentRepo,
          undefined,
          auditRepo,
          req.auth!.role,
        );
        res.status(201).json(result);
      } catch (err) {
        const { statusCode, body } = toErrorResponse(err);
        res.status(statusCode).json(body);
      }
    }
  );

  router.get(
    '/',
    requireAuth,
    requireTenant,
    requirePermission('appointments:view'),
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        // Empty-valued params mean "no filter" — see stringFilter's comment.
        const jobId = stringFilter(req.query.jobId);
        const technicianId = stringFilter(req.query.technicianId);
        const status = stringFilter(req.query.status) as AppointmentStatus | undefined;
        const sort: 'asc' | 'desc' = req.query.sort === 'desc' ? 'desc' : 'asc';

        const fromRaw = stringFilter(req.query.fromDate);
        const toRaw = stringFilter(req.query.toDate);
        const fromDate = fromRaw ? new Date(fromRaw) : undefined;
        const toDate = toRaw ? new Date(toRaw) : undefined;
        if (fromDate && Number.isNaN(fromDate.getTime())) {
          res.status(400).json({ error: 'VALIDATION_ERROR', message: 'fromDate must be a valid ISO date' });
          return;
        }
        if (toDate && Number.isNaN(toDate.getTime())) {
          res.status(400).json({ error: 'VALIDATION_ERROR', message: 'toDate must be a valid ISO date' });
          return;
        }

        const wantsPaginated =
          req.query.paginated === 'true' ||
          req.query.limit !== undefined ||
          req.query.offset !== undefined ||
          fromDate !== undefined ||
          toDate !== undefined ||
          technicianId !== undefined ||
          status !== undefined;

        // Legacy contract: GET /api/appointments?jobId=... still returns
        // a bare array of appointments for that job. Only enter the new
        // paginated path when one of the new filters/pagination params is
        // present so existing UI consumers don't break.
        if (jobId && !wantsPaginated) {
          const result = await listByJob(req.auth!.tenantId, jobId, appointmentRepo);
          res.json(result);
          return;
        }
        if (!jobId && !wantsPaginated) {
          // Preserve historical 400 when caller provides no usable filter.
          res.status(400).json({ error: 'VALIDATION_ERROR', message: 'jobId query parameter is required' });
          return;
        }

        const limitRaw = req.query.limit as string | undefined;
        const offsetRaw = req.query.offset as string | undefined;
        const limit = limitRaw !== undefined ? parseInt(limitRaw, 10) : DEFAULT_APPOINTMENT_LIMIT;
        const offset = offsetRaw !== undefined ? parseInt(offsetRaw, 10) : 0;
        if (limitRaw !== undefined && (Number.isNaN(limit) || limit < 1 || limit > MAX_APPOINTMENT_LIMIT)) {
          res.status(400).json({
            error: 'VALIDATION_ERROR',
            message: `limit must be between 1 and ${MAX_APPOINTMENT_LIMIT}`,
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

        const result = await listAppointmentsWithMeta(req.auth!.tenantId, appointmentRepo, {
          jobId,
          technicianId,
          status,
          fromDate,
          toDate,
          sort,
          limit,
          offset,
        });
        res.json(result);
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
    requirePermission('appointments:view'),
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        const result = await getAppointment(req.auth!.tenantId, req.params.id, appointmentRepo);
        if (!result) {
          res.status(404).json({ error: 'NOT_FOUND', message: 'Appointment not found' });
          return;
        }
        res.json(result);
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
    requirePermission('appointments:update'),
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        // `running_late` is a virtual status, not a persisted
        // AppointmentStatus — it triggers the delay notification coordinator
        // so the next customer receives an SMS. Kept on PUT for backcompat
        // with dispatcher clients (e.g. AppointmentEdit's NotifyDelayDialog);
        // technicians use POST /:id/running-late below.
        if (req.body?.status === 'running_late') {
          const delayMinutes: number =
            typeof req.body.delayMinutes === 'number' && req.body.delayMinutes > 0
              ? req.body.delayMinutes
              : 20;
          await handleRunningLate(req, res, delayMinutes);
          return;
        }

        const updates = { ...req.body };
        if (updates.scheduledStart) updates.scheduledStart = new Date(updates.scheduledStart);
        if (updates.scheduledEnd) updates.scheduledEnd = new Date(updates.scheduledEnd);
        if (updates.arrivalWindowStart) updates.arrivalWindowStart = new Date(updates.arrivalWindowStart);
        if (updates.arrivalWindowEnd) updates.arrivalWindowEnd = new Date(updates.arrivalWindowEnd);

        const result = await updateAppointment(
          req.auth!.tenantId,
          req.params.id,
          updates,
          appointmentRepo,
          undefined,
          auditRepo,
          req.auth!.userId,
          req.auth!.role,
        );
        if (!result) {
          res.status(404).json({ error: 'NOT_FOUND', message: 'Appointment not found' });
          return;
        }
        res.json(result);
      } catch (err) {
        const { statusCode, body } = toErrorResponse(err);
        res.status(statusCode).json(body);
      }
    }
  );

  // Technician-reachable running-late notice. Technicians deliberately hold
  // only `appointments:view` (see auth/rbac.ts — appointments:update stays
  // dispatcher/owner-only), so the PUT virtual-status path 403s for them.
  // This endpoint triggers the same delay notification without granting any
  // appointment mutation.
  router.post(
    '/:id/running-late',
    requireAuth,
    requireTenant,
    requirePermission('appointments:view'),
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        const parsed = runningLateBodySchema.parse(req.body ?? {});
        await handleRunningLate(req, res, parsed.delayMinutes ?? 20);
      } catch (err) {
        const { statusCode, body } = toErrorResponse(err);
        res.status(statusCode).json(body);
      }
    }
  );

  router.post(
    '/:id/delay-ack',
    requireAuth,
    requireTenant,
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        const parsed = delayAcknowledgmentSchema.parse(req.body);
        if (parsed.appointmentId !== req.params.id) {
          res.status(400).json({ error: 'VALIDATION_ERROR', message: 'appointmentId must match route id' });
          return;
        }

        const appointment = await getAppointment(req.auth!.tenantId, req.params.id, appointmentRepo);
        if (!appointment) {
          res.status(404).json({ error: 'NOT_FOUND', message: 'Appointment not found' });
          return;
        }

        const role = req.auth!.role;
        const actorId = req.auth!.userId;
        if (role !== 'dispatcher' && role !== 'technician') {
          res.status(403).json({ error: 'FORBIDDEN', message: 'Only assigned technician/dispatcher can acknowledge delay' });
          return;
        }

        if (role === 'technician') {
          const job = await jobRepo.findById(req.auth!.tenantId, appointment.jobId);
          if (!job || job.assignedTechnicianId !== actorId) {
            res.status(403).json({ error: 'FORBIDDEN', message: 'Only the assigned technician can acknowledge delay' });
            return;
          }
        }

        const inferredTriggerState = parsed.isRunningBehind ? 'running_behind' : 'on_time';
        const metadata: DelayAcknowledgmentMetadata = {
          appointmentId: parsed.appointmentId,
          isRunningBehind: parsed.isRunningBehind,
          delayMinutes: parsed.delayMinutes,
          reasonCode: parsed.reasonCode,
          actorId,
          actorRole: role,
          timestamp: new Date().toISOString(),
          inferredTriggerState,
        };

        const timelineEntry = await addDelayAcknowledgmentTimelineEntry(
          req.auth!.tenantId,
          appointment.jobId,
          actorId,
          role,
          timelineRepo,
          metadata
        );

        if (auditRepo) {
          const auditEvent = createAuditEvent({
            tenantId: req.auth!.tenantId,
            actorId,
            actorRole: role,
            eventType: 'appointment.delay_acknowledged',
            entityType: 'appointment',
            entityId: appointment.id,
            metadata: {
              jobId: appointment.jobId,
              isRunningBehind: parsed.isRunningBehind,
              delayMinutes: parsed.delayMinutes,
              reasonCode: parsed.reasonCode,
              inferredTriggerState,
            },
          });
          await auditRepo.create(auditEvent);
        }

        let delayNoticeIdempotencyKey: string | null = null;
        if (parsed.isRunningBehind && parsed.delayMinutes) {
          const history = await timelineRepo.findByJob(req.auth!.tenantId, appointment.jobId);
          const delayVersion = history.filter(
            (entry) =>
              entry.eventType === JOB_TIMELINE_EVENT_TYPES.DELAY_ACKNOWLEDGED &&
              entry.metadata?.isRunningBehind === true
          ).length;
          try {
            delayNoticeIdempotencyKey = await options?.delayNotificationCoordinator?.enqueueDelayNotice({
              tenantId: req.auth!.tenantId,
              currentAppointmentId: appointment.id,
              delayVersion,
              delayMinutes: parsed.delayMinutes,
            }) ?? null;
          } catch (notificationError) {
            // eslint-disable-next-line no-console
            console.warn('Failed to enqueue delay notification', {
              appointmentId: appointment.id,
              error: notificationError instanceof Error ? notificationError.message : String(notificationError),
            });
          }
        }

        res.status(201).json({
          appointmentId: appointment.id,
          jobId: appointment.jobId,
          isRunningBehind: parsed.isRunningBehind,
          delayMinutes: parsed.delayMinutes,
          reasonCode: parsed.reasonCode,
          inferredTriggerState,
          timelineEntry,
          delayNoticeIdempotencyKey,
        });
      } catch (err) {
        const { statusCode, body } = toErrorResponse(err);
        res.status(statusCode).json(body);
      }
    }
  );

  return router;
}
