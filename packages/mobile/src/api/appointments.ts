/**
 * Typed wrappers for the scheduling surface (U7 / B1–B5). They accept the
 * `fetch`-shaped client from `useApiClient` so the Clerk JWT is attached, and
 * call no hooks themselves.
 *
 * Server paths used:
 *   - GET  /api/dispatch/availability   open slots (B1 book, B2 reschedule-pick)
 *   - POST /api/appointments            direct manual booking (B1)
 *   - PUT  /api/appointments/:id        direct status change → confirm (B4) / cancel (B3)
 *   - POST /api/proposals               mint scheduling proposals (B2 reschedule, B5 crew)
 *
 * Reschedule/reassign/add-crew/remove-crew are the four scheduling proposal
 * types the POST /api/proposals whitelist accepts; create/confirm/cancel have
 * DIRECT audited appointment routes so they don't need a proposal mint path.
 */
import { decodeError } from '../lib/appError';
import type { AuthedFetch } from './me';

export interface AvailabilitySlot {
  start: string;
  end: string;
}

export interface AvailabilityResponse {
  timezone: string;
  durationMin: number;
  slots: AvailabilitySlot[];
}

export interface FetchAvailabilityParams {
  /** Inclusive start day, YYYY-MM-DD. */
  from: string;
  /** Inclusive end day, YYYY-MM-DD. */
  to: string;
  durationMin?: number;
  /** Scope the search to a single technician's calendar (reschedule/reassign). */
  technicianId?: string;
}

/** GET /api/dispatch/availability — open slots in the tenant timezone. */
export async function fetchAvailability(
  client: AuthedFetch,
  params: FetchAvailabilityParams,
): Promise<AvailabilityResponse> {
  const qs = new URLSearchParams({ from: params.from, to: params.to });
  if (params.durationMin !== undefined) qs.set('durationMin', String(params.durationMin));
  if (params.technicianId) qs.set('technicianId', params.technicianId);
  const res = await client(`/api/dispatch/availability?${qs.toString()}`);
  if (!res.ok) throw await decodeError(res);
  return (await res.json()) as AvailabilityResponse;
}

export interface CreateAppointmentInput {
  jobId: string;
  /** ISO 8601 UTC instant. */
  scheduledStart: string;
  /** ISO 8601 UTC instant. */
  scheduledEnd: string;
  /** IANA timezone the appointment is anchored to (the tenant tz). */
  timezone: string;
  notes?: string;
}

/** POST /api/appointments — direct manual booking (B1). Returns the new id. */
export async function createAppointment(
  client: AuthedFetch,
  input: CreateAppointmentInput,
): Promise<{ id: string }> {
  const res = await client('/api/appointments', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jobId: input.jobId,
      scheduledStart: input.scheduledStart,
      scheduledEnd: input.scheduledEnd,
      timezone: input.timezone,
      ...(input.notes ? { notes: input.notes } : {}),
    }),
  });
  if (!res.ok) throw await decodeError(res);
  return (await res.json()) as { id: string };
}

/**
 * PUT /api/appointments/:id { status } — the lifecycle status change shared by
 * confirm (B4) and cancel (B3). Both are DIRECT, audited, and require
 * `appointments:update` (owner/dispatcher). The server's transition guard
 * (appointment-lifecycle.ts) rejects illegal moves with a 400.
 */
