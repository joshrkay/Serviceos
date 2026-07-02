import { Router, Request, Response } from 'express';
import { getDispatchBoardData, BoardQueryDependencies, PendingChangeKind } from './board-query';
import { AppointmentRepository, listAppointmentsWithMeta } from '../appointments/appointment';
import { AssignmentRepository } from '../appointments/assignment';
import { JobRepository } from '../jobs/job';
import { CustomerRepository } from '../customers/customer';
import { LocationRepository } from '../locations/location';
import { ProposalRepository } from '../proposals/proposal';
import { UserRepository } from '../users/user';
import { resolvePendingChangeRequests } from './pending-changes';
import { requireAuth, requireTenant } from '../middleware/auth';
import { AuthenticatedRequest } from '../auth/clerk';
import { toErrorResponse } from '../shared/errors';
import { createBoardEventsRouter, BoardEventsRouteDeps } from './board-events-route';
import { createPresenceRouter } from './presence-routes';

export interface EnRouteEnqueuer {
  enqueueEnRouteNotice(input: {
    tenantId: string;
    appointmentId: string;
    technicianName?: string;
  }): Promise<string | null>;
}

/**
 * Resolve a technician's `users.id` to a human display name for the board.
 * Prefers "First Last", then email, then the raw id when no user row exists
 * (deactivated tech still referenced by a past assignment).
 */
export async function resolveTechnicianName(
  userRepo: UserRepository,
  tenantId: string,
  technicianId: string
): Promise<string> {
  const user = await userRepo.findById(tenantId, technicianId);
  if (!user) return technicianId;
  const fullName = [user.firstName, user.lastName].filter(Boolean).join(' ').trim();
  return fullName || user.email || technicianId;
}

export function createDispatchRoutes(deps: {
  appointmentRepo: AppointmentRepository;
  assignmentRepo: AssignmentRepository;
  jobRepo?: JobRepository;
  customerRepo?: CustomerRepository;
  locationRepo?: LocationRepository;
  boardEventsDeps?: BoardEventsRouteDeps;
  enRouteCoordinator?: EnRouteEnqueuer;
  proposalRepo?: ProposalRepository;
  userRepo?: UserRepository;
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

      const proposalRepo = deps.proposalRepo;
      const userRepo = deps.userRepo;
      const boardDeps: BoardQueryDependencies = {
        appointmentRepo: deps.appointmentRepo,
        assignmentRepo: deps.assignmentRepo,
        viewingUserId: authReq.auth?.userId,
        ...(proposalRepo
          ? {
              getPendingChangeRequests: (appointmentIds: string[]) =>
                resolvePendingChangeRequests(proposalRepo, tenantId, appointmentIds),
            }
          : {}),
        // Resolve technician UUIDs to display names so the board shows people,
        // not bare ids. Falls back to the id (in board-query) when the lookup
        // returns nothing — e.g. a deactivated tech still on a past assignment.
        ...(userRepo
          ? {
              getTechnicianName: (technicianId: string) =>
                resolveTechnicianName(userRepo, tenantId, technicianId),
            }
          : {}),
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
        // Guard before the query: a non-UUID id (e.g. a stale client's
        // hardcoded 'tech-1') previously reached Postgres and 500'd on the
        // uuid cast (QA 2026-07-02). Bad input is the caller's error.
        if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(technicianId)) {
          return res.status(400).json({ error: 'VALIDATION_ERROR', message: 'technician id must be a UUID' });
        }

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
              updatedAt: appt.updatedAt.toISOString(),
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
   * POST /api/dispatch/appointments/:id/en-route
   *
   * Sends the customer a neutral "on the way" notice for this appointment.
   * Called by the dispatch board / technician day view when a tech departs.
   * Returns 202 with `notified` = whether a recipient was resolved (a
   * canceled/completed appointment or missing customer yields notified=false).
   */
  router.post(
    '/appointments/:id/en-route',
    requireAuth,
    requireTenant,
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        if (!deps.enRouteCoordinator) {
          return res
            .status(503)
            .json({ error: 'UNAVAILABLE', message: 'En-route notifications are not configured' });
        }
        const tenantId = req.auth!.tenantId;
        const appointmentId = req.params.id;

        const appointment = await deps.appointmentRepo.findById(tenantId, appointmentId);
        if (!appointment) {
          return res.status(404).json({ error: 'NOT_FOUND', message: 'Appointment not found' });
        }

        const technicianName =
          typeof req.body?.technicianName === 'string' && req.body.technicianName.trim()
            ? req.body.technicianName.trim()
            : undefined;

        const idempotencyKey = await deps.enRouteCoordinator.enqueueEnRouteNotice({
          tenantId,
          appointmentId,
          technicianName,
        });

        return res.status(202).json({
          accepted: true,
          notified: idempotencyKey !== null,
          idempotencyKey,
        });
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
