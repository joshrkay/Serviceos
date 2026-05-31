import { WorkerHandler, QueueMessage } from '../queues/queue';
import { Logger } from '../logging/logger';
import { LLMGateway } from '../ai/gateway/gateway';
import { ProposalRepository, createProposal, CreateProposalInput, ProposalType, Proposal } from '../proposals/proposal';
import { assertValidProposalPayload } from '../proposals/contracts';
import {
  classifyIntent,
  ExtractedEntities,
  IntentClassification,
  IntentType,
} from '../ai/orchestration/intent-classifier';
import {
  resolveReferences,
  ConversationReferent,
} from '../ai/orchestration/reference-resolver';
import { InvoiceTaskHandler } from '../ai/tasks/invoice-task';
import { EstimateTaskHandler } from '../ai/tasks/estimate-task';
import { CreateAppointmentAITaskHandler } from '../ai/tasks/create-appointment-task';
import { SlotConflictChecker } from '../ai/tasks/slot-conflict-checker';
import { AvailabilityFinder } from '../ai/tasks/availability-finder';
import { AppointmentRepository } from '../appointments/appointment';
import { JobRepository } from '../jobs/job';
import { InvoiceEditTaskHandler } from '../ai/tasks/invoice-edit-task';
import { EstimateEditTaskHandler } from '../ai/tasks/estimate-edit-task';
import { CreateCustomerTaskHandler, TaskHandler, TaskContext, TaskResult } from '../ai/tasks/task-handlers';
import {
  RescheduleAppointmentTaskHandler,
  CancelAppointmentTaskHandler,
  ReassignAppointmentTaskHandler,
  AddNoteTaskHandler,
  SendInvoiceTaskHandler,
  SendEstimateTaskHandler,
  RecordPaymentTaskHandler,
  CreateJobVoiceTaskHandler,
  EmergencyDispatchTaskHandler,
  UpdateCustomerTaskHandler,
  LogExpenseTaskHandler,
  ConvertLeadTaskHandler,
  ConfirmAppointmentTaskHandler,
  MarkLeadLostTaskHandler,
  AddServiceLocationTaskHandler,
  LogTimeEntryTaskHandler,
  NotifyDelayTaskHandler,
  RequestFeedbackTaskHandler,
} from '../ai/tasks/voice-extended-tasks';
import { instrument } from '../monitoring/instrumentation';

/**
 * voice-action-router — the bridge between "Whisper gave us a
 * transcript" and "a proposal landed in the operator's review queue".
 *
 * Routed intents today:
 *   create_invoice      → draft_invoice proposal   (Phase 1)
 *   draft_estimate      → draft_estimate proposal  (Phase 1)
 *   create_appointment  → create_appointment       (Phase 1)
 *   update_invoice      → update_invoice           (Phase 2 — add/remove line item)
 *   update_estimate     → update_estimate          (Phase 2b — add/remove line item)
 *   create_customer     → create_customer          (AST-01 — CRM record)
 *
 * When classification fails — either the classifier returns 'unknown',
 * confidence falls below the threshold, or the classifier output
 * cannot be parsed — the router emits a `voice_clarification`
 * proposal instead of silently dropping. That proposal is a prompt
 * in the operator's feed ("I heard X but wasn't sure what to do"),
 * not a mutation. It closes when the operator dismisses it or speaks
 * a replacement command.
 */

export interface VoiceActionRouterPayload {
  tenantId: string;
  userId: string;
  transcript: string;
  conversationId?: string;
  recordingId?: string;
  /**
   * Resolved caller identity (caller-ID match). Threaded onto the task
   * context so handlers that need the caller's customer — create/cancel/
   * reschedule appointment — attribute the proposal to the verified
   * caller instead of asking the LLM to guess.
   */
  customerId?: string;
}

/**
 * Optional cross-turn referent provider. When supplied, the router
 * rewrites pronouns in the transcript ("send it to him") with
 * concrete referents pulled from the most recent proposals in the
 * same conversation BEFORE calling the classifier. Keeps the
 * classifier prompt focused on intent detection and avoids
 * repeat-prompt gymnastics for conversational follow-ups.
 */
