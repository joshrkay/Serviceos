import type { AppointmentStatusValue } from './status.js';

/**
 * Appointment summary returned by the technician day endpoint.
 *
 * Datetimes are ISO-8601 strings on the wire. Tenant-local rendering remains
 * the client's responsibility.
 */
export interface TechnicianDayAppointment {
  id: string;
  jobId: string;
  customerName: string;
  locationAddress: string;
  locationLatitude?: number;
  locationLongitude?: number;
  scheduledStart: string;
  scheduledEnd: string;
  status: AppointmentStatusValue;
  jobSummary?: string;
  updatedAt: string;
}

/** Terminal visit statuses excluded from "next / active job" selection. */
export const TECHNICIAN_APPOINTMENT_TERMINAL_STATUSES = new Set<string>([
  'canceled',
  'completed',
  'no_show',
]);

export interface PickActiveAppointmentInput {
  id: string;
  status: string;
  scheduledStart: string;
  scheduledEnd: string;
}

/**
 * Pick the tradesperson's current / next job for GPS attachment and schedule UX.
 *
 * Preference order:
 * 1. `in_progress`
 * 2. Currently inside the scheduled window
 * 3. Next future start
 * 4. Most recently started open visit (late / overrun)
 */
export function pickActiveAppointment<T extends PickActiveAppointmentInput>(
  appointments: readonly T[],
  nowMs: number,
): T | null {
  const open = appointments.filter(
    (appointment) => !TECHNICIAN_APPOINTMENT_TERMINAL_STATUSES.has(appointment.status),
  );
  if (open.length === 0) return null;

  const inProgress = open.find((appointment) => appointment.status === 'in_progress');
  if (inProgress) return inProgress;

  const inWindow = open.find((appointment) => {
    const start = Date.parse(appointment.scheduledStart);
    const end = Date.parse(appointment.scheduledEnd);
    return Number.isFinite(start) && Number.isFinite(end) && start <= nowMs && nowMs <= end;
  });
  if (inWindow) return inWindow;

  const upcoming = open
    .filter((appointment) => {
      const start = Date.parse(appointment.scheduledStart);
      return Number.isFinite(start) && start >= nowMs;
    })
    .sort(
      (left, right) =>
        Date.parse(left.scheduledStart) - Date.parse(right.scheduledStart),
    );
  if (upcoming[0]) return upcoming[0];

  const pastOpen = [...open].sort(
    (left, right) =>
      Date.parse(right.scheduledStart) - Date.parse(left.scheduledStart),
  );
  return pastOpen[0] ?? null;
}

/** Calendar date `YYYY-MM-DD` in the tenant timezone (falls back to runtime local). */
export function tenantLocalDate(now: Date, timeZone?: string): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    ...(timeZone ? { timeZone } : {}),
  }).formatToParts(now);
  const year = parts.find((part) => part.type === 'year')?.value ?? '';
  const month = parts.find((part) => part.type === 'month')?.value ?? '';
  const day = parts.find((part) => part.type === 'day')?.value ?? '';
  return `${year}-${month}-${day}`;
}

export interface TechnicianDayAppointmentListResponse {
  appointments: TechnicianDayAppointment[];
  total: number;
}

export interface EnRouteNoticeRequest {
  technicianName?: string;
}

export interface EnRouteNoticeResponse {
  accepted: boolean;
  notified: boolean;
  idempotencyKey: string | null;
}

export interface RunningLateRequest {
  delayMinutes?: number;
}

export interface RunningLateResponse {
  appointmentId: string;
  delayMinutes: number;
  queued: boolean;
}

/**
 * A single device location sample submitted over the technician field API.
 * `clientPingId` must be a UUID — the API rejects non-UUID client ids.
 */
export interface TechnicianLocationPingInput {
  clientPingId: string;
  appointmentId?: string;
  lat: number;
  lng: number;
  accuracyMeters?: number;
  speedMps?: number;
  heading?: number;
  recordedAt: string;
  source: string;
}

export interface TechnicianLocationPingBatchRequest {
  technicianId: string;
  pings: TechnicianLocationPingInput[];
}

/** A persisted location sample as returned by the batch ingest endpoint. */
export interface TechnicianLocationPingResponse extends TechnicianLocationPingInput {
  id: string;
  tenantId: string;
  technicianId: string;
}

export interface TechnicianLocationPingBatchResponse {
  count: number;
  acceptedCount: number;
  duplicateCount: number;
  pings: TechnicianLocationPingResponse[];
}
