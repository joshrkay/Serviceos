/**
 * Voice intent → proposal type: THE map, plus the summary line that rides
 * with it.
 *
 * There used to be three copies of this mapping, and they had already drifted
 * in BOTH directions with no test catching it:
 *
 *   - `workers/voice-action-router.ts INTENT_TO_PROPOSAL_TYPE` — 35 intents,
 *     exported, consumed by `app.ts` (the speakable-action catalog) and
 *     `proposals/redraft-handler-factory.ts`. The most complete.
 *   - `ai/agents/customer-calling/inapp-adapter.ts intentToProposalType` —
 *     25 cases. Missing the whole taxonomy-1.2.0 wave, the crew ops, the
 *     collections ops and `update_job`.
 *   - `ai/voice-turn/create-voice-turn-processor.ts intentToProposalType` —
 *     17 cases, private. Missing everything in-app had beyond the core, plus
 *     the same 9 the router alone carried.
 *
 * The drift was invisible because the DEFAULT is `voice_clarification`: an
 * intent that falls out of the map does not error, it silently becomes a
 * clarification card. So a copy losing (or never gaining) a case degrades a
 * real request into "a human should look at this" with no signal anywhere.
 *
 * This module is the single source of truth; `INTENT_TO_PROPOSAL_TYPE` is
 * re-exported from `workers/voice-action-router.ts` so its existing consumers
 * are unchanged. `test/proposals/voice-intent-map.contract.test.ts` pins that
 * exactly one map exists.
 *
 * ── Why unifying does not widen the inbound-caller surface ─────────────────
 * Unifying makes previously-unmapped intents produce their REAL proposal type
 * on the phone path instead of falling through to `voice_clarification`. That
 * is safe here, and provably so, because the S1 allowlist
 * (`proposals/surface.ts`) is applied to the mapped type BEFORE the payload is
 * built (`create-voice-turn-processor.ts handleCreateProposal`): a type that is
 * not S1-allowed is coerced to `voice_clarification` anyway. Every intent this
 * unification newly maps on the caller path resolves to a NON-allowlisted type,
 * so the caller-reachable proposal set is byte-identical — what changes is that
 * the block is now recorded honestly as `voice.surface_violation_blocked` with
 * the real `requestedProposalType`, instead of masquerading as a contract
 * failure on a `voice_clarification` nobody asked for.
 *
 * The allowlist — not this map — is therefore the security boundary. Adding an
 * intent here can never make a proposal type reachable from an unauthenticated
 * transcript; only editing `S1_ALLOWED_PROPOSAL_TYPES` can do that.
 */
import type { IntentType } from '../ai/orchestration/intent-classifier';
import type { ProposalType } from './proposal';

/**
 * P11-001: lookup_* intents are READ-ONLY and never produce a proposal — the
 * Twilio adapter routes them to the lookup-skill family directly. They are
 * omitted from this map on purpose; every consumer falls back to
 * `voice_clarification` for any IntentType not present here.
 *
 * B5.5 / Part F decision F-3: `en_route` ("on my way") is ALSO deliberately
 * omitted, for a different reason than lookup_* — it isn't read-only, it's a
 * DIRECT status act. Voice/SMS "on my way" invokes the exact same audited
 * act the shipped app en-route button already executes (dispatch/routes.ts
 * `triggerEnRoute` → `appointment.en_route_triggered` audit + branded ETA
 * SMS) rather than drafting an AI proposal for a human to approve — the
 * technician IS the human acting, the precedent PRD B10.10 already blesses.
 * See workers/voice-action-router.ts (the `en_route` branch, handled before
 * the proposalType lookup below) and dispatch/en-route-voice.ts. Registered
 * here, next to lookup_*, so the drift test
 * (test/ai/voice-action-catalog.contract.test.ts) and a human reader both
 * see this as an intentional exclusion, not a gap.
 */