async function setAppointmentStatus(
  client: AuthedFetch,
  id: string,
  status: 'confirmed' | 'canceled',
): Promise<void> {
  const res = await client(`/api/appointments/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status }),
  });
  if (!res.ok) throw await decodeError(res);
}

/** B4 — confirm an appointment (scheduled → confirmed). Capture lane. */
export async function confirmAppointment(client: AuthedFetch, id: string): Promise<void> {
  return setAppointmentStatus(client, id, 'confirmed');
}

/**
 * B3 — cancel an appointment (→ canceled, a TERMINAL state). Irreversible: the
 * caller MUST gate this behind the U1 destructive confirm before invoking.
 */
export async function cancelAppointment(client: AuthedFetch, id: string): Promise<void> {
  return setAppointmentStatus(client, id, 'canceled');
}

/**
 * POST /api/proposals for one of the four whitelisted scheduling types. The
 * appointment's `updatedAt` ISO is the optimistic-concurrency version — sent as
 * both the `If-Match` header (server precedence) and `appointmentVersion` body
 * field (non-browser fallback), matching the web dispatch client. A stale
 * version 409s, an infeasible slot 422s; both decode to a surfaced AppError.
 */
async function mintScheduleProposal(
  client: AuthedFetch,
  body: {
    proposalType: 'reschedule_appointment' | 'reassign_appointment' | 'add_crew_member' | 'remove_crew_member';
    payload: Record<string, unknown>;
    summary: string;
  },
  appointmentVersion: string,
): Promise<{ id: string }> {
  const res = await client('/api/proposals', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'If-Match': appointmentVersion,
    },
    body: JSON.stringify({ ...body, appointmentVersion }),
  });
  if (!res.ok) throw await decodeError(res);
  return (await res.json()) as { id: string };
}

export interface RescheduleProposalInput {
  appointmentId: string;
  newScheduledStart: string;
  newScheduledEnd: string;
  reason?: string;
  /** The appointment's current `updatedAt` ISO (optimistic-concurrency token). */
  appointmentVersion: string;
}

/** B2 — mint a reschedule_appointment proposal from the chosen slot. */
export async function createRescheduleProposal(
  client: AuthedFetch,
  input: RescheduleProposalInput,
): Promise<{ id: string }> {
  return mintScheduleProposal(
    client,
    {
      proposalType: 'reschedule_appointment',
      payload: {
        appointmentId: input.appointmentId,
        newScheduledStart: input.newScheduledStart,
        newScheduledEnd: input.newScheduledEnd,
        ...(input.reason ? { reason: input.reason } : {}),
      },
      summary: input.reason || 'Reschedule appointment',
    },
    input.appointmentVersion,
  );
}

export interface ReassignProposalInput {
  appointmentId: string;
  toTechnicianId: string;
  fromTechnicianId?: string;
  reason?: string;
  appointmentVersion: string;
}

/** B5 — mint a reassign_appointment proposal (move the visit to another tech). */
export async function createReassignProposal(
  client: AuthedFetch,
  input: ReassignProposalInput,
): Promise<{ id: string }> {
  return mintScheduleProposal(
    client,
    {
      proposalType: 'reassign_appointment',
      payload: {
        appointmentId: input.appointmentId,
        toTechnicianId: input.toTechnicianId,
        ...(input.fromTechnicianId ? { fromTechnicianId: input.fromTechnicianId } : {}),
        ...(input.reason ? { reason: input.reason } : {}),
      },
      summary: input.reason || 'Reassign appointment',
    },
    input.appointmentVersion,
  );
}

export interface CrewMemberProposalInput {
  appointmentId: string;
  technicianId: string;
  reason?: string;
  appointmentVersion: string;
}

/** B5 — mint an add_crew_member proposal (add a tech to the visit). */
export async function addCrewMember(
  client: AuthedFetch,
  input: CrewMemberProposalInput,
): Promise<{ id: string }> {
  return mintScheduleProposal(
    client,
    {
      proposalType: 'add_crew_member',
      payload: {
        appointmentId: input.appointmentId,
        technicianId: input.technicianId,
        ...(input.reason ? { reason: input.reason } : {}),
      },
      summary: input.reason || 'Add crew member',
    },
    input.appointmentVersion,
  );
}

/** B5 — mint a remove_crew_member proposal (drop a tech from the visit). */
export async function removeCrewMember(
  client: AuthedFetch,
  input: CrewMemberProposalInput,
): Promise<{ id: string }> {
  return mintScheduleProposal(
    client,
    {
      proposalType: 'remove_crew_member',
      payload: {
        appointmentId: input.appointmentId,
        technicianId: input.technicianId,
        ...(input.reason ? { reason: input.reason } : {}),
      },
      summary: input.reason || 'Remove crew member',
    },
    input.appointmentVersion,
  );
}
