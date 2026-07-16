import { Router, Request, Response } from 'express';
import { getDispatchBoardData, getDayBoundaries, BoardQueryDependencies, PendingChangeKind } from './board-query';
import { AppointmentRepository, listAppointmentsWithMeta } from '../appointments/appointment';
import { AssignmentRepository } from '../appointments/assignment';
import { JobRepository } from '../jobs/job';
import { CustomerRepository } from '../customers/customer';
import { LocationRepository } from '../locations/location';
import { ProposalRepository } from '../proposals/proposal';
import { UserRepository } from '../users/user';
import { SettingsRepository } from '../settings/settings';
import { resolvePendingChangeRequests } from './pending-changes';
import { requireAuth, requireRole, requireTenant } from '../middleware/auth';
import { AuthenticatedRequest } from '../auth/clerk';
import { toErrorResponse } from '../shared/errors';
import { createBoardEventsRouter, BoardEventsRouteDeps } from './board-events-route';
import { createPresenceRouter } from './presence-routes';
import { AuditRepository, createAuditEvent } from '../audit/audit';

export interface EnRouteEnqueuer {
  enqueueEnRouteNotice(input: {
    tenantId: string;
    appointmentId: string;
    technicianName?: string;
  }): Promise<string | null>;
}

interface DispatchRouteDeps {
  appointmentRepo: AppointmentRepository;
  assignmentRepo: AssignmentRepository;
  jobRepo?: JobRepository;
  customerRepo?: CustomerRepository;
  locationRepo?: LocationRepository;
  boardEventsDeps?: BoardEventsRouteDeps;
  enRouteCoordinator?: EnRouteEnqueuer;
  proposalRepo?: ProposalRepository;
  userRepo?: UserRepository;
  settingsRepo?: SettingsRepository;
  auditRepo?: AuditRepository;
}

async function emitEnRouteAudit(
  deps: DispatchRouteDeps,
  auth: NonNullable<AuthenticatedRequest['auth']>,
  appointmentId: string,
  idempotencyKey: string | null,
): Promise<void> {
  if (!deps.auditRepo) return;
  await deps.auditRepo.create(
    createAuditEvent({
      tenantId: auth.tenantId,
      actorId: auth.userId,
      actorRole: auth.role,
      eventType: 'appointment.en_route_triggered',
      entityType: 'appointment',
      entityId: appointmentId,
      correlationId: idempotencyKey ?? undefined,
    }),
  );
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

export function createDispatchRoutes(deps: DispatchRouteDeps): Router {
  const router = Router();

  router.get('/board', requireAuth, requireTenant, async (req: AuthenticatedRequest, res: Response) => {
    try {
      // SEC-21 — tenant is derived exclusively from the verified session
      // (req.auth.tenantId), never a client-supplied header. requireAuth +
      // requireTenant above already 401/403 when it's absent; the old
      // `?? x-tenant-id header` fallback let a forged header resolve the
      // board for an arbitrary tenant on any future remount that skipped
      // (or reordered) the global auth middleware.
      const authReq = req;
      const tenantId = authReq.auth!.tenantId;

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
    requireRole('owner', 'dispatcher', 'technician'),
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

        // SEC-22 — same-tenant IDOR guard. Mirrors the gate in
        // routes/technician-location.ts:47: owner/dispatcher may read any
        // technician's day; a technician-role caller may only read their
        // OWN day. req.auth.userId is the Clerk subject, while the URL and
        // assignment rows use canonical users.id UUIDs; resolveAuthorization
        // places that UUID in canonicalUserId. Absence fails closed.
        // Without this, any authenticated tenant member — including a
        // plain technician — could pass an arbitrary technician UUID and
        // read that technician's customer names, addresses, lat/long, and
        // job summaries for the day.
        if (
          req.auth!.role === 'technician' &&
          technicianId !== req.auth!.canonicalUserId
        ) {
          return res.status(403).json({
            error: 'FORBIDDEN',
            message: 'Technicians may only view their own appointments',
          });
        }

        const dateStr = req.query.date as string | undefined;
        if (!dateStr || !/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
          return res.status(400).json({ error: 'VALIDATION_ERROR', message: 'date query parameter is required (YYYY-MM-DD)' });
        }

        // Bucket the technician's day in the TENANT timezone, not UTC. The old
        // hardcoded `${dateStr}T00:00:00.000Z`..`T23:59:59.999Z` window dropped
        // appointments whose tenant-local day maps onto a different UTC day
        // (e.g. a 23:00 America/Los_Angeles appointment lands on the NEXT UTC
        // day). Reuses the board's established getDayBoundaries helper.
        const settings = deps.settingsRepo
          ? await deps.settingsRepo.findByTenant(tenantId)
          : null;
        const { start: fromDate, end: toDate } = getDayBoundaries(
          dateStr,
          settings?.timezone,
        );

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
    requireRole('owner', 'dispatcher', 'technician'),
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

        if (req.auth!.role === 'technician') {
          const canonicalUserId = req.auth!.canonicalUserId;
          const assignments = canonicalUserId
            ? await deps.assignmentRepo.findByAppointment(tenantId, appointmentId)
            : [];
          if (!assignments.some((assignment) => assignment.technicianId === canonicalUserId)) {
            return res.status(403).json({
              error: 'FORBIDDEN',
              message: 'Only an assigned technician can send an en-route notice',
            });
          }
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
        await emitEnRouteAudit(deps, req.auth!, appointmentId, idempotencyKey);

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
