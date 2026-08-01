/**
 * UB-D / D-015 — Autonomous booking lane (per-tenant opt-in, default OFF).
 *
 * A scoped exception to the unsupervised auto-approve block: when a tenant
 * has explicitly enabled `autonomous_booking_enabled`, an inbound-receptionist
 * booking proposal (`create_appointment` / `create_booking` — capture class
 * only) may auto-approve with no supervisor present, provided EVERY gate
 * below passes. The customer gets an instant confirmation after the standard
 * 5-second undo window; the owner gets an immediate SMS with a one-tap UNDO
 * that cancels + apologizes (proposals/one-tap-undo.ts).
 *
 * This module is PURE — no I/O. Callers gather the inputs and thread the
 * eligible result into `decideInitialStatus` via `CreateProposalInput
 * .autonomousLane`. `proposals/auto-approve.ts` is intentionally untouched:
 * money-, comms-, and irreversible-class proposals are structurally
 * unaffected (the lane is consulted only inside the existing
 * `autonomous + capture` branch of `decideInitialStatus`).
 *
 * Every evaluation (pass or fail) should be stamped on the proposal's
 * sourceContext (`autonomousLaneEvaluation`) so the audit trail records why
 * a booking did or did not take the lane.
 *
 * D-015 amendment (2026-07-11): a platform-wide kill switch
 * (`AUTONOMOUS_BOOKING_DISABLED=true`) can disable the lane for every
 * tenant regardless of their opt-in. It is checked FIRST — before the
 * tenant opt-in gate — so the stamped reason (`platform_disabled`)
 * distinguishes an operator-level shutoff from a tenant simply not having
 * opted in.
 */
import { actionClassForProposalType, type ProposalType } from './proposal';
import { confidenceMetaBlocksAutoApprove } from './auto-approve';

/** Proposal types the lane may ever apply to. Locked by D-015. */
export const AUTONOMOUS_LANE_PROPOSAL_TYPES: readonly ProposalType[] = [
  'create_appointment',
  'create_booking',
];

/** Hard floor for the per-tenant threshold — enforced in code, not just the DB CHECK. */
export const AUTONOMOUS_BOOKING_THRESHOLD_FLOOR = 0.9;
/** Default per-tenant threshold when the column is unset. */
export const AUTONOMOUS_BOOKING_THRESHOLD_DEFAULT = 0.95;

export interface AutonomousLaneSettings {
  enabled: boolean;
  /** Clamped to ≥ AUTONOMOUS_BOOKING_THRESHOLD_FLOOR by the evaluator. */
  threshold?: number;
}

export interface EvaluateAutonomousLaneInput {
  /**
   * D-015 amendment — platform-wide kill switch (AUTONOMOUS_BOOKING_DISABLED).
   * Checked before every other gate, including tenant opt-in.
   */
  platformDisabled?: boolean;
  settings?: AutonomousLaneSettings;
  proposalType: ProposalType;
  /**
   * True only for the inbound-receptionist path (customer-call FSM or the
   * voice-action router acting on an inbound call with a verified caller).
   * Owner memos / assistant chat never take the lane.
   */
  inboundReceptionistSource: boolean;
  confidenceScore?: number;
  /** The proposal payload — inspected for the `_meta` confidence marker. */
  payload?: unknown;
  missingFields?: string[];
  /** Unresolved free-text references (annotation.pendingReferences). */
  pendingReferenceCount: number;
  /** Verified customer id (caller-ID or resolver hit). */
  customerId?: string;
  /** A tentative held slot exists (holdPendingApproval placed by the task). */
  holdPlaced: boolean;
  /** The hold's expiry; must be in the future at evaluation time. */
  holdExpiryAt?: Date;
  now: Date;
  /**
   * True when the proposed slot start falls inside the tenant's business
   * hours (caller computes from tenant_settings.businessHours in the tenant
   * timezone; when the tenant has no configured hours, callers pass true —
   * absence of configuration is not a lane blocker, D-015).
   */
  slotWithinBusinessHours: boolean;
  /** Session flags — any true blocks the lane. */
  flags?: {
    vulnerability?: boolean;
    emergency?: boolean;
    negotiation?: boolean;
  };
}

