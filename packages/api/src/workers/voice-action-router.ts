import { WorkerHandler, QueueMessage } from '../queues/queue';
import { Logger } from '../logging/logger';
import { LLMGateway } from '../ai/gateway/gateway';
import { Proposal, ProposalRepository, createProposal, CreateProposalInput, ProposalType } from '../proposals/proposal';
import { assertValidProposalPayload } from '../proposals/contracts';
import { isSupervisorPresent } from '../ai/supervisor-presence';
import { routeUnsupervisedProposal } from '../proposals/auto-approve';
import { renderProposalSms } from '../proposals/sms/render';
import type { RouteUnsupervisedProposalDeps } from '../proposals/auto-approve';
import type { AuditRepository } from '../audit/audit';
import type { UnsupervisedProposalRouting } from '../settings/settings';
import { ConflictError } from '../shared/errors';
import { voiceProposalIdempotencyKey } from '../voice/voice-audit';
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
import {
  decomposeTranscript,
  TranscriptSegment,
} from '../ai/orchestration/transcript-decomposer';
import {
  ChainRef,
  applyChainMetadata,
  payloadPathFor,
} from '../proposals/chain';
import { v4 as uuidv4 } from 'uuid';
import { InvoiceTaskHandler } from '../ai/tasks/invoice-task';
import { EstimateTaskHandler } from '../ai/tasks/estimate-task';
import { CreateAppointmentAITaskHandler } from '../ai/tasks/create-appointment-task';
import { DEFAULT_TENANT_TIMEZONE } from '../ai/scheduling/resolve-datetime';
import { SlotConflictChecker } from '../ai/tasks/slot-conflict-checker';
import { AvailabilityFinder } from '../ai/tasks/availability-finder';
import { AppointmentRepository } from '../appointments/appointment';
import { JobRepository } from '../jobs/job';
import { CatalogItemRepository } from '../catalog/catalog-item';
import {
  EntityCandidate,
  EntityKind,
  EntityResolver,
} from '../ai/resolution/entity-resolver';
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

