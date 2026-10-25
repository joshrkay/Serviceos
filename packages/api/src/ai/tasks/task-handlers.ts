import { Proposal, CreateProposalInput, createProposal, ProposalType } from '../../proposals/proposal';
import type { InjectedStandingInstruction } from '../standing-instructions-context';
import type { IntentType } from '../orchestration/intent-classifier';

export interface TaskContext {
  tenantId: string;
  message: string;
  /**
   * #1232 — `message` (and every entity the classifier extracted from it) is
   * S1 caller-authored text: set by voice-action-router for
   * `sourceChannel: 'voicemail'` jobs, whose owner-line caller-ID match is
   * spoofable. Drafting handlers must render such text into a prompt only
   * through `taskMessageForPrompt` / `untrustedTaskTextForPrompt`
   * (task-input.ts), which fence it. Absent on owner surfaces, whose prompts
   * stay byte-identical.
   */
  untrustedMessage?: boolean;
  conversationId?: string;
  /**
   * OBS-2 — the live voice session (telephony or in-app call) this task runs
   * in. Set only on the two live surfaces' in-call respond_to_review handoff
   * to `RespondToReviewTaskHandler` (create-voice-turn-processor.ts for
   * telephony, inapp-adapter.ts for in-app). No other caller sets it; without
   * it `draftingRunMetadata` keys by the conversation, else the recording.
   * Every AI run on a call is keyed to the session id (the classifier's
   * correlation id there), so that review draft's runs are too. Never stamped
   * on the proposal.
   */
  voiceSessionId?: string;
  existingEntities?: Record<string, unknown>;
  userId: string;
  /**
   * Quality-review fix (2026-08-09, Task 11) — the classified voice/chat
   * intent, when the entry point has one to give (voice-action-router.ts).
   * Multiple intents can alias onto the SAME `taskType`/proposal type (e.g.
   * `log_mileage` and `log_expense` both drive `LogExpenseTaskHandler`), so
   * a handler that needs to tell them apart cannot use `taskType` — this is
   * the one place to look. Before this field existed, `LogExpenseTaskHandler`
   * had to key its `log_mileage` branch on the mere PRESENCE of an
   * extracted-entity field (`mileageMiles`) instead, which a shared,
   * un-scoped classifier JSON template could defeat: the model is free to
   * populate `mileageMiles` on a `log_expense` turn (or `amount` on a
   * `log_mileage` turn) since nothing enforces per-intent field scoping
   * (`entitiesForProposal`, `workers/voice-action-router.ts`, is a
   * passthrough for every intent except `create_customer`). Optional —
   * older/other entry points (e.g. `ai/orchestration/task-router.ts`, which
   * has no production callers today) may still omit it.
   */
  intent?: IntentType;
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
    /**
     * `tenant_settings.owner_phone`, the number the owner UNDO SMS goes to.
     * No number on file ⇒ the lane reports `owner_cell_missing`.
     */
    ownerPhone: string | null | undefined;
    /** True only when the entry point can send the owner UNDO SMS. */
    undoChannelAvailable: boolean;
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
  /**
   * #1173 — photos the operator attached to this turn (Assistant chat),
   * already resolved TENANT-SCOPED by the entry point and presigned to a URL
   * the gateway can fetch (`files/chat-image-attachments.ts`). A handler that
   * accepts images (EstimateTaskHandler) sends one image part per photo on
   * its model request — the same `LLMContentPart` shape
   * MmsEstimateTaskHandler builds. `fileId` rides along for provenance only;
   * the model never sees it. Absent → a text-only request, byte-identical to
   * before.
   */
  images?: TaskImage[];
}

/** #1173 — one resolved, presigned photo handed to a drafting task. */
export interface TaskImage {
  url: string;
  contentType?: string;
  fileId?: string;
}

export interface TaskResult {
  proposal: Proposal;
  taskType: string;
}

export interface TaskHandler {
  taskType: ProposalType;
  handle(context: TaskContext): Promise<TaskResult>;
}

/**
 * OBS-2 — the join keys every drafting handler passes on its
 * `gateway.complete`, so the ai_runs row the completion writes can be found
 * from the call or conversation it served: `ai_runs.correlation_id` is the
 * live call's voice session id, else the conversation id, else (for a memo
 * with neither) the recording id — instead of a gateway-minted random uuid.
 * Each is the key the classifier's run on that surface carries too.
 * `sessionId` groups the trace with the classifier's (the voice session on a
 * call, the conversation in chat and memos). No new column: correlation_id
 * already exists. Spread into the request:
 * `gateway.complete({ ..., ...draftingRunMetadata(context) })`.
 */
export function draftingRunMetadata(
  context: Pick<TaskContext, 'conversationId' | 'recordingId' | 'voiceSessionId'>,
): { metadata?: Record<string, unknown> } {
  const sessionId = context.voiceSessionId ?? context.conversationId;
  const correlationId = sessionId ?? context.recordingId;
  if (!correlationId) return {};
  return {
    metadata: {
      correlationId,
      ...(sessionId ? { sessionId } : {}),
    },
  };
}

/**
 * OBS-2 — link a proposal to the run that authored its payload: spread into
 * the CreateProposalInput. Only when the gateway persisted a run
 * (`proposals.ai_run_id` is an FK to `ai_runs(id)`, so never a made-up id).
 */
export function draftingRunLink(
  response: { aiRunId?: string } | null | undefined,
): { aiRunId?: string } {
  return response?.aiRunId ? { aiRunId: response.aiRunId } : {};
}

/**
 * OBS-2 — record which classifier run routed the turn to this drafting
 * handler (`sourceContext.classifierAiRunId`). The proposal's own `aiRunId`
 * is the DRAFTING run; this keeps the routing decision reachable too.
 */
export function withClassifierRun<P extends Pick<Proposal, 'sourceContext'>>(
  proposal: P,
  classifierAiRunId: string | undefined,
): P {
  if (!classifierAiRunId) return proposal;
  return {
    ...proposal,
    sourceContext: { ...(proposal.sourceContext ?? {}), classifierAiRunId },
  };
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
