import { v4 as uuidv4 } from 'uuid';
import { ConflictError } from '../shared/errors';
import {
  resolveAutoApproveThreshold,
  shouldAutoApprove,
  type Mode,
  type ResolveThresholdInput,
} from './auto-approve';

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
export type ProposalType = 'create_customer' | 'update_customer' | 'create_job' | 'create_appointment' | 'create_booking' | 'callback' | 'draft_estimate' | 'update_estimate' | 'draft_invoice' | 'update_invoice' | 'issue_invoice' | 'reassign_appointment' | 'reschedule_appointment' | 'add_crew_member' | 'remove_crew_member' | 'cancel_appointment' | 'voice_clarification' | 'add_note' | 'send_invoice' | 'send_estimate' | 'record_payment' | 'log_expense' | 'convert_lead' | 'confirm_appointment' | 'mark_lead_lost' | 'add_service_location' | 'log_time_entry' | 'notify_delay' | 'request_feedback' | 'emergency_dispatch' | 'onboarding_tenant_settings' | 'onboarding_service_category' | 'onboarding_estimate_template' | 'onboarding_team_member' | 'onboarding_schedule' | 'review_response_proposal';

export const VALID_PROPOSAL_TYPES: ProposalType[] = [
  'create_customer',
  'update_customer',
  'create_job',
  'create_appointment',
  'create_booking',
  'callback',
  'draft_estimate',
  'update_estimate',
  'draft_invoice',
  'update_invoice',
  'issue_invoice',
  'reassign_appointment',
  'reschedule_appointment',
  'add_crew_member',
  'remove_crew_member',
  'cancel_appointment',
  'voice_clarification',
  'add_note',
  'send_invoice',
  'send_estimate',
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
];

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

export type ActionClass = 'capture' | 'comms' | 'money' | 'irreversible';
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
    // Phase 12 — resolve the mode-aware threshold. `null` means the
    // tenant is unsupervised and auto-approval is categorically blocked.
    const threshold = resolveAutoApproveThreshold({
      supervisorMode: input.supervisorMode,
      supervisorPresent: input.supervisorPresent,
      tenantOverride: input.tenantThresholdOverride,
    });

    if (threshold === null) {
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
  findById(tenantId: string, id: string): Promise<Proposal | null>;
  findByTenant(tenantId: string): Promise<Proposal[]>;
  findByStatus(tenantId: string, status: ProposalStatus): Promise<Proposal[]>;
  findByAiRun(tenantId: string, aiRunId: string): Promise<Proposal[]>;
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
  // D3 wiring: status is decided by the trust-tier rules below, not
  // hardcoded. Callers that don't pass `sourceTrustTier` get 'draft'
  // exactly as before — every existing test and AI task is unchanged.
  const status = decideInitialStatus({
    proposalType: input.proposalType,
    sourceTrustTier: input.sourceTrustTier,
    confidenceScore: input.confidenceScore,
    missingFields: input.missingFields,
  });
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
  return {
    id: uuidv4(),
    tenantId: input.tenantId,
    proposalType: input.proposalType,
    status,
    payload: input.payload,
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
    expiresAt: input.expiresAt,
    approvedAt,
    createdBy: input.createdBy,
    createdAt: now,
    updatedAt: now,
  };
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

  async findByAiRun(tenantId: string, aiRunId: string): Promise<Proposal[]> {
    return Array.from(this.proposals.values())
      .filter((p) => p.tenantId === tenantId && p.aiRunId === aiRunId)
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
