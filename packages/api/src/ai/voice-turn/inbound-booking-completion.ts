/**
 * U3 — live-call inbound booking completion helpers.
 *
 * After a create_appointment draft is grounded, the live voice path may
 * upgrade to create_booking + hold + D-015 autonomous lane evaluation so a
 * confident booking confirms without an owner mid-call. Pure speech helpers
 * keep R6 (honest spoken outcome when the lane is off/ineligible).
 */
import {
  evaluateAutonomousBookingLane,
  autonomousLaneStamp,
  type AutonomousLaneEvaluation,
  type AutonomousLaneSettings,
} from '../../proposals/autonomous-lane';
import { formatForReadback } from '../scheduling/resolve-datetime';

/** Spoken when D-015 auto-confirms the slot (customer is booked). */
export function spokenAutonomousBookConfirm(timeReadback: string): string {
  return `You're booked for ${timeReadback}. I'll text you a confirmation — reply if you need to change it.`;
}

/**
 * Spoken when a hold is placed but the lane is off or ineligible —
 * never claims the booking is final.
 */
export function spokenBookingPendingOwner(timeReadback: string): string {
  return `I've reserved ${timeReadback} for you. Our team will confirm shortly and you'll get a text.`;
}

/** Spoken when we only have a draft proposal (no hold). */
export function spokenBookingDraftOnly(): string {
  return `I've noted that appointment request. Someone from our team will confirm the time with you shortly.`;
}

export function bookingSpeechForLane(
  evaluation: AutonomousLaneEvaluation | undefined,
  timeReadback: string | undefined,
): string {
  if (evaluation?.eligible === true && timeReadback) {
    return spokenAutonomousBookConfirm(timeReadback);
  }
  if (timeReadback) {
    return spokenBookingPendingOwner(timeReadback);
  }
  return spokenBookingDraftOnly();
}

export function buildLaneInputFromSettings(opts: {
  platformDisabled?: boolean;
  settings?: AutonomousLaneSettings;
  confidenceScore?: number;
  customerId?: string;
  holdExpiryAt: Date;
  now: Date;
  slotWithinBusinessHours: boolean;
  pendingReferenceCount?: number;
  negotiationFlagged?: boolean;
  payload: Record<string, unknown>;
}): AutonomousLaneEvaluation {
  return evaluateAutonomousBookingLane({
    platformDisabled: opts.platformDisabled === true,
    settings: opts.settings,
    proposalType: 'create_booking',
    inboundReceptionistSource: true,
    confidenceScore: opts.confidenceScore,
    payload: opts.payload,
    pendingReferenceCount: opts.pendingReferenceCount ?? 0,
    customerId: opts.customerId,
    holdPlaced: true,
    holdExpiryAt: opts.holdExpiryAt,
    now: opts.now,
    slotWithinBusinessHours: opts.slotWithinBusinessHours,
    flags: {
      negotiation: opts.negotiationFlagged === true,
    },
  });
}

export function timeReadbackFromHold(
  scheduledStartIso: string,
  timezone: string,
): string {
  return formatForReadback(scheduledStartIso, timezone);
}

export function laneStampIfPresent(evaluation: AutonomousLaneEvaluation | undefined) {
  return evaluation ? autonomousLaneStamp(evaluation) : undefined;
}
