import { Proposal, CreateProposalInput, createProposal, ProposalType } from '../../proposals/proposal';
import type { InjectedStandingInstruction } from '../standing-instructions-context';

export interface TaskContext {
  tenantId: string;
  message: string;
  conversationId?: string;
  existingEntities?: Record<string, unknown>;
  userId: string;
  /**
   * Resolved caller identity. Set by the entry-point once the inbound
   * caller has been matched to a customer (e.g. by caller-ID). Handlers
   * that need the caller's customer (create_appointment, cancel,
   * reschedule) read this instead of asking the LLM to invent one.
   */
  customerId?: string;
  /**
   * Originating voice recording id, when this task came from the
   * transcription → voice_action_router queue path. Used to derive a
   * deterministic idempotency key for at-least-once writes (e.g. the
   * held-slot appointment) so a redelivered message can't double-book.
   */
  recordingId?: string;
  /**
   * Tier 4 / PR B — per-tenant auto-approve threshold override
   * resolved by the entry-point (voice-action-router) and threaded
   * onto each task's CreateProposalInput. Optional: when undefined,
   * proposals fall through to DEFAULT_AUTO_APPROVE_THRESHOLDS.
   */
  tenantThresholdOverride?: Partial<Record<'supervisor' | 'tech' | 'both', number>>;
  /**
   * Phase 12 supervisor presence, resolved once per request by the
   * entry-point (voice-action-router) via `isSupervisorPresent`. Threaded
   * onto each task's CreateProposalInput so an autonomous, capture-class
   * proposal can only auto-approve when a supervisor is actually present.
   * When undefined (non-voice callers), the proposal falls back to the
   * pre-Phase-12 permissive default.
   */
  supervisorPresent?: boolean;
  /**
   * Phase 12 supervisor current_mode at request time, when known. Tunes
   * the auto-approve threshold (0.90 supervisor / 0.92 both / 0.95 tech).
   * Optional — when undefined the legacy 0.9 threshold applies.
   */
  supervisorMode?: 'supervisor' | 'tech' | 'both';
  /**
   * Tenant IANA timezone (e.g. "America/New_York"), resolved once per
   * request by the entry-point from tenant_settings. Scheduling handlers
   * use it to translate spoken times ("next Tuesday at 2pm") into the
   * correct UTC instant. When undefined, handlers fall back to the product
   * default (DEFAULT_TENANT_TIMEZONE) — NEVER a hardcoded zone.
   */
  timezone?: string;
  /**
   * Reference instant for resolving relative phrases ("tomorrow",
   * "next Tuesday"). Set by the entry-point to request time; defaults to
   * `new Date()` at point of use. Injectable so scheduling is testable.
   */
  now?: Date;
  /**
   * Story 7.2 — how many clarification loops the Estimate Agent has already
   * run for this estimate (0 on the first pass). Threaded from conversation
   * state by the voice/orchestration entry-point so the draft handler can
   * enforce the hard 3-loop cap and flag the final draft for review. Absent
   * (undefined) → treated as 0 (first pass).
   */
  clarificationCount?: number;
  /**
   * Tenant business-hours schedule (tenant_settings.business_hours),
   * resolved once per request by the entry-point alongside `timezone`
   * (voice-action-router's tenantSchedulingResolver). The held-slot booking
   * path uses it to decide whether the proposed slot falls inside business
   * hours for the autonomous lane (UB-D). Absent/empty is treated as "no
   * schedule configured" — fail-open, per D-015.
   */
  businessHours?: Record<string, { open: string; close: string } | null> | null;
  /**
   * UB-D / D-015 — autonomous booking lane inputs, threaded by the
   * entry-point ONLY for booking-classified segments (never a settings read
   * on other intents). `inboundReceptionistSource` is true ONLY when the
   * request originated from an inbound customer call with a verified caller
   * (caller-ID match); owner memos and assistant chat are always false, so
   * the lane can never engage for them. `pendingReferenceCount` carries the
   * router's unresolved free-text reference count (annotation
   * .pendingReferences) — any pending reference blocks the lane.
   * `platformDisabled` (D-015 amendment) carries the AUTONOMOUS_BOOKING_DISABLED
   * platform kill switch — checked before tenant opt-in by the evaluator.
   */
  autonomousBooking?: {
    settings: { enabled: boolean; threshold?: number };
    inboundReceptionistSource: boolean;
    pendingReferenceCount: number;
    platformDisabled?: boolean;
  };
  /**
   * UB-A3 — owner standing instructions applicable to this task, resolved
   * best-effort ONCE per request by the entry point (voice-action-router /
   * assistant chat) via `listActive` → `selectApplicableInstructions` (≤5)
   * keyed on the classified intent. Drafting handlers inject them as a
   * delimited system-message section that adjusts draft CONTENT only —
   * never approvals, confidence, or pricing grounding. Resolver failure
   * leaves this undefined and never blocks the task.
   */
  standingInstructions?: InjectedStandingInstruction[];
}

export interface TaskResult {
  proposal: Proposal;
  taskType: string;
}

export interface TaskHandler {
  taskType: ProposalType;
  handle(context: TaskContext): Promise<TaskResult>;
}

export class CreateCustomerTaskHandler implements TaskHandler {
  readonly taskType: ProposalType = 'create_customer';

  async handle(context: TaskContext): Promise<TaskResult> {
    const input: CreateProposalInput = {
      tenantId: context.tenantId,
      proposalType: this.taskType,
      payload: context.existingEntities ?? {
        name: '',
        email: '',
        phone: '',
      },
      summary: context.message,
      sourceContext: context.conversationId ? { conversationId: context.conversationId } : undefined,
      createdBy: context.userId,
      ...(context.tenantThresholdOverride
        ? { tenantThresholdOverride: context.tenantThresholdOverride }
        : {}),
    };

    const proposal = createProposal(input);
    return { proposal, taskType: this.taskType };
  }
}

export class CreateJobTaskHandler implements TaskHandler {
  readonly taskType: ProposalType = 'create_job';

  async handle(context: TaskContext): Promise<TaskResult> {
    const input: CreateProposalInput = {
      tenantId: context.tenantId,
      proposalType: this.taskType,
      payload: context.existingEntities ?? {
        title: '',
        description: '',
      },
      summary: context.message,
      sourceContext: context.conversationId ? { conversationId: context.conversationId } : undefined,
      createdBy: context.userId,
      ...(context.tenantThresholdOverride
        ? { tenantThresholdOverride: context.tenantThresholdOverride }
        : {}),
    };

    const proposal = createProposal(input);
    return { proposal, taskType: this.taskType };
  }
}

export class CreateAppointmentTaskHandler implements TaskHandler {
  readonly taskType: ProposalType = 'create_appointment';

  async handle(context: TaskContext): Promise<TaskResult> {
    const input: CreateProposalInput = {
      tenantId: context.tenantId,
      proposalType: this.taskType,
      payload: context.existingEntities ?? {
        date: '',
        time: '',
        customerId: '',
      },
      summary: context.message,
      sourceContext: context.conversationId ? { conversationId: context.conversationId } : undefined,
      createdBy: context.userId,
      ...(context.tenantThresholdOverride
        ? { tenantThresholdOverride: context.tenantThresholdOverride }
        : {}),
    };

    const proposal = createProposal(input);
    return { proposal, taskType: this.taskType };
  }
}
