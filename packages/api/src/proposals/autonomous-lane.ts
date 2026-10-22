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
 *
 * D-015 amendment (2026-10-16): autonomous approval requires the owner's cell
 * (`owner_cell_missing`), an UNDO SMS channel that can deliver now
 * (`undo_channel_unavailable`), localized caller copy (`language_unsupported`)
 * and a slot-conflict check that ran (`conflict_check_unavailable`; a slot
 * the check finds busy is refused before the lane runs). These are the
 * `AutonomyOnlyInput` gates, which `evaluateBookingLaneForOwnerApproval`
 * skips for the D-019 close, which the owner always approves.
 */
import { actionClassForProposalType, type ProposalType } from './proposal';
import { confidenceMetaBlocksAutoApprove } from './auto-approve';

/** Proposal types the lane may ever apply to. Locked by D-015. */
export const AUTONOMOUS_LANE_PROPOSAL_TYPES: readonly ProposalType[] = [
  'create_appointment',
  'create_booking',
];

/**
 * Hard floor for the per-tenant threshold — enforced in code, not just the DB
 * CHECK.
 *
 * ACCIDENTAL COUPLING (found during the followup-autoapprove-default audit,
 * documented rather than fixed — see that investigation for why): this value
 * is REQUIRED to stay `>= LEGACY_AUTO_APPROVE_THRESHOLD`
 * (proposals/auto-approve.ts). Reasoning:
 * `ai/voice-turn/create-voice-turn-processor.ts` (the live-call FSM) never
 * threads `supervisorMode`/`supervisorPresent` into `createProposal` for its
 * `create_booking` proposals — the ONLY place it ever sets
 * `sourceTrustTier: 'autonomous'` is inside `...(autonomousLaneForCreate ?
 * {...} : {})`, i.e. only once `evaluateAutonomousBookingLane` below has
 * already confirmed `confidenceScore >= max(FLOOR, tenantThreshold)`. With no
 * supervision signal threaded, `resolveAutoApproveThreshold` never sees
 * `supervisorPresent === false`, so it never returns `null` — the
 * `threshold === null` branch in `decideInitialStatus` that's SUPPOSED to
 * consult this lane's own dedicated threshold never runs for this caller.
 * Instead `decideInitialStatus` falls through to its generic
 * `shouldAutoApprove(confidenceScore, LEGACY_AUTO_APPROVE_THRESHOLD)` check.
 * That check is currently harmless ONLY because `LEGACY_AUTO_APPROVE_
 * THRESHOLD === AUTONOMOUS_BOOKING_THRESHOLD_FLOOR` (0.9 === 0.9): eligibility
 * already guarantees `confidenceScore >= FLOOR`, so the generic check is
 * guaranteed to also pass. If `FLOOR` ever drops below `LEGACY_AUTO_APPROVE_
 * THRESHOLD` (or `LEGACY_AUTO_APPROVE_THRESHOLD` is ever raised above
 * `FLOOR`), a booking the lane deems eligible would silently fail the generic
 * check and land in 'draft' instead of 'approved' — a silent regression
 * toward MORE caution (a booking that should auto-approve doesn't), not a
 * safety leak in the other direction, but still a real behavior change with
 * no test today wired specifically to the create-voice-turn-processor.ts
 * caller. Pinned as a standing invariant in
 * test/proposals/autonomous-lane.test.ts; if you need to move either
 * constant, update both together (or thread real supervision into that
 * caller, which would make this whole coupling irrelevant).
 */
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
  /**
   * The owner's cell (`tenant_settings.owner_phone`). Required so every
   * caller decides: the owner UNDO SMS is part of why the lane is safe, so a
   * tenant with no cell on file never books autonomously.
   */
  ownerPhone: string | null | undefined;
  /**
   * True only when the owner UNDO SMS can actually be minted and sent now
   * (`LaneUndoChannel` wired and `canDeliver()`, which follows the outbound
   * SMS kill switch). Required so every caller decides; anything but true is
   * `undo_channel_unavailable`.
   */
  undoChannelAvailable: boolean;
  /**
   * True only when the P0-035 slot-conflict check RAN before the hold and
   * found the slot free. A busy slot never gets here (the hold is refused, or
   * the memo path asks a clarification), so false means the check did not
   * run; such a slot is never auto-booked (`conflict_check_unavailable`).
   * Required.
   */
  slotConflictFree: boolean;
  /**
   * False when the live caller's language has no localized booking copy, so
   * the binding "you're booked" line could not be spoken in it. Absent on
   * surfaces with no caller to speak to (the memo router).
   */
  callerLanguageSupported?: boolean;
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
    /** The prompt-injection guard flagged the session: its model confidence is not trusted. */
    injection?: boolean;
  };
}

export type AutonomousLaneEvaluation =
  | { eligible: true; threshold: number }
  | { eligible: false; reason: AutonomousLaneIneligibleReason };

export type AutonomousLaneIneligibleReason =
  | 'platform_disabled'
  | 'tenant_not_opted_in'
  | 'owner_cell_missing'
  | 'undo_channel_unavailable'
  | 'language_unsupported'
  | 'conflict_check_unavailable'
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
 * All-gates evaluator for AUTONOMOUS approval. Order matters only for the
 * audit reason (first failing gate wins); eligibility requires every gate to
 * pass.
 */
export function evaluateAutonomousBookingLane(
  input: EvaluateAutonomousLaneInput,
): AutonomousLaneEvaluation {
  return evaluateLaneGates(input, true);
}

/**
 * D-019 — every D-015 gate except the autonomy-only ones (`AutonomyOnlyInput`),
 * for a booking a human approves (the on-call close's owner-approval chain).
 * Those gates exist because the system approves alone; a close is never
 * system-approved.
 */
export function evaluateBookingLaneForOwnerApproval(
  input: Omit<EvaluateAutonomousLaneInput, AutonomyOnlyInput>,
): AutonomousLaneEvaluation {
  return evaluateLaneGates(input, false);
}

/** Inputs only autonomous (system) approval checks; the D-019 close omits them. */
type AutonomyOnlyInput =
  | 'ownerPhone'
  | 'undoChannelAvailable'
  | 'slotConflictFree'
  | 'callerLanguageSupported';

function evaluateLaneGates(
  input: Omit<EvaluateAutonomousLaneInput, AutonomyOnlyInput> &
    Partial<Pick<EvaluateAutonomousLaneInput, AutonomyOnlyInput>>,
  autonomousApproval: boolean,
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
  // After the structural gates, so traffic that could never take the lane
  // (owner memos, non-booking types) keeps its structural audit reason.
  if (autonomousApproval && !input.ownerPhone?.trim()) {
    return { eligible: false, reason: 'owner_cell_missing' };
  }
  if (autonomousApproval && input.undoChannelAvailable !== true) {
    return { eligible: false, reason: 'undo_channel_unavailable' };
  }
  if (autonomousApproval && input.callerLanguageSupported === false) {
    return { eligible: false, reason: 'language_unsupported' };
  }
  const flags = input.flags ?? {};
  if (flags.vulnerability || flags.emergency || flags.negotiation || flags.injection) {
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
  if (autonomousApproval && input.slotConflictFree !== true) {
    return { eligible: false, reason: 'conflict_check_unavailable' };
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
