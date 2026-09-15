/**
 * #1051 follow-up — the TENANT-WIDE money-approval PIN lock decision (pure).
 *
 * The per-session three-strike lock (proposal-approval-task.ts) is re-derived
 * from a session's own strike rows, so a caller who hangs up and dials again
 * gets a fresh session — and, before this, fresh guesses. The tenant lock
 * counts the SAME durable strike rows across every session of the tenant:
 * `TENANT_PIN_STRIKE_LIMIT` strikes inside a rolling `TENANT_PIN_STRIKE_WINDOW_MS`
 * lock voice money approval for the whole tenant until enough of them age out
 * or the PIN changes (only strikes after the latest PIN change count).
 *
 * The owner is alerted ONCE per lock episode — a continuous stretch during
 * which the lock stays engaged. A strike aging out can release the lock; if it
 * later re-engages that is a new episode and a new alert is due.
 *
 * No I/O: the caller (proposal-approval-task.ts) reads the rows and the PIN
 * change time and hands in their timestamps.
 */

/** Strikes one tenant may spend inside the window before voice money approval locks. */
export const TENANT_PIN_STRIKE_LIMIT = 5;
/** The rolling window strikes are counted over. */
export const TENANT_PIN_STRIKE_WINDOW_MS = 24 * 60 * 60 * 1000;

export interface TenantPinLockInput {
  /** `createdAt` of this tenant's strike rows (failed-code + lockout), any order. */
  strikes: readonly Date[];
  /** `createdAt` of this tenant's owner-alert rows. */
  alerts: readonly Date[];
  /** Latest PIN set/change/clear; null when unknown (every strike in the window counts). */
  pinChangedAt: Date | null;
  now: Date;
}

export interface TenantPinLockDecision {
  locked: boolean;
  /** Strikes that count right now (after the PIN change, inside the window). */
  strikeCount: number;
  /** True when locked and no alert has been sent for THIS lock episode. */
  alertDue: boolean;
}

export function decideTenantPinLock(input: TenantPinLockInput): TenantPinLockDecision {
  const now = input.now.getTime();
  const floor = input.pinChangedAt ? input.pinChangedAt.getTime() : Number.NEGATIVE_INFINITY;
  const counts = (t: number) => t > floor && t <= now;
  const strikes = input.strikes.map((d) => d.getTime()).filter(counts);

  /** Strikes counting at instant `at`: inside (at - window, at]. */
  const countAt = (at: number) =>
    strikes.filter((s) => s > at - TENANT_PIN_STRIKE_WINDOW_MS && s <= at).length;

  const strikeCount = countAt(now);
  const locked = strikeCount >= TENANT_PIN_STRIKE_LIMIT;
  if (!locked) return { locked, strikeCount, alertDue: false };

  const alerts = input.alerts.map((d) => d.getTime()).filter(counts);
  const lastAlert = alerts.length > 0 ? Math.max(...alerts) : null;
  // A lock episode cannot outlast its own strikes by more than a window, so an
  // alert older than that belongs to an earlier episode.
  if (lastAlert === null || lastAlert <= now - TENANT_PIN_STRIKE_WINDOW_MS) {
    return { locked, strikeCount, alertDue: true };
  }
  // The last alert covers this episode only if the lock was engaged when it was
  // sent and never released since. The count only drops when a strike ages out
  // (at strike + window), so those are the only instants to check.
  const releasedSinceAlert =
    countAt(lastAlert) < TENANT_PIN_STRIKE_LIMIT ||
    strikes.some((s) => {
      const agesOut = s + TENANT_PIN_STRIKE_WINDOW_MS;
      return agesOut > lastAlert && agesOut <= now && countAt(agesOut) < TENANT_PIN_STRIKE_LIMIT;
    });
  return { locked, strikeCount, alertDue: releasedSinceAlert };
}