export interface RecentReferentProvider {
  forConversation(tenantId: string, conversationId: string): Promise<ConversationReferent[]>;
}

export interface VoiceActionRouterDeps {
  gateway: LLMGateway;
  proposalRepo: ProposalRepository;
  recentReferents?: RecentReferentProvider;
  /**
   * Optional: pre-draft slot-conflict checker for `create_appointment`
   * proposals (P0-035). When present, the AI will emit a
   * `voice_clarification` proposal instead of a conflicting
   * `create_appointment` whenever the proposed slot overlaps an
   * existing appointment for the same technician or customer.
   *
   * Wire this in `app.ts` with a `DefaultSlotConflictChecker` whose
   * deps are the same `appointmentRepo`, `assignmentRepo`, and
   * `jobRepo` already in scope. Leaving it undefined preserves the
   * pre-P0-035 behavior — useful for tests that don't care about the
   * pre-check path.
   */
  slotConflictChecker?: SlotConflictChecker;
  /**
   * Optional: availability finder used to surface alternative open
   * slots in the voice_clarification proposal whenever
   * `slotConflictChecker` rejects the AI's proposed time. The
   * dispatcher sees up to 3 next-available windows for the same
   * duration (and same technician, when one was proposed) so they
   * don't have to scan the calendar by hand. Leaving this undefined
   * preserves the no-alternatives wording.
   */
  availabilityFinder?: AvailabilityFinder;
  /**
   * Tier 4 / PR B — per-tenant auto-approve threshold override
   * resolver. When wired, the worker loads the override before
   * createProposal so the persisted Settings UI value affects the
   * threshold decision. Optional: when absent, proposals fall through
   * to DEFAULT_AUTO_APPROVE_THRESHOLDS.
   */
  thresholdResolver?: (tenantId: string) => Promise<
    Partial<Record<'supervisor' | 'tech' | 'both', number>> | undefined
  >;
  /** When provided, the create_appointment handler produces held-slot bookings. */
  appointmentRepo?: AppointmentRepository;
  /**
   * When provided alongside `appointmentRepo`, the reschedule / cancel /
   * confirm handlers scope appointment resolution to the verified caller's
   * own appointments (appointment → job → customerId) instead of the
   * tenant-wide single-active scan. Prevents a caller's "cancel my
   * appointment" from resolving to a different customer's appointment.
   */
  jobRepo?: JobRepository;
  /**
   * §3B/3D/3E — vertical-aware prompt resolver. When wired, the classifier
   * sees the tenant's active pack terminology, intake-disambiguation
   * questions, and objection scripts as a separate system message. Without
   * it the operator's voice commands ("draft an estimate for the Johnson
   * water heater") miss vertical-specific entity terms and the classifier
   * is more likely to bottom out at `unknown` for HVAC/plumbing-shaped
   * utterances. Optional so tests can omit it; production wires
   * `buildVerticalPromptResolver(...)` from `verticals/resolve-active-pack.ts`.
   */
  verticalPromptResolver?: (tenantId: string) => Promise<string | undefined>;
}

// P11-001: lookup_* intents are READ-ONLY and never produce a
// proposal — the Twilio adapter routes them to the lookup-skill family
// directly. They're omitted from this map; the action router falls back
// to `voice_clarification` for any IntentType not present here.
const INTENT_TO_PROPOSAL_TYPE: Partial<Record<Exclude<IntentType, 'unknown'>, ProposalType>> = {
  create_invoice: 'draft_invoice',
  draft_estimate: 'draft_estimate',
  create_appointment: 'create_appointment',
  update_invoice: 'update_invoice',
  update_estimate: 'update_estimate',
  issue_invoice: 'issue_invoice',
  create_customer: 'create_customer',
  create_job: 'create_job',
  reschedule_appointment: 'reschedule_appointment',
  cancel_appointment: 'cancel_appointment',
  reassign_appointment: 'reassign_appointment',
  add_note: 'add_note',
  send_invoice: 'send_invoice',
  send_estimate: 'send_estimate',
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
};

