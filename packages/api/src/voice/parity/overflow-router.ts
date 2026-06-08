/**
 * After-hours / overflow call-handling decision (Feature 5).
 *
 * Encodes the four Avoca-parity rules that the inbound stack did not yet make
 * as one auditable decision:
 *
 *   1. After-hours, non-emergency → AI handles the whole call (no human-dial
 *      attempt) when the tenant opted into `ai_answering`; otherwise voicemail.
 *   2. Within hours, non-emergency → a human CSR takes it UNLESS every seat is
 *      busy (`csrBusyCount >= csrSeats`), in which case the AI handles overflow.
 *   3. Emergency intent → dial the on-call number regardless of the hour. This
 *      is life-safety and outranks every other rule.
 *   4. Any booking made on an after-hours call is flagged for morning review.
 *
 * Pure and deterministic. The adapter/FSM owns the side effects (answer, dial,
 * voicemail); this module owns the policy so it can be tested exhaustively and
 * reasoned about without Twilio in the loop.
 */

import { checkBusinessHours, type BusinessHoursConfig } from '../../compliance/business-hours';

/** How the tenant configured after-hours inbound answering. */
export type AfterHoursVoiceMode = 'voicemail' | 'ai_answering';

export type CallHandlingMode =
  /** Emergency: dial the on-call number now, regardless of hour. */
  | 'emergency_dial'
  /** AI answers and handles the full call (after-hours ai_answering tenant). */
  | 'ai_handles'
  /** AI answers because every CSR seat is busy (within-hours overflow). */
  | 'ai_overflow'
  /** Send to voicemail (after-hours, tenant did not opt into AI answering). */
  | 'voicemail'
  /** A human CSR takes the call (within hours, a seat is free). */
  | 'human';

export interface CallHandlingInput {
  /** True when the call arrives inside the tenant's business hours. */
  withinBusinessHours: boolean;
  /** True when the classified/early intent is an emergency. */
  isEmergency: boolean;
  /** Configured number of human CSR seats. Treated as 0 when unset. */
  csrSeats?: number;
  /** Live count of CSRs currently on a call. Treated as 0 when unset. */
  csrBusyCount?: number;
  /** Tenant's after-hours answering preference. Defaults to 'voicemail'. */
  afterHoursVoiceMode?: AfterHoursVoiceMode;
}

export interface CallHandlingDecision {
  mode: CallHandlingMode;
  /** Echo of "this call arrived outside business hours" for downstream flagging. */
  afterHours: boolean;
  /**
   * Whether a booking made during THIS call should be flagged `after_hours`
   * for morning review. True for any non-emergency call handled outside hours.
   */
  flagBookingAfterHours: boolean;
  /** Audit-friendly reason code. */
  reason:
    | 'emergency_regardless_of_hours'
    | 'after_hours_ai_answering'
    | 'after_hours_voicemail'
    | 'within_hours_overflow_to_ai'
    | 'within_hours_human';
}

/**
 * Decide how an inbound call should be handled. See module docstring for the
 * rule ordering; emergency is evaluated first because it is unconditional.
 */
export function decideCallHandling(input: CallHandlingInput): CallHandlingDecision {
  const afterHours = !input.withinBusinessHours;

  // Rule 3 — emergency outranks everything, in or out of hours.
  if (input.isEmergency) {
    return {
      mode: 'emergency_dial',
      afterHours,
      // An emergency is dispatched, not "booked after hours" for routine review.
      flagBookingAfterHours: false,
      reason: 'emergency_regardless_of_hours',
    };
  }

  // Rule 1 — after hours, non-emergency.
  if (afterHours) {
    const mode = (input.afterHoursVoiceMode ?? 'voicemail');
    if (mode === 'ai_answering') {
      return {
        mode: 'ai_handles',
        afterHours: true,
        flagBookingAfterHours: true,
        reason: 'after_hours_ai_answering',
      };
    }
    return {
      mode: 'voicemail',
      afterHours: true,
      // Voicemail can't book, so nothing to flag.
      flagBookingAfterHours: false,
      reason: 'after_hours_voicemail',
    };
  }

  // Rule 2 — within hours, non-emergency: AI only on overflow.
  const seats = Math.max(0, Math.floor(input.csrSeats ?? 0));
  const busy = Math.max(0, Math.floor(input.csrBusyCount ?? 0));
  if (busy >= seats) {
    return {
      mode: 'ai_overflow',
      afterHours: false,
      flagBookingAfterHours: false,
      reason: 'within_hours_overflow_to_ai',
    };
  }
  return {
    mode: 'human',
    afterHours: false,
    flagBookingAfterHours: false,
    reason: 'within_hours_human',
  };
}

/**
 * Whether a proposed appointment slot starts outside the tenant's business
 * hours, and therefore should be flagged for morning review. Reuses the
 * canonical {@link checkBusinessHours} so "after hours" means exactly the same
 * thing for live calls and for booked slots. Fail-open: an unconfigured or
 * malformed schedule is treated as in-hours (not flagged), matching the rest
 * of the stack.
 */
export function isAfterHoursBooking(
  slotStartUtc: Date,
  config: BusinessHoursConfig | null,
): boolean {
  return checkBusinessHours(config, slotStartUtc).isOpen === false;
}