export interface UnsupervisedRoutingDeps extends RouteUnsupervisedProposalDeps {
  resolveOwnerPhone?: (tenantId: string) => Promise<string | null | undefined>;
  resolveRouting?: (tenantId: string) => Promise<UnsupervisedProposalRouting | undefined>;
  /**
   * P2-034 — records the outbound proposal SMS (`proposal_sms_events`,
   * kind `proposal_rendered`) that anchors the inbound reply transport.
   */
  recordSmsEvent?: (args: {
    tenantId: string;
    proposalId: string;
    body: string;
  }) => Promise<void>;
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
  /**
   * Resolves the tenant's scheduling context (IANA timezone) once per
   * request from tenant_settings, mirroring `thresholdResolver`. Threaded
   * onto the TaskContext so the create/reschedule appointment handlers
   * translate spoken times against the TENANT's timezone instead of a
   * hardcoded zone. Best-effort: a resolver hiccup degrades to the product
   * default timezone rather than blocking the call.
   */
  tenantSchedulingResolver?: (
    tenantId: string,
  ) => Promise<{ timezone?: string } | undefined>;
  /**
   * Injectable clock for the scheduling handlers' relative-date resolution
   * ("tomorrow", "next Tuesday"). Defaults to `new Date()` in production;
   * the voice-quality corpus pins it so booking expectations are
   * deterministic. Threaded onto TaskContext.now.
   */
  now?: () => Date;
  /**
   * Multi-action chaining feature gate. When this resolves truthy for a
   * tenant, the router first runs `decomposeTranscript`; a multi-action
   * utterance produces an ORDERED chain of linked proposals instead of a
   * single one. When absent or falsy, the router uses the existing
   * single-intent path verbatim — `decomposeTranscript` is never called,
   * so there is zero added cost or behavior change for tenants without
   * the flag. Optional, like every other dep here.
   */
  multiActionEnabled?: (tenantId: string) => Promise<boolean>;
  /**
   * P22 catalog grounding for the draft_invoice / draft_estimate
   * handlers. When present, drafted line items are resolved against the
   * tenant's active catalog and matched prices override the LLM's
   * numbers (ambiguous → operator picks; uncatalogued → confidence
   * capped below auto-approve). Optional so tests without a catalog
   * keep the pre-P22 behavior.
   */
  catalogRepo?: CatalogItemRepository;
  /**
   * P8 — "three Bobs" closure. When present, the classifier's free-text
   * customerName / jobReference are resolved to tenant-scoped IDs
   * BEFORE the task handler runs: resolved → verified UUIDs land on the
   * task context; ambiguous → a voice_clarification with the candidate
   * list replaces the draft (no LLM drafting call is wasted);
   * not_found → the raw reference is stamped on
   * sourceContext.pendingReference for the review UI. Annotate-only:
   * resolution never changes proposal status or approval logic.
   * Production wires `PgEntityResolver` (pg_trgm); optional so tests
   * without it keep the pre-resolver behavior.
   */
  entityResolver?: EntityResolver;
  /**
   * P12-004 — routes review-held proposals when no supervisor is present.
   * Production sends a one-tap approval SMS for queue_and_sms tenants and
   * records the unsupervised routing audit event. Optional for tests.
   */
  unsupervisedRouting?: UnsupervisedRoutingDeps;
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
  handlers.set('draft_invoice', new InvoiceTaskHandler(deps.gateway, deps.catalogRepo));
  handlers.set('draft_estimate', new EstimateTaskHandler(deps.gateway, deps.catalogRepo));
  handlers.set(
    'create_appointment',
    new CreateAppointmentAITaskHandler(
      deps.gateway,
      deps.slotConflictChecker,
      deps.availabilityFinder,
      deps.appointmentRepo,
      deps.jobRepo,
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
  handlers.set('notify_delay', new NotifyDelayTaskHandler(deps.appointmentRepo, deps.jobRepo));
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
 * Matches on EITHER anchor a prior delivery may have left behind:
 *   - single-action proposals carry the deterministic `idempotencyKey`
 *     (voiceProposalIdempotencyKey) — also the anchor for the atomic
 *     ON CONFLICT guard that covers the concurrent race;
 *   - chain members are persisted keyless (one recording → many proposals,
 *     so they can't share one key) but each carries `recordingId` on
 *     `sourceContext`. Matching that anchor too means a sequential chain
 *     redelivery (the common at-least-once case) is still suppressed here.
 *
 * Concurrent CHAIN redelivery (two workers past this check at once) has no
 * atomic backstop — keyless members can't collide on the unique index — so
 * it can still double-create. That window is narrow (needs >visibility-timeout
 * processing) and matches the pre-existing chain behavior; see PR follow-ups.
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
  const key = voiceProposalIdempotencyKey(recordingId);
  // Indexed lookup (P1): matches the single-action atomic key OR a chain
  // member's sourceContext.recordingId, without scanning every proposal for
  // the tenant on each inbound message.
  const match = await proposalRepo.findByRecordingId(tenantId, recordingId, key);
  return match?.id;
}

/**
 * Stamp the originating `recordingId` onto a proposal's sourceContext for
 * traceability. Used on every persisted voice proposal (single-action AND
 * chain members). Deliberately does NOT set an idempotencyKey: chain members
 * share one recordingId but must each persist via `createMany`, so a shared
 * key would collide. Returns the proposal unchanged when there's no recordingId.
 */
function stampRecordingId(proposal: Proposal, recordingId: string | undefined): Proposal {
  if (!recordingId) return proposal;
  return {
    ...proposal,
    sourceContext: { ...(proposal.sourceContext ?? {}), recordingId },
  };
}

/**
 * Single-action stamp: sourceContext traceability PLUS a deterministic
 * `idempotencyKey` (so the pre-check and a *concurrent* redelivery dedup
 * atomically on one shared key via the proposals table's ON CONFLICT index).
 * Only safe on the single-action path, where one recording yields exactly one
 * proposal. Chains use the keyless `stampRecordingId` above.
 */
function stampSingleActionDedup(proposal: Proposal, recordingId: string | undefined): Proposal {
  if (!recordingId) return proposal;
  return {
    ...proposal,
    sourceContext: { ...(proposal.sourceContext ?? {}), recordingId },
    idempotencyKey: proposal.idempotencyKey ?? voiceProposalIdempotencyKey(recordingId),
  };
}

/**
 * Persist a proposal, treating an idempotency-key conflict as a successful
 * dedup rather than an error. The pre-check (findAlreadyProcessed) catches
 * the common sequential-redelivery case; this catches the concurrent case
 * where two deliveries both pass the pre-check and race to create — the DB
 * (or in-memory) unique constraint lets exactly one win and the loser's
 * ConflictError is swallowed here instead of failing the message.
 *
 * Only swallowed for KEYED proposals: a ConflictError can only come from the
 * idempotency-key constraint when a key is set, so guarding on it avoids
 * masking any future unrelated uniqueness violation on a keyless proposal.
 */
async function createDeduped(
  repo: ProposalRepository,
  proposal: Proposal,
  recordingId: string | undefined,
  log: Logger,
): Promise<void> {
  try {
    await repo.create(proposal);
  } catch (err) {
    if (err instanceof ConflictError && proposal.idempotencyKey) {
      log.info('voice-action-router: duplicate proposal create skipped (idempotency conflict)', {
        recordingId,
        idempotencyKey: proposal.idempotencyKey,
      });
      return;
    }
    throw err;
  }
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

/** Resolved-entity annotation for one utterance (see annotateResolvedEntities). */
interface EntityAnnotation {
  kind: 'ok';
  resolved: { customerId?: string; jobId?: string };
  pendingReferences: Array<{ kind: EntityKind; reference: string }>;
}
/** An ambiguous reference that must be clarified before drafting. */
interface EntityAmbiguity {
  kind: 'ambiguous';
  entityKind: EntityKind;
  reference: string;
  candidates: EntityCandidate[];
}

/**
 * Resolve the classifier's free-text entity references against
 * tenant-scoped records (P8 "three Bobs"). Best-effort by design:
 * a resolver failure logs a warning and behaves like 'skipped' —
 * entity resolution must never block or fail a drafting pipeline that
 * worked without it.
 *
 * The verified caller-ID identity is sacred: when `verifiedCustomerId`
 * is present, the spoken customerName is NOT resolved (a caller saying
 * a name must never reassign the proposal to a different customer).
 */
async function annotateResolvedEntities(
  resolver: EntityResolver | undefined,
  params: {
    tenantId: string;
    entities: ExtractedEntities | undefined;
    verifiedCustomerId?: string;
  },
  log: Logger,
): Promise<EntityAnnotation | EntityAmbiguity> {
  const ok: EntityAnnotation = { kind: 'ok', resolved: {}, pendingReferences: [] };
  if (!resolver || !params.entities) return ok;

  const lookups: Array<{ kind: 'customer' | 'job'; reference: string }> = [];
  if (params.entities.customerName && !params.verifiedCustomerId) {
    lookups.push({ kind: 'customer', reference: params.entities.customerName });
  }
  if (params.entities.jobReference) {
    lookups.push({ kind: 'job', reference: params.entities.jobReference });
  }

  for (const lookup of lookups) {
    let result;
    try {
      result = await resolver.resolve({
        tenantId: params.tenantId,
        reference: lookup.reference,
        kind: lookup.kind,
      });
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      log.warn('voice-action-router: entity resolver failed, continuing unresolved', {
        entityKind: lookup.kind,
        error: error.message,
      });
      continue;
    }
    switch (result.kind) {
      case 'resolved':
        if (lookup.kind === 'customer') ok.resolved.customerId = result.candidate.id;
        else ok.resolved.jobId = result.candidate.id;
        break;
      case 'ambiguous':
        // First ambiguity wins — one clarification per utterance keeps
        // the operator's feed to a single, answerable question.
        return {
          kind: 'ambiguous',
          entityKind: lookup.kind,
          reference: lookup.reference,
          candidates: result.candidates,
        };
      case 'not_found':
        ok.pendingReferences.push({ kind: lookup.kind, reference: lookup.reference });
        break;
      case 'skipped':
        break;
    }
  }
  return ok;
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
    /**
     * Dedup key for this clarification. Set only on the single-action path
     * (one recording → one proposal). Left undefined for chain segments,
     * where a recording can legitimately emit several clarifications that
     * must not collide on one key.
     */
    idempotencyKey?: string;
    /**
     * P8 — set when the intent classified fine but an entity reference
     * matched several records ("three Bobs"). The clarification carries
     * the candidate list so the review UI can render a one-tap picker.
     */
    entityAmbiguity?: {
      entityKind: EntityKind;
      reference: string;
      candidates: EntityCandidate[];
    };
  },
  log: Logger
): Promise<void> {
  const { tenantId, userId, transcript, classification, conversationId, recordingId } = input;
  const reason = input.entityAmbiguity
    ? 'ambiguous_entity'
    : (classification.unknownReason ?? 'unknown_intent');

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
    ...(input.entityAmbiguity
      ? {
          entityReference: input.entityAmbiguity.reference,
          entityCandidates: input.entityAmbiguity.candidates.map((c) => ({
            id: c.id,
            label: c.label,
            ...(c.hint ? { hint: c.hint } : {}),
            score: c.score,
          })),
        }
      : {}),
  };

  const tenantThresholdOverride = deps.thresholdResolver
    ? await deps.thresholdResolver(tenantId).catch(() => undefined)
    : undefined;

  // P2-002 AI-safety gate. The clarification payload is built
  // by-construction above, but the validator pins the contract so a
  // future edit that drops `transcript` or `reason` trips here
  // instead of writing a malformed proposal to storage.
  assertValidProposalPayload('voice_clarification', payload);

  // Entity ambiguity is a different question than "didn't catch that" —
  // the intent was understood; the operator just picks WHICH record.
  const summary = input.entityAmbiguity
    ? `Which ${input.entityAmbiguity.entityKind}? "${input.entityAmbiguity.reference}" matched ${input.entityAmbiguity.candidates.length} records`
    : clarificationSummary(transcript);
  const explanation = input.entityAmbiguity
    ? `Heard the request, but "${input.entityAmbiguity.reference}" matches more than one ${input.entityAmbiguity.entityKind}. Tap the right one below.`
    : clarificationExplanation(classification);

  const proposal = createProposal({
    tenantId,
    proposalType: 'voice_clarification',
    payload,
    summary,
    explanation,
    confidenceScore: classification.confidence,
    sourceContext: {
      source: 'voice',
      transcript: transcript.trim(),
      ...(conversationId ? { conversationId } : {}),
      ...(recordingId ? { recordingId } : {}),
    },
    // Same deterministic key as the single-action task path so a redelivered
    // message dedups atomically regardless of which proposal type it produced.
    // Only set on the single-action path (passed in); chains leave it undefined.
    ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
    ...(tenantThresholdOverride ? { tenantThresholdOverride } : {}),
    createdBy: userId,
    // Deliberately NO sourceTrustTier. decideInitialStatus will land
    // this in 'draft' regardless of reason/confidence. A clarification
    // is never auto-approved and has no execution handler — the only
    // terminal transitions are `rejected` (operator dismissed) or
    // `expired`.
  });

  await createDeduped(deps.proposalRepo, proposal, recordingId, log);

  log.info('voice-action-router: clarification proposal emitted', {
    proposalId: proposal.id,
    reason,
    confidence: classification.confidence,
    lowConfidenceIntent: classification.lowConfidenceIntent,
  });
}

/**
 * Per-segment parameters shared by the single-intent path and each
 * iteration of the multi-action chain loop.
 */
interface SegmentParams {
  tenantId: string;
  userId: string;
  segmentText: string;
  conversationId?: string;
  recordingId?: string;
  customerId?: string;
  verticalPromptSection?: string;
  /**
   * When true (single-action path only), thread `recordingId` into the task
   * context — so the held-slot appointment is keyed `voice-hold:<recordingId>`
   * — and stamp the clarification dedup key. Left false/undefined for chain
   * segments, which share one recordingId across several proposals and so
   * must not collide on these per-recording keys.
   */
  applyDedup?: boolean;
}

type SegmentOutcome =
  | {
      kind: 'proposal';
      proposal: Proposal;
      classification: IntentClassification;
      /** Tenant-wide presence at routing time (P12-004 unsupervised routing). */
      supervisorPresent: boolean;
    }
  // The classifier could not route this segment — a voice_clarification
  // was emitted in its place (single path) or should be (chain path; see
  // processChain). `classification` is returned so the caller can decide.
  | { kind: 'clarified'; classification: IntentClassification }
  // A real intent with no proposal mapping (lookup_* etc.) — nothing to
  // do for this worker.
  | { kind: 'skipped'; classification: IntentClassification };

/**
 * Classify a single (sub-)utterance and build its proposal WITHOUT
 * persisting it. Mirrors the original single-intent body exactly so the
 * flag-off path is unchanged; the chain loop reuses it per segment and
 * stamps chain metadata before persisting.
 *
 * For an 'unknown' classification this emits a voice_clarification
 * itself (clarifications are independent, terminal records) and returns
 * `clarified` so the caller does not also persist a proposal.
 */
async function processSegment(
  deps: VoiceActionRouterDeps,
  handlers: Map<ProposalType, TaskHandler>,
  params: SegmentParams,
  log: Logger,
): Promise<SegmentOutcome> {
  const { tenantId, userId, segmentText, conversationId, recordingId, customerId } = params;

  const classification = await classifyIntent(
    segmentText,
    { tenantId, ...(params.verticalPromptSection ? { verticalPromptSection: params.verticalPromptSection } : {}) },
    deps.gateway,
  );

  if (classification.invalidEnumFields && classification.invalidEnumFields.length > 0) {
    log.warn('voice-action-router: classifier returned invalid enum values', {
      invalidEnumFields: classification.invalidEnumFields,
      intentType: classification.intentType,
    });
  }

  if (classification.intentType === 'unknown') {
    await emitClarification(
      deps,
      {
        tenantId,
        userId,
        transcript: segmentText,
        classification,
        conversationId,
        recordingId,
        // Single-action only: dedup a redelivered clarification atomically.
        ...(params.applyDedup && recordingId
          ? { idempotencyKey: voiceProposalIdempotencyKey(recordingId) }
          : {}),
      },
      log,
    );
    return { kind: 'clarified', classification };
  }

  const proposalType = INTENT_TO_PROPOSAL_TYPE[classification.intentType];
  const handler = proposalType ? handlers.get(proposalType) : undefined;
  if (!handler) {
    log.warn('voice-action-router: no handler for intent', {
      intent: classification.intentType,
      proposalType,
    });
    return { kind: 'skipped', classification };
  }

  // P8 — resolve free-text entity references to verified tenant IDs
  // before drafting. Runs after the handler lookup so lookup_*/unknown
  // paths never pay for it; an ambiguous reference short-circuits to a
  // clarification BEFORE the (more expensive) LLM drafting call.
  const annotation = await annotateResolvedEntities(
    deps.entityResolver,
    {
      tenantId,
      entities: classification.extractedEntities,
      ...(customerId ? { verifiedCustomerId: customerId } : {}),
    },
    log,
  );
  if (annotation.kind === 'ambiguous') {
    await emitClarification(
      deps,
      {
        tenantId,
        userId,
        transcript: segmentText,
        classification,
        conversationId,
        recordingId,
        entityAmbiguity: {
          entityKind: annotation.entityKind,
          reference: annotation.reference,
          candidates: annotation.candidates,
        },
        ...(params.applyDedup && recordingId
          ? { idempotencyKey: voiceProposalIdempotencyKey(recordingId) }
          : {}),
      },
      log,
    );
    return { kind: 'clarified', classification };
  }

  const tenantThresholdOverride = deps.thresholdResolver
    ? await deps.thresholdResolver(tenantId).catch(() => undefined)
    : undefined;

  // Resolve the tenant's timezone (best-effort) so the create/reschedule
  // appointment handlers translate spoken times against the right zone
  // instead of a hardcoded one. Falls back to the product default.
  const scheduling = deps.tenantSchedulingResolver
    ? await deps.tenantSchedulingResolver(tenantId).catch(() => undefined)
    : undefined;

  // Phase 12 supervisor gate. Resolve presence once per request and thread
  // it onto the context so an autonomous, capture-class proposal (today:
  // create_appointment / create_booking) can only auto-approve when a
  // supervisor is actually on the wall. Reads the singleton wired in app.ts
  // (pgSupervisorPresenceLoader); in tests with no loader it returns the
  // permissive default, preserving existing fixtures. Without this the
  // proposal-status decision used a permissive default and voice bookings
  // auto-executed with no human in the loop.
  const supervisorPresent = await isSupervisorPresent(tenantId);

  const context: TaskContext = {
    tenantId,
    userId,
    message: segmentText,
    conversationId,
    existingEntities: {
      ...entitiesForProposal(classification.intentType, classification.extractedEntities),
      // P8 — resolved IDs ride the context entities so the drafting LLM
      // (and passthrough handlers) get verified UUIDs instead of free text.
      ...(annotation.resolved.customerId ? { customerId: annotation.resolved.customerId } : {}),
      ...(annotation.resolved.jobId ? { jobId: annotation.resolved.jobId } : {}),
    },
    timezone: scheduling?.timezone ?? DEFAULT_TENANT_TIMEZONE,
    now: deps.now ? deps.now() : new Date(),
    supervisorPresent,
    // Verified caller-ID identity wins; a resolver hit fills it only
    // when caller-ID didn't establish one.
    ...((customerId ?? annotation.resolved.customerId)
      ? { customerId: customerId ?? annotation.resolved.customerId }
      : {}),
    // Single-action only: lets the held-slot path key the appointment on
    // `voice-hold:<recordingId>` so a concurrent redelivery can't double-book.
    ...(params.applyDedup && recordingId ? { recordingId } : {}),
    ...(tenantThresholdOverride ? { tenantThresholdOverride } : {}),
  };

  const { proposal } = await handler.handle(context);
  // P8 — references that matched nothing are stamped on sourceContext so
  // the review UI prompts "pick from the list or create new" instead of
  // the operator discovering a dangling name at execution time.
  const annotated =
    annotation.pendingReferences.length > 0
      ? {
          ...proposal,
          sourceContext: {
            ...(proposal.sourceContext ?? {}),
            pendingReference: annotation.pendingReferences,
          },
        }
      : proposal;
  // Chokepoint backstop for the "never auto-execute when unsupervised"
  // invariant. Every task handler forwards supervisorPresent into its
  // CreateProposalInput, but this is the single place every voice-sourced
  // proposal flows through — so even a future autonomous handler that forgets
  // to thread presence can't slip an auto-approved (→ auto-executing) proposal
  // past an unsupervised tenant. No-op in the normal case (the handler already
  // computed 'ready_for_review').
  return {
    kind: 'proposal',
    proposal: holdIfUnsupervised(annotated, supervisorPresent),
    classification,
    supervisorPresent,
  };
}

/**
 * Downgrade an auto-approved proposal to the review queue when the tenant is
 * unsupervised. Pure — returns the proposal unchanged unless it would
 * auto-execute (status 'approved') with no supervisor present.
 */
function holdIfUnsupervised(proposal: Proposal, supervisorPresent: boolean): Proposal {
  if (supervisorPresent || proposal.status !== 'approved') return proposal;
  return { ...proposal, status: 'ready_for_review', approvedAt: undefined };
}

/**
 * Process a multi-action chain: classify each segment in order, link the
 * resulting proposals with a shared chainId, rewrite dependent payload
 * fields with symbolic reference tokens, and persist parents-first so a
 * partial crash leaves resolvable parents behind.
 *
 * Per-segment clarification is preserved: a segment that fails to
 * classify becomes a voice_clarification (tagged with the chain) and the
 * chain proceeds. A later segment that depended on a clarified/ skipped
 * segment is still created but left with its unresolved token in
 * missingFields, so it surfaces in review as needing manual resolution
 * rather than silently executing against a missing parent.
 */
async function processChain(
  deps: VoiceActionRouterDeps,
  handlers: Map<ProposalType, TaskHandler>,
  segments: TranscriptSegment[],
  base: Omit<SegmentParams, 'segmentText'>,
  log: Logger,
): Promise<void> {
  const chainId = uuidv4();
  const chainLength = segments.length;

  // First pass: classify each segment and build its proposal (without
  // persisting). Clarifications are emitted inline by processSegment as
  // they happen — they are independent records, not chain members.
  const built: { proposal: Proposal; chainIndex: number; refCount: number; type: string }[] = [];

  for (const segment of segments) {
    const outcome = await processSegment(
      deps,
      handlers,
      { ...base, segmentText: segment.text },
      log,
    );

    if (outcome.kind !== 'proposal') {
      log.info('voice-action-router: chain segment did not produce a proposal', {
        chainId,
        chainIndex: segment.index,
        outcome: outcome.kind,
      });
      continue;
    }

    const proposal = outcome.proposal;

    // Build the dependency edges this segment can actually consume. The
    // decomposer suggests (parentIndex, entityKind); we only wire an
    // edge when this proposal type has a payload field for that kind.
    const chainRefs: ChainRef[] = [];
    if (segment.dependsOn.length > 0 && segment.dependencyEntityKind) {
      for (const parentChainIndex of segment.dependsOn) {
        const payloadPath = payloadPathFor(proposal.proposalType, segment.dependencyEntityKind);
        if (!payloadPath) continue;
        chainRefs.push({
          payloadPath,
          parentChainIndex,
          entityKind: segment.dependencyEntityKind,
        });
      }
    }

    applyChainMetadata(proposal, {
      chainId,
      chainIndex: segment.index,
      chainLength,
      dependsOnChainIndices: segment.dependsOn,
      chainRefs,
    });

    built.push({
      // Stamp the originating recordingId onto sourceContext (alongside the
      // chain metadata) — keyless, since chain members can't share one
      // idempotencyKey. findAlreadyProcessed matches this recordingId so a
      // SEQUENTIAL chain redelivery short-circuits once the chain is
      // persisted. (Concurrent chain redelivery has no atomic backstop.)
      proposal: stampRecordingId(proposal, base.recordingId),
      chainIndex: segment.index,
      refCount: chainRefs.length,
      type: proposal.proposalType,
    });
  }

  if (built.length === 0) {
    log.info('voice-action-router: chain produced no proposals', { chainId, chainLength });
    return;
  }

  // Second pass: persist every chain member atomically. A partial
  // failure must not leave orphaned members (e.g. a parent with no
  // dependents, or dependents whose parent never landed), so all writes
  // share one transaction.
  await deps.proposalRepo.createMany(built.map((b) => b.proposal));

  for (const b of built) {
    log.info('voice-action-router: chain proposal created', {
      chainId,
      chainIndex: b.chainIndex,
      proposalId: b.proposal.id,
      proposalType: b.type,
      refCount: b.refCount,
    });
  }

  log.info('voice-action-router: chain complete', {
    chainId,
    chainLength,
    createdCount: built.length,
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

      // Multi-action chaining (feature-flagged). When enabled AND the
      // utterance decomposes into more than one action, route each
      // segment through the existing single-intent pipeline and link the
      // resulting proposals into a chain. Otherwise fall through to the
      // unchanged single-intent path. `decomposeTranscript` is only
      // called when the flag is on, so flag-off tenants pay nothing and
      // behave exactly as before.
      let chainEnabled = false;
      if (deps.multiActionEnabled) {
        try {
          chainEnabled = await deps.multiActionEnabled(tenantId);
        } catch (err) {
          const error = err instanceof Error ? err : new Error(String(err));
          log.warn('voice-action-router: multiActionEnabled resolver failed, single-intent path', {
            error: error.message,
          });
        }
      }

      if (chainEnabled) {
        let decomposition;
        try {
          decomposition = await decomposeTranscript(
            effectiveTranscript,
            { tenantId },
            deps.gateway,
          );
        } catch (err) {
          // Decomposer failure is non-fatal — fall back to the single
          // path rather than dropping the utterance.
          const error = err instanceof Error ? err : new Error(String(err));
          log.warn('voice-action-router: decomposeTranscript failed, single-intent path', {
            error: error.message,
          });
          decomposition = undefined;
        }

        if (decomposition && decomposition.isMultiAction) {
          await processChain(
            deps,
            handlers,
            decomposition.segments,
            {
              tenantId,
              userId,
              conversationId,
              recordingId,
              customerId,
              verticalPromptSection,
            },
            log,
          );
          return;
        }
      }

      const outcome = await processSegment(
        deps,
        handlers,
        {
          tenantId,
          userId,
          segmentText: effectiveTranscript,
          conversationId,
          recordingId,
          customerId,
          verticalPromptSection,
          // Single-action path: apply the per-recording dedup keys.
          applyDedup: true,
        },
        log,
      );

      if (outcome.kind === 'proposal') {
        await createDeduped(
          deps.proposalRepo,
          stampSingleActionDedup(outcome.proposal, recordingId),
          recordingId,
          log,
        );
        log.info('voice-action-router: proposal created from voice', {
          proposalId: outcome.proposal.id,
          proposalType: outcome.proposal.proposalType,
          classifierConfidence: outcome.classification.confidence,
          proposalConfidence: outcome.proposal.confidenceScore,
        });

        // P12-004 — unsupervised routing. The proposal just queued with no
        // supervisor on the wall: apply the tenant-configured routing
        // (`queue_and_sms` default → one-tap approve SMS to the owner) and
        // emit the `unsupervised_proposal_routed` audit event. Best-effort:
        // a routing failure never fails the (already persisted) proposal.
        if (
          deps.unsupervisedRouting &&
          !outcome.supervisorPresent &&
          outcome.proposal.status === 'ready_for_review'
        ) {
          const ur = deps.unsupervisedRouting;
          try {
            const routing = await ur.resolveRouting?.(tenantId);
            const ownerPhone = await ur.resolveOwnerPhone?.(tenantId);
            const proposal = outcome.proposal;
            await routeUnsupervisedProposal(
              {
                auditRepo: ur.auditRepo,
                ...(ur.sendSms ? { sendSms: ur.sendSms } : {}),
                ...(ur.secret ? { secret: ur.secret } : {}),
                ...(ur.buildApproveUrl ? { buildApproveUrl: ur.buildApproveUrl } : {}),
                // P2-034 — persist the outbound render so the inbound
                // Y/N/EDIT reply handler can resolve which proposal the
                // owner is answering.
                ...(ur.recordSmsEvent
                  ? {
                      onSmsSent: async ({ body }: { body: string }) =>
                        ur.recordSmsEvent!({
                          tenantId,
                          proposalId: proposal.id,
                          body,
                        }),
                    }
                  : {}),
              },
              {
                tenantId,
                proposalId: proposal.id,
                ...(routing ? { routing } : {}),
                // Operator voice recordings are not a live inbound call, so
                // `escalate_to_oncall` falls back to queue_only here by design.
                channel: 'other',
                ...(ownerPhone ? { ownerPhone } : {}),
                summaryText: proposal.summary,
                // P2-034 — full reply-token body (summary + facts +
                // "Reply Y/N/EDIT" + the one-tap link).
                renderSmsBody: (approveUrl: string) =>
                  renderProposalSms(
                    {
                      proposalType: proposal.proposalType,
                      summary: proposal.summary,
                      payload: proposal.payload,
                    },
                    { approveUrl },
                  ),
              },
            );
          } catch (err) {
            log.warn('voice-action-router: unsupervised routing failed', {
              proposalId: outcome.proposal.id,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }
      }
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
