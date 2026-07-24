import { v4 as uuidv4 } from 'uuid';
import { ConflictError } from '../shared/errors';
import {
  confidenceMetaBlocksAutoApprove,
  resolveAutoApproveThreshold,
  shouldAutoApprove,
  type Mode,
  type ResolveThresholdInput,
} from './auto-approve';
import { payloadHeadlineCents } from './payload-money';
import { getSupervisorCreationHook } from './supervisor/hook';
import { payloadWithSupervisorMarker } from './supervisor/marker';
import { capInitialStatus, type InitialProposalStatus } from './supervisor/policy';

export type ProposalStatus =
  | 'draft'
  | 'ready_for_review'
  | 'approved'
  | 'executing'
  | 'rejected'
  | 'expired'
  | 'executed'
  | 'execution_failed'
  // Undone: the operator pressed "undo" during the 5-second window
  // after approval. Terminal — an undone proposal cannot be reapproved
  // or re-executed. If the operator wants to proceed after undoing,
  // they draft a new proposal. Decision 9 ("5-second undo window").
  | 'undone';
export type ProposalType = 'create_customer' | 'update_customer' | 'create_job' | 'update_job' | 'create_appointment' | 'create_booking' | 'callback' | 'draft_estimate' | 'update_estimate' | 'draft_invoice' | 'update_invoice' | 'issue_invoice' | 'create_invoice_schedule' | 'batch_invoice' | 'reassign_appointment' | 'reschedule_appointment' | 'add_crew_member' | 'remove_crew_member' | 'cancel_appointment' | 'voice_clarification' | 'add_note' | 'send_invoice' | 'send_estimate' | 'send_estimate_nudge' | 'record_payment' | 'log_expense' | 'convert_lead' | 'confirm_appointment' | 'mark_lead_lost' | 'add_service_location' | 'log_time_entry' | 'notify_delay' | 'request_feedback' | 'emergency_dispatch' | 'onboarding_tenant_settings' | 'onboarding_service_category' | 'onboarding_estimate_template' | 'onboarding_team_member' | 'onboarding_schedule' | 'review_response_proposal' | 'send_payment_reminder' | 'apply_late_fee' | 'create_standing_instruction' | 'update_catalog_item' | 'adopt_entity_alias';

export const VALID_PROPOSAL_TYPES: ProposalType[] = [
  'create_customer',
  'update_customer',
  'create_job',
  'update_job',
  'create_appointment',
  'create_booking',
  'callback',
  'draft_estimate',
  'update_estimate',
  'draft_invoice',
  'update_invoice',
  'issue_invoice',
  'create_invoice_schedule',
  'batch_invoice',
  'reassign_appointment',
  'reschedule_appointment',
  'add_crew_member',
  'remove_crew_member',
  'cancel_appointment',
  'voice_clarification',
  'add_note',
  'send_invoice',
  'send_estimate',
  'send_estimate_nudge',
  'record_payment',
  'log_expense',
  'convert_lead',
  'confirm_appointment',
  'mark_lead_lost',
  'add_service_location',
  'log_time_entry',
  'notify_delay',
  'request_feedback',
  'emergency_dispatch',
  'onboarding_tenant_settings',
  'onboarding_service_category',
  'onboarding_estimate_template',
  'onboarding_team_member',
  'onboarding_schedule',
  'review_response_proposal',
  'send_payment_reminder',
  'apply_late_fee',
  'create_standing_instruction',
  'update_catalog_item',
  'adopt_entity_alias',
];

/**
 * §5.5 Schedule proposal cards expire after 48 hours. These are the proposal
 * types that put a specific time on the calendar (the booking/reschedule cards
 * a contractor reviews) — if not acted on they go stale: the slot may pass or
 * be taken, so a silently-lingering one could be approved into a conflict.
 * Every OTHER proposal type persists indefinitely (its `expiresAt` is left
 * unset). This list is the single source of truth for the expiry policy.
 *
 * Note: the product also speaks of "message schedule" proposals, but the live
 * stack has no distinct scheduled-message proposal type — outbound messages
 * (send_estimate/send_invoice/etc.) are comms proposals that intentionally
 * persist until an operator acts. If a scheduled-message type is added later,
 * add it here.
 */
export const SCHEDULE_PROPOSAL_TYPES: readonly ProposalType[] = [
  'create_appointment',
  'create_booking',
  'reschedule_appointment',
];

/** §5.5 — 48 hours, in milliseconds. */
export const SCHEDULE_PROPOSAL_EXPIRY_MS = 48 * 60 * 60 * 1000;

export function isScheduleProposalType(type: ProposalType): boolean {
  return SCHEDULE_PROPOSAL_TYPES.includes(type);
}

/**
 * §5.5 Default expiry for a newly created proposal: schedule proposals get a
 * 48-hour TTL from `now`; everything else persists (returns undefined). An
 * explicit `expiresAt` supplied by the caller always takes precedence.
 */
export function defaultProposalExpiry(type: ProposalType, now: Date): Date | undefined {
  return isScheduleProposalType(type)
    ? new Date(now.getTime() + SCHEDULE_PROPOSAL_EXPIRY_MS)
    : undefined;
}

