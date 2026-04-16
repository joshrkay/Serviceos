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
export type ProposalType = 'create_customer' | 'update_customer' | 'create_job' | 'create_appointment' | 'draft_estimate' | 'update_estimate' | 'draft_invoice' | 'reassign_appointment' | 'reschedule_appointment' | 'cancel_appointment' | 'onboarding_tenant_settings' | 'onboarding_service_category' | 'onboarding_estimate_template' | 'onboarding_team_member' | 'onboarding_schedule';

const VALID_PROPOSAL_TYPES: ProposalType[] = [
  'create_customer',
  'update_customer',
  'create_job',
  'create_appointment',
  'draft_estimate',
  'update_estimate',
  'draft_invoice',
  'reassign_appointment',
  'reschedule_appointment',
  'cancel_appointment',
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
    case 'reassign_appointment':
    case 'reschedule_appointment':
    case 'onboarding_tenant_settings':
    case 'onboarding_service_category':
    case 'onboarding_estimate_template':
    case 'onboarding_team_member':
    case 'onboarding_schedule':
      return 'capture';
    case 'cancel_appointment':
      return 'irreversible';
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
}): ProposalStatus {
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
  });
  // D9 undo window: auto-approved proposals stamp `approvedAt` at
  // creation so the 5-second undo window starts ticking immediately.
  // Without this stamp, the executor would run without any hold — the
  // whole point of the window is to give the operator a chance to
  // reverse a machine-approved action.
  const approvedAt = status === 'approved' ? now : undefined;
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
    sourceContext: input.sourceContext,
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
}