export type AutonomousLaneEvaluation =
  | { eligible: true; threshold: number }
  | { eligible: false; reason: AutonomousLaneIneligibleReason };

export type AutonomousLaneIneligibleReason =
  | 'platform_disabled'
  | 'tenant_not_opted_in'
  | 'proposal_type_not_eligible'
  | 'not_inbound_receptionist'
  | 'below_threshold'
  | 'confidence_marker_blocks'
  | 'missing_fields'
  | 'pending_references'
  | 'no_verified_customer'
  | 'no_held_slot'
  | 'hold_expired'
  | 'outside_business_hours'
  | 'session_flagged';

/**
 * All-gates evaluator. Order matters only for the audit reason (first
 * failing gate wins); eligibility requires every gate to pass.
 */
export function evaluateAutonomousBookingLane(
  input: EvaluateAutonomousLaneInput,
): AutonomousLaneEvaluation {
  if (input.platformDisabled) {
    return { eligible: false, reason: 'platform_disabled' };
  }
  if (!input.settings?.enabled) {
    return { eligible: false, reason: 'tenant_not_opted_in' };
  }
  if (
    !AUTONOMOUS_LANE_PROPOSAL_TYPES.includes(input.proposalType) ||
    actionClassForProposalType(input.proposalType) !== 'capture'
  ) {
    return { eligible: false, reason: 'proposal_type_not_eligible' };
  }
  if (!input.inboundReceptionistSource) {
    return { eligible: false, reason: 'not_inbound_receptionist' };
  }
  const flags = input.flags ?? {};
  if (flags.vulnerability || flags.emergency || flags.negotiation) {
    return { eligible: false, reason: 'session_flagged' };
  }
  if (confidenceMetaBlocksAutoApprove(input.payload)) {
    return { eligible: false, reason: 'confidence_marker_blocks' };
  }
  if (input.missingFields && input.missingFields.length > 0) {
    return { eligible: false, reason: 'missing_fields' };
  }
  if (input.pendingReferenceCount > 0) {
    return { eligible: false, reason: 'pending_references' };
  }
  if (!input.customerId) {
    return { eligible: false, reason: 'no_verified_customer' };
  }
  if (!input.holdPlaced) {
    return { eligible: false, reason: 'no_held_slot' };
  }
  if (!input.holdExpiryAt || input.holdExpiryAt.getTime() <= input.now.getTime()) {
    return { eligible: false, reason: 'hold_expired' };
  }
  if (!input.slotWithinBusinessHours) {
    return { eligible: false, reason: 'outside_business_hours' };
  }
  const threshold = Math.max(
    AUTONOMOUS_BOOKING_THRESHOLD_FLOOR,
    input.settings.threshold ?? AUTONOMOUS_BOOKING_THRESHOLD_DEFAULT,
  );
  if (typeof input.confidenceScore !== 'number' || input.confidenceScore < threshold) {
    return { eligible: false, reason: 'below_threshold' };
  }
  return { eligible: true, threshold };
}

/**
 * The sourceContext stamp recording the evaluation (both outcomes) for the
 * audit trail and for downstream consumers (the router's unsupervised
 * chokepoint + the one-tap UNDO sender key off `eligible: true`).
 */
export function autonomousLaneStamp(evaluation: AutonomousLaneEvaluation): {
  autonomousLaneEvaluation:
    | { eligible: true; threshold: number }
    | { eligible: false; reason: AutonomousLaneIneligibleReason };
} {
  return { autonomousLaneEvaluation: evaluation };
}

/** Typed reader for the sourceContext stamp. */
export function autonomousLaneEvaluationFor(proposal: {
  sourceContext?: Record<string, unknown> | undefined;
}): AutonomousLaneEvaluation | undefined {
  const raw = proposal.sourceContext?.autonomousLaneEvaluation as
    | AutonomousLaneEvaluation
    | undefined;
  if (!raw || typeof raw !== 'object' || typeof raw.eligible !== 'boolean') return undefined;
  return raw;
}