/**
 * Handles "send/issue invoice" voice commands. No LLM call needed —
 * the payload is just { invoiceId }. The invoice ID is resolved from:
 *   1. extractedEntities.jobReference (explicit mention like "invoice 1024")
 *   2. The most recent draft_invoice proposal in the same conversation
 *      (handles "the one we just drafted")
 * If neither resolves, the proposal is created with an empty invoiceId
 * so the execution handler can return a clear validation failure.
 */
class IssueInvoiceTaskHandler implements TaskHandler {
  readonly taskType: ProposalType = 'issue_invoice';

  constructor(
    private readonly proposalRepo: ProposalRepository,
    private readonly thresholdResolver?: (tenantId: string) => Promise<
      Partial<Record<'supervisor' | 'tech' | 'both', number>> | undefined
    >,
  ) {}

  async handle(context: TaskContext): Promise<TaskResult> {
    let invoiceId: string | undefined;

    if (
      context.existingEntities?.jobReference &&
      typeof context.existingEntities.jobReference === 'string'
    ) {
      invoiceId = context.existingEntities.jobReference;
    }

    if (!invoiceId && context.conversationId) {
      const all = await this.proposalRepo.findByTenant(context.tenantId);
      const recentDraft = all
        .filter(
          (p) =>
            p.proposalType === 'draft_invoice' &&
            p.sourceContext?.conversationId === context.conversationId &&
            p.resultEntityId
        )
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0];
      if (recentDraft?.resultEntityId) {
        invoiceId = recentDraft.resultEntityId;
      }
    }

    // Codex P2 (PR #316): prefer the override the router already
    // resolved at request entry. Re-resolving here means a transient
    // failure on this single handler can desync issue_invoice from
    // the rest of the request's intents (which use context). Fall
    // back to the resolver only when context didn't carry one (e.g.
    // legacy callers that don't go through voice-action-router).
    const tenantThresholdOverride =
      context.tenantThresholdOverride
      ?? (this.thresholdResolver
        ? await this.thresholdResolver(context.tenantId).catch(() => undefined)
        : undefined);

    const input: CreateProposalInput = {
      tenantId: context.tenantId,
      proposalType: 'issue_invoice',
      payload: invoiceId ? { invoiceId } : {},
      summary: invoiceId
        ? `Issue invoice ${invoiceId}`
        : context.message,
      sourceContext: context.conversationId ? { conversationId: context.conversationId } : undefined,
      createdBy: context.userId,
      ...(tenantThresholdOverride ? { tenantThresholdOverride } : {}),
    };

    const proposal = createProposal(input);
    return { proposal, taskType: 'issue_invoice' };
  }
}

function buildHandlers(deps: VoiceActionRouterDeps): Map<ProposalType, TaskHandler> {
  const handlers = new Map<ProposalType, TaskHandler>();
  handlers.set('draft_invoice', new InvoiceTaskHandler(deps.gateway));
  handlers.set('draft_estimate', new EstimateTaskHandler(deps.gateway));
  handlers.set(
    'create_appointment',
    new CreateAppointmentAITaskHandler(
      deps.gateway,
      deps.slotConflictChecker,
      deps.availabilityFinder,
      deps.appointmentRepo,
    ),
  );
  handlers.set('update_invoice', new InvoiceEditTaskHandler(deps.gateway));
  handlers.set('update_estimate', new EstimateEditTaskHandler(deps.gateway));
  handlers.set('issue_invoice', new IssueInvoiceTaskHandler(deps.proposalRepo, deps.thresholdResolver));
  handlers.set('create_customer', new CreateCustomerTaskHandler());
  handlers.set('create_job', new CreateJobVoiceTaskHandler());
  handlers.set(
    'reschedule_appointment',
    new RescheduleAppointmentTaskHandler(deps.gateway, deps.appointmentRepo, deps.jobRepo),
  );
  handlers.set(
    'cancel_appointment',
    new CancelAppointmentTaskHandler(deps.appointmentRepo, deps.jobRepo),
  );
  handlers.set('reassign_appointment', new ReassignAppointmentTaskHandler());
  handlers.set('add_note', new AddNoteTaskHandler());
  handlers.set('send_invoice', new SendInvoiceTaskHandler());
  handlers.set('send_estimate', new SendEstimateTaskHandler());
  handlers.set('record_payment', new RecordPaymentTaskHandler());
  handlers.set('emergency_dispatch', new EmergencyDispatchTaskHandler());
  handlers.set('update_customer', new UpdateCustomerTaskHandler());
  handlers.set('log_expense', new LogExpenseTaskHandler());
  handlers.set('convert_lead', new ConvertLeadTaskHandler());
  handlers.set('confirm_appointment', new ConfirmAppointmentTaskHandler(deps.appointmentRepo, deps.jobRepo));
  handlers.set('mark_lead_lost', new MarkLeadLostTaskHandler());
  handlers.set('add_service_location', new AddServiceLocationTaskHandler());
  handlers.set('log_time_entry', new LogTimeEntryTaskHandler());
  handlers.set('notify_delay', new NotifyDelayTaskHandler(deps.appointmentRepo));
  handlers.set('request_feedback', new RequestFeedbackTaskHandler());
  return handlers;
}

