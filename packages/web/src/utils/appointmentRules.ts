/**
 * #1402 §3/§15 — client mirror of the API's appointment write rules, so the
 * operator hears "that's in the past" before a round trip. The API
 * (packages/api/src/appointments/appointment.ts, PAST_START_GRACE_MS) stays
 * the authority; this uses the same 5-minute grace so the two never disagree
 * about a start "right now".
 */
const PAST_START_GRACE_MS = 5 * 60 * 1000;

export const PAST_START_ERROR = 'That start time is in the past — pick a later time.';

export function isPastStart(start: Date, now: Date = new Date()): boolean {
  return start.getTime() < now.getTime() - PAST_START_GRACE_MS;
}

/** Non-blocking `warnings` the appointment write routes attach to a 2xx body. */
export function appointmentWarnings(body: unknown): string[] {
  const w = (body as { warnings?: unknown } | null)?.warnings;
  return Array.isArray(w) ? w.filter((x): x is string => typeof x === 'string') : [];
}