export interface Proposal {
  id: string;
  tenantId: string;
  proposalType: ProposalType;
  status: ProposalStatus;
  payload: Record<string, unknown>;
  summary: string;
  explanation?: string;
  confidenceScore?: number;
  confidenceFactors?: string[];
  sourceContext?: Record<string, unknown>;
  aiRunId?: string;
  promptVersionId?: string;
  targetEntityType?: string;
  targetEntityId?: string;
  resultEntityId?: string;
  rejectionReason?: string;
  rejectionDetails?: string;
  idempotencyKey?: string;
  expiresAt?: Date;
  /**
   * When the proposal transitioned into 'approved' (either via
   * operator approval or via auto-approval by the trust-tier wiring).
   * Used by the 5-second undo window — a proposal cannot be executed
   * while `Date.now() - approvedAt < UNDO_WINDOW_MS`, and
   * `undoProposal` only succeeds inside that window.
   *
   * Undefined on historical proposals (pre-undo-window slice) — the
   * executor treats missing `approvedAt` as "no window" and runs
   * immediately, preserving backward compatibility.
   */
  approvedAt?: Date;
  executedAt?: Date;
  executedBy?: string;
  /** QA-2026-06-05: why execution failed — persisted so failed proposals are debuggable. */
  executionError?: string;
  claimedBy?: string;
  claimedAt?: Date;
  executionRetryCount?: number;
  /**
   * Stamped when a proposal transitions to 'undone'. Distinct from
   * rejection: rejection means "never execute"; undo means "we
   * approved, then changed our mind within 5s".
   */
  undoneAt?: Date;
  undoneBy?: string;
  /**
   * Multi-action chaining. Shared by every proposal decomposed from the
   * same voice utterance. Denormalized into its own indexed column (in
   * addition to `sourceContext.chainId`) so the execution-time chain
   * resolver can look up siblings without scanning JSONB. Undefined for
   * single-action proposals — they behave exactly as before.
   */
  chainId?: string;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateProposalInput {
  tenantId: string;
  proposalType: ProposalType;
  payload: Record<string, unknown>;
  summary: string;
  explanation?: string;
  confidenceScore?: number;
  confidenceFactors?: string[];
  sourceContext?: Record<string, unknown>;
  aiRunId?: string;
  promptVersionId?: string;
  targetEntityType?: string;
  targetEntityId?: string;
  idempotencyKey?: string;
  expiresAt?: Date;
  /**
   * Multi-action chaining — links this proposal to its sibling
   * proposals decomposed from the same utterance. Optional: omitting it
   * yields a standalone (single-action) proposal exactly as before.
   */
  chainId?: string;
  createdBy: string;
  /**
   * Trust tier of the agent that produced this proposal. When set,
   * createProposal consults `decideInitialStatus` to determine whether
   * the proposal can be created in 'approved' status (skipping the
   * human review gate). When omitted, the proposal lands in 'draft'
   * exactly as before — preserves backward compatibility for callers
   * that do not yet pass agent-source signals.
   *
   * Decision 3 (per-action-class trust) wiring lives in
   * `decideInitialStatus` below.
   */
  sourceTrustTier?: TrustTier;
  /**
   * Required fields the task handler could not fill from the input.
   * When non-empty, the proposal is forced to 'draft' regardless of
   * trust tier / confidence — the review UI prompts the operator to
   * fill each gap before approval is allowed. Stored on the persisted
   * proposal under `sourceContext.missingFields` so existing tables
   * don't need a schema migration; helper `missingFieldsFor` reads it
   * back with the correct type.
   */
  missingFields?: string[];
  /**
   * Phase 12 supervisor-gating signals, forwarded verbatim to
   * `decideInitialStatus`. These were previously declared on the AI
   * task inputs but DROPPED here — `createProposal` never forwarded
   * them — so the unsupervised hard-block and the per-tenant threshold
   * override never engaged on the agent/voice path. They are now
   * threaded through. Omitting them preserves the pre-Phase-12 default
   * (supervisor assumed present, legacy 0.9 threshold) for callers that
   * don't supply agent-source signals.
   */
  supervisorMode?: Mode;
  supervisorPresent?: boolean;
  tenantThresholdOverride?: ResolveThresholdInput['tenantOverride'];
  /**
   * UB-D / D-015 — autonomous booking lane result, set ONLY by the
   * inbound-receptionist booking call sites after
   * `evaluateAutonomousBookingLane` (proposals/autonomous-lane.ts) passed
   * every gate. See `decideInitialStatus.autonomousLane`.
   */
  autonomousLane?: { eligible: true; threshold: number };
}

/**
 * Extract the list of missing required fields from a proposal. These
 * are stored under `sourceContext.missingFields` (see CreateProposalInput)
 * so no DB migration is required; this helper is the typed accessor.
 */
export function missingFieldsFor(proposal: Proposal): string[] {
  const ctx = proposal.sourceContext;
  if (!ctx) return [];
  const mf = (ctx as Record<string, unknown>).missingFields;
  if (!Array.isArray(mf)) return [];
  return mf.filter((s): s is string => typeof s === 'string');
}

// ─── Decision 3: action class + trust tier ───────────────────────────────
//
// Decision 3 from the 2026-04-14 Idea Crystallization doc says trust is
// per action class:
//
//   capture/record   → autonomous from day one
//   customer comms   → graduates fast
//   money-moving     → graduates slowly
//   irreversible     → always asks
//
// The data lives on the Python `Agent` primitive
// (service-os-agent/agent/primitive.py); the runtime wiring lives here.
// `decideInitialStatus` is the SINGLE place where (action class, trust
// tier, confidence) maps to an initial proposal status.

export type ActionClass = 'capture' | 'comms' | 'money' | 'irreversible' | 'manual';
export type TrustTier =
  | 'autonomous'
  | 'graduates_fast'
  | 'graduates_slowly'
  | 'always_asks';

/**
 * Map every ProposalType to an action class. The exhaustive switch is
 * the forcing function: adding a new ProposalType without classifying
 * it produces a compile error, so D3 cannot silently regress.
 */
export function actionClassForProposalType(type: ProposalType): ActionClass {
  switch (type) {
    case 'create_customer':
    case 'update_customer':
    case 'create_job':
    // B7 — update_job is a bounded, safe field edit (status/priority/
    // title/description) to an EXISTING job — no money, no schedule (those
    // have their own proposal paths). Mirrors update_estimate/
    // update_invoice's capture classification: an AI-drafted edit to an
    // existing entity, always human-approved before execution.
    case 'update_job':
    case 'create_appointment':
    case 'create_booking':
    // A callback request is a low-risk capture: it asks an operator to
    // call the caller back (e.g. an after-hours booking). It carries no
    // money and mutates nothing until the operator acts.
    case 'callback':
    case 'draft_estimate':
    case 'update_estimate':
    case 'draft_invoice':
    case 'update_invoice':
    // create_invoice_schedule sets up a milestone plan + drafts the first
    // milestone invoice — no money moves and sending is a later step, so it
    // is capture-class (stays in 'draft' until the owner approves).
    case 'create_invoice_schedule':
    // batch_invoice fans out N draft_invoice proposals on approval — it mints
    // drafts, moves no money, and sends nothing, so it is capture-class too.
    case 'batch_invoice':
    case 'reassign_appointment':
    case 'reschedule_appointment':
    // Crew add/remove are dispatcher-initiated capture actions: they
    // attach/detach a non-primary technician on an appointment. They
    // mutate an assignment row, not money or customer comms.
    case 'add_crew_member':
    case 'remove_crew_member':
    case 'add_note':
    case 'onboarding_tenant_settings':
    case 'onboarding_service_category':
    case 'onboarding_estimate_template':
    case 'onboarding_team_member':
    case 'onboarding_schedule':
    case 'log_expense':
    // Converting a lead to a customer is a low-risk capture: it promotes
    // an existing CRM record. It moves no money and is reversible (the
    // customer can be re-archived), so it stays capture-class.
    case 'convert_lead':
    // Confirming an appointment, marking a lead lost, adding a service
    // location, and clocking in time are all low-risk capture actions:
    // they record an operator-stated fact, move no money, and are
    // reversible.
    case 'confirm_appointment':
    case 'mark_lead_lost':
    case 'add_service_location':
    case 'log_time_entry':
    // UB-A2 — capturing a standing instruction WRITES a directive row, moves
    // no money and contacts no customer; the instruction only ever shapes
    // future DRAFTS (which are themselves reviewed). Capture-class, but the
    // voice task handler deliberately omits sourceTrustTier, so the
    // instruction itself always lands for human review in v1.
    case 'create_standing_instruction':
    // WS20 — updating a catalog item's unit price is a config change: it moves
    // no money (only shapes FUTURE drafts, which are themselves reviewed),
    // contacts no customer, and is reversible (edit the price back). Capture-
    // class, but the correction loop creates it with no trust tier, so it
    // always lands for human review — never auto-executed (D-004).
    case 'update_catalog_item':
      return 'capture';
    // Delay notices and feedback requests are outbound customer-facing
    // messages — comms-class so they never auto-approve regardless of
    // trust tier. An operator always screen-taps before a customer is
    // contacted.
    case 'notify_delay':
    case 'request_feedback':
      return 'comms';
    case 'issue_invoice':
      return 'money';
    // voice_clarification is not a mutation — it is a user-visible
    // prompt emitted when the classifier can't confidently route a
    // transcript. It never auto-approves and has no execution handler;
    // it closes when the operator dismisses it or speaks again. It is
    // bucketed as 'capture' so the D3 rules leave it in 'draft' (no
    // sourceTrustTier is passed when it is created, so the capture
    // bucket is effectively a formality).
    case 'voice_clarification':
      return 'capture';
    // Cancellation is irreversible and must never auto-approve — the
    // operator always screen-taps. Per CLAUDE.md "Never auto-execute".
    case 'cancel_appointment':
      return 'irreversible';
    // Emergency dispatch escalates a live call to on-call personnel —
    // irreversible in the sense that the notification fires immediately.
    case 'emergency_dispatch':
      return 'irreversible';
    // Outbound communications: even with autonomous trust, we do not
    // let the system send a customer-facing message without an
    // explicit approval. A mis-sent invoice is a real reputation
    // cost.
    case 'send_invoice':
    // Sending an estimate is an outbound customer-facing message too —
    // same 'comms' gate as send_invoice. Never auto-approves regardless
    // of trust tier; an operator (or supervisor) must approve the send.
    case 'send_estimate':
    // RV-086: a nudge re-sends the estimate link to the customer — an
    // outbound customer-facing message, so it carries the same 'comms'
    // gate: never auto-approves regardless of trust tier.
    case 'send_estimate_nudge':
      return 'comms';
    // Review responses: public + private + service-credit are always
    // owner-approved (per-component). The auto-approve path is
    // hard-blocked because the 'comms' class never auto-approves
    // regardless of trust tier — see decideInitialStatus().
    case 'review_response_proposal':
      return 'comms';
    // Money: per D3, money-class proposals never auto-approve
    // regardless of confidence / trust tier. The MCP money_server
    // provides a second gate at the tool layer.
    case 'record_payment':
      return 'money';
    // A dunning payment reminder is an outbound customer-facing message
    // (the overdue-invoice sweep raises one per due cadence step). Comms-
    // class so it never auto-approves regardless of trust tier — the owner
    // approves before the customer is contacted, exactly like the other
    // outbound sends above.
    case 'send_payment_reminder':
      return 'comms';
    // Applying a late fee appends a charge to an issued invoice — it moves
    // money (raises amount due), so it is money-class and never auto-applies
    // regardless of confidence / trust tier. The owner approves deliberately
    // before any fee is charged.
    case 'apply_late_fee':
      return 'money';
    // Tenant learning changes future resolver behavior. It is reversible, but
    // never eligible for trust-tier graduation or one-tap capture batching:
    // only an explicit owner approval may activate it.
    case 'adopt_entity_alias':
      return 'manual';
  }
}

/**
 * Decide the initial proposal status from (action class, trust tier,
 * confidence). Pure function — no side effects, no I/O.
 *
 * Rules (D3):
 *  - No source trust tier  → 'draft' (existing behavior).
 *  - autonomous + capture-class + confidence ≥ 0.9 → 'approved'.
 *  - graduates_fast / graduates_slowly → 'draft' (gated until the
 *    trust ledger lands; data still attached so the ledger can be
 *    retroactively built from approval history).
 *  - always_asks → 'draft' (always gated, even with maximum trust).
 *  - Money-moving and irreversible classes never auto-approve
 *    regardless of trust tier. The MCP money_server provides a
 *    second gate at the tool layer for money-moving actions.
 */
export function decideInitialStatus(input: {
  proposalType: ProposalType;
  sourceTrustTier?: TrustTier;
  confidenceScore?: number;
  missingFields?: string[];
  /**
   * Phase 12: the supervisor's current_mode at the time the proposal
   * was generated. Read from `voice_sessions.supervisor_mode_at_start`
   * by the caller (the proposal-creation site in the AI gateway).
   *
   * When supplied, the auto-approve threshold becomes mode-aware
   * (0.90 supervisor / 0.92 both / 0.95 tech by default). Optional —
   * legacy callers that don't thread mode keep the pre-Phase-12 0.9.
   */
  supervisorMode?: Mode;
  /**
   * Phase 12: tenant-wide supervisor presence — false means the
   * tenant is "unsupervised" (no user in supervisor or both mode).
   * When false, auto-approval is hard-blocked regardless of
   * confidence and the proposal lands in 'ready_for_review' so it
   * surfaces in the queue + the unsupervised-routing worker can
   * notify the owner per `tenant_settings.unsupervised_proposal_routing`.
   *
   * Optional, defaults to `true` so legacy callers preserve behavior.
   */
  supervisorPresent?: boolean;
  /**
   * Phase 12: per-tenant override map for the auto-approve threshold,
   * read from `tenant_settings.auto_approve_threshold` (a JSONB column
   * keyed by mode). Pass-through to `resolveAutoApproveThreshold`.
   */
  tenantThresholdOverride?: ResolveThresholdInput['tenantOverride'];
  /**
   * RV-007: the proposal payload, inspected for the optional
   * `_meta.overallConfidence` confidence marker. A 'low' / 'very_low'
   * level hard-blocks auto-approval regardless of the numeric
   * confidence score. Optional — payloads without `_meta` (and callers
   * that don't thread the payload) keep pre-RV-007 behavior exactly.
   */
  payload?: unknown;
  /**
   * UB-D / D-015 — autonomous booking lane. Set ONLY by the
   * inbound-receptionist booking call sites after
   * `evaluateAutonomousBookingLane` passed every gate (tenant opt-in,
   * booking capture types only, clean resolution, live held slot in
   * business hours, no session flags). When present-and-eligible AND the
   * tenant is unsupervised (threshold resolution returned null), the lane's
   * dedicated (stricter) threshold is used instead of categorically
   * blocking. Absent input ⇒ behavior byte-identical to pre-lane code for
   * every proposal type × trust tier × supervisorPresent combination
   * (pinned by test). Money/comms/irreversible classes never reach this
   * branch (it lives inside the `autonomous + capture` arm).
   */
  autonomousLane?: { eligible: true; threshold: number };
}): ProposalStatus {
  // Missing required fields always land in 'draft' — a partial payload
  // can't be auto-approved even by an autonomous agent with high
  // confidence. The operator must fill the gaps at review time.
  if (input.missingFields && input.missingFields.length > 0) return 'draft';

  if (!input.sourceTrustTier) return 'draft';

  const cls = actionClassForProposalType(input.proposalType);

  // Auto-approve is only ever a possibility for `sourceTrustTier === 'autonomous'`
  // and capture-class. Money / comms / irreversible classes never auto-approve
  // regardless of trust tier or mode (see `actionClassForProposalType` doc).
  if (input.sourceTrustTier === 'autonomous' && cls === 'capture') {
    // RV-007 — Confidence Marker hard-block. When the AI handler stamped
    // `payload._meta.overallConfidence` as 'low' / 'very_low', the
    // proposal can never auto-approve, whatever the numeric score says.
    // Checked before threshold resolution so the unsupervised
    // 'ready_for_review' branch (semantics: "would have auto-approved if
    // a supervisor were present") is also skipped — a low-confidence
    // proposal would NOT have auto-approved, so it lands in 'draft' for
    // a full human review rather than a one-tap SMS approve. Absent or
    // malformed `_meta` never blocks (pre-RV-007 behavior preserved).
    if (confidenceMetaBlocksAutoApprove(input.payload)) {
      return 'draft';
    }

    // Phase 12 — resolve the mode-aware threshold. `null` means the
    // tenant is unsupervised and auto-approval is categorically blocked.
    const threshold = resolveAutoApproveThreshold({
      supervisorMode: input.supervisorMode,
      supervisorPresent: input.supervisorPresent,
      tenantOverride: input.tenantThresholdOverride,
    });

    if (threshold === null) {
      // UB-D / D-015 — the autonomous booking lane is the single, scoped
      // exception to the unsupervised block: booking capture proposals
      // from the inbound receptionist, tenant opted in, every lane gate
      // passed (evaluated by the call site), judged against the lane's
      // dedicated stricter threshold. Anything below it falls through to
      // the normal unsupervised routing.
      if (
        input.autonomousLane?.eligible &&
        shouldAutoApprove(input.confidenceScore, input.autonomousLane.threshold)
      ) {
        return 'approved';
      }
      // Unsupervised. The proposal would have auto-approved if a
      // supervisor were present — surface it in the queue (rather than
      // 'draft') so the unsupervised-routing path picks it up. The
      // routing worker reads `status='ready_for_review'` rows and
      // applies tenant_settings.unsupervised_proposal_routing.
      return 'ready_for_review';
    }

    if (shouldAutoApprove(input.confidenceScore, threshold)) {
      return 'approved';
    }
  }

  return 'draft';
}

export interface ProposalRepository {
  create(proposal: Proposal): Promise<Proposal>;
  /**
   * Persist several proposals atomically (single transaction). Used by
   * the voice chain builder so a partial failure mid-chain never leaves
   * orphaned members in the DB — either every member of the chain is
   * written or none is. All proposals MUST share the same tenantId.
   */
  createMany(proposals: Proposal[]): Promise<Proposal[]>;
  findById(tenantId: string, id: string): Promise<Proposal | null>;
  findByTenant(tenantId: string): Promise<Proposal[]>;
  findByStatus(tenantId: string, status: ProposalStatus): Promise<Proposal[]>;
  /**
   * Scale-to-1000 (P3): proposals of `status` created on/after `since`, newest
   * first, optionally capped at `limit`. Bounds a recurring sweep's working set
   * in the DB (WHERE created_at >= $3 + the (tenant_id, status, created_at)
   * index) instead of loading every row of that status and filtering by time in
   * memory — the supervisor-review sweep's hot path. Optional so legacy fakes
   * still satisfy the interface; callers fall back to findByStatus when absent.
   */
  findByStatusSince?(
    tenantId: string,
    status: ProposalStatus,
    since: Date,
    limit?: number,
  ): Promise<Proposal[]>;
  /**
   * §5.5 — expired proposals of the given types that lapsed on/after `since`,
   * newest first, capped at `limit`. Bounds the inbox's re-proposable list in
   * the DB (WHERE + ORDER BY + LIMIT) instead of fetching every expired row and
   * trimming in memory. Optional so legacy fakes still satisfy the interface;
   * callers fall back to findByStatus + in-memory filtering when it's absent.
   */
  findExpiredScheduleProposals?(
    tenantId: string,
    proposalTypes: readonly ProposalType[],
    since: Date,
    limit: number,
  ): Promise<Proposal[]>;
  /**
   * N-005 — proposals created in [from, to) whose `_meta.overallConfidence` is
   * a blocking level ('low' | 'very_low'). Drives the digest "what I wasn't
   * sure about today". Newest first, capped at `limit`. Optional so partial
   * test doubles still satisfy the interface; the digest falls back to an empty
   * section when it is absent.
   */
  findConfidenceMarkedForDay?(
    tenantId: string,
    from: Date,
    to: Date,
    limit?: number,
  ): Promise<Proposal[]>;
  /**
   * D-015 amendment — proposals created in [from, to) that took the
   * autonomous booking lane (`sourceContext.autonomousLaneEvaluation.eligible
   * === true`). Drives the digest "Auto-booked: N appointment(s)"
   * reflection. Newest first, capped at `limit`. Optional so partial test
   * doubles still satisfy the interface; the digest falls back to an empty
   * section when it is absent.
   */
  findAutonomousLaneApprovedForDay?(
    tenantId: string,
    from: Date,
    to: Date,
    limit?: number,
  ): Promise<Proposal[]>;
  /**
   * WS10 — proposals created in [from, to) that carry at least one stamp in
   * `payload._meta.appliedStandingInstructions` (see
   * ai/standing-instructions-context.ts:36-39 — Array<{id, text}>, only
   * stamped by drafting tasks when non-empty). Drives the digest "Applied
   * your rule ..." reflection. Newest first, capped at `limit`. Optional so
   * partial test doubles still satisfy the interface; the digest falls back
   * to an empty section when it is absent.
   */
  findAppliedInstructionsForDay?(
    tenantId: string,
    from: Date,
    to: Date,
    limit?: number,
  ): Promise<Proposal[]>;
  findByAiRun(tenantId: string, aiRunId: string): Promise<Proposal[]>;
  /**
   * Indexed lookup for deterministic producer deduplication. Optional so
   * narrow legacy fakes remain source-compatible; both production repositories
   * implement it.
   */
  findByIdempotencyKey?(
    tenantId: string,
    idempotencyKey: string,
  ): Promise<Proposal | null>;
  /**
   * Indexed lookup for voice redelivery dedup (P1). Returns the most recent
   * proposal whose idempotencyKey === `idempotencyKey` (single-action path) OR
   * whose sourceContext.recordingId === `recordingId` (chain members, which
   * can't share one key), else null. Replaces a per-message findByTenant scan
   * on the hot inbound-voice path — backed by the idempotency unique index and
   * idx_proposals_source_recording.
   */
  findByRecordingId(
    tenantId: string,
    recordingId: string,
    idempotencyKey: string,
  ): Promise<Proposal | null>;
  /**
   * Multi-action chaining — fetch every proposal sharing a chainId,
   * ordered by chainIndex. Used by the execution-time chain resolver to
   * read a dependency's resultEntityId, and by the inbox to group a
   * chain into one card.
   */
  findByChain(tenantId: string, chainId: string): Promise<Proposal[]>;
  /**
   * Conversation-scoped fetch — every proposal whose
   * sourceContext.conversationId matches, filtered in SQL. Lets callers count
   * per-conversation state (e.g. the Estimate Agent's clarification-loop count)
   * without pulling a tenant-wide proposal set into memory. Optional so partial
   * test doubles still satisfy the interface; both real repos implement it.
   */
  findByConversation?(tenantId: string, conversationId: string): Promise<Proposal[]>;
  /**
   * WS20 — proposals of `proposalType` that carry a matching
   * `sourceContext.correctionTarget` (`{ kind, key }`), optionally filtered to
   * `statuses`. Backs the correction-repetition dedup: a meta-proposal for the
   * same catalog SKU (or banned phrase) that is already open (draft /
   * ready_for_review) suppresses a duplicate; a rejected one suppresses until a
   * NEWER correction re-earns it. Filtered in SQL on the JSONB path so a
   * tenant-wide proposal set is never pulled into memory. Optional so partial
   * test doubles still satisfy the interface; both real repos implement it.
   */
  findByCorrectionTarget?(
    tenantId: string,
    proposalType: ProposalType,
    target: { kind: string; key: string },
    statuses?: readonly ProposalStatus[],
  ): Promise<Proposal[]>;
  updateStatus(
    tenantId: string,
    id: string,
    status: ProposalStatus,
    updates?: Partial<
      Pick<
        Proposal,
        | 'rejectionReason'
        | 'rejectionDetails'
        | 'resultEntityId'
        | 'approvedAt'
        | 'executedAt'
        | 'executedBy'
        | 'executionError'
        | 'undoneAt'
        | 'undoneBy'
      >
    >
  ): Promise<Proposal | null>;
  update(
    tenantId: string,
    id: string,
    updates: Partial<Omit<Proposal, 'id' | 'tenantId' | 'createdBy' | 'createdAt'>>
  ): Promise<Proposal | null>;

