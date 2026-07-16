import { Router, Response } from 'express';
import { z } from 'zod';
import { AuthenticatedRequest } from '../auth/clerk';
import { asyncRoute } from '../middleware/async-route';
import { requireAuth, requireRole, requireTenant } from '../middleware/auth';
import {
  createTechnicianLocationPing,
  TechnicianLocationPing,
  TechnicianLocationPingRepository,
} from '../telemetry/technician-location-ping';
import { AuditRepository, createAuditEvent } from '../audit/audit';

const pingSchema = z.object({
  clientPingId: z.string().uuid(),
  appointmentId: z.string().uuid().optional(),
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
  canSubmitForTechnician?: (
    auth: NonNullable<AuthenticatedRequest['auth']>,
    technicianId: string,
  ) => Promise<boolean>;
  /**
   * When set, pings whose appointmentId is not assigned to the submitting
   * technician have appointmentId stripped (location still accepted).
   */
  isAppointmentAssignedToTechnician?: (
    tenantId: string,
    appointmentId: string,
    technicianId: string,
  ) => Promise<boolean>;
  auditRepo?: AuditRepository;
}

type ParsedPing = z.infer<typeof pingSchema>;

async function sanitizeAppointmentIds(
  deps: TechnicianLocationRouteDeps,
  tenantId: string,
  technicianId: string,
  pings: ParsedPing[],
): Promise<ParsedPing[]> {
  if (!deps.isAppointmentAssignedToTechnician) return pings;

  const cache = new Map<string, boolean>();
  const out: ParsedPing[] = [];
  for (const ping of pings) {
    if (!ping.appointmentId) {
      out.push(ping);
      continue;
    }
    let allowed = cache.get(ping.appointmentId);
    if (allowed === undefined) {
      allowed = await deps.isAppointmentAssignedToTechnician(
        tenantId,
        ping.appointmentId,
        technicianId,
      );
      cache.set(ping.appointmentId, allowed);
    }
    if (allowed) {
      out.push(ping);
    } else {
      const { appointmentId: _stripped, ...rest } = ping;
      out.push(rest);
    }
  }
  return out;
}

function buildLocationBatch(
  tenantId: string,
  technicianId: string,
  pings: ParsedPing[],
): TechnicianLocationPing[] {
  return pings.map((ping) =>
    createTechnicianLocationPing({
      tenantId,
      technicianId,
      clientPingId: ping.clientPingId,
      appointmentId: ping.appointmentId,
      lat: ping.lat,
      lng: ping.lng,
      accuracyMeters: ping.accuracyMeters,
      speedMps: ping.speedMps,
      heading: ping.heading,
      recordedAt: new Date(ping.recordedAt),
      source: ping.source,
    }),
  );
}

async function emitLocationBatchAudit(
  deps: TechnicianLocationRouteDeps,
  auth: NonNullable<AuthenticatedRequest['auth']>,
  technicianId: string,
  submittedCount: number,
  acceptedCount: number,
): Promise<void> {
  if (!deps.auditRepo) return;
  await deps.auditRepo.create(
    createAuditEvent({
      tenantId: auth.tenantId,
      actorId: auth.userId,
      actorRole: auth.role,
      eventType: 'technician_location.batch_ingested',
      entityType: 'technician',
      entityId: technicianId,
      metadata: {
        submittedCount,
        acceptedCount,
        duplicateCount: submittedCount - acceptedCount,
      },
    }),
  );
}

export function createTechnicianLocationRouter(
  repositoryOrDeps: TechnicianLocationPingRepository | TechnicianLocationRouteDeps,
): Router {
  const deps: TechnicianLocationRouteDeps =
    'repository' in repositoryOrDeps ? repositoryOrDeps : { repository: repositoryOrDeps };
  const router = Router();

  router.post(
    '/',
    requireAuth,
    requireTenant,
    requireRole('owner', 'dispatcher', 'technician'),
    asyncRoute(async (req: AuthenticatedRequest, res: Response) => {
      const parsed = batchedPingSchema.parse(req.body);

      if (
        req.auth!.role === 'technician' &&
        parsed.technicianId !== req.auth!.canonicalUserId
      ) {
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

      const sanitized = await sanitizeAppointmentIds(
        deps,
        req.auth!.tenantId,
        parsed.technicianId,
        parsed.pings,
      );
      const batch = buildLocationBatch(req.auth!.tenantId, parsed.technicianId, sanitized);

      const inserted = await deps.repository.insertMany(req.auth!.tenantId, batch);
      await emitLocationBatchAudit(
        deps,
        req.auth!,
        parsed.technicianId,
        batch.length,
        inserted.length,
      );
      res.status(201).json({
        count: inserted.length,
        acceptedCount: inserted.length,
        duplicateCount: batch.length - inserted.length,
        pings: inserted,
      });
    }),
  );

  return router;
}
