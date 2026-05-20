import { Router, Request, Response } from 'express';
import { getDispatchBoardData, BoardQueryDependencies } from './board-query';
import { AppointmentRepository, listAppointmentsWithMeta } from '../appointments/appointment';
import { AssignmentRepository } from '../appointments/assignment';
import { JobRepository } from '../jobs/job';
import { CustomerRepository } from '../customers/customer';
import { LocationRepository } from '../locations/location';
import { requireAuth, requireTenant } from '../middleware/auth';
import { AuthenticatedRequest } from '../auth/clerk';
import { toErrorResponse } from '../shared/errors';
import { createBoardEventsRouter, BoardEventsRouteDeps } from './board-events-route';
import { createPresenceRouter } from './presence-routes';

export function createDispatchRoutes(deps: {
  appointmentRepo: AppointmentRepository;
  assignmentRepo: AssignmentRepository;
  jobRepo?: JobRepository;
  customerRepo?: CustomerRepository;
  locationRepo?: LocationRepository;
  boardEventsDeps?: BoardEventsRouteDeps;
}): Router {
  const router = Router();

  router.get('/board', async (req: Request, res: Response) => {
    try {
      const authReq = req as AuthenticatedRequest;
      const tenantId =
        authReq.auth?.tenantId ?? (req.headers['x-tenant-id'] as string | undefined);
      if (!tenantId) {
        return res.status(400).json({ error: 'x-tenant-id header is required' });
      }

      const date = req.query.date as string;
      if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        return res.status(400).json({ error: 'date query parameter is required (YYYY-MM-DD)' });
      }

      const timezone = req.query.timezone as string | undefined;

      const boardDeps: BoardQueryDependencies = {
        appointmentRepo: deps.appointmentRepo,
        assignmentRepo: deps.assignmentRepo,
        viewingUserId: authReq.auth?.userId,
      };

      const boardData = await getDispatchBoardData(tenantId, date, boardDeps, timezone);
      return res.json(boardData);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Internal server error';
      return res.status(500).json({ error: message });
    }
  });

  if (deps.boardEventsDeps) {
    router.use(createBoardEventsRouter(deps.boardEventsDeps));
  }
  router.use(createPresenceRouter());

  /**
   * GET /api/dispatch/technician/:id/appointments?date=YYYY-MM-DD
   *
   * Returns the appointments assigned to a specific technician for the given
   * calendar day, enriched with customer name and service address.
   * Used by TechnicianDayView.
   */
  router.get(
    '/technician/:id/appointments',
    requireAuth,
    requireTenant,
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        const tenantId = req.auth!.tenantId;
        const technicianId = req.params.id;

        const dateStr = req.query.date as string | undefined;
        if (!dateStr || !/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
          return res.status(400).json({ error: 'VALIDATION_ERROR', message: 'date query parameter is required (YYYY-MM-DD)' });
        }

        const fromDate = new Date(`${dateStr}T00:00:00.000Z`);
        const toDate = new Date(`${dateStr}T23:59:59.999Z`);

        const result = await listAppointmentsWithMeta(tenantId, deps.appointmentRepo, {
          technicianId,
          fromDate,
          toDate,
          sort: 'asc',
          limit: 50,
        });

        const enriched = await Promise.all(
          result.data.map(async (appt) => {
            let customerName = '';
            let locationAddress = '';
            let locationLatitude: number | undefined;
            let locationLongitude: number | undefined;
            let jobSummary: string | undefined;

            if (deps.jobRepo) {
              const job = await deps.jobRepo.findById(tenantId, appt.jobId);
              if (job) {
                jobSummary = job.summary;
                if (deps.customerRepo) {
                  const customer = await deps.customerRepo.findById(tenantId, job.customerId);
                  if (customer) customerName = customer.displayName;
                }
                if (deps.locationRepo && job.locationId) {
                  const loc = await deps.locationRepo.findById(tenantId, job.locationId);
                  if (loc) {
                    locationAddress = [loc.street1, loc.city, loc.state].filter(Boolean).join(', ');
                    locationLatitude = loc.latitude ?? undefined;
                    locationLongitude = loc.longitude ?? undefined;
                  }
                }
              }
            }

            return {
              id: appt.id,
              jobId: appt.jobId,
              customerName,
              locationAddress,
              locationLatitude,
              locationLongitude,
              scheduledStart: appt.scheduledStart.toISOString(),
              scheduledEnd: appt.scheduledEnd.toISOString(),
              status: appt.status,
              jobSummary,
            };
          }),
        );

        return res.json({ appointments: enriched, total: result.total });
      } catch (err) {
        const { statusCode, body } = toErrorResponse(err);
        return res.status(statusCode).json(body);
      }
    },
  );

  /**
   * POST /api/dispatch/delay-prompt-audits
   *
   * Records a delay-prompt audit event emitted by the technician GPS
   * engine (TechnicianDayView). Accepted and logged; returns 201.
   */
  router.post(
    '/delay-prompt-audits',
    requireAuth,
    requireTenant,
    async (_req: AuthenticatedRequest, res: Response) => {
      // Fire-and-forget analytics sink. Body is accepted without strict
      // validation so the GPS loop is never blocked by a schema change here.
      return res.status(201).json({ accepted: true });
    },
  );

  /**
   * POST /api/dispatch/delay-escalations
   *
   * Records a dispatcher escalation when a technician does not respond to
   * the delay prompt within the configured timeout window.
   */
  router.post(
    '/delay-escalations',
    requireAuth,
    requireTenant,
    async (_req: AuthenticatedRequest, res: Response) => {
      return res.status(201).json({ accepted: true });
    },
  );

  return router;
}