export const INTENT_TO_PROPOSAL_TYPE: Partial<Record<Exclude<IntentType, 'unknown'>, ProposalType>> = {
  create_invoice: 'draft_invoice',
  draft_estimate: 'draft_estimate',
  create_appointment: 'create_appointment',
  update_invoice: 'update_invoice',
  update_estimate: 'update_estimate',
  issue_invoice: 'issue_invoice',
  batch_invoice: 'batch_invoice',
  create_customer: 'create_customer',
  create_job: 'create_job',
  update_job: 'update_job',
  reschedule_appointment: 'reschedule_appointment',
  cancel_appointment: 'cancel_appointment',
  reassign_appointment: 'reassign_appointment',
  add_crew_member: 'add_crew_member',
  remove_crew_member: 'remove_crew_member',
  add_note: 'add_note',
  send_invoice: 'send_invoice',
  send_estimate: 'send_estimate',
  send_estimate_nudge: 'send_estimate_nudge',
  send_payment_reminder: 'send_payment_reminder',
  apply_late_fee: 'apply_late_fee',
  record_payment: 'record_payment',
  emergency_dispatch: 'emergency_dispatch',
  update_customer: 'update_customer',
  log_expense: 'log_expense',
  convert_lead: 'convert_lead',
  confirm_appointment: 'confirm_appointment',
  mark_lead_lost: 'mark_lead_lost',
  add_service_location: 'add_service_location',
  log_time_entry: 'log_time_entry',
  notify_delay: 'notify_delay',
  request_feedback: 'request_feedback',
  // Taxonomy 1.2.0 (agent wave, Track A) — the on-ramp trio. Each rides an
  // existing (U2/U3) or new-in-this-train (UB-A2) proposal type + execution
  // handler; the catalog contract test pins all three legs.
  create_invoice_schedule: 'create_invoice_schedule',
  respond_to_review: 'review_response_proposal',
  create_standing_instruction: 'create_standing_instruction',
  // B1.18 — brand voice captured by voice. `manual` action class (never
  // auto-approves at any trust tier — proposals/proposal.ts). Lock stays
  // tap-only: the payload has no field capable of expressing
  // `brand_voice_locked` (see contracts/brand-voice.ts).
  update_brand_voice: 'update_brand_voice',
  // Tradesperson wave 1 — alias intents onto existing proposal types.
  // Drafting + execution handlers are keyed by PROPOSAL type, so these
  // inherit the create_appointment / add_note / create_job legs unchanged.
  schedule_inspection: 'create_appointment',
  log_permit: 'add_note',
  log_warranty_claim: 'create_job',
  // Tradesperson wave 1, Task 2 — WS20 type + handler pre-exist; this adds
  // the voice on-ramp. NOT S1-allowed (operator-only): see
  // proposals/surface.ts S1_ALLOWED_PROPOSAL_TYPES and its contract test.
  update_catalog_item: 'update_catalog_item',
};

/**
 * Function form for the two voice adapters, which hold a raw classifier
 * string rather than a narrowed `IntentType`.
 *
 * The `voice_clarification` DEFAULT is load-bearing and slightly dangerous:
 * `voice_clarification` is S1-allowed, so an unmapped intent does not fail
 * closed at the surface gate — it becomes a clarification card. That card has
 * NO execution handler, so its payload must satisfy
 * `voiceClarificationPayloadSchema` (`transcript` + `reason`); a caller that
 * lands here must build a real clarification payload rather than persisting
 * the raw `{intent, entities}` envelope. See
 * `create-voice-turn-processor.ts buildContractFailureClarification`.
 */
export function intentToProposalType(intent: string | undefined): ProposalType {
  if (!intent) return 'voice_clarification';
  return (
    INTENT_TO_PROPOSAL_TYPE[intent as Exclude<IntentType, 'unknown'>] ?? 'voice_clarification'
  );
}

/**
 * The human-readable one-liner stamped on a voice proposal's `summary`.
 *
 * Not cosmetic. `Proposal.summary` is non-optional and `buildProposal` rejects
 * an empty one, which makes it the always-present terminator that
 * `CreateAppointmentExecutionHandler` (`proposals/execution/handlers.ts`) uses
 * to NAME an auto-opened job when the classifier emitted no `jobTitle`. The
 * real phone path used to pass a bare `` `Voice intent: ${intent}` `` there,
 * so a caller who booked over the phone got a job literally named
 * "Voice intent: create_appointment" in the operator's list. This template —
 * the in-app one, which was always the better implementation — is now shared
 * by both surfaces, so that job is named "Schedule appointment for Jane Smith".
 */
export function voiceProposalSummary(
  intent: string | undefined,
  entities: Record<string, unknown> | undefined,
): string {
  const name = entities && typeof entities.customerName === 'string' ? entities.customerName : undefined;
  const ref = entities && typeof entities.jobReference === 'string' ? entities.jobReference : undefined;
  if (intent === 'create_invoice') return `Draft invoice${name ? ` for ${name}` : ''}`;
  if (intent === 'draft_estimate') return `Draft estimate${name ? ` for ${name}` : ''}`;
  if (intent === 'create_appointment') return `Schedule appointment${name ? ` for ${name}` : ''}`;
  if (intent === 'emergency_dispatch') return 'Emergency dispatch — escalate to on-call';
  if (intent === 'update_brand_voice') return 'Update brand voice';
  if (intent) return `Voice intent: ${intent}${ref ? ` (${ref})` : ''}`;
  return 'Voice clarification needed';
}
