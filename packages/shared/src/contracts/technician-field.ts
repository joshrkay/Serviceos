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