  /**
   * System-level query for the auto-delivery worker. Returns all
   * proposals in 'approved' status whose `approvedAt` + `windowMs`
   * has passed — i.e., the 5-second undo window has closed and they
   * are ready for execution. Does NOT filter by tenant — this is a
   * privileged background sweep, not an API route.
   *
   * Proposals without `approvedAt` (historical, pre-undo-window-slice)
   * are included — they have no window and should execute immediately.
   */
  findReadyForExecution(windowMs: number): Promise<Proposal[]>;
  claimForExecution(proposalId: string, workerId: string): Promise<Proposal | null>;
  resetStaleExecuting(
    staleMinutes: number,
    maxRetries: number
  ): Promise<{ resetToApproved: number; movedToFailed: number }>;
}

export function validateProposalInput(input: CreateProposalInput): string[] {
  const errors: string[] = [];
  if (!input.tenantId) errors.push('tenantId is required');
  if (!input.proposalType) {
    errors.push('proposalType is required');
  } else if (!VALID_PROPOSAL_TYPES.includes(input.proposalType)) {
    errors.push('proposalType is invalid');
  }
  if (!input.payload || typeof input.payload !== 'object') {
    errors.push('payload must be a non-null object');
  }
  if (!input.summary) errors.push('summary is required');
  if (!input.createdBy) errors.push('createdBy is required');
  if (
    input.confidenceScore !== undefined &&
    (typeof input.confidenceScore !== 'number' ||
      input.confidenceScore < 0 ||
      input.confidenceScore > 1)
  ) {
    errors.push('confidenceScore must be a number between 0 and 1');
  }
  return errors;
}

export function createProposal(input: CreateProposalInput): Proposal {
  const now = new Date();
  // The load-bearing signal is the explicit `voiceMutation` flag every voice
  // call site sets — a conversational readback confirms interpretation, never
  // authorization. RIVET P4: an S1 (inbound, unauthenticated caller) surface
  // is treated the same way — a stranger's transcript can never carry an
  // autonomous trust tier into an auto-approve. (The previous
  // `'inapp_voice'`/`'telephony_voice'` channel comparisons were dead — real
  // channels are `'telephony'`/`'inapp'` — so the `voiceMutation` flag and the
  // surface stamp are the two real guards, not a channel string.)
  const voiceMutation =
    input.sourceContext?.voiceMutation === true ||
    input.sourceContext?.surface === 'S1';
  // The only voice-originated exception is the separately gated autonomous
  // booking lane, whose evaluation is explicit and auditable.
  const effectiveTrustTier =
    voiceMutation && !input.autonomousLane?.eligible
      ? undefined
      : input.sourceTrustTier;
  // Rivet P2 F-1 — Supervisor Agent v1 hook point. Evaluated BEFORE the
  // trust-tier decision so the deterministic tenant policy (budget caps,
  // blocked types) sees every proposal at creation. The hook is a
  // module-level optional dep (see supervisor/hook.ts for the injection
  // rationale): when unconfigured — every caller that hasn't opted in —
  // `supervisorHook` is null and this function behaves exactly as
  // before. The verdict can only DOWNGRADE the initial status
  // (capInitialStatus is monotone non-increasing), so money/irreversible
  // proposals can never be upgraded by policy, structurally.
  const supervisorHook = getSupervisorCreationHook();
  const supervisorDecision = supervisorHook
    ? supervisorHook.evaluate({
        tenantId: input.tenantId,
        proposalType: input.proposalType,
        actionClass: actionClassForProposalType(input.proposalType),
        amountCents: payloadHeadlineCents(input.payload),
      })
    : null;
  // D3 wiring: status is decided by the trust-tier rules below, not
  // hardcoded. Callers that don't pass `sourceTrustTier` get 'draft'
  // exactly as before — every existing test and AI task is unchanged.
  const baselineStatus = decideInitialStatus({
    proposalType: input.proposalType,
    sourceTrustTier: effectiveTrustTier,
    confidenceScore: input.confidenceScore,
    missingFields: input.missingFields,
    // Phase 12: forward the supervisor-gating signals. Previously these
    // were silently dropped, so the unsupervised hard-block and the
    // per-tenant threshold override were dead-wired on the voice path —
    // a high-confidence autonomous proposal auto-approved even with no
    // supervisor present. Forwarding restores the gate.
    supervisorMode: input.supervisorMode,
    supervisorPresent: input.supervisorPresent,
    tenantThresholdOverride: input.tenantThresholdOverride,
    // RV-007: thread the payload so the `_meta.overallConfidence`
    // confidence-marker guard sees it. Every auto-approve path goes
    // through createProposal → decideInitialStatus, so this is the
    // single wiring point.
    payload: input.payload,
    // UB-D / D-015: the autonomous booking lane input, set only by the
    // inbound-receptionist booking call sites after every lane gate
    // passed. The supervisor hook below still runs and can only
    // downgrade — a policy block/force_review beats the lane.
    autonomousLane: input.autonomousLane,
  });
  // Supervisor verdict application:
  //   'block'        → 'draft' (decideInitialStatus result discarded);
  //   'force_review' → capped at 'ready_for_review' (never 'approved');
  //   'allow' / null → baseline untouched.
  // Non-'allow' verdicts stamp an explanatory `_meta` marker so the
  // review UI / SMS / voice readback can say WHY the proposal is gated.
  // Safe narrowing: decideInitialStatus only ever returns one of the
  // three initial statuses (draft | ready_for_review | approved); its
  // declared type is the full ProposalStatus union for historical
  // reasons.
  const status = supervisorDecision
    ? capInitialStatus(supervisorDecision.verdict, baselineStatus as InitialProposalStatus)
    : baselineStatus;
  const payload =
    supervisorDecision && supervisorDecision.verdict !== 'allow'
      ? payloadWithSupervisorMarker(
          input.payload,
          supervisorDecision.reasons,
        )
      : input.payload;
  // Budget accounting: machine approvals count against the hourly
  // auto-approval budget at decide time. Only fires while the supervisor
  // is active for the tenant (the hook's evaluate returned a verdict).
  if (supervisorHook && supervisorDecision && status === 'approved') {
    supervisorHook.onAutoApproved(input.tenantId);
  }
  // D9 undo window: auto-approved proposals stamp `approvedAt` at
  // creation so the 5-second undo window starts ticking immediately.
  // Without this stamp, the executor would run without any hold — the
  // whole point of the window is to give the operator a chance to
  // reverse a machine-approved action.
  const approvedAt = status === 'approved' ? now : undefined;
  // missingFields rides in sourceContext so we avoid a DB schema
  // change. `missingFieldsFor(proposal)` is the typed reader.
  const sourceContext =
    input.missingFields && input.missingFields.length > 0
      ? { ...(input.sourceContext ?? {}), missingFields: input.missingFields }
      : input.sourceContext;
  const proposal: Proposal = {
    id: uuidv4(),
    tenantId: input.tenantId,
    proposalType: input.proposalType,
    status,
    payload,
    summary: input.summary,
    explanation: input.explanation,
    confidenceScore: input.confidenceScore,
    confidenceFactors: input.confidenceFactors,
    sourceContext,
    aiRunId: input.aiRunId,
    promptVersionId: input.promptVersionId,
    targetEntityType: input.targetEntityType,
    targetEntityId: input.targetEntityId,
    idempotencyKey: input.idempotencyKey,
    // §5.5 — schedule proposals default to a 48h TTL; an explicit caller
    // value always wins, and non-schedule types stay unset (persist).
    expiresAt: input.expiresAt ?? defaultProposalExpiry(input.proposalType, now),
    chainId: input.chainId,
    approvedAt,
    createdBy: input.createdBy,
    createdAt: now,
    updatedAt: now,
  };
  // Audit trail for applied (non-'allow') verdicts — fire-and-forget
  // inside the hook implementation, so the pure builder stays sync and
  // a down audit store can't break proposal creation.
  if (supervisorHook && supervisorDecision && supervisorDecision.verdict !== 'allow') {
    supervisorHook.onDecision(proposal, supervisorDecision);
  }
  return proposal;
}

export class InMemoryProposalRepository implements ProposalRepository {
  private proposals: Map<string, Proposal> = new Map();