/**
 * Processing-level idempotency guard for at-least-once queue redelivery.
 *
 * The transcription worker enqueues each `voice_action_router` job with a
 * deterministic idempotencyKey (`${tenantId}:${recordingId}:voice_action_router`),
 * so the pg-queue dedups double *enqueues*. But a single message that is
 * redelivered after a worker crash/timeout (the at-least-once contract)
 * would otherwise re-run classification and create a SECOND proposal —
 * and for the held-slot `create_appointment` path, a second tentative
 * appointment hold (a real double-booking).
 *
 * We stamp `recordingId` onto every persisted proposal's `sourceContext`
 * (clarification proposals already carry it; the task path is stamped in
 * the worker before `create`). Before doing any work we look for an
 * existing proposal with the same `recordingId` and skip if found — the
 * same "look up by stable key, skip if already processed" contract used by
 * `handleWebhookEvent` in webhooks/webhook-handler.ts.
 *
 * Returns the existing proposal id when this message has already been
 * processed, otherwise undefined. No-ops (returns undefined) when no
 * recordingId is present — the in-app voice path is synchronous and not
 * subject to queue redelivery.
 */
async function findAlreadyProcessed(
  proposalRepo: ProposalRepository,
  tenantId: string,
  recordingId: string | undefined,
): Promise<string | undefined> {
  if (!recordingId) return undefined;
  const existing = await proposalRepo.findByTenant(tenantId);
  const match = existing.find((p) => {
    const sc = p.sourceContext as Record<string, unknown> | undefined;
    return sc !== undefined && sc.recordingId === recordingId;
  });
  return match?.id;
}

/**
 * Stamp the originating `recordingId` onto a proposal's sourceContext so a
 * redelivered message can detect it was already processed. Returns the
 * proposal unchanged when there's no recordingId.
 */
function stampRecordingId(proposal: Proposal, recordingId: string | undefined): Proposal {
  if (!recordingId) return proposal;
  return {
    ...proposal,
    sourceContext: { ...(proposal.sourceContext ?? {}), recordingId },
  };
}

/**
 * The classifier surfaces the new customer's name as `displayName` to
 * keep it distinct from `customerName` (which references an existing
 * customer on invoice/estimate/appointment intents). The
 * create_customer proposal contract expects `name`, so we translate
 * here — at the router boundary — so the task handler stays a dumb
 * passthrough and every downstream payload matches the Zod schema.
 */
function entitiesForProposal(
  intent: Exclude<IntentType, 'unknown'>,
  entities: ExtractedEntities | undefined
): Record<string, unknown> | undefined {
  if (intent !== 'create_customer' || !entities) {
    return entities as Record<string, unknown> | undefined;
  }
  const payload: Record<string, unknown> = {};
  if (entities.displayName) payload.name = entities.displayName;
  if (entities.email) payload.email = entities.email;
  if (entities.phone) payload.phone = entities.phone;
  return payload;
}

