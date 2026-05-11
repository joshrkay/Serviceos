import { Router, Request, Response } from 'express';
import { getDispatchBoardData, BoardQueryDependencies } from './board-query';
import { AppointmentRepository, Appointment } from '../appointments/appointment';
import { AssignmentRepository } from '../appointments/assignment';
import { AuthenticatedRequest } from '../auth/clerk';
import { requireAuth, requireTenant } from '../middleware/auth';

export function createDispatchRoutes(deps: {
  appointmentRepo: AppointmentRepository;
  assignmentRepo: AssignmentRepository;
}): Router {
  const router = Router();

  router.get('/board', async (req: Request, res: Response) => {
    try {
      const tenantId = req.headers['x-tenant-id'] as string;
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
      };

      const boardData = await getDispatchBoardData(tenantId, date, boardDeps, timezone);
      return res.json(boardData);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Internal server error';
      return res.status(500).json({ error: message });
    }
  });

  // BUG-5 — TechnicianDayView (web) calls this URL on mount; without
  // a handler the page surfaces "Failed to load appointments" on every
  // load. Returns the shape the page expects:
  //   { appointments: TechnicianAppointment[] }
  // Joined customer/location names are left as empty strings here —
  // the in-memory dev/test boot doesn't carry that context, and the
  // page renders correctly with the fallback strings ("Customer",
  // "No location"). Production wiring through customer/location
  // joins is tracked separately.
  router.get(
    '/technician/:id/appointments',
    requireAuth,
    requireTenant,
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        const tenantId = req.auth!.tenantId;
        const technicianId = req.params.id;
        const date = (req.query.date as string | undefined) ?? '';
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
          res.status(400).json({
            error: 'BAD_REQUEST',
            message: 'date query parameter is required (YYYY-MM-DD)',
          });
          return;
        }

        const [year, month, day] = date.split('-').map(Number);
        const start = new Date(Date.UTC(year, month - 1, day, 0, 0, 0, 0));
        const end = new Date(Date.UTC(year, month - 1, day, 23, 59, 59, 999));

        const dayAppointments = await deps.appointmentRepo.findByDateRange(
          tenantId,
          start,
          end,
        );
        const assignments = await deps.assignmentRepo.findByTechnician(
          tenantId,
          technicianId,
        );
        const assignedAppointmentIds = new Set(
          assignments.map((a) => a.appointmentId),
        );

        const filtered: Appointment[] = dayAppointments.filter((appt) =>
          assignedAppointmentIds.has(appt.id),
        );

        const appointments = filtered.map((appt) => ({
          id: appt.id,
          jobId: appt.jobId,
          customerName: '',
          locationAddress: '',
          scheduledStart: appt.scheduledStart.toISOString(),
          scheduledEnd: appt.scheduledEnd.toISOString(),
          status: appt.status,
        }));

        res.json({ appointments });
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Internal server error';
        res.status(500).json({ error: message });
      }
    },
  );

  return router;
}
