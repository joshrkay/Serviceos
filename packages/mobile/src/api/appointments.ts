import { decodeError } from '../lib/appError';
import type { AuthedFetch } from './me';
import type { Slot } from '../scheduling/slots';

export interface AvailabilityResponse {
  timezone: string;
  durationMin: number;
  slots: Slot[];
}

export interface FetchAvailabilityParams {
  /** Inclusive `YYYY-MM-DD` range start. */
  from: string;
  /** Inclusive `YYYY-MM-DD` range end. */
  to: string;
  /** Visit length in minutes (server default 60, range 15–480). */
  durationMin?: number;
}

/**
 * GET /api/public/booking/:tenantId/availability — the only slot source the API
 * exposes; there is no authenticated availability endpoint. It computes open
 * slots server-side from the tenant's working hours minus existing bookings and
 * returns them as UTC instants plus the tenant `timezone`, so the client never
 * has to do timezone math. Mounted before Clerk, so it ignores the auth header
 * the shared client attaches — harmless to call with the authed `client`.
 */
export async function fetchAvailability(
  client: AuthedFetch,
  tenantId: string,
  params: FetchAvailabilityParams,
): Promise<AvailabilityResponse> {
  const qs = new URLSearchParams({ from: params.from, to: params.to });
  if (params.durationMin !== undefined) qs.set('durationMin', String(params.durationMin));
  const res = await client(`/api/public/booking/${tenantId}/availability?${qs.toString()}`);
  if (!res.ok) throw new Error((await decodeError(res)).message);
  return (await res.json()) as AvailabilityResponse;
}

export interface CreateAppointmentInput {
  jobId: string;
  /** ISO instant (from a chosen availability slot). */
  scheduledStart: string;
  scheduledEnd: string;
  /** IANA tenant timezone — required by the server. */
  timezone: string;
  notes?: string;
}

/**
 * POST /api/appointments — book a visit against an existing job. The server's
 * `no_double_booking` exclusion constraint is the source of truth for conflicts
 * (a slot can be taken between availability load and submit): a clash comes back
 * 409, whose message we surface verbatim so the picker can prompt a re-pick.
 */
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
      notes: input.notes,
    }),
  });
  if (!res.ok) throw new Error((await decodeError(res)).message);
  return (await res.json()) as { id: string };
}
