import type { ProposalType } from '../proposals/proposal';

/**
 * §9 — versioned time-credit constants.
 *
 * Each automated action carries a small, fixed number of minutes the
 * owner did NOT spend doing it by hand. The numbers are deliberately
 * conservative — the dollar figure they drive has to stay credible.
 *
 * `PROPOSAL_TIME_CREDITS` is a Partial map, not an exhaustive Record:
 * the spec wants these "tunable, versioned, recalibrate-safe", and a
 * compile-time forcing function fights that. A ProposalType with no
 * explicit entry falls back to `DEFAULT_PROPOSAL_CREDIT_MINUTES`.
 *
 * Bump `TIME_CREDIT_VERSION` whenever a number changes so a stored or
 * displayed estimate can be traced to the calibration that produced it.
 */
export const TIME_CREDIT_VERSION = 'v1-2026-05';

/** Minutes credited per executed proposal, by type. */
export const PROPOSAL_TIME_CREDITS: Partial<Record<ProposalType, number>> = {
  create_customer: 3,
  update_customer: 2,
  create_job: 4,
  create_appointment: 4,
  create_booking: 5,
  draft_estimate: 12,
  update_estimate: 4,
  draft_invoice: 8,
  update_invoice: 3,
  issue_invoice: 3,
  reassign_appointment: 2,
  reschedule_appointment: 5,
  cancel_appointment: 3,
  // Not a real mutation — a clarifying prompt. Explicitly zero.
  voice_clarification: 0,
  add_note: 1,
  send_invoice: 3,
  record_payment: 3,
  log_expense: 2,
  emergency_dispatch: 5,
  onboarding_tenant_settings: 2,
  onboarding_service_category: 2,
  onboarding_estimate_template: 2,
  onboarding_team_member: 2,
  onboarding_schedule: 2,
};

/** Fallback for any ProposalType without an explicit entry above. */
export const DEFAULT_PROPOSAL_CREDIT_MINUTES = 3;

/** Minutes credited per voice call the agent handled end to end. */
export const CALL_HANDLED_CREDIT_MINUTES = 8;

/** Resolve the credit for a proposal type, applying the default fallback. */
export function creditForProposalType(type: ProposalType): number {
  const explicit = PROPOSAL_TIME_CREDITS[type];
  return explicit !== undefined ? explicit : DEFAULT_PROPOSAL_CREDIT_MINUTES;
}
