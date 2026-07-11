import { Proposal, ProposalType } from './proposal';
import { TIER_KEYS, type TierKey } from '../ai/skills/triage-rules.schema';

export interface PrioritizedProposal {
  proposal: Proposal;
  urgency: 'critical' | 'high' | 'normal' | 'low';
  reason?: string;
}

/**
 * Read the §6.4-B emergency severity tier a draft carries, if any. The MMS
 * vision task (and voice triage) persist it at `payload._meta.severity` as
 * an optional {@link TierKey}; `payload` is an untyped bag, so read it
 * defensively and ignore anything that isn't a known tier.
 */
function severityTier(proposal: Proposal): TierKey | undefined {
  const meta = (proposal.payload as { _meta?: { severity?: unknown } })._meta;
  const severity = meta?.severity;
  return typeof severity === 'string' &&
    (TIER_KEYS as readonly string[]).includes(severity)
    ? (severity as TierKey)
    : undefined;
}

const TYPE_PRIORITY: Record<ProposalType, number> = {
  draft_estimate: 0,
  draft_invoice: 1,
  update_invoice: 1,
  issue_invoice: 1,
  // Setting up a milestone billing plan is invoicing work — same tier.
  create_invoice_schedule: 1,
  // Morning batch-invoice nudge — invoicing work, surfaces alongside the rest.
  batch_invoice: 1,
  update_estimate: 1,
  create_appointment: 2,
  create_booking: 2,
  // After-hours callback requests surface alongside booking work.
  callback: 2,
  create_job: 3,
  create_customer: 4,
  update_customer: 5,
  reassign_appointment: 1,
  reschedule_appointment: 1,
  // Crew add/remove are dispatch-day work — same tier as reassignment.
  add_crew_member: 1,
  remove_crew_member: 1,
  cancel_appointment: 1,
  // Clarification cards surface ahead of everything else — they are
  // prompts for the operator, not queued work; stale clarifications
  // are useless, so we want them top of feed while fresh.
  voice_clarification: 0,
  // Money-moving / comms proposals surface high — they require
  // screen-tap and usually have same-day relevance.
  record_payment: 1,
  send_invoice: 1,
  send_estimate: 1,
  // RV-086 — estimate nudges are owner-approved comms, same tier as
  // send_estimate (same-day relevance, screen-tap required).
  send_estimate_nudge: 1,
  // Notes are low priority — they never gate other work.
  add_note: 5,
  // Expense logging is informational — captured after the fact, never
  // gates any other work.
  log_expense: 5,
  // Converting a lead is CRM follow-up work — same tier as create_customer.
  convert_lead: 4,
  // Appointment confirmation + delay notices are dispatch-day, customer-
  // facing work — surface high alongside scheduling changes.
  confirm_appointment: 1,
  notify_delay: 1,
  // Lead loss, service-location adds, time entries, and feedback requests
  // are CRM/back-office follow-up — same low tier as notes.
  mark_lead_lost: 4,
  add_service_location: 5,
  log_time_entry: 5,
  request_feedback: 5,
  emergency_dispatch: 1,
  onboarding_tenant_settings: 6,
  onboarding_service_category: 7,
  onboarding_estimate_template: 8,
  onboarding_team_member: 9,
  onboarding_schedule: 10,
  // P7-026 PR c — review responses are owner-approved comms. Same
  // tier as send_invoice / record_payment — high priority but not
  // critical, since they typically have ~24h relevance windows
  // (longer than appointment-related work).
  review_response_proposal: 1,
  // Collections work surfaces high — overdue reminders and late fees are
  // time-sensitive, customer-facing money/comms that require screen-tap.
  // Same tier as record_payment / send_invoice.
  send_payment_reminder: 1,
  apply_late_fee: 1,
  // UB-A2 — standing instructions are back-office policy capture; they gate
  // no same-day work. Same low tier as notes.
  create_standing_instruction: 5,
  // WS20 — correction-repetition catalog update is back-office config capture;
  // it gates no same-day work. Same low tier as notes / standing instructions.
  update_catalog_item: 5,
};

export function getUrgency(proposal: Proposal): { urgency: PrioritizedProposal['urgency']; reason: string } {
  if (proposal.expiresAt) {
    const now = new Date();
    const twoHoursMs = 2 * 60 * 60 * 1000;
    const timeUntilExpiry = proposal.expiresAt.getTime() - now.getTime();
    if (timeUntilExpiry <= twoHoursMs) {
      return { urgency: 'critical', reason: 'Expiring within 2 hours' };
    }
  }

  // §6.4-B — a photo/voice-sourced emergency must surface at the top of the
  // queue even at normal confidence. getUrgency is the inbox's only ordering
  // signal, so without this an emergency draft (e.g. a burst-pipe photo quote)
  // would sit at 'low' behind routine work. TIER_1 (evacuate / life-safety) is
  // critical; TIER_2 (emergency dispatch) is high. TIER_3/4 (same-day/routine)
  // do not elevate — they fall through to the confidence/status rules below.
  const severity = severityTier(proposal);
  if (severity === 'TIER_1_EVACUATE') {
    return { urgency: 'critical', reason: 'Emergency severity — evacuate' };
  }
  if (severity === 'TIER_2_EMERGENCY_DISPATCH') {
    return { urgency: 'high', reason: 'Emergency severity — dispatch' };
  }

  if (proposal.confidenceScore !== undefined && proposal.confidenceScore < 0.5) {
    return { urgency: 'high', reason: 'Low confidence score' };
  }

  if (proposal.status === 'ready_for_review') {
    return { urgency: 'normal', reason: 'Awaiting review' };
  }

  return { urgency: 'low', reason: 'Standard priority' };
}

const URGENCY_ORDER: Record<PrioritizedProposal['urgency'], number> = {
  critical: 0,
  high: 1,
  normal: 2,
  low: 3,
};

export function prioritizeProposals(proposals: Proposal[]): PrioritizedProposal[] {
  const prioritized: PrioritizedProposal[] = proposals.map((proposal) => {
    const { urgency, reason } = getUrgency(proposal);
    return { proposal, urgency, reason };
  });

  prioritized.sort((a, b) => {
    const urgencyDiff = URGENCY_ORDER[a.urgency] - URGENCY_ORDER[b.urgency];
    if (urgencyDiff !== 0) return urgencyDiff;

    // Within same urgency, oldest first (by createdAt)
    const ageDiff = a.proposal.createdAt.getTime() - b.proposal.createdAt.getTime();
    if (ageDiff !== 0) return ageDiff;

    // Tie-break by type priority
    const typePriorityA = TYPE_PRIORITY[a.proposal.proposalType] ?? 99;
    const typePriorityB = TYPE_PRIORITY[b.proposal.proposalType] ?? 99;
    return typePriorityA - typePriorityB;
  });

  return prioritized;
}