/**
 * Sanitize the classifier's free-text reasoning before persisting it
 * on a proposal. Bounds length and strips control characters so the
 * LLM can't inject terminal escapes, log-split payloads, or excessive
 * content into the audit trail. Safe to render in HTML because
 * control characters are removed; downstream renderers still own
 * HTML escaping.
 */
const CLASSIFIER_REASONING_MAX_CHARS = 200;
// eslint-disable-next-line no-control-regex
const CONTROL_CHAR_REGEX = /[\x00-\x1f\x7f]/g;
export function sanitizeReasoning(raw: string): string {
  const stripped = raw.replace(CONTROL_CHAR_REGEX, ' ').trim();
  if (stripped.length <= CLASSIFIER_REASONING_MAX_CHARS) return stripped;
  return `${stripped.slice(0, CLASSIFIER_REASONING_MAX_CHARS - 1)}…`;
}

/**
 * Build a short, operator-friendly summary for a clarification card.
 * Keeps the transcript prefix short so the summary fits in the feed
 * row without truncation.
 */
function clarificationSummary(transcript: string): string {
  const trimmed = transcript.trim();
  const head = trimmed.length > 60 ? `${trimmed.slice(0, 57)}…` : trimmed;
  return `Didn't catch that: "${head}"`;
}

/**
 * Human phrasing for each unknown-reason. Used as the clarification
 * proposal's `explanation`, shown in the review card's "why this
 * suggestion" expando.
 */
function clarificationExplanation(classification: IntentClassification): string {
  switch (classification.unknownReason) {
    case 'low_confidence':
      return classification.lowConfidenceIntent
        ? `Heard this as possibly "${classification.lowConfidenceIntent.replace(
            /_/g,
            ' '
          )}" but not confidently (${classification.confidence.toFixed(
            2
          )}). Tap a suggestion below or try again.`
        : `Not confident enough to route this (${classification.confidence.toFixed(2)}). Try again?`;
    case 'parse_failed':
      return 'The classifier returned an unexpected response. Try again — the transcript was heard but not understood.';
    case 'empty_transcript':
      return 'No speech detected in the recording.';
    case 'unknown_intent':
    default:
      return 'Heard the transcript but did not recognize an action we support yet. Try rephrasing, or use the screen UI.';
  }
}

async function emitClarification(
  deps: VoiceActionRouterDeps,
  input: {
    tenantId: string;
    userId: string;
    transcript: string;
    classification: IntentClassification;
    conversationId?: string;
    recordingId?: string;
  },
  log: Logger
): Promise<void> {
  const { tenantId, userId, transcript, classification, conversationId, recordingId } = input;
  const reason = classification.unknownReason ?? 'unknown_intent';

  const suggestedIntents: string[] = [];
  if (classification.lowConfidenceIntent) {
    suggestedIntents.push(classification.lowConfidenceIntent);
  }

  // classifierReasoning is LLM-generated text — derived from a
  // user-controlled transcript, so it's semi-untrusted. Truncate to
  // bound DB growth and strip control characters so it can't carry
  // terminal escapes or log-injection payloads into downstream
  // consumers. The full raw reasoning is still available in the
  // structured info log emitted below for debugging.
  const sanitizedReasoning = classification.reasoning
    ? sanitizeReasoning(classification.reasoning)
    : undefined;

  const payload = {
    transcript: transcript.trim(),
    reason,
    ...(suggestedIntents.length > 0 ? { suggestedIntents } : {}),
    ...(sanitizedReasoning ? { classifierReasoning: sanitizedReasoning } : {}),
    ...(classification.confidence > 0
      ? { classifierConfidence: classification.confidence }
      : {}),
    ...(recordingId ? { recordingId } : {}),
    ...(conversationId ? { conversationId } : {}),
  };

  const tenantThresholdOverride = deps.thresholdResolver
    ? await deps.thresholdResolver(tenantId).catch(() => undefined)
    : undefined;

  // P2-002 AI-safety gate. The clarification payload is built
  // by-construction above, but the validator pins the contract so a
  // future edit that drops `transcript` or `reason` trips here
  // instead of writing a malformed proposal to storage.
  assertValidProposalPayload('voice_clarification', payload);

  const proposal = createProposal({
    tenantId,
    proposalType: 'voice_clarification',
    payload,
    summary: clarificationSummary(transcript),
    explanation: clarificationExplanation(classification),
    confidenceScore: classification.confidence,
    sourceContext: {
      source: 'voice',
      transcript: transcript.trim(),
      ...(conversationId ? { conversationId } : {}),
      ...(recordingId ? { recordingId } : {}),
    },
    ...(tenantThresholdOverride ? { tenantThresholdOverride } : {}),
    createdBy: userId,
    // Deliberately NO sourceTrustTier. decideInitialStatus will land
    // this in 'draft' regardless of reason/confidence. A clarification
    // is never auto-approved and has no execution handler — the only
    // terminal transitions are `rejected` (operator dismissed) or
    // `expired`.
  });

  await deps.proposalRepo.create(proposal);

  log.info('voice-action-router: clarification proposal emitted', {
    proposalId: proposal.id,
    reason,
    confidence: classification.confidence,
    lowConfidenceIntent: classification.lowConfidenceIntent,
  });
}