  async create(proposal: Proposal): Promise<Proposal> {
    if (proposal.idempotencyKey) {
      const existing = Array.from(this.proposals.values()).find(
        (p) => p.tenantId === proposal.tenantId && p.idempotencyKey === proposal.idempotencyKey
      );
      if (existing) {
        throw new ConflictError(
          `Proposal with idempotency key '${proposal.idempotencyKey}' already exists for this tenant`
        );
      }
    }
    this.proposals.set(proposal.id, { ...proposal });
    return { ...proposal };
  }

  async createMany(proposals: Proposal[]): Promise<Proposal[]> {
    // Atomic semantics: validate every member first (idempotency
    // collisions — both against the store AND within the batch, which
    // the pg unique index would catch), then commit them all. A throw
    // before the commit loop leaves the store untouched, matching the pg
    // single-transaction behavior.
    const seenKeys = new Set<string>();
    for (const proposal of proposals) {
      if (!proposal.idempotencyKey) continue;
      const dedupeKey = `${proposal.tenantId}:${proposal.idempotencyKey}`;
      const collides =
        seenKeys.has(dedupeKey) ||
        Array.from(this.proposals.values()).some(
          (p) => p.tenantId === proposal.tenantId && p.idempotencyKey === proposal.idempotencyKey
        );
      if (collides) {
        throw new ConflictError(
          `Proposal with idempotency key '${proposal.idempotencyKey}' already exists for this tenant`
        );
      }
      seenKeys.add(dedupeKey);
    }
    const created: Proposal[] = [];
    for (const proposal of proposals) {
      this.proposals.set(proposal.id, { ...proposal });
      created.push({ ...proposal });
    }
    return created;
  }

