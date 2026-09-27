/**
 * #1406 D10 / #1416 — what a running_late request actually did, in words.
 * Shared by every delay-notice surface (AppointmentEdit's dialog, the
 * Schedule page's delay sheet) so none of them claims a notice that the API
 * reports was never queued (`queued: false` + `reason`).
 */
export interface RunningLateOutcome {
  queued?: boolean;
  reason?: string;
}

export function delayOutcomeMessage(body: RunningLateOutcome): string {
  if (body.queued) return 'Delay notice queued — the next customer will receive an SMS.';
  if (body.reason === 'NO_CUSTOMER_TO_NOTIFY') {
    return 'No customer was notified — there is no later visit for this technician today (or that customer opted out of texts).';
  }
  return 'No customer was notified — the delay notice could not be queued.';
}
