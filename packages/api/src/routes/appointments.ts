import { Router, Response } from 'express';
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

export function createAppointmentRouter(
  appointmentRepo: AppointmentRepository,
  ownership: TenantOwnership,
  jobRepo: JobRepository,
  timelineRepo: JobTimelineRepository,
  options?: AppointmentRouterOptions
): Router {
  const router = Router();

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
          appointmentRepo
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
        const jobId = typeof req.query.jobId === 'string' ? req.query.jobId : undefined;
        const technicianId = typeof req.query.technicianId === 'string' ? req.query.technicianId : undefined;
        const status = typeof req.query.status === 'string' ? req.query.status as AppointmentStatus : undefined;
        const sort: 'asc' | 'desc' = req.query.sort === 'desc' ? 'desc' : 'asc';

        const fromRaw = typeof req.query.fromDate === 'string' ? req.query.fromDate : undefined;
        const toRaw = typeof req.query.toDate === 'string' ? req.query.toDate : undefined;
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
        const updates = { ...req.body };
        if (updates.scheduledStart) updates.scheduledStart = new Date(updates.scheduledStart);
        if (updates.scheduledEnd) updates.scheduledEnd = new Date(updates.scheduledEnd);
        if (updates.arrivalWindowStart) updates.arrivalWindowStart = new Date(updates.arrivalWindowStart);
        if (updates.arrivalWindowEnd) updates.arrivalWindowEnd = new Date(updates.arrivalWindowEnd);

        const result = await updateAppointment(req.auth!.tenantId, req.params.id, updates, appointmentRepo);
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
