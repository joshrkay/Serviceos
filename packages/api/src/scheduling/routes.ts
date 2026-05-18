import { Router, Response } from 'express';
import { z } from 'zod';
import { AuthenticatedRequest } from '../auth/clerk';
import { requireAuth, requireTenant } from '../middleware/auth';
import { toErrorResponse } from '../shared/errors';
import { validate } from '../shared/validation';
import { UserRepository } from '../users/user';
import { FeasibilityDependencies } from './feasibility-types';
import { checkFeasibility } from './feasibility';

const bodySchema = z.object({
  appointmentId: z.string().min(1),
  proposedTechnicianId: z.string().min(1),
  proposedScheduledStart: z.string().refine((s) => !Number.isNaN(new Date(s).getTime()), 'invalid ISO date'),
  proposedScheduledEnd: z.string().refine((s) => !Number.isNaN(new Date(s).getTime()), 'invalid ISO date'),
});

export function createSchedulingRouter(
  deps: FeasibilityDependencies,
  userRepo: UserRepository,
): Router {
  const router = Router();

  router.post(
    '/check-feasibility',
    requireAuth,
    requireTenant,
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        const parsed = validate(bodySchema, req.body);
        const tenantId = req.auth!.tenantId;

        const appointment = await deps.appointmentRepo.findById(tenantId, parsed.appointmentId);
        if (!appointment) {
          res.status(404).json({ error: 'APPOINTMENT_NOT_FOUND' });
          return;
        }

        const tech = await userRepo.findById(tenantId, parsed.proposedTechnicianId);
        if (!tech || tech.role !== 'technician') {
          res.status(404).json({ error: 'TECHNICIAN_NOT_FOUND' });
          return;
        }

        const result = await checkFeasibility(
          {
            tenantId,
            appointment,
            proposedTechnicianId: parsed.proposedTechnicianId,
            proposedScheduledStart: new Date(parsed.proposedScheduledStart),
            proposedScheduledEnd: new Date(parsed.proposedScheduledEnd),
          },
          deps,
        );

        res.json(result);
      } catch (err) {
        const { statusCode, body } = toErrorResponse(err);
        res.status(statusCode).json(body);
      }
    },
  );

  return router;
}
