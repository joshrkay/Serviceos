/**
 * #1051 follow-up — the TENANT-WIDE money-approval PIN lock decision (pure).
 *
 * The per-session three-strike lock (proposal-approval-task.ts) is re-derived
 * from a session's own strike rows, so a caller who hangs up and dials again
 * gets a fresh session — and, before this, fresh guesses. The tenant lock
 * budgets guesses across every session of the tenant:
 * `TENANT_PIN_STRIKE_LIMIT` counted attempts inside a rolling
 * `TENANT_PIN_STRIKE_WINDOW_MS` lock voice money approval for the whole tenant
 * until enough of them age out or the PIN changes (only attempts after the
 * latest PIN change count).
 *
 * #1233 review — the budget is enforced on RESERVED attempts, not on strike
 * rows written after the fact: every spoken code is reserved durably BEFORE it
 * is compared and counts until it is cleared (a correct code, a cancel, or a
 * refusal over the budget). A reserved attempt may be compared only while the
 * count INCLUDING it is within the limit (`attemptWithinBudget`), so parallel
 * calls cannot each read "4" and each guess: of any set of concurrent
 * reservations, the one that counts last sees all of them.
 *
 * The owner is alerted ONCE per lock episode. The episode is identified by the
 * attempt that engaged it — the `TENANT_PIN_STRIKE_LIMIT`-th SETTLED counted
 * attempt, oldest first. Settled means its wrong-code outcome is recorded (or
 * it has been pending longer than `PIN_ATTEMPT_SETTLE_MS`). A still-pending
 * reservation counts for the lock (fail closed) but never keys the episode:
 * its outcome may yet clear it, and a reservation stamped earlier but committed
 * later would otherwise move the key and re-send the alert. While the lock
 * holds no new attempt is compared, so the key stays the same until an attempt
 * ages out (releasing the lock); a re-engagement has a new key, and a new alert.
 *
 * No I/O: the caller reads the rows and the PIN change time and hands them in.
 */

/** Attempts one tenant may spend inside the window before voice money approval locks. */
export const TENANT_PIN_STRIKE_LIMIT = 5;
/** The rolling window attempts are counted over. */
export const TENANT_PIN_STRIKE_WINDOW_MS = 24 * 60 * 60 * 1000;
/**
 * Replicas stamp attempts with their own clocks; an attempt stamped up to this
 * far ahead of the deciding replica's `now` still counts.
 */
export const PIN_LOCK_CLOCK_SKEW_MS = 60 * 1000;
/**
 * A reservation normally gets its outcome within milliseconds. One still
 * pending after this long (a crash between reservation and outcome) is
 * treated as a spent guess for the episode key too.
 */
export const PIN_ATTEMPT_SETTLE_MS = 2 * 60 * 1000;

export interface ReservedPinAttempt {
  /** The reservation's audit row id — the key a clearing row refers to. */
  id: string;
  at: Date;
}

export interface TenantPinLockInput {
  /** This tenant's reserved attempts (any order). */
  attempts: readonly ReservedPinAttempt[];
  /** Ids of attempts that were cleared (passed, cancelled, refused over the budget). */
  clearedIds: ReadonlySet<string>;
  /** Ids of attempts whose wrong-code outcome is recorded (failed / lockout rows). */
  settledIds: ReadonlySet<string>;
  /** Latest PIN set/change/clear; null when unknown (every attempt in the window counts). */
  pinChangedAt: Date | null;
  now: Date;
}

export interface TenantPinLockDecision {
  locked: boolean;
  /** Attempts counting right now: reserved, not cleared, after the PIN change, inside the window. */
  strikeCount: number;
  /**
   * The attempt that engaged this lock episode — the owner-alert claim key.
   * Null when unlocked, or while one of the attempts that would engage it is
   * still pending.
   */
  engagingAttemptId: string | null;
}

export function decideTenantPinLock(input: TenantPinLockInput): TenantPinLockDecision {
  const now = input.now.getTime();
  const floor = input.pinChangedAt ? input.pinChangedAt.getTime() : Number.NEGATIVE_INFINITY;
  const counted = input.attempts
    .filter((a) => {
      const t = a.at.getTime();
      return (
        !input.clearedIds.has(a.id) &&
        t > floor &&
        t > now - TENANT_PIN_STRIKE_WINDOW_MS &&
        t <= now + PIN_LOCK_CLOCK_SKEW_MS
      );
    })
    .sort((a, b) => a.at.getTime() - b.at.getTime() || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const strikeCount = counted.length;
  const locked = strikeCount >= TENANT_PIN_STRIKE_LIMIT;
  const settled = counted.filter(
    (a) => input.settledIds.has(a.id) || now - a.at.getTime() > PIN_ATTEMPT_SETTLE_MS,
  );
  return {
    locked,
    strikeCount,
    engagingAttemptId:
      locked && settled.length >= TENANT_PIN_STRIKE_LIMIT ? settled[TENANT_PIN_STRIKE_LIMIT - 1].id : null,
  };
}

/**
 * The compare gate. `decision` must be taken AFTER this attempt was reserved,
 * so its count includes the attempt itself: the 5th guess is within budget,
 * a 6th never is.
 */
export function attemptWithinBudget(decision: TenantPinLockDecision): boolean {
  return decision.strikeCount <= TENANT_PIN_STRIKE_LIMIT;
}