  async findById(tenantId: string, id: string): Promise<Proposal | null> {
    const proposal = this.proposals.get(id);
    if (!proposal || proposal.tenantId !== tenantId) return null;
    return { ...proposal };
  }

  async findByTenant(tenantId: string): Promise<Proposal[]> {
    return Array.from(this.proposals.values())
      .filter((p) => p.tenantId === tenantId)
      .map((p) => ({ ...p }));
  }

  async findByStatus(tenantId: string, status: ProposalStatus): Promise<Proposal[]> {
    return Array.from(this.proposals.values())
      .filter((p) => p.tenantId === tenantId && p.status === status)
      .map((p) => ({ ...p }));
  }

  async findByStatusSince(
    tenantId: string,
    status: ProposalStatus,
    since: Date,
    limit?: number,
  ): Promise<Proposal[]> {
    const rows = Array.from(this.proposals.values())
      .filter(
        (p) =>
          p.tenantId === tenantId &&
          p.status === status &&
          p.createdAt.getTime() >= since.getTime(),
      )
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .map((p) => ({ ...p }));
    return typeof limit === 'number' ? rows.slice(0, limit) : rows;
  }

  async findExpiredScheduleProposals(
    tenantId: string,
    proposalTypes: readonly ProposalType[],
    since: Date,
    limit: number,
  ): Promise<Proposal[]> {
    return Array.from(this.proposals.values())
      .filter(
        (p) =>
          p.tenantId === tenantId &&
          p.status === 'expired' &&
          proposalTypes.includes(p.proposalType) &&
          !!p.expiresAt &&
          p.expiresAt.getTime() >= since.getTime(),
      )
      .sort((a, b) => (b.expiresAt?.getTime() ?? 0) - (a.expiresAt?.getTime() ?? 0))
      .slice(0, limit)
      .map((p) => ({ ...p }));
  }

