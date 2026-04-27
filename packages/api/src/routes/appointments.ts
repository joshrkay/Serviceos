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
  AppointmentRepository,
} from '../appointments/appointment';
import { JobRepository } from '../jobs/job';
import {
  addDelayAcknowledgmentTimelineEntry,
  JobTimelineRepository,
  DelayAcknowledgmentMetadata,
} from '../jobs/job-lifecycle';

export function createAppointmentRouter(
  appointmentRepo: AppointmentRepository,
  ownership: TenantOwnership,
  jobRepo: JobRepository,
  timelineRepo: JobTimelineRepository
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
        const jobId = req.query.jobId as string;
        if (!jobId) {
          res.status(400).json({ error: 'VALIDATION_ERROR', message: 'jobId query parameter is required' });
          return;
        }
        const result = await listByJob(req.auth!.tenantId, jobId, appointmentRepo);
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

        res.status(201).json({
          appointmentId: appointment.id,
          jobId: appointment.jobId,
          isRunningBehind: parsed.isRunningBehind,
          delayMinutes: parsed.delayMinutes,
          reasonCode: parsed.reasonCode,
          inferredTriggerState,
          timelineEntry,
        });
      } catch (err) {
        const { statusCode, body } = toErrorResponse(err);
        res.status(statusCode).json(body);
      }
    }
  );

  return router;
}
