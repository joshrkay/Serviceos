/**
 * D-018 — Autonomous CLOSE lane (per-tenant opt-in, default OFF).
 *
 * A scoped, stricter sibling of the D-015 autonomous BOOKING lane
 * (autonomous-lane.ts). Where D-015 lets an inbound booking auto-approve while
 * unsupervised, D-018 authorizes the agent to CLOSE THE SALE on the live call:
 * draft the estimate, send it (the deposit/approval link SMS), and confirm the
 * held booking — a three-member chain (draft_estimate → send_estimate →
 * create_booking) that includes a COMMS-class member (send_estimate) which
 * decideInitialStatus never auto-approves. The close flow performs an explicit
 * SYSTEM APPROVAL of each member under this sanction; decideInitialStatus and
 * actionClassForProposalType are deliberately UNCHANGED (a comms proposal is
 * still born blocked — the sanction is the analog of the owner's one-tap).
 *
 * This module is PURE — no I/O. It is a SIBLING of autonomous-lane.ts, not an
 * extension: D-015's gate set stays untouched. It COMPOSES
 * evaluateAutonomousBookingLane for the create_booking leg (so the calendar /
 * hold / customer gates are enforced exactly once, in one place) and layers the
 * close-specific gates on top.
 *
 * Gate order (first-failing wins; eligibility requires every gate to pass):
 *   platform_disabled (AUTONOMOUS_CLOSE_DISABLED — checked FIRST, independent of
 *     AUTONOMOUS_BOOKING_DISABLED so the audit reason distinguishes the two
 *     kill switches)
 *   → tenant_not_opted_in (tenant_settings.autonomous_close_enabled, default OFF)
 *   → quote_not_grounded_clean (every line a clean catalog match — no LLM price
 *     ever gets auto-sent to a customer)
 *   → above_close_cap (tenant_settings.autonomous_close_max_cents)
 *   → not_strict_confirmed (the strict confirmIntent gate — a deterministic
 *     affirmative is necessary, not sufficient)
 *   → sms_consent_not_captured (the on-call TCPA capture must have succeeded)
 *   → scheduling_incomplete / hold_not_placed / hold_expired
 *   → booking_lane_ineligible (the composed D-015 evaluation)
 *   → session_flagged (vulnerability / emergency / negotiation)
 *
 * Both outcomes are stamped on every chain member's
 * sourceContext.autonomousCloseEvaluation for the audit trail.
 */
import {
  evaluateAutonomousBookingLane,
  type EvaluateAutonomousLaneInput,
  type AutonomousLaneIneligibleReason,
} from './autonomous-lane';

export type AutonomousCloseIneligibleReason =
  | 'platform_disabled'
  | 'tenant_not_opted_in'
  | 'quote_not_grounded_clean'
  | 'above_close_cap'
  | 'not_strict_confirmed'
  | 'sms_consent_not_captured'
  | 'scheduling_incomplete'
  | 'hold_not_placed'
  | 'hold_expired'
  | 'booking_lane_ineligible'
  | 'session_flagged';

export type AutonomousCloseEvaluation =
  | { eligible: true; bookingThreshold: number; closeCapCents?: number }
  | {
      eligible: false;
      reason: AutonomousCloseIneligibleReason;
      /** The composed D-015 reason, when the failure was booking_lane_ineligible. */
      bookingReason?: AutonomousLaneIneligibleReason;
    };

export interface EvaluateAutonomousCloseInput {
  /** AUTONOMOUS_CLOSE_DISABLED — checked FIRST, independent of the booking switch. */
  platformDisabled?: boolean;
  /** tenant_settings.autonomous_close_enabled (default OFF). */
  tenantOptedIn: boolean;
  /** tenant_settings.autonomous_close_max_cents; undefined ⇒ no cap. */
  closeCapCents?: number;
  /** Every quote line resolved to a clean catalog match. */
  groundedClean: boolean;
  /** The spoken quote total (integer cents) compared to the close cap. */
  quoteTotalCents: number;
  /** The strict confirmIntent gate passed (authoritative, not the pre-check). */
  strictConfirmed: boolean;
  /** The on-call SMS consent capture succeeded. */
  smsConsentCaptured: boolean;
  /** A resolved time + a persisted (held) appointment exist. */
  schedulingComplete: boolean;
  holdPlaced: boolean;
  holdExpiryAt?: Date;
  now: Date;
  /**
   * The D-015 booking-lane inputs for the create_booking leg. `flags` is forced
   * empty here — the close lane checks live-session flags itself (last gate) so
   * the audit reason is `session_flagged`, not `booking_lane_ineligible`.
   */
  booking: Omit<EvaluateAutonomousLaneInput, 'flags'>;
  /** Live-session risk flags — any true blocks the close (checked LAST). */
  flags?: {
    vulnerability?: boolean;
    emergency?: boolean;
    negotiation?: boolean;
  };
}

export function evaluateAutonomousCloseLane(
  input: EvaluateAutonomousCloseInput,
): AutonomousCloseEvaluation {
  if (input.platformDisabled) {
    return { eligible: false, reason: 'platform_disabled' };
  }
  if (!input.tenantOptedIn) {
    return { eligible: false, reason: 'tenant_not_opted_in' };
  }
  if (!input.groundedClean) {
    return { eligible: false, reason: 'quote_not_grounded_clean' };
  }
  if (
    typeof input.closeCapCents === 'number' &&
    input.quoteTotalCents > input.closeCapCents
  ) {
    return { eligible: false, reason: 'above_close_cap' };
  }
  if (!input.strictConfirmed) {
    return { eligible: false, reason: 'not_strict_confirmed' };
  }
  if (!input.smsConsentCaptured) {
    return { eligible: false, reason: 'sms_consent_not_captured' };
  }
  if (!input.schedulingComplete) {
    return { eligible: false, reason: 'scheduling_incomplete' };
  }
  if (!input.holdPlaced) {
    return { eligible: false, reason: 'hold_not_placed' };
  }
  if (!input.holdExpiryAt || input.holdExpiryAt.getTime() <= input.now.getTime()) {
    return { eligible: false, reason: 'hold_expired' };
  }
  // Compose the D-015 booking lane (flags forced empty — checked here last).
  const booking = evaluateAutonomousBookingLane({ ...input.booking, flags: {} });
  if (!booking.eligible) {
    return { eligible: false, reason: 'booking_lane_ineligible', bookingReason: booking.reason };
  }
  const flags = input.flags ?? {};
  if (flags.vulnerability || flags.emergency || flags.negotiation) {
    return { eligible: false, reason: 'session_flagged' };
  }
  return {
    eligible: true,
    bookingThreshold: booking.threshold,
    ...(typeof input.closeCapCents === 'number' ? { closeCapCents: input.closeCapCents } : {}),
  };
}

/** The sourceContext stamp recording the evaluation (both outcomes). */
export function autonomousCloseStamp(evaluation: AutonomousCloseEvaluation): {
  autonomousCloseEvaluation: AutonomousCloseEvaluation;
} {
  return { autonomousCloseEvaluation: evaluation };
}

/** Typed reader for the sourceContext stamp. */
export function autonomousCloseEvaluationFor(proposal: {
  sourceContext?: Record<string, unknown> | undefined;
}): AutonomousCloseEvaluation | undefined {
  const raw = proposal.sourceContext?.autonomousCloseEvaluation as
    | AutonomousCloseEvaluation
    | undefined;
  if (!raw || typeof raw !== 'object' || typeof raw.eligible !== 'boolean') return undefined;
  return raw;
}