  async findConfidenceMarkedForDay(
    tenantId: string,
    from: Date,
    to: Date,
    limit?: number,
  ): Promise<Proposal[]> {
    const BLOCKING = new Set(['low', 'very_low']);
    const rows = Array.from(this.proposals.values())
      .filter((p) => {
        if (p.tenantId !== tenantId) return false;
        const t = p.createdAt.getTime();
        if (t < from.getTime() || t >= to.getTime()) return false;
        const meta = (p.payload as Record<string, unknown>)?._meta;
        const overall =
          meta && typeof meta === 'object'
            ? (meta as Record<string, unknown>).overallConfidence
            : undefined;
        return typeof overall === 'string' && BLOCKING.has(overall);
      })
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .map((p) => ({ ...p }));
    return typeof limit === 'number' ? rows.slice(0, limit) : rows;
  }

  async findAutonomousLaneApprovedForDay(
    tenantId: string,
    from: Date,
    to: Date,
    limit?: number,
  ): Promise<Proposal[]> {
    const rows = Array.from(this.proposals.values())
      .filter((p) => {
        if (p.tenantId !== tenantId) return false;
        const t = p.createdAt.getTime();
        if (t < from.getTime() || t >= to.getTime()) return false;
        const evaluation = (p.sourceContext as Record<string, unknown> | undefined)
          ?.autonomousLaneEvaluation;
        return (
          !!evaluation &&
          typeof evaluation === 'object' &&
          (evaluation as Record<string, unknown>).eligible === true
        );
      })
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .map((p) => ({ ...p }));
    return typeof limit === 'number' ? rows.slice(0, limit) : rows;
  }

