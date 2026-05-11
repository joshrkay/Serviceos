import { Router, Request, Response } from 'express';
import { getDispatchBoardData, BoardQueryDependencies } from './board-query';
import { AppointmentRepository, listAppointmentsWithMeta } from '../appointments/appointment';
import { AssignmentRepository } from '../appointments/assignment';
import { JobRepository } from '../jobs/job';
import { CustomerRepository } from '../customers/customer';
import { LocationRepository } from '../locations/location';
import {
  requireAuth,
  requireTenant,
  requirePermission,
} from '../middleware/auth';
import { AuthenticatedRequest } from '../auth/clerk';

export function createDispatchRoutes(deps: {
  appointmentRepo: AppointmentRepository;
  assignmentRepo: AssignmentRepository;
  jobRepo?: JobRepository;
  customerRepo?: CustomerRepository;
  locationRepo?: LocationRepository;
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

  /**
   * GET /api/dispatch/technician/:technicianId/appointments?date=YYYY-MM-DD
   * Returns the day's appointments for a given technician, enriched with
   * customer name, service address, and job summary for the mobile day view.
   */
  router.get(
    '/technician/:technicianId/appointments',
    requireAuth,
    requireTenant,
    requirePermission('appointments:view'),
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        const tenantId = req.auth!.tenantId;
        const { technicianId } = req.params;
        const dateStr = req.query.date as string | undefined;

        if (!dateStr || !/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
          res.status(400).json({ error: 'VALIDATION_ERROR', message: 'date query parameter is required (YYYY-MM-DD)' });
          return;
        }

        const fromDate = new Date(`${dateStr}T00:00:00.000Z`);
        const toDate   = new Date(`${dateStr}T23:59:59.999Z`);

        const { data: appointments } = await listAppointmentsWithMeta(
          tenantId,
          deps.appointmentRepo,
          { technicianId, fromDate, toDate, sort: 'asc', limit: 50 },
        );

        // Enrich each appointment with job/customer/location data when
        // repos are available (in-memory and Pg modes both work).
        const enriched = await Promise.all(appointments.map(async (appt) => {
          let customerName = 'Customer';
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
                if (customer) {
                  customerName = customer.displayName ||
                    [customer.firstName, customer.lastName].filter(Boolean).join(' ') ||
                    'Customer';
                }
              }
              if (deps.locationRepo && job.locationId) {
                const loc = await deps.locationRepo.findById(tenantId, job.locationId);
                if (loc) {
                  locationAddress = [loc.street1, loc.city, loc.state, loc.postalCode].filter(Boolean).join(', ');
                  locationLatitude  = loc.latitude;
                  locationLongitude = loc.longitude;
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
            scheduledEnd:   appt.scheduledEnd.toISOString(),
            status: appt.status,
            jobSummary,
          };
        }));

        res.json({ appointments: enriched });
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Internal server error';
        res.status(500).json({ error: message });
      }
    }
  );

  return router;
}
