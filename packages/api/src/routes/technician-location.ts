import { Router, Response } from 'express';
import { z } from 'zod';
import { AuthenticatedRequest } from '../auth/clerk';
import { requireAuth, requireRole, requireTenant } from '../middleware/auth';
import { toErrorResponse } from '../shared/errors';
import {
  createTechnicianLocationPing,
  TechnicianLocationPingRepository,
} from '../telemetry/technician-location-ping';

const pingSchema = z.object({
  appointmentId: z.string().optional(),
  lat: z.number(),
  lng: z.number(),
  accuracyMeters: z.number().optional(),
  speedMps: z.number().optional(),
  heading: z.number().optional(),
  recordedAt: z.string(),
  source: z.string().min(1),
});

const batchedPingSchema = z.object({
  technicianId: z.string().min(1),
  pings: z.array(pingSchema).min(1).max(500),
});

export interface TechnicianLocationRouteDeps {
  repository: TechnicianLocationPingRepository;
  canSubmitForTechnician?: (auth: NonNullable<AuthenticatedRequest['auth']>, technicianId: string) => Promise<boolean>;
}

export function createTechnicianLocationRouter(
  repositoryOrDeps: TechnicianLocationPingRepository | TechnicianLocationRouteDeps
): Router {
  const deps: TechnicianLocationRouteDeps =
    'repository' in repositoryOrDeps ? repositoryOrDeps : { repository: repositoryOrDeps };
  const router = Router();

  router.post(
    '/',
    requireAuth,
    requireTenant,
    requireRole('owner', 'dispatcher', 'technician'),
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        const parsed = batchedPingSchema.parse(req.body);

        if (req.auth!.role === 'technician' && parsed.technicianId !== req.auth!.userId) {
          res.status(403).json({
            error: 'FORBIDDEN',
            message: 'Technicians may only submit their own location pings',
          });
          return;
        }

        if (deps.canSubmitForTechnician) {
          const permitted = await deps.canSubmitForTechnician(req.auth!, parsed.technicianId);
          if (!permitted) {
            res.status(403).json({
              error: 'FORBIDDEN',
              message: 'You are not allowed to submit location pings for this technician',
            });
            return;
          }
        }

        const batch = parsed.pings.map((ping) =>
          createTechnicianLocationPing({
            tenantId: req.auth!.tenantId,
            technicianId: parsed.technicianId,
            appointmentId: ping.appointmentId,
            lat: ping.lat,
            lng: ping.lng,
            accuracyMeters: ping.accuracyMeters,
            speedMps: ping.speedMps,
            heading: ping.heading,
            recordedAt: new Date(ping.recordedAt),
            source: ping.source,
          })
        );

        const inserted = await deps.repository.insertMany(req.auth!.tenantId, batch);
        res.status(201).json({ count: inserted.length, pings: inserted });
      } catch (err) {
        const { statusCode, body } = toErrorResponse(err);
        res.status(statusCode).json(body);
      }
    }
  );

  return router;
}