  async findAppliedInstructionsForDay(
    tenantId: string,
    from: Date,
    to: Date,
    limit?: number,
  ): Promise<Proposal[]> {
    const rows = Array.from(this.proposals.values())
      .filter((p) => {
        if (p.tenantId !== tenantId) return false;
        const t = p.createdAt.getTime();
        if (t < from.getTime() || t >= to.getTime()) return false;
        const meta = (p.payload as Record<string, unknown> | undefined)?._meta;
        const applied =
          meta && typeof meta === 'object'
            ? (meta as Record<string, unknown>).appliedStandingInstructions
            : undefined;
        return Array.isArray(applied) && applied.length > 0;
      })
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .map((p) => ({ ...p }));
    return typeof limit === 'number' ? rows.slice(0, limit) : rows;
  }

  async findByAiRun(tenantId: string, aiRunId: string): Promise<Proposal[]> {
    return Array.from(this.proposals.values())
      .filter((p) => p.tenantId === tenantId && p.aiRunId === aiRunId)
      .map((p) => ({ ...p }));
  }

  async findByIdempotencyKey(
    tenantId: string,
    idempotencyKey: string,
  ): Promise<Proposal | null> {
    const proposal = Array.from(this.proposals.values()).find(
      (candidate) =>
        candidate.tenantId === tenantId &&
        candidate.idempotencyKey === idempotencyKey,
    );
    return proposal ? { ...proposal } : null;
  }

