/**
 * #1079 / PRD row 4.7 — the adapter between the truck-location signal and the
 * dispatch board. It reads an appointment's recent technician pings
 * (`technician_location_pings`, ingested by POST /api/technician-location)
 * and its service-location coordinates, then runs `computeDispatchLateness`.
 * The dispatch route passes it to `getDispatchBoardData` as
 * `getAppointmentLateness`, so `GET /api/dispatch/board` serves a lateness
 * state + confidence breakdown per appointment.
 *
 * Read-only by design: the result's `autoNotifyCustomer` is a signal for the
 * operator, never an action — anything customer-facing still goes through the
 * proposal gate.
 *
 * Cost: one ping read per active board appointment; the job + location reads
 * only happen for appointments that actually have pings.
 */
import type { Appointment } from '../appointments/appointment';
import type { JobRepository } from '../jobs/job';
import type { LocationRepository } from '../locations/location';
import type { TechnicianLocationPingRepository } from '../telemetry/technician-location-ping';
import { computeDispatchLateness, type DispatchLatenessResult } from './lateness';

export interface AppointmentLatenessResolverDeps {
  pingRepo: Pick<TechnicianLocationPingRepository, 'listByAppointment'>;
  jobRepo: Pick<JobRepository, 'findById'>;
  locationRepo: Pick<LocationRepository, 'findById'>;
  now?: () => Date;
}

/** Terminal appointments have nothing left to be late for. */
const INACTIVE_STATUSES = new Set(['completed', 'canceled', 'no_show']);

export function createAppointmentLatenessResolver(
  tenantId: string,
  deps: AppointmentLatenessResolverDeps,
): (appointment: Appointment, technicianId?: string) => Promise<DispatchLatenessResult | undefined> {
  return async (appointment, technicianId) => {
    if (INACTIVE_STATUSES.has(appointment.status)) return undefined;
    const pings = await deps.pingRepo.listByAppointment(tenantId, appointment.id);
    if (pings.length === 0) return undefined;

    const job = await deps.jobRepo.findById(tenantId, appointment.jobId);
    if (!job?.locationId) return undefined;
    const location = await deps.locationRepo.findById(tenantId, job.locationId);
    if (typeof location?.latitude !== 'number' || typeof location?.longitude !== 'number') {
      return undefined;
    }

    return computeDispatchLateness({
      scheduledStart: appointment.scheduledStart,
      scheduledEnd: appointment.scheduledEnd,
      ...(appointment.arrivalWindowStart ? { arrivalWindowStart: appointment.arrivalWindowStart } : {}),
      ...(appointment.arrivalWindowEnd ? { arrivalWindowEnd: appointment.arrivalWindowEnd } : {}),
      ...(technicianId ? { technicianId } : {}),
      pings: pings.map((p) => ({
        occurredAt: p.recordedAt,
        latitude: p.lat,
        longitude: p.lng,
        ...(p.accuracyMeters !== undefined ? { accuracyMeters: p.accuracyMeters } : {}),
        ...(p.speedMps !== undefined ? { speedMps: p.speedMps } : {}),
        ...(p.heading !== undefined ? { heading: p.heading } : {}),
      })),
      serviceLocation: { latitude: location.latitude, longitude: location.longitude },
      now: deps.now?.() ?? new Date(),
    });
  };
}
