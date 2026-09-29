/**
 * Recognise a Postgres technician double-booking violation, whichever DB
 * guard raised it. Both appointment and assignment writes map it to a 409.
 *
 *  - `no_double_booking` — migration 131's EXCLUDE constraint: SQLSTATE
 *    23P01 with `constraint = 'no_double_booking'`.
 *  - legacy `trg_no_double_booking` — databases that once ran the withdrawn
 *    migration `129_double_booking_exclusion` still carry its BEFORE INSERT
 *    OR UPDATE trigger. It raises 23P01 with NO constraint name and a
 *    `DOUBLE_BOOKING:` message, and fires before the EXCLUDE constraint, so
 *    matching on the constraint name alone let a reschedule into an
 *    overlapping slot surface as a 500 (#1472).
 */
export function isDoubleBookingViolation(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { code?: string; constraint?: string; message?: string };
  if (e.code !== '23P01') return false;
  return (
    e.constraint === 'no_double_booking' ||
    (e.constraint === undefined && typeof e.message === 'string' && e.message.startsWith('DOUBLE_BOOKING:'))
  );
}