  async findByRecordingId(
    tenantId: string,
    recordingId: string,
    idempotencyKey: string,
  ): Promise<Proposal | null> {
    const match = Array.from(this.proposals.values())
      .filter(
        (p) =>
          p.tenantId === tenantId &&
          (p.idempotencyKey === idempotencyKey ||
            (p.sourceContext as Record<string, unknown> | undefined)?.recordingId ===
              recordingId),
      )
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0];
    return match ? { ...match } : null;
  }

  async findByChain(tenantId: string, chainId: string): Promise<Proposal[]> {
    return Array.from(this.proposals.values())
      .filter((p) => p.tenantId === tenantId && p.chainId === chainId)
      .map((p) => ({ ...p }))
      .sort((a, b) => {
        const ai = (a.sourceContext?.chainIndex as number | undefined) ?? 0;
        const bi = (b.sourceContext?.chainIndex as number | undefined) ?? 0;
        return ai - bi;
      });
  }

  async findByConversation(tenantId: string, conversationId: string): Promise<Proposal[]> {
    return Array.from(this.proposals.values())
      .filter(
        (p) =>
          p.tenantId === tenantId &&
          (p.sourceContext as Record<string, unknown> | undefined)?.conversationId ===
            conversationId,
      )
      .map((p) => ({ ...p }));
  }

  async findByCorrectionTarget(
    tenantId: string,
    proposalType: ProposalType,
    target: { kind: string; key: string },
    statuses?: readonly ProposalStatus[],
  ): Promise<Proposal[]> {
    return Array.from(this.proposals.values())
      .filter((p) => {
        if (p.tenantId !== tenantId || p.proposalType !== proposalType) return false;
        if (statuses && !statuses.includes(p.status)) return false;
        const ct = (p.sourceContext as Record<string, unknown> | undefined)?.correctionTarget as
          | { kind?: unknown; key?: unknown }
          | undefined;
        return ct?.kind === target.kind && ct?.key === target.key;
      })
      .map((p) => ({ ...p }));
  }

  async updateStatus(
    tenantId: string,
    id: string,
    status: ProposalStatus,
    updates?: Partial<
      Pick<
        Proposal,
        | 'rejectionReason'
        | 'rejectionDetails'
        | 'resultEntityId'
        | 'approvedAt'
        | 'executedAt'
        | 'executedBy'
        | 'executionError'
        | 'undoneAt'
        | 'undoneBy'
      >
    >
  ): Promise<Proposal | null> {
    const proposal = this.proposals.get(id);
    if (!proposal || proposal.tenantId !== tenantId) return null;

    proposal.status = status;
    proposal.updatedAt = new Date();
    if (updates) {
      if (updates.rejectionReason !== undefined) proposal.rejectionReason = updates.rejectionReason;
      if (updates.rejectionDetails !== undefined) proposal.rejectionDetails = updates.rejectionDetails;
      if (updates.resultEntityId !== undefined) proposal.resultEntityId = updates.resultEntityId;
      if (updates.approvedAt !== undefined) proposal.approvedAt = updates.approvedAt;
      if (updates.executionError !== undefined) proposal.executionError = updates.executionError;
      if (updates.executedAt !== undefined) proposal.executedAt = updates.executedAt;
      if (updates.executedBy !== undefined) proposal.executedBy = updates.executedBy;
      if (updates.undoneAt !== undefined) proposal.undoneAt = updates.undoneAt;
      if (updates.undoneBy !== undefined) proposal.undoneBy = updates.undoneBy;
    }

    this.proposals.set(id, proposal);
    return { ...proposal };
  }

  async update(
    tenantId: string,
    id: string,
    updates: Partial<Omit<Proposal, 'id' | 'tenantId' | 'createdBy' | 'createdAt'>>
  ): Promise<Proposal | null> {
    const proposal = this.proposals.get(id);
    if (!proposal || proposal.tenantId !== tenantId) return null;

    Object.assign(proposal, updates, { updatedAt: new Date() });
    this.proposals.set(id, proposal);
    return { ...proposal };
  }

  async findReadyForExecution(windowMs: number): Promise<Proposal[]> {
    const now = Date.now();
    return Array.from(this.proposals.values())
      .filter((p) => {
        if (p.status !== 'approved') return false;
        // No approvedAt → historical proposal, treat as past-window.
        if (!p.approvedAt) return true;
        return now - p.approvedAt.getTime() >= windowMs;
      })
      .map((p) => ({ ...p }));
  }

  async claimForExecution(proposalId: string, workerId: string): Promise<Proposal | null> {
    const proposal = this.proposals.get(proposalId);
    if (!proposal || proposal.status !== 'approved') return null;
    proposal.status = 'executing';
    proposal.claimedBy = workerId;
    proposal.claimedAt = new Date();
    proposal.updatedAt = new Date();
    this.proposals.set(proposalId, proposal);
    return { ...proposal };
  }

  async resetStaleExecuting(
    staleMinutes: number,
    maxRetries: number
  ): Promise<{ resetToApproved: number; movedToFailed: number }> {
    const now = Date.now();
    let resetToApproved = 0;
    let movedToFailed = 0;
    for (const [id, proposal] of this.proposals.entries()) {
      if (proposal.status !== 'executing' || !proposal.claimedAt) continue;
      const ageMinutes = (now - proposal.claimedAt.getTime()) / 60000;
      if (ageMinutes < staleMinutes) continue;
      const retries = proposal.executionRetryCount ?? 0;
      if (retries >= maxRetries) {
        proposal.status = 'execution_failed';
        movedToFailed++;
      } else {
        proposal.status = 'approved';
        proposal.executionRetryCount = retries + 1;
        proposal.claimedAt = undefined;
        proposal.claimedBy = undefined;
        resetToApproved++;
      }
      proposal.updatedAt = new Date();
      this.proposals.set(id, proposal);
    }
    return { resetToApproved, movedToFailed };
  }
}