export function createVoiceActionRouterWorker(
  deps: VoiceActionRouterDeps
): WorkerHandler<VoiceActionRouterPayload> {
  const handlers = buildHandlers(deps);

  // §11 H3: Wrap the per-message handler with instrument() so any
  // unexpected throw inside the routing pipeline is tagged
  // `path=voice-action-router` (plus tenant_id when available) and
  // captured to Sentry before the error rethrows. Per-handler failures
  // already log via the worker runtime; this captures the structural
  // ones (gateway timeouts, repo errors, classifier crashes).
  const handle = instrument(
    async (
      message: QueueMessage<VoiceActionRouterPayload>,
      logger: Logger
    ): Promise<void> => {
      const { tenantId, userId, transcript, conversationId, recordingId, customerId } = message.payload;

      const log = logger.child({ tenantId, recordingId, transcriptLen: transcript.length });
      log.info('voice-action-router: classifying transcript');

      // Empty/whitespace transcripts carry no intent and nothing for
      // the operator to clarify — skip silently. Upstream voice
      // recording validation already rejects <500ms audio and
      // surfaces that to the UI.
      if (!transcript || transcript.trim().length === 0) {
        log.info('voice-action-router: empty transcript, skipping');
        return;
      }

      // Idempotency guard (at-least-once redelivery). If a proposal already
      // exists for this recordingId we've processed this message before —
      // skip BEFORE classification + any held-slot appointment creation so a
      // redelivery can't double-book. No-op for the in-app path (no recordingId).
      const alreadyProcessedId = await findAlreadyProcessed(
        deps.proposalRepo,
        tenantId,
        recordingId,
      );
      if (alreadyProcessedId) {
        log.info('voice-action-router: duplicate message skipped', {
          recordingId,
          existingProposalId: alreadyProcessedId,
        });
        return;
      }

      // Cross-turn reference rewrite. Pronouns and "the X" references
      // get replaced with concrete referents from the most recent
      // proposal in the same conversation — purely deterministic,
      // no extra LLM call. When no referent provider is wired the
      // transcript is unchanged (backward compatible).
      let effectiveTranscript = transcript;
      if (deps.recentReferents && conversationId) {
        try {
          const recent = await deps.recentReferents.forConversation(tenantId, conversationId);
          const resolution = resolveReferences(transcript, { recentReferents: recent });
          if (resolution.rewrote) {
            effectiveTranscript = resolution.transcript;
            log.info('voice-action-router: pronouns rewritten', {
              substitutions: resolution.substitutions,
            });
          }
        } catch (err) {
          // Referent lookup failures are non-fatal — fall back to the
          // raw transcript rather than breaking the pipeline.
          const error = err instanceof Error ? err : new Error(String(err));
          log.warn('voice-action-router: reference resolver failed, continuing with raw transcript', {
            error: error.message,
          });
        }
      }

      // §3B/3D/3E — resolve the tenant's vertical context once per
      // request (the resolver memoizes internally) so the classifier
      // sees HVAC/plumbing terminology, intake-disambiguation
      // questions, and objection scripts in its system messages. A
      // resolver failure is non-fatal — fall back to the bare classifier.
      let verticalPromptSection: string | undefined;
      if (deps.verticalPromptResolver) {
        try {
          verticalPromptSection = await deps.verticalPromptResolver(tenantId);
        } catch (err) {
          const error = err instanceof Error ? err : new Error(String(err));
          log.warn('voice-action-router: verticalPromptResolver failed, continuing without vertical context', {
            error: error.message,
          });
        }
      }

      const classification = await classifyIntent(
        effectiveTranscript,
        { tenantId, ...(verticalPromptSection ? { verticalPromptSection } : {}) },
        deps.gateway,
      );

      // Surface enum-validation drift from the classifier so prompt
      // regressions are debuggable. Dropped-value behavior (field
      // left undefined on the extracted entities) is preserved —
      // we just no longer do it silently.
      if (classification.invalidEnumFields && classification.invalidEnumFields.length > 0) {
        log.warn('voice-action-router: classifier returned invalid enum values', {
          invalidEnumFields: classification.invalidEnumFields,
          intentType: classification.intentType,
        });
      }

      if (classification.intentType === 'unknown') {
        // Emit a clarification proposal instead of dropping. The
        // operator sees "I heard X but wasn't sure what to do",
        // tries again or dismisses. Silent drops break the product
        // promise that every utterance has a visible outcome.
        await emitClarification(
          deps,
          {
            tenantId,
            userId,
            transcript: effectiveTranscript,
            classification,
            conversationId,
            recordingId,
          },
          log
        );
        return;
      }

      const proposalType = INTENT_TO_PROPOSAL_TYPE[classification.intentType];
      const handler = proposalType ? handlers.get(proposalType) : undefined;
      if (!handler) {
        // P11-001: lookup_* intents have no proposal mapping (read-only,
        // routed to skill family by the FSM adapter). They're not a
        // worker concern — bail without warning.
        log.warn('voice-action-router: no handler for intent', {
          intent: classification.intentType,
          proposalType,
        });
        return;
      }

      // PR B — resolve the tenant's auto-approve threshold override
      // ONCE per request and place it on the task context. Each
      // handler picks it up and threads it through its
      // CreateProposalInput. Best-effort: a resolver hiccup degrades
      // to the locked product defaults rather than blocking the call.
      const tenantThresholdOverride = deps.thresholdResolver
        ? await deps.thresholdResolver(tenantId).catch(() => undefined)
        : undefined;

      const context: TaskContext = {
        tenantId,
        userId,
        // Task handlers see the REWRITTEN transcript so proposals
        // that reach review carry the resolved entity names, not the
        // original pronouns.
        message: effectiveTranscript,
        conversationId,
        existingEntities: entitiesForProposal(
          classification.intentType,
          classification.extractedEntities
        ),
        ...(customerId ? { customerId } : {}),
        ...(tenantThresholdOverride ? { tenantThresholdOverride } : {}),
      };

      const { proposal } = await handler.handle(context);
      // Stamp recordingId so a redelivered message sees this proposal and
      // short-circuits in findAlreadyProcessed above. Clarification proposals
      // already carry recordingId via emitClarification's sourceContext.
      await deps.proposalRepo.create(stampRecordingId(proposal, recordingId));

      log.info('voice-action-router: proposal created from voice', {
        proposalId: proposal.id,
        proposalType: proposal.proposalType,
        classifierConfidence: classification.confidence,
        proposalConfidence: proposal.confidenceScore,
      });
    },
    {
      path: 'voice-action-router',
      extractTags: (message) => ({
        tenant_id: message.payload.tenantId,
      }),
    },
  );

  return {
    type: 'voice_action_router',
    handle,
  };
}
