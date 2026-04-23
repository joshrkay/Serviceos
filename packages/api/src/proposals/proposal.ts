import { v4 as uuidv4 } from 'uuid';
import { ConflictError } from '../shared/errors';

export type ProposalStatus =
  | 'draft'
  | 'ready_for_review'
  | 'approved'
  | 'rejected'
  | 'expired'
  | 'executed'
  | 'execution_failed'
  // Undone: the operator pressed "undo" during the 5-second window
  // after approval. Terminal — an undone proposal cannot be reapproved
  // or re-executed. If the operator wants to proceed after undoing,
  // they draft a new proposal. Decision 9 ("5-second undo window").
  | 'undone';
export type ProposalType = 'create_customer' | 'update_customer' | 'create_job' | 'create_appointment' | 'draft_estimate' | 'update_estimate' | 'draft_invoice' | 'update_invoice' | 'reassign_appointment' | 'reschedule_appointment' | 'cancel_appointment' | 'voice_clarification' | 'add_note' | 'send_invoice' | 'record_payment' | 'onboarding_tenant_settings' | 'onboarding_service_category' | 'onboarding_estimate_template' | 'onboarding_team_member' | 'onboarding_schedule';

const VALID_PROPOSAL_TYPES: ProposalType[] = [
  'create_customer',
  'update_customer',
  'create_job',
  'create_appointment',
  'draft_estimate',
  'update_estimate',
  'draft_invoice',
  'update_invoice',
  'issue_invoice',
  'reassign_appointment',
  'reschedule_appointment',
  'cancel_appointment',
  'voice_clarification',
  'add_note',
  'send_invoice',
  'record_payment',
  'onboarding_tenant_settings',
  'onboarding_service_category',
  'onboarding_estimate_template',
  'onboarding_team_member',
  'onboarding_schedule',
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
    case 'draft_estimate':
    case 'update_estimate':
    case 'draft_invoice':
    case 'update_invoice':
    case 'reassign_appointment':
    case 'reschedule_appointment':
    case 'add_note':
    case 'onboarding_tenant_settings':
    case 'onboarding_service_category':
    case 'onboarding_estimate_template':
    case 'onboarding_team_member':
    case 'onboarding_schedule':
      return 'capture';
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
    // Outbound communications: even with autonomous trust, we do not
    // let the system send a customer-facing message without an
    // explicit approval. A mis-sent invoice is a real reputation
    // cost.
    case 'send_invoice':
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
}): ProposalStatus {
  // Missing required fields always land in 'draft' — a partial payload
  // can't be auto-approved even by an autonomous agent with high
  // confidence. The operator must fill the gaps at review time.
  if (input.missingFields && input.missingFields.length > 0) return 'draft';

  if (!input.sourceTrustTier) return 'draft';

  const cls = actionClassForProposalType(input.proposalType);

  if (
    input.sourceTrustTier === 'autonomous' &&
    cls === 'capture' &&
    (input.confidenceScore ?? 0) >= 0.9
  ) {
    return 'approved';
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
}
