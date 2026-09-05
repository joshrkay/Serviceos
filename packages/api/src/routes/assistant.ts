import { Router, Response } from 'express';
import { z } from 'zod';
import { v4 as uuidv4 } from 'uuid';
import {
  centsToInputValue,
  isCentsKey,
  isFlatMissingField,
  labelForMissingField,
  readStructuredAddress,
  resolveSpokenAddress,
  EN_ROUTE_SMS_KEYWORDS,
} from '@ai-service-os/shared';
import { AuthenticatedRequest } from '../auth/clerk';
import { requireAuth, requireTenant, requirePermission } from '../middleware/auth';
import { hasPermission, isValidRole, type Permission, type Role } from '../auth/rbac';
import { toErrorResponse } from '../shared/errors';
import { LLMGateway } from '../ai/gateway/gateway';
import { Proposal, ProposalRepository, ProposalType } from '../proposals/proposal';
// PR-0a (#967, #962) — the shared chain-metadata stamper the voice/memo
// path (workers/voice-action-router.ts) already uses. The chat chain block
// below previously wrote sourceContext.chainId only, never the TOP-LEVEL
// Proposal.chainId column this helper sets — the column findByChain and
// the web Inbox's groupIntoFeed both key on.
import { applyChainMetadata } from '../proposals/chain';
// Aliased — the card field this feeds is also called `undoExpiresAt`.
import {
  undoExpiresAt as undoWindowCloseAt,
  undoRemainingMs as undoWindowRemainingMs,
} from '../proposals/lifecycle';
import { createAuditEvent, type AuditRepository } from '../audit/audit';
import {
  recordAssistantTurn,
  type ConversationRepository,
} from '../conversations/conversation-service';
import {
  classifyIntent,
  isLookupIntent,
  isVoiceApprovalIntent,
  isVoiceEditIntent,
  CLASSIFIER_CONFIDENCE_THRESHOLD,
} from '../ai/orchestration/intent-classifier';
// Lookup wiring (2026-07): `lookup_*` intents previously matched nothing in
// either dispatch map below and fell through to the generic LLM — which has
// no DB access and answered from nothing (production: ZERO `ai_runs` rows
// with model='data-lookup' or a lookup task_type, ever). They now dispatch
// through the SAME per-skill implementation the recorded-memo worker uses
// (`workers/voice-lookup-answer.ts#executeLookupAnswer`); the module below
// is a thin surface adapter, NOT a second copy of the switch.
import {
  dispatchAssistantLookup,
  type AssistantLookupDeps,
} from '../ai/orchestration/lookup-dispatch';
// #847 — en_route ("on my way") from chat: the same technician core the
// recorded-memo wrapper and the phone surface (Gather branch + media-streams
// speechTurn) drive. (The SMS keyword leg fires the same audited
// `triggerEnRoute` act but still resolves inline rather than through this
// core — a filed follow-up.) A DIRECT status act (F-3), never a proposal —
// which is why it is dispatched from its own branch below rather than added
// to CHAT_INTENT_TO_REGISTRY_KEY (that map is intent → proposal type, and
// its key set is pinned by test/routes/assistant-dropped-intents.test.ts).
import { ambiguousReferenceLine } from '../ai/orchestration/lookup-reference';
import {
  handleEnRouteForTechnician,
  technicianNameIfKnown,
  type EnRouteTechnicianDeps,
} from '../dispatch/en-route-voice';
import { resolveCanonicalUser, type UserRepository } from '../users/user';
// Honest-failure guard (2026-07). The intent path can end without a proposal
// three different ways, and every one of them used to fall into the same
// DB-less generic LLM — which cheerfully replied "I've scheduled you for two
// hours on this job." having scheduled nothing. See the module header for the
// production evidence and the three-layer shape.
import {
  isActionIntent,
  detectFabricatedActionClaim,
  buildUnmappedCapabilityReply,
  buildNotUnderstoodReply,
  buildClassifierErrorReply,
  NO_ACTION_TAKEN_DIRECTIVE,
} from '../ai/orchestration/assistant-honesty-guard';
import type { TaskHandler } from '../ai/tasks/task-handlers';
// Money/edit/send handlers are no longer constructed inline here — both
// dispatch maps resolve them from the shared handler-registry below.
// B5 — the scheduling-family / create_job / invoice-follow-up intents this
// route was missing (12 in total) are drafted by the SAME handler-registry
// builder workers/voice-action-router.ts's buildHandlers uses, so the two
// surfaces can't diverge again — see the doc comment on HandlerRegistryDeps.
// B4 — issue_invoice joined this shared registry too (see
// HandlerRegistryDeps.proposalRepo in ai/orchestration/handler-registry.ts).
import { buildTaskHandlers } from '../ai/orchestration/handler-registry';
// U1 (voice back-office workflows) — chat-surface parity with the voice
// worker's P8 pre-draft entity resolution: the SAME intent-conditioned
// resolver the voice-action-router runs (annotateResolvedEntities) now runs
// here before drafting, so "send the Henderson invoice" typed into chat
// resolves to a verified invoiceId exactly as the spoken memo does.
import { resolveVoiceEntityReferences } from '../ai/agents/customer-calling/entity-resolution';
import type { EntityResolver } from '../ai/resolution/entity-resolver';
// #909 — the POST-draft half of the same loop. Pre-draft resolution
// (`resolveVerifiedIdsForDraft` below) can only resolve what the classifier
// happened to extract into the fields `planVoiceEntityLookups` reads; the
// gate a handler actually stamps is on the PAYLOAD, and until now nothing
// resolved that. Sixteen capabilities drafted a proposal carrying only free
// text and stalled at ready_for_review permanently. See the module doc on
// ai/resolution/gated-reference-resolution.ts.
import {
  resolveGatedReferences,
  applyGatedReferences,
  stampPendingAmbiguity,
  pendingAmbiguityOf,
  clearPendingAmbiguity,
  buildDisambiguationQuestion,
  buildGatedReferenceReply,
  isDisambiguationAnswer,
  PENDING_AMBIGUITY_KEY,
} from '../ai/resolution/gated-reference-resolution';
import {
  resolveDisambiguationFollowUp,
  MAX_DISAMBIGUATION_ATTEMPTS,
  type PendingEntityAmbiguity,
} from '../ai/agents/customer-calling/entity-resolution';
// Phase 12 supervisor gate (commit 1 of the followup-autoapprove-default
// fix) — mirrors workers/voice-action-router.ts's use of the SAME function:
// resolve tenant-wide supervisor presence once per turn and thread it onto
// every dispatched TaskContext so an autonomous, capture-class proposal
// (draft_estimate / draft_invoice / update_estimate / update_invoice /
// update_job / create_appointment / create_booking) can only auto-approve
// when a supervisor is actually on duty. Before this, chat never threaded
// supervisorPresent/supervisorMode at all, so `resolveAutoApproveThreshold`
// silently fell through to the permissive LEGACY_AUTO_APPROVE_THRESHOLD
// (0.9) regardless of real tenant supervision — see auto-approve.ts and
// CHAT_CONTEXT_CUSTOMER_ID_INTENTS's doc comment (C1) for the full history.
// `isSupervisorPresent` never throws (its own internal try/catch degrades
// to the permissive `true` default), so no wrapping try/catch is needed
// here — same as the voice worker's call site.
import { isSupervisorPresent } from '../ai/supervisor-presence';
// Minor fix (post-C1 review) — reuse the shared `Mode` type instead of a
// hand-rolled `'supervisor' | 'tech' | 'both'` structural union.
import type { Mode } from '../proposals/auto-approve';
// I4 (post-C1 review) — the memo worker's chokepoint backstop, reused
// as-is rather than re-implemented: pure, already tested
// (test/workers/voice-action-router*.test.ts), and importing it keeps the
// downgrade rule in exactly one place instead of two copies that could
// drift. `routes -> workers` imports are an existing pattern in this
// codebase (see routes/admin-tenants.ts, routes/onboarding.ts).
import { holdIfUnsupervised } from '../workers/voice-action-router';
import type { InvoiceRepository } from '../invoices/invoice';
import type { CatalogItemRepository } from '../catalog/catalog-item';
import type { EstimateRepository } from '../estimates/estimate';
import type { AppointmentRepository } from '../appointments/appointment';
import type { JobRepository } from '../jobs/job';
import type { DunningEventRepository } from '../invoices/dunning-config';
import type { CustomerRepository } from '../customers/customer';
import type { LocationRepository } from '../locations/location';
import type { StandingInstruction } from '../instructions/standing-instructions';
import { selectInjectedStandingInstructions } from '../ai/standing-instructions-context';
import { createLogger } from '../logging/logger';

const logger = createLogger({
  service: 'routes.assistant',
  environment: process.env.NODE_ENV || 'development',
});

const assistantMessageSchema = z.object({
  role: z.enum(['system', 'user', 'assistant']),
  content: z.string().min(1),
});

/**
 * UI proposal shape consumed by AssistantPage + AIProposalCard. Narrower
 * than the server-side Proposal — the card only renders a title, summary,
 * optional edit fields, and a coarse confidence band. 'Customer' was
 * added alongside AST-01b so create_customer proposals have a home in
 * the UI type switch.
 */
const assistantProposalSchema = z.object({
  id: z.string(),
  title: z.string(),
  summary: z.string(),
  explanation: z.string(),
  reasoning: z.array(z.string()).optional(),
  // `kind` (review J5) tells the card how to PARSE the typed input before
  // it reaches `PUT /api/proposals/:id { edits }`. Absent means 'text',
  // which is what every pre-existing emitter produces, so this stays
  // backward compatible. A 'cents' field is DOLLARS in the input and
  // integer cents on the wire.
  editFields: z
    .array(
      z.object({
        label: z.string(),
        key: z.string(),
        value: z.string(),
        kind: z.enum(['text', 'cents', 'number']).optional(),
      }),
    )
    .optional(),
  confidence: z.enum(['High', 'Medium']),
  type: z.enum(['Invoice', 'Estimate', 'Schedule', 'Follow-up', 'Alert', 'Duplicate', 'Customer']),
  // QA-2026-06-05: LLMs emit free-form statuses ('Sent', 'Draft', …) —
  // coerce anything unknown to 'Pending' instead of discarding the reply.
  status: z.preprocess(
    (v) => (v === 'Approved' || v === 'Rejected' ? v : 'Pending'),
    z.enum(['Pending', 'Approved', 'Rejected'])
  ),
  /**
   * Follow-up (auto-approved undo parity) — the instant the server's 5s undo
   * window closes for an already-'Approved' card, so the chat surface can
   * raise the SAME `UndoToast` an operator-tapped approval raises. Only set
   * for auto-approved cards; an operator-tapped approval gets its window from
   * the approve response instead.
   *
   * The client anchors its countdown to this instant rather than a fresh
   * client 5s, so the part of the window the chat round-trip already spent is
   * never offered back — `useUndoableApproval` leaves the affordance inactive
   * when nothing is left, instead of offering an undo `POST
   * /api/proposals/:id/undo` would 409 with UNDO_WINDOW_CLOSED.
   */
  undoExpiresAt: z.string().nullish().transform((v) => v ?? undefined),
  undoRemainingMs: z.number().nullish().transform((v) => v ?? undefined),
  // QA-2026-06-05: LLMs emit JSON null for "no value" — .optional() alone
  // rejects null, so every estimate-draft completion whose relatedId/impact
  // was null failed validation and degraded to the fallback envelope
  // (live: "LLM completion failed ... expected string, received null").
  relatedId: z.string().nullish().transform((v) => v ?? undefined),
  impact: z.string().nullish().transform((v) => v ?? undefined),
  // E10 (U7) — pass-through of the trust signals AIProposalCard already
  // renders: the 4-tier confidence + severity badge + "what I wasn't sure
  // about" markers (`_meta`), the per-line catalog-grounding source
  // (`lineItems[].pricingSource`), and the unfilled-required-field prompt
  // (`missingFields`) that blocks Approve. Every field is `.nullish()` so a
  // normal complete proposal — and the QA-2026-06-05 null-coercion / status
  // -preprocess envelope — still validates unchanged.
  meta: z
    .object({
      overallConfidence: z.enum(['high', 'medium', 'low', 'very_low']).nullish().transform((v) => v ?? undefined),
      severity: z
        .enum(['TIER_1_EVACUATE', 'TIER_2_EMERGENCY_DISPATCH', 'TIER_3_SAME_DAY_URGENT', 'TIER_4_SCHEDULE'])
        .nullish()
        .transform((v) => v ?? undefined),
      markers: z
        .array(z.object({ path: z.string(), reason: z.string() }))
        .nullish()
        .transform((v) => v ?? undefined),
      // UB-A3 — "Standing instruction applied" chips on the assistant card.
      appliedStandingInstructions: z
        .array(z.object({ id: z.string(), text: z.string() }))
        .nullish()
        .transform((v) => v ?? undefined),
    })
    .nullish()
    .transform((v) => v ?? undefined),
  lineItems: z
    .array(
      z.object({
        description: z.string().nullish().transform((v) => v ?? undefined),
        pricingSource: z
          .enum(['catalog', 'ambiguous', 'uncatalogued', 'manual'])
          .nullish()
          .transform((v) => v ?? undefined),
      }),
    )
    .nullish()
    .transform((v) => v ?? undefined),
  missingFields: z.array(z.string()).nullish().transform((v) => v ?? undefined),
  /**
   * The address a `missingFields: ['locationId']` gate needs in order to be
   * closable by a human. Without it the card shows a bare "locationId"
   * prompt and the operator has no way to know WHICH address was spoken —
   * the gate becomes a dead end and the booking is stuck exactly as hard as
   * the execution failure it replaced. Carries the preserved address, where
   * it was recovered from, and a structured prefill for the address inputs.
   */
  serviceLocationGap: z
    .object({
      customerId: z.string(),
      recoveredAddress: z.string().nullish().transform((v) => v ?? undefined),
      recoveredFrom: z
        .enum(['communication_notes', 'transcript'])
        .nullish()
        .transform((v) => v ?? undefined),
      prefill: z.record(z.string()).nullish().transform((v) => v ?? undefined),
      stillMissing: z.array(z.string()).nullish().transform((v) => v ?? undefined),
    })
    .nullish()
    .transform((v) => v ?? undefined),
  /**
   * The internal proposal type, so the card can special-case a family
   * without pattern-matching on the humanized `type` label.
   */
  proposalType: z.string().nullish().transform((v) => v ?? undefined),
  /**
   * The ADDRESS SLICE of a `create_customer` payload, passed through
   * verbatim — the free-text `address` the technician spoke plus whatever
   * structured fields already exist.
   *
   * Deliberately NOT pre-resolved into "here are the inputs to render".
   * This card shape is the fourth allowlist a spoken address had to survive
   * (classifier prompt → ExtractedEntities → the classifier sanitizer →
   * entitiesForProposal → HERE), and every previous one broke by rebuilding
   * an object and quietly dropping a key. So the server hands over the raw
   * keys and the card calls the SAME `resolveSpokenAddress` the execution
   * handler uses to decide what's missing — one implementation, no chance of
   * the card and the writer disagreeing about "complete".
   */
  addressCapture: z
    .object({
      address: z.string().nullish().transform((v) => v ?? undefined),
      street1: z.string().nullish().transform((v) => v ?? undefined),
      street2: z.string().nullish().transform((v) => v ?? undefined),
      city: z.string().nullish().transform((v) => v ?? undefined),
      state: z.string().nullish().transform((v) => v ?? undefined),
      postalCode: z.string().nullish().transform((v) => v ?? undefined),
      country: z.string().nullish().transform((v) => v ?? undefined),
    })
    .nullish()
    .transform((v) => v ?? undefined),
});

const assistantReplySchema = z.object({
  content: z.string().min(1),
  reasoning: z.string().optional(),
  autoApplied: z.boolean().optional(),
  proposal: assistantProposalSchema.nullable().optional(),
});

const assistantChatRequestSchema = z.object({
  messages: z.array(assistantMessageSchema).min(1),
  stream: z.boolean().optional(),
  // Story 3.11 — the client pins the running conversation so each turn persists
  // to the same thread; omitted on the first turn (server opens a new one).
  conversationId: z.string().optional(),
  // UB-B3 — how the operator produced this message. 'voice' turns (conversation
  // mode / PTT transcripts) are refused approval/reject/edit intents: in-app
  // voice approval stays deferred (RV-071/RV-225 posture — approvals are a
  // screen tap here).
  inputMode: z.enum(['voice', 'text']).optional(),
});

/**
 * UB-B3 — deterministic refusal copy for voice-mode approval intents.
 *
 * Re-exported, not re-declared: the in-app voice-session adapter refuses the
 * same three intents with the same sentence (see the constant's doc comment in
 * `tts-copy.ts`), and two literals would drift the moment either is reworded.
 * Kept exported from here because this route's tests and callers already
 * import it by this name.
 */
import { VOICE_APPROVAL_REFUSAL } from '../ai/agents/customer-calling/tts-copy';
export { VOICE_APPROVAL_REFUSAL };

/**
 * The "nothing happened" sentence is no longer assembled here.
 *
 * PR #776 gave every unrouted turn one blanket clarification
 * (`assistant.clarification`, built by a local `buildUnroutedClarification`).
 * That collapsed three genuinely different failures into one reply and — worse
 * — left a CONFIDENT but unmapped write intent falling through to the generic
 * LLM, which is the same fabrication path it was written to close.
 *
 * The copy now lives with the taxonomy in `ai/orchestration/assistant-honesty-guard`,
 * where each of the three outcomes states the absence of action in its own
 * words:
 *   assistant.unhandled.<intent>  "I haven't created, changed, or scheduled anything."
 *   assistant.not_understood      "I haven't scheduled, logged, or changed anything."
 *   assistant.intent_failed       "I can't confirm anything went through."
 * The last is deliberately weaker: a throw AFTER a proposal was persisted is
 * possible, so it must not assert that nothing was written.
 */

function inferTaskType(text: string): string {
  const t = text.toLowerCase();
  if (t.includes('invoice') || t.includes('payment') || t.includes('overdue')) return 'assistant.invoice';
  if (t.includes('schedule') || t.includes('tomorrow') || t.includes('dispatch')) return 'assistant.schedule';
  if (t.includes('follow-up') || t.includes('follow up') || t.includes('reminder')) return 'assistant.followup';
  if (t.includes('estimate') || t.includes('quote')) return 'assistant.estimate';
  return 'assistant.general';
}

/**
 * Per-task system prompts. The "you have taken no action" rule is NOT applied
 * here: `NO_ACTION_TAKEN_DIRECTIVE` is appended unconditionally at the gateway
 * call site below, so it covers every taskType rather than only
 * `assistant.general`. PR #776 added a near-identical rule to this function's
 * default branch only; keeping both would have meant two copies of the same
 * instruction in one prompt for general turns and none at all for the
 * invoice/schedule/followup/estimate turns, which can fabricate just as well.
 */
function getSystemPrompt(taskType: string): string {
  if (taskType === 'assistant.invoice') {
    return 'You are a field-service assistant. Focus on invoice recommendations, payment status, and concise next actions.';
  }
  if (taskType === 'assistant.schedule') {
    return 'You are a field-service assistant. Focus on dispatch scheduling, availability, and conflict-free recommendations.';
  }
  if (taskType === 'assistant.followup') {
    return 'You are a field-service assistant. Focus on customer follow-up drafting with polite and actionable language.';
  }
  if (taskType === 'assistant.estimate') {
    return 'You are a field-service assistant. Focus on estimate clarity, scope, and customer-ready language.';
  }
  return 'You are a field-service assistant. Provide concise, high-signal operational help for jobs, customers, schedule, and billing.';
}

const outputContract = `
Return JSON only. No markdown. Match this schema exactly:
{
  "content": "assistant message text",
  "reasoning": "short optional rationale",
  "autoApplied": false,
  "proposal": null
}
"proposal" must ALWAYS be null on this path. You have no tools and no
database access, so you cannot draft, price, or persist a reviewable
proposal — only the field-service handlers this app dispatches to can do
that. Never invent a "proposal" object, an id, a title, or any other field
that implies a reviewable card exists. If the user's request needs one,
say so in "content" instead of fabricating it.
`;

/**
 * #847 — everything the chat surface needs to fire "on my way", as ONE
 * optional bundle (same convention as `AssistantLookupDeps`).
 * `EnRouteTechnicianDeps` is the shared core's set — app.ts wires its
 * `enRouteCoordinator` to the SAME DelayNotificationCoordinator instance the
 * app button / SMS / memo legs use. `userRepo` is this surface's own: it
 * resolves `req.auth.userId` (a Clerk subject) to the canonical, role-checked
 * technician row via `resolveCanonicalUser`.
 */
export interface AssistantEnRouteDeps extends EnRouteTechnicianDeps {
  userRepo: Pick<UserRepository, 'findByTenant'>;
}

export interface AssistantRouterDeps {
  gateway: LLMGateway;
  proposalRepo: ProposalRepository;
  /**
   * QA-2026-06-05 (AST-05): read-only query intents ("which invoices are
   * unpaid?") answer from data instead of LLM narrative. Optional so tests
   * without an invoice repo keep working.
   */
  invoiceRepo?: InvoiceRepository;
  /**
   * §3B/3D/3E — vertical-aware prompt resolver. When wired, the
   * assistant chat classifier sees the tenant's HVAC/plumbing pack
   * terminology + intake-disambiguation questions + objection scripts
   * as a separate system message, matching the voice pipeline. Without
   * it, an operator chatting "draft an estimate for the Johnson water
   * heater" can miss vertical-specific entity terms. Optional so tests
   * can omit it.
   */
  verticalPromptResolver?: (tenantId: string) => Promise<string | undefined>;
  /**
   * UB-A3 — resolves the tenant's ACTIVE standing instructions once per
   * chat turn (production wires `standingInstructionRepo.listActive`).
   * `selectApplicableInstructions` (≤5) narrows per classified intent
   * before drafting. Mirrors `verticalPromptResolver`: optional,
   * failure-soft — a resolver error drafts without owner instructions.
   */
  standingInstructionsResolver?: (tenantId: string) => Promise<StandingInstruction[]>;
  /**
   * P22 — catalog grounding for assistant-drafted invoices/estimates:
   * line items get priced from the tenant's catalog instead of trusting
   * the LLM's invented numbers. Optional so tests can omit it.
   */
  catalogRepo?: CatalogItemRepository;
  /**
   * RV-042 — review-time visibility of acceptance voiding: lets the
   * update_estimate task handler read the targeted estimate and stamp the
   * `_meta.markers` acceptance-void warning when it is currently accepted.
   * Optional; absent -> marker skipped.
   *
   * B5 — widened from a narrow `Pick` to the full repository so the SAME
   * value can also feed batch_invoice's completed-unbilled enumeration
   * (`findJobsRequiringInvoicing`, which needs `EstimateRepository` in
   * full — see `HandlerRegistryDeps.invoicingDeps` in
   * ai/orchestration/handler-registry.ts). Every existing caller already
   * passes a real repository implementation (Pg or in-memory), which
   * satisfies both the old narrow shape and this one, so this is
   * source-compatible.
   */
  estimateRepo?: EstimateRepository;
  /**
   * B5 — appointment resolution for the scheduling-family intents this
   * route was missing (reschedule/cancel/confirm/notify_delay), mirroring
   * `workers/voice-action-router.ts`'s `appointmentRepo`. Optional: absent
   * → those proposals draft gated (`missingFields: ['appointmentId']`)
   * instead of resolving a concrete appointment — the same fail-open
   * posture every other optional dep here already has.
   */
  appointmentRepo?: AppointmentRepository;
  /**
   * B5 — paired with `appointmentRepo` (scopes appointment resolution to
   * appointment → job → customerId) and with `invoiceRepo` + `estimateRepo`
   * for batch_invoice's completed-unbilled enumeration.
   */
  jobRepo?: JobRepository;
  /**
   * B5 — send_payment_reminder's Layer-3 advisory duplicate-reminder
   * marker (draft-time only; never blocks). Optional; absent → no marker,
   * exact pre-B5 drafting.
   */
  dunningEventRepo?: DunningEventRepository;
  /**
   * B8 — create_customer draft-time duplicate detection parity: threaded
   * into `buildTaskHandlers` so this route's create_customer proposals get
   * the SAME dedup-aware `CreateCustomerVoiceTaskHandler` the telephony FSM
   * already uses (`twilio-adapter.ts`), instead of the thin passthrough.
   * Optional; absent → drafts with no dedup check (pre-B8 behavior).
   */
  customerRepo?: CustomerRepository;
  /**
   * create_appointment draft-time bookability. `jobs.location_id` is NOT
   * NULL, so a customer with zero `service_locations` rows cannot be booked
   * — the execution handler fails with "Customer has no service location".
   * Threaded into `buildTaskHandlers` (the SAME registry the voice worker
   * uses) so a booking drafted here gates on the gap instead of
   * auto-approving into a guaranteed failure. Optional; absent → no gate.
   */
  locationRepo?: LocationRepository;
  /**
   * Story 3.11 — persist each chat turn (operator message + agent reply) so the
   * running conversation survives reload and is searchable. Optional so tests
   * without a repo keep working (persistence simply skipped).
   */
  conversationRepo?: ConversationRepository;
  /** Audit sink for the conversation.created event on first persist. */
  auditRepo?: AuditRepository;
  /**
   * Read-only `lookup_*` dispatch. ONE bundle rather than ten sibling repo
   * fields; app.ts passes the SAME `answers`/`shared` objects it already
   * builds for the recorded-memo worker, so the two surfaces cannot be
   * wired with different repos. Optional — absent, lookups keep falling
   * through exactly as they did before (tests that don't care omit it).
   */
  lookups?: AssistantLookupDeps;
  /**
   * #847 — en_route ("on my way") direct status act from chat. Optional —
   * absent, the intent keeps falling into the honest unmapped-capability
   * refusal exactly as before (tests that don't care omit it).
   */
  enRoute?: AssistantEnRouteDeps;
  /**
   * Tenant IANA timezone (`tenant_settings.timezone`), resolved once per
   * request and threaded onto every drafting TaskContext.
   *
   * This route dispatches `create_appointment` (both the single-intent and
   * the multi-action chain path) and, until 2026-07-28, built its TaskContext
   * WITHOUT a timezone — the one scheduling entry point that never resolved
   * one. `CreateAppointmentAITaskHandler` then fell through to its
   * (now-removed) `America/New_York` default, so an operator in
   * America/Phoenix had every spoken booking stored three hours early and
   * auto-executed at confidence 1.
   *
   * Mirrors the voice worker's `tenantSchedulingResolver` and shares the SAME
   * cached settings read in app.ts, so the two surfaces cannot drift on which
   * zone a tenant books in. Optional and failure-soft: absent or throwing ⇒
   * no zone on the context ⇒ the handler emits a clarification rather than
   * booking at a guessed offset.
   */
  tenantTimezoneResolver?: (tenantId: string) => Promise<string | undefined>;
  /**
   * U1 — the SAME tenant-scoped entity resolver the voice-action-router uses
   * (app.ts wires `sharedEntityResolver`: alias-first → pg_trgm, τ_ent=0.80).
   * When present, both drafting paths run intent-conditioned resolution
   * BEFORE the task handler, thread verified ids onto `existingEntities`
   * (the seam the task handlers already consume on the voice path), and
   * stamp them into `sourceContext.verifiedIds` so `dropUnverifiedIds`
   * preserves them — resolver output is a DB lookup, verifiable by
   * construction (see the B4 security note on that function). Optional and
   * failure-soft: absent/ambiguous/not-found/error ⇒ no ids threaded ⇒ the
   * handlers keep today's gated drafting.
   */
  entityResolver?: EntityResolver;
  /**
   * I3 (post-C1 review, followup-autoapprove-default) — per-tenant
   * auto-approve threshold override resolver (`tenant_settings.
   * auto_approve_threshold`, the Settings UI value), mirroring
   * `workers/voice-action-router.ts`'s `thresholdResolver` dep exactly —
   * same shape, same fallback posture (absent/throwing ⇒
   * DEFAULT_AUTO_APPROVE_THRESHOLDS). `resolveAutoApproveThreshold`
   * (proposals/auto-approve.ts) can only consult this map once
   * `supervisorMode` is known — before commit 1, chat never threaded
   * `supervisorMode` at all, so this override was dead-wired on every
   * caller that had it (twilio-adapter.ts, create-voice-turn-processor.ts,
   * inapp-agent's in-app calls — none of which set `supervisorMode`
   * either; see the correction on inapp-adapter.ts's PR B comment). Chat
   * is now the first (and only) place in the codebase where a real
   * `supervisorMode` and a tenant override can meet, so it's threaded here
   * too — see test/routes/assistant-dropped-intents.test.ts's I3 suite for
   * the before/after proof. Optional; absent → the mode-aware defaults.
   */
  thresholdResolver?: (
    tenantId: string,
  ) => Promise<Partial<Record<Mode, number>> | undefined>;
}

export type AssistantProposal = z.infer<typeof assistantProposalSchema>;

/**
 * E10 (U7) — lift the trust signals AIProposalCard renders out of a persisted
 * proposal's `payload._meta` / `payload.lineItems` / `sourceContext.missingFields`
 * onto the UI card shape. Without this the assistant chat card dropped them and
 * an operator could approve an AI-estimated/ambiguous/missing-field proposal
 * into a server rejection.
 *
 * Price-field-agnostic: it reads only `description` + `pricingSource` from each
 * line, so it works for estimates (lines priced in `unitPrice`) and invoices
 * (priced in `unitPriceCents`) alike — it never touches a price field.
 * Every returned key is optional; a fully-grounded complete proposal yields an
 * empty object and the card renders exactly as before.
 */
export function proposalSignals(
  payload: Record<string, unknown> | undefined,
  sourceContext: Record<string, unknown> | undefined,
): Pick<AssistantProposal, 'meta' | 'lineItems' | 'missingFields' | 'serviceLocationGap'> {
  const out: Pick<
    AssistantProposal,
    'meta' | 'lineItems' | 'missingFields' | 'serviceLocationGap'
  > = {};

  const rawMeta = payload?._meta;
  if (rawMeta !== null && typeof rawMeta === 'object') {
    const m = rawMeta as Record<string, unknown>;
    const meta: NonNullable<AssistantProposal['meta']> = {};
    if (
      m.overallConfidence === 'high' ||
      m.overallConfidence === 'medium' ||
      m.overallConfidence === 'low' ||
      m.overallConfidence === 'very_low'
    ) {
      meta.overallConfidence = m.overallConfidence;
    }
    if (
      m.severity === 'TIER_1_EVACUATE' ||
      m.severity === 'TIER_2_EMERGENCY_DISPATCH' ||
      m.severity === 'TIER_3_SAME_DAY_URGENT' ||
      m.severity === 'TIER_4_SCHEDULE'
    ) {
      meta.severity = m.severity;
    }
    if (Array.isArray(m.markers)) {
      const markers = m.markers
        .filter((mk): mk is Record<string, unknown> => mk !== null && typeof mk === 'object')
        .filter((mk) => typeof mk.path === 'string' && typeof mk.reason === 'string')
        .map((mk) => ({ path: mk.path as string, reason: mk.reason as string }));
      if (markers.length > 0) meta.markers = markers;
    }
    // UB-A3 — lift the applied-standing-instruction marker so the assistant
    // card can render its "Standing instruction applied" chips.
    if (Array.isArray(m.appliedStandingInstructions)) {
      const applied = m.appliedStandingInstructions
        .filter((si): si is Record<string, unknown> => si !== null && typeof si === 'object')
        .filter((si) => typeof si.id === 'string' && typeof si.text === 'string')
        .map((si) => ({ id: si.id as string, text: si.text as string }));
      if (applied.length > 0) meta.appliedStandingInstructions = applied;
    }
    if (meta.overallConfidence || meta.severity || meta.markers || meta.appliedStandingInstructions) {
      out.meta = meta;
    }
  }

  const rawLines = payload?.lineItems;
  if (Array.isArray(rawLines)) {
    const lineItems = rawLines
      .filter((li): li is Record<string, unknown> => li !== null && typeof li === 'object')
      .map((li) => {
        const item: {
          description?: string;
          pricingSource?: 'catalog' | 'ambiguous' | 'uncatalogued' | 'manual';
        } = {};
        if (typeof li.description === 'string') item.description = li.description;
        if (
          li.pricingSource === 'catalog' ||
          li.pricingSource === 'ambiguous' ||
          li.pricingSource === 'uncatalogued' ||
          li.pricingSource === 'manual'
        ) {
          item.pricingSource = li.pricingSource;
        }
        return item;
      });
    if (lineItems.length > 0) out.lineItems = lineItems;
  }

  // missingFields lives on sourceContext (createProposal stamps it there to
  // avoid a DB schema change; the catalog resolver appends to it too).
  const rawMissing = sourceContext?.missingFields;
  if (Array.isArray(rawMissing)) {
    const missingFields = rawMissing.filter((f): f is string => typeof f === 'string');
    if (missingFields.length > 0) out.missingFields = missingFields;
  }

  // The companion context for a `missingFields: ['locationId']` gate. This
  // function rebuilds `out` from a whitelist, so anything not lifted HERE is
  // silently dropped no matter how carefully the drafting handler assembled
  // it — the recovered address would never reach the operator and the gate
  // would be unclosable. Lifted with the same defensive shape-checking the
  // other branches use.
  const rawGap = sourceContext?.serviceLocationGap;
  if (rawGap !== null && typeof rawGap === 'object') {
    const g = rawGap as Record<string, unknown>;
    if (typeof g.customerId === 'string' && g.customerId.length > 0) {
      const gap: NonNullable<AssistantProposal['serviceLocationGap']> = {
        customerId: g.customerId,
      };
      if (typeof g.recoveredAddress === 'string' && g.recoveredAddress.length > 0) {
        gap.recoveredAddress = g.recoveredAddress;
      }
      if (g.recoveredFrom === 'communication_notes' || g.recoveredFrom === 'transcript') {
        gap.recoveredFrom = g.recoveredFrom;
      }
      if (g.prefill !== null && typeof g.prefill === 'object') {
        const prefill: Record<string, string> = {};
        for (const [k, v] of Object.entries(g.prefill as Record<string, unknown>)) {
          if (typeof v === 'string' && v.length > 0) prefill[k] = v;
        }
        if (Object.keys(prefill).length > 0) gap.prefill = prefill;
      }
      if (Array.isArray(g.stillMissing)) {
        const stillMissing = g.stillMissing.filter((f): f is string => typeof f === 'string');
        if (stillMissing.length > 0) gap.stillMissing = stillMissing;
      }
      out.serviceLocationGap = gap;
    }
  }

  return out;
}

/**
 * Pull the `create_customer` address slice out of a payload for the review
 * card. Returns `undefined` when there is no address of any kind, so a card
 * for a name-and-phone-only customer looks exactly as it did before.
 *
 * NOTE THE ABSENCE OF A RENAME. Every key here is spelled exactly as it is
 * spelled in `createCustomerPayloadSchema`, so the values the card sends back
 * through `PUT /api/proposals/:id { edits }` land on the payload keys the
 * execution handler reads. A translation layer here is precisely how the
 * address got lost four times already.
 */
export function addressCaptureFor(
  proposalType: string,
  payload: Record<string, unknown>,
): AssistantProposal['addressCapture'] {
  if (proposalType !== 'create_customer') return undefined;
  const resolution = resolveSpokenAddress(payload);
  if (resolution.kind === 'none') return undefined;
  const structured = readStructuredAddress(payload);
  const verbatim = typeof payload.address === 'string' ? payload.address.trim() : '';
  return {
    ...(verbatim ? { address: verbatim } : {}),
    ...structured,
  };
}

/**
 * Review K4 — the persisted explanation WINS; the source echo is the
 * FALLBACK, for the types that persist no reasoning of their own (blank
 * counts as none).
 *
 * Both card serializers on this route call this ONE helper rather than each
 * carrying its own copy of the ternary. K4 fixed `proposalToUI`, which used
 * to overwrite `proposal.explanation` unconditionally and so discarded the
 * only thing on the card that said what the proposal refused to do — a
 * chat-dispatched `update_catalog_item` whose spoken price was rejected
 * showed the operator "Needs: proposedUnitPriceCents" and nothing else. It
 * did NOT fix `customerProposalToUI`, which had the identical defect and is
 * the serializer for the one type that persists an explanation on EVERY
 * draft (`CreateCustomerVoiceTaskHandler`, ai/tasks/create-customer-task.ts —
 * including the lead-match branch, "Approve to convert to customer; reject
 * to keep as lead", which is a decision the approver cannot make without it).
 * Two parallel serializers, one of them silently missing a fix, is exactly
 * the drift K4's own comment warned about, so the rule now lives in one
 * place and cannot be applied to only half the surface again.
 *
 * The 120-char slice on the echo comes from `proposalToUI` and now applies
 * to both: an unbounded verbatim echo of the operator's message was never
 * intended on a card field, and the customer serializer had no cap at all.
 *
 * N8 — the slice now MARKS itself when it bites. The closing quote used to
 * go straight on the end of the cut, so a truncated verbatim quote read as
 * a complete one and the operator had no way to tell "this is all you said"
 * from "this is the first 120 characters of what you said". That is the same
 * honesty class F1 was about, so shipping it on a second serializer was
 * worse than leaving it on one. `truncateForSpeech`
 * (ai/skills/lookup-materials.ts) already marks its own cut this way.
 */
const CARD_ECHO_MAX_CHARS = 120;

export function cardExplanation(persisted: string | undefined, sourceMessage: string): string {
  if (persisted && persisted.trim().length > 0) return persisted;
  const echo =
    sourceMessage.length > CARD_ECHO_MAX_CHARS
      ? `${sourceMessage.slice(0, CARD_ECHO_MAX_CHARS)}…`
      : sourceMessage;
  return `From your message: "${echo}"`;
}

/**
 * Map the server-side create_customer Proposal to the UI card shape.
 * Reads `name` / `email` / `phone` out of the payload (the router
 * translates classifier `displayName` → contract `name` in AST-01).
 *
 * N9 — an OPTIONS OBJECT, not positionals. This grew to six parameters with
 * two optional trailing ones of unrelated types, and the failure mode is
 * silent: a caller that omits the 6th gets a card whose explanation reverts
 * to the source echo — exactly the defect F1 existed to fix, reintroduced by
 * an argument list rather than by any change to this function. Named keys
 * make an omission a compile error at the shape, and make the two optionals
 * unorderable relative to each other.
 */
interface CustomerProposalToUIInput {
  proposalId: string;
  payload: Record<string, unknown>;
  sourceMessage: string;
  confidenceScore: number;
  sourceContext?: Record<string, unknown>;
  /** The drafting handler's own reasoning, as persisted on the row — see `cardExplanation`. */
  explanation?: string;
}

function customerProposalToUI({
  proposalId,
  payload,
  sourceMessage,
  confidenceScore,
  sourceContext,
  explanation,
}: CustomerProposalToUIInput): AssistantProposal {
  const name = typeof payload.name === 'string' && payload.name.length > 0 ? payload.name : undefined;
  const email = typeof payload.email === 'string' ? payload.email : undefined;
  const phone = typeof payload.phone === 'string' ? payload.phone : undefined;

  // The verbatim spoken address belongs in the SUMMARY the approver reads —
  // it is the field that was silently dropped on the way to the CRM, so it
  // has to be visible on the card that authorises the write.
  const spokenAddress = typeof payload.address === 'string' ? payload.address.trim() : '';

  const title = name ? `New customer: ${name}` : 'New customer (needs details)';
  const summary = [
    name ? `Name: ${name}` : 'Name not provided',
    email ? `Email: ${email}` : undefined,
    phone ? `Phone: ${phone}` : undefined,
    spokenAddress ? `Address: ${spokenAddress}` : undefined,
  ]
    .filter(Boolean)
    .join(' · ');

  return {
    id: proposalId,
    title,
    summary: summary || 'Review and approve to add this customer.',
    explanation: cardExplanation(explanation, sourceMessage),
    editFields: [
      { label: 'Name', key: 'name', value: name ?? '' },
      { label: 'Email', key: 'email', value: email ?? '' },
      { label: 'Phone', key: 'phone', value: phone ?? '' },
      // The verbatim spoken address is editable here too. It is the payload's
      // `address` key, unrenamed, so an edit lands where the executor reads.
      { label: 'Address (as spoken)', key: 'address', value: spokenAddress },
    ],
    confidence: confidenceScore >= 0.85 ? 'High' : 'Medium',
    type: 'Customer',
    status: 'Pending',
    proposalType: 'create_customer',
    // The address slice the card turns into "city / state / ZIP" inputs when
    // an address was captured but can't yet satisfy service_locations.
    addressCapture: addressCaptureFor('create_customer', payload),
    // E10 (U7) — surface any missing-field / confidence signals (a
    // create_customer with only a name carries missingFields).
    ...proposalSignals(payload, sourceContext),
  };
}


/**
 * QA-2026-06-05: the assistant accepts FREE TEXT — entity ids in LLM-built
 * payloads must literally appear in the operator's message (or classifier
 * entities); the model may not invent them (live: hallucinated textbook
 * UUIDs sent executions into doomed lookups).
 *
 * B4 — extended with a `sourceContext.verifiedIds` allowlist: an id a task
 * handler resolved via a REPO LOOKUP (not LLM text) — e.g.
 * IssueInvoiceTaskHandler's conversation-context resolution of "the one we
 * just drafted" — is verifiable by construction even though it never
 * literally appears in the operator's words. `verifiedIds` must be stamped
 * ONLY by such repo-lookup code paths (see the doc comment on
 * IssueInvoiceTaskHandler in ai/orchestration/task-router.ts); this function
 * trusts whatever is there, so a handler that ever copied LLM/classifier
 * output into `verifiedIds` would reopen the exact hallucinated-id hole this
 * scrub exists to close. A key present in `payload` but ABSENT from
 * `verifiedIds` (or not exactly matching the verified value) still gets the
 * ordinary haystack check — a hallucinated id is stripped regardless of
 * whether some other key happened to get verified.
 */
// Exported for a direct unit pin on the verifiedIds allowlist semantics
// (test/routes/assistant.route.test.ts) — this is B4's main review surface.
export function dropUnverifiedIds(
  payload: Record<string, unknown>,
  operatorText: string,
  entities: Record<string, unknown>,
  sourceContext?: Record<string, unknown>
): void {
  const haystack = (operatorText + ' ' + JSON.stringify(entities)).toLowerCase();
  const verifiedIds =
    sourceContext?.verifiedIds && typeof sourceContext.verifiedIds === 'object'
      ? (sourceContext.verifiedIds as Record<string, unknown>)
      : undefined;
  for (const key of ['jobId', 'customerId', 'estimateId', 'invoiceId', 'appointmentId']) {
    const v = payload[key];
    if (typeof v !== 'string' || v.length < 32) continue;
    if (haystack.includes(v.toLowerCase())) continue;
    if (verifiedIds && verifiedIds[key] === v) continue;
    delete payload[key];
  }
}

/**
 * U1 — pre-draft entity resolution for the chat surface, mirroring the voice
 * worker's `annotateResolvedEntities` (workers/voice-action-router.ts): run
 * the intent-conditioned resolver over the classifier's free-text references
 * and return ONLY the resolver-verified ids (annotation.resolved — never the
 * classifier's own id-shaped output). Failure-soft by the worker's own
 * convention: an ambiguous reference, a not_found, a missing resolver, or a
 * resolver error all return `{}` so drafting proceeds exactly as it does
 * today (gated missingFields + B2 candidates). Ambiguity on this surface
 * stays a gated card with a candidate picker rather than a
 * voice_clarification — the operator is already looking at a screen.
 */
async function resolveVerifiedIdsForDraft(
  resolver: EntityResolver | undefined,
  tenantId: string,
  intent: string,
  entities: Record<string, unknown> | undefined,
): Promise<Record<string, string>> {
  if (!resolver || !entities) return {};
  try {
    const annotation = await resolveVoiceEntityReferences(resolver, {
      tenantId,
      intent,
      entities,
    });
    if (annotation.kind !== 'ok') return {};
    const resolved: Record<string, string> = {};
    for (const [key, value] of Object.entries(annotation.resolved)) {
      if (typeof value === 'string' && value.length > 0) resolved[key] = value;
    }
    return resolved;
  } catch {
    return {};
  }
}

/**
 * U1 — record route-resolved ids on `sourceContext.verifiedIds` so
 * `dropUnverifiedIds` preserves them (pattern: IssueInvoiceTaskHandler's
 * rung-2 conversation-context resolution, ai/orchestration/task-router.ts).
 * SECURITY: callers must only pass ids from `resolveVerifiedIdsForDraft`
 * (a DB lookup) — never classifier/LLM output. A task handler's own
 * repo-verified `verifiedIds` (e.g. send_estimate_nudge's liftGate) win on
 * key collision; both sources are DB-verified so either value is safe.
 */
function stampVerifiedIds(
  proposal: { sourceContext?: Record<string, unknown> },
  verifiedIds: Record<string, string>,
): void {
  if (Object.keys(verifiedIds).length === 0) return;
  const existing =
    proposal.sourceContext?.verifiedIds && typeof proposal.sourceContext.verifiedIds === 'object'
      ? (proposal.sourceContext.verifiedIds as Record<string, unknown>)
      : {};
  proposal.sourceContext = {
    ...(proposal.sourceContext ?? {}),
    verifiedIds: { ...verifiedIds, ...existing },
  };
}

/**
 * #909 — the chat surface's thin adapter over the gated-reference core.
 *
 * Runs AFTER the drafting handler, over the references the PROPOSAL is
 * carrying, and lifts only the gates it resolves itself. Three outcomes,
 * mirroring the voice FSM's `entity_resolution` state:
 *
 *   unambiguous → the id is filled and that one gate lifts, so the operator's
 *                 very next tap can approve (the failure mode #909 is about:
 *                 approve → 400 {missingFields:[...]} forever).
 *   ambiguous   → NOTHING is filled. The pending question is stamped on the
 *                 proposal and the caller asks it. Never a guess (CLAUDE.md).
 *   neither     → the gate stays exactly as it is today: a review card the
 *                 operator finishes by hand.
 *
 * D-004: this can only ever move a proposal from 'draft' toward
 * 'ready_for_review' (the caller's existing promotion), never toward
 * 'approved'. `decideInitialStatus` already ran inside the handler, and it is
 * deliberately NOT re-run here — re-running it on a now-ungated payload is
 * exactly how a resolution loop would grow an auto-approve it was never
 * supposed to have.
 *
 * Returns the question to ask, when there is one.
 */
async function resolveGatedReferencesForChat(
  deps: AssistantRouterDeps,
  tenantId: string,
  userId: string,
  correlationId: string,
  proposal: Proposal,
  entities: Record<string, unknown> | undefined,
  /**
   * Whether this caller will actually ASK the question it is handed.
   *
   * A pending question is only legitimate if the operator saw it: it costs
   * them a turn to answer and, unanswered, it sits on the proposal waiting
   * to consume a later message. The chain path passes `false` — see the
   * call site there for why a chain reply deliberately does not ask.
   */
  askClarification: boolean,
): Promise<string | undefined> {
  const outcome = await resolveGatedReferences(
    deps.entityResolver,
    tenantId,
    proposal,
    entities,
  );

  const filledKeys = applyGatedReferences(proposal, outcome.filled);

  if (outcome.ambiguity && askClarification) {
    stampPendingAmbiguity(proposal, outcome.ambiguity);
  }

  if (filledKeys.length > 0 || outcome.ambiguity) {
    await emitResolutionAudit(deps, tenantId, userId, correlationId, proposal.id, {
      filled: filledKeys,
      unresolved: outcome.unresolved,
      ...(outcome.ambiguity
        ? {
            ambiguousField: outcome.ambiguity.refKey,
            candidateCount: outcome.ambiguity.candidates.length,
            askedClarification: askClarification,
          }
        : {}),
    });
  }

  // The actual "what does the operator see" decision is a PURE function of
  // the outcome (ambiguity ask, honest can't-match line, or nothing) — see
  // `buildGatedReferenceReply`'s own doc comment for why it lives in the
  // core module rather than here.
  return buildGatedReferenceReply(outcome, askClarification);
}

/**
 * Every mutation the resolution loop makes is audited (CLAUDE.md: all
 * mutations emit audit events). Failure-soft, exactly like the route's other
 * audit call sites — an audit outage must not cost the operator their reply.
 */
async function emitResolutionAudit(
  deps: AssistantRouterDeps,
  tenantId: string,
  userId: string,
  correlationId: string,
  proposalId: string,
  metadata: Record<string, unknown>,
): Promise<void> {
  if (!deps.auditRepo) return;
  try {
    await deps.auditRepo.create(
      createAuditEvent({
        tenantId,
        actorId: userId,
        actorRole: 'user',
        eventType: 'assistant.entity_resolution',
        entityType: 'proposal',
        entityId: proposalId,
        correlationId,
        metadata,
      }),
    );
  } catch {
    // Audit failures must not block the reply.
  }
}

/**
 * The proposal in this conversation that is waiting on a disambiguation
 * answer, if any.
 *
 * The chat surface has no session store — every turn is classified from
 * scratch. Rather than add one, the pending question rides `sourceContext`
 * on the very proposal it blocks, and is recalled here through the SAME
 * conversation-scoped lookup `IssueInvoiceTaskHandler` already uses for "the
 * one we just drafted" (ai/orchestration/task-router.ts). Newest first, and
 * only a still-reviewable proposal counts: an answer to a question about a
 * proposal the operator has since approved or rejected is stale, and acting
 * on it would edit a decided record.
 */
async function findPendingClarification(
  deps: AssistantRouterDeps,
  tenantId: string,
  conversationId: string | undefined,
): Promise<{ proposal: Proposal; pending: PendingEntityAmbiguity } | undefined> {
  if (!conversationId || !deps.proposalRepo.findByConversation) return undefined;
  let candidates: Proposal[];
  try {
    candidates = await deps.proposalRepo.findByConversation(tenantId, conversationId);
  } catch {
    return undefined;
  }

  const reviewable = candidates
    .filter((p) => p.status === 'draft' || p.status === 'ready_for_review')
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

  for (const proposal of reviewable) {
    const carriesKey =
      (proposal.sourceContext as Record<string, unknown> | undefined)?.[
        PENDING_AMBIGUITY_KEY
      ] !== undefined;
    if (!carriesKey) continue;

    const pending = pendingAmbiguityOf(proposal);
    if (pending) return { proposal, pending };

    // Present but invalid — a blob that fails its own contract cannot be
    // trusted to drive a payload write, and leaving it in place would make
    // every future turn re-fail the same parse. Drop it and move on; the
    // proposal keeps its gate and its candidate picker.
    clearPendingAmbiguity(proposal);
    try {
      await deps.proposalRepo.update(tenantId, proposal.id, {
        sourceContext: proposal.sourceContext,
      });
    } catch {
      // Best-effort cleanup — never cost the operator their turn.
    }
  }
  return undefined;
}

type AssistantUsage = { input: number; output: number; total: number };

/**
 * #913 — the reply envelope's `usage` for a turn that paid for a real
 * classify call. The classifier surfaces `{ input, output }` only when it
 * actually hit the gateway (absent on a short-circuit), so an absent usage
 * is an honest zero, not a masked one.
 */
function usageOf(tokenUsage: { input: number; output: number } | undefined): AssistantUsage {
  const input = tokenUsage?.input ?? 0;
  const output = tokenUsage?.output ?? 0;
  return { input, output, total: input + output };
}

function sumUsage(a: AssistantUsage, b: AssistantUsage): AssistantUsage {
  return { input: a.input + b.input, output: a.output + b.output, total: a.total + b.total };
}

/**
 * The reply envelope `generateAssistantReply` returns for a proposal-bearing
 * turn — the same literal shape the single-intent dispatch builds, named here
 * so the #909 follow-up leg can be a function rather than an inline block.
 */
interface AssistantProposalReply {
  taskType: string;
  model: string;
  usage: { input: number; output: number; total: number };
  // Never set on this path — a resolution turn is answered deterministically,
  // not by a degraded model fallback. Declared so this type unions cleanly
  // with the generic-LLM reply the same variable can hold.
  degraded?: boolean;
  fallbackStage?: string | undefined;
  message: {
    role: 'assistant';
    content: string;
    reasoning?: string;
    proposal: AssistantProposal;
  };
}

/**
 * #909 — consume one disambiguation answer.
 *
 * Returns a reply when the turn was genuinely an answer (matched, or a
 * re-ask); returns `undefined` to mean "this was not an answer and we have
 * stopped waiting" — the caller then classifies the turn as an ordinary new
 * request. Either way the proposal row is left consistent: a matched answer
 * has its id filled and its gate lifted, an abandoned question is cleared.
 *
 * D-004: on a match the proposal is UPDATED, never approved and never
 * executed. It stays exactly the status it already had, waiting for the
 * operator's tap — the whole point is that the tap now succeeds instead of
 * 400-ing on missingFields.
 */
async function applyDisambiguationAnswer(
  deps: AssistantRouterDeps,
  tenantId: string,
  userId: string,
  correlationId: string,
  proposal: Proposal,
  pending: PendingEntityAmbiguity,
  answerText: string,
): Promise<AssistantProposalReply | undefined> {
  const match = await resolveDisambiguationFollowUp(
    deps.entityResolver,
    tenantId,
    answerText,
    pending,
  );

  if (match.status === 'resolved') {
    clearPendingAmbiguity(proposal);
    applyGatedReferences(proposal, { [pending.refKey]: match.candidateId });

    // The answered reference may unblock a SECOND lookup that could not run
    // before it — an appointment reachable only once its customer is known,
    // for instance. Run the loop once more so a two-reference utterance
    // needs one answer, not two round trips per reference.
    const nextQuestion = await resolveGatedReferencesForChat(
      deps,
      tenantId,
      userId,
      correlationId,
      proposal,
      undefined,
      // Asks: this reply carries the next question in its own text, so the
      // operator sees it exactly as they saw the first one.
      true,
    );

    await deps.proposalRepo.update(tenantId, proposal.id, {
      payload: proposal.payload,
      sourceContext: proposal.sourceContext,
    });
    await emitResolutionAudit(deps, tenantId, userId, correlationId, proposal.id, {
      event: 'disambiguation_answered',
      field: pending.refKey,
      candidateId: match.candidateId,
      entityKind: pending.entityKind,
    });

    const picked = pending.candidates.find((c) => c.id === match.candidateId);
    const uiProposal = proposalToUI(proposal, answerText);
    return {
      taskType: 'assistant.entity_resolution',
      model: 'entity-resolver',
      usage: { input: 0, output: 0, total: 0 },
      message: {
        role: 'assistant' as const,
        content: nextQuestion
          ? `${picked ? `${picked.name} — got it. ` : ''}${nextQuestion}`
          : `${picked ? `${picked.name} — got it. ` : ''}${uiProposal.title}. ${proposalReplySuffix(uiProposal.status)}`,
        reasoning: 'Resolved a pending entity reference from the operator’s answer.',
        proposal: uiProposal,
      },
    };
  }

  // Not an answer we could match. Re-ask, up to the voice surface's bound.
  if (pending.attemptCount < MAX_DISAMBIGUATION_ATTEMPTS) {
    const retried: PendingEntityAmbiguity = {
      ...pending,
      attemptCount: pending.attemptCount + 1,
    };
    stampPendingAmbiguity(proposal, retried);
    await deps.proposalRepo.update(tenantId, proposal.id, {
      sourceContext: proposal.sourceContext,
    });
    const uiProposal = proposalToUI(proposal, answerText);
    return {
      taskType: 'assistant.entity_resolution',
      model: 'entity-resolver',
      usage: { input: 0, output: 0, total: 0 },
      message: {
        role: 'assistant' as const,
        content:
          match.status === 'still_ambiguous'
            ? `That still matches more than one. ${buildDisambiguationQuestion(retried)}`
            : buildDisambiguationQuestion(retried),
        reasoning: 'Re-asking a pending entity clarification.',
        proposal: uiProposal,
      },
    };
  }

  // Bound reached — stop waiting. The proposal keeps its gate (and its
  // candidate picker on the card), and this turn becomes an ordinary
  // request so the operator is never trapped in a question they have
  // moved on from.
  clearPendingAmbiguity(proposal);
  await deps.proposalRepo.update(tenantId, proposal.id, {
    sourceContext: proposal.sourceContext,
  });
  await emitResolutionAudit(deps, tenantId, userId, correlationId, proposal.id, {
    event: 'disambiguation_abandoned',
    field: pending.refKey,
    attempts: pending.attemptCount,
  });
  return undefined;
}

/**
 * B1 — friendly labels for the flat id-shaped keys the money-path task
 * handlers gate on. Falls back to the raw key (see `editFieldsForMissing`)
 * for any missingFields entry not listed here (e.g. `title`, `jobId`), so a
 * newly-added gate never silently loses its Edit control.
 */
// Moved to @ai-service-os/shared (contracts/proposal.ts) — the web INBOX
// renders the SAME list and was showing the raw key, so the two surfaces were
// drifting off two definitions. `labelForMissingField` falls back to the raw
// key for anything unlisted, exactly as this map's `??` did.

/**
 * B1 — the free-text reference field each gated id is paired with on the
 * money/reference-carrying proposal types (see contracts.ts:
 * `sendInvoicePayloadSchema`, `sendEstimateNudgePayloadSchema`,
 * `confirmAppointmentPayloadSchema`, etc.). Used only to prefill the Edit
 * input with context — never copied into the payload itself.
 */
const REFERENCE_FIELD_FOR_MISSING: Record<string, string> = {
  invoiceId: 'invoiceReference',
  estimateId: 'estimateReference',
  jobId: 'jobReference',
  customerId: 'customerReference',
  appointmentId: 'appointmentReference',
  leadId: 'leadReference',
};

/**
 * B1 — turn `sourceContext.missingFields` into the same `editFields` shape
 * `customerProposalToUI` already emits, so the existing edit-then-approve UI
 * (AIProposalCard → PUT /api/proposals/:id { edits }) can fill a gated field
 * without any client-side change. Path-shaped entries
 * (`lineItems[0].catalogItemId`, `editActions[0].lineItem.catalogItemId`)
 * are owned by resolve-line's candidate picker (B2/B3), not this generic
 * text-input form, so they're skipped here exactly as
 * `clearSatisfiedMissingFields` (proposals/missing-fields.ts) skips them.
 */
export function editFieldsForMissing(
  missingFields: string[] | undefined,
  payload: Record<string, unknown>,
): AssistantProposal['editFields'] {
  if (!missingFields || missingFields.length === 0) return undefined;

  const fields = missingFields
    .filter(isFlatMissingField)
    .map((key) => {
      const existing = payload[key];
      const label = labelForMissingField(key);
      // Review J5 — a NUMERIC gated field (the catalog unit price) used to
      // fall through every branch below and emit `value: ''`, because the
      // helper only ever prefilled STRINGS. The operator then typed into an
      // empty box and the card sent a string against a `z.number()` field.
      // Both halves are fixed here: the current value is prefilled, and
      // `kind` tells the card what to parse it back into.
      if (typeof existing === 'number' && Number.isFinite(existing)) {
        return isCentsKey(key)
          ? { label, key, kind: 'cents' as const, value: centsToInputValue(existing) }
          : { label, key, kind: 'number' as const, value: String(existing) };
      }
      const referenceKey = REFERENCE_FIELD_FOR_MISSING[key];
      const referenceValue = referenceKey ? payload[referenceKey] : undefined;
      const value =
        typeof existing === 'string'
          ? existing
          : typeof referenceValue === 'string'
            ? referenceValue
            : '';
      return { label, key, kind: 'text' as const, value };
    });

  return fields.length > 0 ? fields : undefined;
}

/**
 * QA-2026-06-05 (AST-02/03/04): map any persisted proposal to the UI card
 * shape — estimates/invoices were previously unpersisted LLM JSON.
 *
 * Exported (pure, no I/O) so the AUTO-APPROVED branch is directly testable.
 * Reaching `status: 'approved'` through the route requires an entity resolver
 * plus enough seeded repos to keep the drafting handler's confidence above the
 * auto-approve threshold — every lightweight harness caps it at 0.5 and lands
 * on 'ready_for_review' — so a route test can only ever exercise the pending
 * half of this mapping. `test/routes/assistant-auto-approved-undo.route.test.ts`
 * pins that half end-to-end and this half directly.
 */
export function proposalToUI(
  proposal: {
    id: string;
    proposalType: string;
    summary: string;
    payload: Record<string, unknown>;
    sourceContext?: Record<string, unknown>;
    confidenceScore?: number;
    /**
     * The drafting handler's own reasoning, as persisted on the row. Where a
     * handler wrote one it is the ONLY place the operator learns what the
     * proposal declined to do and why — `update_catalog_item`'s refused
     * spoken price ("Heard a price of $290,000.00, above the … limit … so it
     * was NOT applied") being the case that exposed this. Optional: most
     * types persist none and fall back to the source echo below.
     */
    explanation?: string;
    /**
     * Commit 2 (followup-autoapprove-default) — the real persisted status.
     * Previously this mapper hardcoded `status: 'Pending'` unconditionally,
     * which was silently wrong for the auto-approving proposal types
     * (draft_estimate / draft_invoice / update_estimate / update_invoice /
     * update_job / create_appointment / create_booking): the chat reply told
     * the operator to "review and approve" a proposal that had ALREADY been
     * approved (and was headed for execution after the undo window). Optional
     * so the (rare, test-only) call sites that construct a bare literal
     * without a status still compile — those default to 'Pending', matching
     * pre-fix behavior exactly.
     */
    status?: string;
    /**
     * Follow-up (auto-approved undo parity) — stamped by `createProposal` at
     * the instant an auto-approving type is decided 'approved'. Feeds the
     * card's `undoExpiresAt` so the chat surface can offer the same undo an
     * operator-tapped approval gets. Optional for the same reason `status`
     * is: bare test literals still compile (no stamp ⇒ no window ⇒ no
     * affordance, which is the honest answer for a card that isn't approved).
     */
    approvedAt?: Date;
  },
  sourceMessage: string
): AssistantProposal {
  const typeMap: Record<string, AssistantProposal['type']> = {
    draft_estimate: 'Estimate',
    update_estimate: 'Estimate',
    draft_invoice: 'Invoice',
    update_invoice: 'Invoice',
    send_invoice: 'Invoice',
    issue_invoice: 'Invoice',
    create_customer: 'Customer',
    update_customer: 'Customer',
    // B5 — the 12 newly-wired intents need a sensible card type too:
    // scheduling family → Schedule; invoice-adjacent follow-ups → Invoice;
    // the estimate follow-up → Estimate. `create_job` has no dedicated
    // type — it falls through to the generic 'Follow-up' default below,
    // same as add_note/log_expense/every other CRM-ish intent.
    reschedule_appointment: 'Schedule',
    cancel_appointment: 'Schedule',
    reassign_appointment: 'Schedule',
    confirm_appointment: 'Schedule',
    notify_delay: 'Schedule',
    send_payment_reminder: 'Invoice',
    apply_late_fee: 'Invoice',
    record_payment: 'Invoice',
    batch_invoice: 'Invoice',
    create_invoice_schedule: 'Invoice',
    send_estimate_nudge: 'Estimate',
  };
  const cardType = typeMap[proposal.proposalType] ?? 'Follow-up';
  const total = typeof proposal.payload.totalCents === 'number'
    ? ` — $${(proposal.payload.totalCents / 100).toFixed(2)}`
    : '';
  const signals = proposalSignals(proposal.payload, proposal.sourceContext);
  return {
    id: proposal.id,
    title: `${cardType}: ${proposal.summary.slice(0, 80)}${total}`,
    summary: proposal.summary.slice(0, 160),
    // Review K4 — the persisted explanation WINS, the source echo is the
    // fallback. Shared with `customerProposalToUI` (see `cardExplanation`),
    // which had the identical defect and did not get this fix in K4.
    explanation: cardExplanation(proposal.explanation, sourceMessage),
    confidence: (proposal.confidenceScore ?? 0) >= 0.85 ? 'High' : 'Medium',
    type: cardType,
    // Commit 2 — the real persisted status, not a hardcoded 'Pending'. Only
    // 'approved' maps to 'Approved'; every other status (draft,
    // ready_for_review, and any future addition) reads as 'Pending' — this
    // card has no "why" to show a 'Rejected' state (a proposal is never
    // created already-rejected).
    status: proposal.status === 'approved' ? 'Approved' : 'Pending',
    // Only meaningful on the auto-approved path — an operator-tapped approval
    // takes its window from the approve response. `undoWindowCloseAt` returns
    // undefined without an `approvedAt` stamp, so an unapproved (or
    // historical, unstamped) proposal emits no window rather than a bogus one.
    ...(proposal.status === 'approved' && proposal.approvedAt
      ? {
          undoExpiresAt: undoWindowCloseAt({ approvedAt: proposal.approvedAt })?.toISOString(),
          // Review N11 — the DURATION twin, so the card's countdown is
          // anchored to the client's own clock at receipt rather than to a
          // differenced server instant. On this path the round trip is an LLM
          // call, so most of the 5s is already gone and skew is the
          // difference between an undo that works and a 409.
          undoRemainingMs: undoWindowRemainingMs({ approvedAt: proposal.approvedAt }),
        }
      : {}),
    proposalType: proposal.proposalType,
    // Same address slice as customerProposalToUI. Kept on BOTH mappers on
    // purpose: `create_customer` reaches the card through either one
    // depending on the branch, and a field present on only one of two
    // parallel serializers is exactly the drift that caused this bug.
    addressCapture: addressCaptureFor(proposal.proposalType, proposal.payload),
    // E10 (U7) — surface AI-pricing / confidence / missing-field warnings so
    // the card can render them and block Approve on unresolved lines.
    ...signals,
    // B1 — a gated card otherwise has no way to unblock Approve on this
    // surface: render an Edit input for every flat missingFields entry.
    editFields: editFieldsForMissing(signals.missingFields, proposal.payload),
  };
}

/**
 * Commit 2 (followup-autoapprove-default) — the reply sentence following a
 * card's title. Previously this was the single hardcoded string "Review and
 * approve to proceed." regardless of the card's actual status; now that
 * `proposalToUI` reports the real status (see its own comment), the reply
 * must agree with it — an already-'Approved' card has nothing left to
 * review, and telling the operator otherwise actively contradicts what the
 * backend just did.
 */
function proposalReplySuffix(status: AssistantProposal['status']): string {
  return status === 'Approved'
    ? 'Approved automatically — it will proceed shortly.'
    : 'Review and approve to proceed.';
}

const UNPAID_QUERY_RE = /(which|what|list|show|any)\b.{0,40}\binvoices?\b.{0,40}\b(unpaid|open|outstanding|overdue|due|owed)|\b(unpaid|outstanding)\s+invoices?/i;

// #914 (C01) — deterministic en_route phrase pre-check. The classifier call
// below runs the full 'operator'-profile (all 78 intents; D-028) taxonomy
// with NO actor-role narrowing on this surface — unlike the phone/inapp-
// voice paths, which resolve a 'field_tech' classifier profile (a 15-intent,
// trade-internal taxonomy — D-028) for a caller-ID/D-026-resolved
// technician, giving en_route far less competition to be classified
// correctly. On chat every authenticated user (owner, dispatcher,
// technician) gets the SAME broad taxonomy, so a brief "On my way to the
// job" can miss classification as en_route and fall through to the generic
// LLM reply. Mirrors the SMS keyword leg's own high-precision phrase list
// (sms/tech-status/en-route-keyword.ts, EN_ROUTE_SMS_KEYWORDS) — reused
// here, not duplicated, so the two never drift — with word-boundary
// matching (SMS matches the WHOLE message; chat needs a substring match
// inside a longer sentence). Conservative on purpose: an utterance that
// doesn't match still falls through to the LLM classifier below, same as
// today.
const EN_ROUTE_PHRASE_RE = new RegExp(
  `\\b(${EN_ROUTE_SMS_KEYWORDS.map((k) => k.replace(/\s+/g, '\\s+')).join('|')})\\b`,
  'i',
);

async function answerUnpaidInvoicesQuery(
  invoiceRepo: InvoiceRepository,
  tenantId: string
): Promise<string> {
  const all = await invoiceRepo.findByTenant(tenantId);
  const cutoff = Date.now() - 31 * 86_400_000;
  const unpaid = all.filter(
    (i) => ['open', 'partially_paid'].includes(i.status) && new Date(i.createdAt).getTime() >= cutoff
  );
  if (unpaid.length === 0) {
    return 'No unpaid invoices from the last month — everything issued in the last 31 days is settled.';
  }
  const lines = unpaid
    .slice(0, 10)
    .map((i) => `${i.invoiceNumber} — $${(i.amountDueCents / 100).toFixed(2)} due (${i.status})`)
    .join('; ');
  const totalDue = unpaid.reduce((s2, i) => s2 + i.amountDueCents, 0);
  return `${unpaid.length} unpaid invoice${unpaid.length === 1 ? '' : 's'} from the last month, $${(totalDue / 100).toFixed(2)} total due: ${lines}${unpaid.length > 10 ? '; …' : ''}`;
}

/**
 * Permission a proposal type needs before it may EXECUTE without a human
 * approval tap.
 *
 * Most drafting handlers pass no `sourceTrustTier`, so their proposals always
 * land in 'draft' → 'ready_for_review' and a permission holder approves them.
 * `create_appointment` is the exception: it carries
 * `sourceTrustTier: 'autonomous'` and is capture-class, so for a supervised,
 * high-confidence tenant `decideInitialStatus` returns 'approved' and the
 * worker executes it — and the execution layer performs NO permission check of
 * its own (verified: no `hasPermission` anywhere under proposals/execution/).
 *
 * Granting technicians `ai:run` therefore has to not become a back door around
 * `appointments:create`, which they deliberately lack (the day-view reschedule
 * flow routes through the proposal path precisely so `proposals:create` stays
 * the low-privilege action). A caller who lacks the direct permission still
 * gets their draft — it just waits for the approval tap instead of
 * self-executing. Fails closed: an unknown/invalid role gets the downgrade.
 */
const DIRECT_EXECUTION_PERMISSION: Partial<Record<ProposalType, Permission>> = {
  create_appointment: 'appointments:create',
  create_booking: 'appointments:create',
};

/**
 * Downgrade an auto-approved proposal to 'ready_for_review' when the caller
 * lacks the permission the equivalent direct route would demand. Returns true
 * when a downgrade was applied. No-op for every proposal that was not
 * auto-approved, so existing owner/dispatcher behavior is byte-identical.
 */
function downgradeIfCallerLacksDirectPermission(
  proposal: { proposalType: ProposalType; status: string; approvedAt?: Date | undefined },
  callerRole: string | undefined,
): boolean {
  if (proposal.status !== 'approved') return false;
  const required = DIRECT_EXECUTION_PERMISSION[proposal.proposalType];
  if (!required) return false;
  const permitted =
    !!callerRole && isValidRole(callerRole) && hasPermission(callerRole as Role, required);
  if (permitted) return false;
  proposal.status = 'ready_for_review';
  proposal.approvedAt = undefined;
  return true;
}

/**
 * Task 15 (2026-08-07 tradesperson plan) — quality-review fix. Single source
 * of truth for which classifier intents this route can dispatch to a
 * drafting handler, mapping the intent (classifier output) to the PROPOSAL
 * TYPE (`sharedHandlers`'s key) that drafts it. Before this constant,
 * `chainHandlers` and `proposalHandlers` (below) were two hand-maintained
 * object-literal copies of the same key list — construction ("resolve from
 * `sharedHandlers`, never `new X(...)` inline") never drifted, but the KEY
 * LIST did, repeatedly, across at least four waves of intents (B5, the
 * 2026-07 field-write batch, Task 15's 18). One list now; both dispatch
 * sites derive from it; a contract test
 * (test/routes/assistant-dropped-intents.test.ts) asserts both maps' key
 * sets equal this constant's key set.
 *
 * `create_customer` is the ONE documented exception: it is deliberately NOT
 * a member of this map. It needs bespoke handling the other 42 don't (asking
 * conversationally for a name when the turn extracted none —
 * `assistant.create_customer.needs_name` below), so the single-intent path
 * dispatches it from its own branch, after this map's lookup fails. The
 * CHAIN path has no equivalent conversational fallback (a chain segment
 * either drafts or is skipped), so it special-cases `create_customer`
 * separately, alongside this map, rather than folding it in here.
 */
export const CHAT_INTENT_TO_REGISTRY_KEY: Readonly<Record<string, ProposalType>> = {
  draft_estimate: 'draft_estimate',
  update_estimate: 'update_estimate',
  create_invoice: 'draft_invoice',
  send_invoice: 'send_invoice',
  issue_invoice: 'issue_invoice',
  update_invoice: 'update_invoice',
  reschedule_appointment: 'reschedule_appointment',
  cancel_appointment: 'cancel_appointment',
  reassign_appointment: 'reassign_appointment',
  confirm_appointment: 'confirm_appointment',
  create_job: 'create_job',
  update_job: 'update_job',
  send_payment_reminder: 'send_payment_reminder',
  apply_late_fee: 'apply_late_fee',
  send_estimate_nudge: 'send_estimate_nudge',
  batch_invoice: 'batch_invoice',
  create_invoice_schedule: 'create_invoice_schedule',
  record_payment: 'record_payment',
  notify_delay: 'notify_delay',
  add_note: 'add_note',
  log_time_entry: 'log_time_entry',
  log_expense: 'log_expense',
  create_appointment: 'create_appointment',
  send_estimate: 'send_estimate',
  update_customer: 'update_customer',
  // Task 15 — the 18 intents a mechanical derivation (every
  // INTENT_TO_PROPOSAL_TYPE key checked against this map) found with a real
  // drafting handler in `sharedHandlers` and no chat dispatch entry.
  add_crew_member: 'add_crew_member',
  remove_crew_member: 'remove_crew_member',
  convert_lead: 'convert_lead',
  mark_lead_lost: 'mark_lead_lost',
  add_service_location: 'add_service_location',
  request_feedback: 'request_feedback',
  record_refund: 'record_refund',
  apply_credit: 'apply_credit',
  send_customer_message: 'send_customer_message',
  create_change_order: 'create_change_order',
  create_service_agreement: 'create_service_agreement',
  add_material: 'add_material',
  update_catalog_item: 'update_catalog_item',
  add_catalog_item: 'add_catalog_item',
  // Alias intents — dispatch keyed by the classifier's INTENT (this map's
  // key), drafting keyed by PROPOSAL type (the value), so each rides its
  // target's handler unchanged, exactly like `create_invoice` → `draft_invoice`
  // above.
  schedule_inspection: 'create_appointment',
  log_permit: 'add_note',
  log_warranty_claim: 'create_job',
  // log_mileage ALSO aliases log_expense's handler, but — unlike the three
  // aliases above — needs `context.intent` threaded through (see the
  // `intent:` field on both `.handle()` calls below) so LogExpenseTaskHandler
  // can tell it apart from a plain log_expense turn (Task 11,
  // TaskContext.intent's doc comment).
  log_mileage: 'log_expense',
};

/**
 * Task 15 quality-review fix (C1/C2) — intents that read `context.customerId`
 * (the TASK-CONTEXT TOP-LEVEL field — distinct from
 * `existingEntities.customerId`) and therefore need it explicitly threaded
 * on this surface. Three of the 18 newly-wired intents read it EXCLUSIVELY,
 * with no `existingEntities.customerId` fallback: `send-customer-message-
 * task.ts`, `create-service-agreement-task.ts`,
 * `AddServiceLocationTaskHandler` (voice-extended-tasks.ts). `schedule_
 * inspection` is a fourth, narrower case: it is a brand-new intent (no
 * shipped chat behavior to regress) that is ALSO a CUSTOMER_REF_INTENTS +
 * JOB_REF_INTENTS member, so admitting it here is a deliberate, tested
 * choice — see the "schedule_inspection — full dependency set" test in
 * test/routes/assistant-dropped-intents.test.ts for exactly what that
 * produces (a held calendar slot / `create_booking`, when a jobRepo +
 * appointmentRepo are wired and the drafting LLM echoes back the resolved
 * jobId).
 *
 * This is an ALLOWLIST, not a blanket thread, because at least TEN already-
 * shipped chat intents read `context.customerId` too, but as one of several
 * EXCLUSIVE-READER SIDE EFFECTS whose behavior this route was never asked to
 * change:
 *
 *   - `CreateAppointmentAITaskHandler` (create_appointment, already wired):
 *     when an `appointmentRepo` is wired and the drafting LLM echoes a
 *     `jobId` (it is embedded in that call's own "Known entities:" prompt
 *     section — `buildUserMessage`), a truthy `context.customerId` is enough
 *     to PASS `place-hold.ts`'s ownership guard (`if (!UUID_RE.test(jobId)
 *     || !customerId) return job_not_owned`) instead of always failing it.
 *     Before: `job_not_owned` was unconditional on chat (customerId was
 *     always undefined) → the review-gated `create_appointment` fallback,
 *     which explicitly STRIPS `sourceTrustTier` so it can never auto-approve
 *     and never writes a hold. After (if threaded blanket): a REAL
 *     `appointments` row can be INSERTED at DRAFT time — before any human
 *     review — as a `create_booking` proposal carrying
 *     `sourceTrustTier: 'autonomous'`. That trust tier is set UNCONDITIONALLY
 *     (not gated on `context.autonomousBooking`, which chat never sets, so
 *     the D-015 autonomous-lane bonus check never engages).
 *
 *     HISTORICAL (fixed by followup-autoapprove-default, commit 1): through
 *     that gap, `decideInitialStatus` (proposals/proposal.ts) didn't need
 *     the lane either — with `context.supervisorPresent` ALSO never set by
 *     chat at the time, `resolveAutoApproveThreshold` fell through to
 *     `LEGACY_AUTO_APPROVE_THRESHOLD` (0.9, NOT the categorical `null`
 *     block), so a plain `shouldAutoApprove(confidenceScore, 0.9)` check —
 *     wholly independent of the lane — could auto-approve the booking
 *     outright for a sufficiently confident drafting call. `generateAssistant
 *     Reply` now resolves real `isSupervisorPresent`/`req.auth.mode` and
 *     threads both into every dispatch site (see the `isSupervisorPresent`
 *     import comment near the top of this file), so that auto-approval now
 *     requires a supervisor genuinely on duty and confidence clearing the
 *     real mode-aware threshold — it is no longer an accident of an unthreaded
 *     field. The row WRITE (the held-slot insert this bullet is actually
 *     about) is unaffected by that fix and still happens regardless of
 *     supervision; only the auto-approval on top of it is now gated.
 *   - `ConfirmAppointmentTaskHandler` / `NotifyDelayTaskHandler` (both
 *     already wired): `resolveActiveAppointmentId`'s customer-scoping block
 *     only runs when `customerId` is truthy; unscoped, it can only auto-pick
 *     an appointment when the ENTIRE TENANT has exactly one active
 *     appointment (near-impossible in a real shop → always gated before).
 *     Scoped, it auto-picks whenever the NAMED customer has exactly one
 *     qualifying appointment — notify_delay's own class doc calls out
 *     exactly this risk ("resolving to a different customer's appointment
 *     would message the wrong person").
 *   - `SendPaymentReminderTaskHandler.attachDuplicateReminderMarker`
 *     (already wired): gated on a truthy `customerId`; newly reachable, it
 *     runs three DB round-trips per chat turn and can synthesize a 'medium'
 *     confidence marker that flips an otherwise auto-approving reminder into
 *     review.
 *
 * None of that is a defensible byproduct of a dispatch-wiring task — "should
 * typing in chat place a real calendar hold?" is a product decision. The fix
 * is an explicit allowlist rather than a blanket thread: every already-
 * shipped intent's behavior stays byte-for-byte what it was before Task 15.
 *
 * `notify_delay` fix (2026-08-29, A31 row of the AI-catalog sweep) — added
 * to the allowlist. It was one of the byproduct risks named above ("already
 * wired" for customer-scoping) but deliberately left OUT of Task 15's
 * allowlist as an unrequested behavior change. The cost of that caution:
 * `NotifyDelayTaskHandler`'s `resolveActiveAppointmentId` customer-scoping
 * block never runs on chat (`context.customerId` is always undefined), so
 * unscoped resolution can only auto-pick when the ENTIRE TENANT has exactly
 * one active appointment — never true once a shop has more than one
 * customer on the books. A chat "tell <customer> we're running late" then
 * has no `appointmentReference` either (nothing in the utterance names a
 * specific appointment), so the proposal drafts with `missingFields:
 * ['appointmentId']` it can NEVER clear — approveProposal refuses forever
 * (a gate with no lifter, the #909 class). Admitting `notify_delay` here
 * only ADDS scoping (it can never resolve to a WRONG or ambiguous
 * appointment — see `resolveActiveAppointmentId`'s own doc comment), and is
 * exactly the fix the handler's own class comment already called for.
 */
export const CHAT_CONTEXT_CUSTOMER_ID_INTENTS: ReadonlySet<string> = new Set([
  'send_customer_message',
  'create_service_agreement',
  'add_service_location',
  'schedule_inspection',
  'notify_delay',
]);

/**
 * Task 15 quality-review fix (I1) — intents this route deliberately never
 * dispatches, for two structurally different reasons. Single source of
 * truth so the rationale lives in exactly one place instead of five
 * (assistant.ts's two dispatch-map comments plus three test files, all
 * previously hand-copied and — for `emergency_dispatch` / `update_brand_
 * voice` — citing the wrong authority):
 *
 *   - `respond_to_review`, `create_standing_instruction`, `update_brand_voice`:
 *     STRUCTURALLY unwireable — none of the three has a handler registered
 *     in the shared registry at all (`ai/orchestration/handler-registry.ts`
 *     `buildTaskHandlers`; grep confirms no `handlers.set(...)` line for any
 *     of them). `respond_to_review` / `create_standing_instruction` are
 *     named in that module's own doc comment as deliberately excluded from
 *     its taxonomy (alongside the synthetic `_complaint`/`_negotiation`
 *     keys); `update_brand_voice` isn't named there but is absent from the
 *     registry all the same. `sharedHandlers.get(...)!` would be `undefined`
 *     for any of the three — wiring them would be a crash, not a feature.
 *   - `emergency_dispatch`: the ODD one out. It DOES have a real handler
 *     (`handler-registry.ts:283`, `EmergencyDispatchTaskHandler`) and DOES
 *     have an `INTENT_TO_PROPOSAL_TYPE` entry — it satisfies every inclusion
 *     criterion Task 15 used for the other 18. Excluded anyway, on this
 *     wave's own PLAN's explicit instruction
 *     (`docs/plans/2026-08-07-001-feat-voice-tradesperson-intents-plan.md`
 *     line 1221: "...stay surface-specific BY DESIGN...do NOT wire them"),
 *     not on any rationale documented in the registry itself. This IS a
 *     real, KNOWN memo/chat divergence, not a false one: an owner typing
 *     "emergency, no heat at the Hayes place, page me" into chat gets the
 *     generic "I can't do that from here yet" refusal (`isActionIntent` +
 *     `buildUnmappedCapabilityReply`), while the identical words recorded as
 *     a voice memo draft a real `emergency_dispatch` proposal —
 *     `workers/voice-action-router.ts` has no special-case branch for it
 *     either; it reaches `EmergencyDispatchTaskHandler` through the exact
 *     same generic `INTENT_TO_PROPOSAL_TYPE` dispatch every other mapped
 *     intent uses. Recorded here rather than silently left as a gap.
 */
export const CHAT_DISPATCH_EXCLUDED_INTENTS: ReadonlySet<string> = new Set([
  'respond_to_review',
  'create_standing_instruction',
  'update_brand_voice',
  'emergency_dispatch',
]);

async function generateAssistantReply(
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>,
  tenantId: string,
  userId: string,
  deps: AssistantRouterDeps,
  correlationId: string,
  // Map drift fix (2026-07): the shared task-handler registry, built ONCE at
  // composition time in createAssistantRouter (the voice worker already does
  // this — see createVoiceActionRouterWorker). BOTH dispatch maps below
  // resolve every registry-covered proposal type from THIS map instead of
  // constructing handlers inline, so the single-intent and chain surfaces
  // can no longer drift on how a shared intent is built (e.g. the
  // single-intent send_invoice losing its invoiceRepo). Positioned before
  // the optional params (required-after-optional is a TS error).
  sharedHandlers: Map<ProposalType, TaskHandler>,
  inputMode?: 'voice' | 'text',
  // B4 — the client-pinned conversation id (parsed.conversationId), threaded
  // into every task handler's TaskContext so conversation-scoped resolution
  // (e.g. IssueInvoiceTaskHandler's "the one we just drafted") can fire on
  // this surface. Undefined on a conversation's first turn — the same
  // rung-2-only-fires-with-a-conversationId behavior the voice worker has
  // always had. Note: this is the id the CLIENT sent in, not the (possibly
  // freshly-minted) id `recordAssistantTurn` returns after this function's
  // caller persists the turn — a brand-new conversation has no prior drafts
  // to resolve against yet, so that ordering is never a gap.
  conversationId?: string,
  // The caller's DB-authoritative role (middleware/auth overwrites
  // req.auth.role with the membership row's role on every request). Used only
  // by downgradeIfCallerLacksDirectPermission to keep an auto-approving
  // proposal from executing for a caller who lacks the direct permission.
  // Undefined → treated as "lacks it" (fails closed).
  callerRole?: string,
  // P12-001/P12-004 wiring gap (commit 1) — `req.auth.mode` has been
  // populated by `requireTenant` on every authenticated request since
  // P12-001, but no proposal-creating caller ever forwarded it into
  // `resolveAutoApproveThreshold`. For chat, "the user-on-record for the
  // originating session" (the docstring's phrase for supervisorMode) is
  // just the requesting user themselves — there is no separate voice
  // session — so `req.auth.mode` is exactly the right per-request signal.
  // Defaults to 'supervisor' at the auth layer when no mode loader is
  // wired (middleware/auth.ts's `loadModeWithCache`). Minor fix (post-C1
  // review): `DEFAULT_AUTO_APPROVE_THRESHOLDS` has no notion of a "default
  // mode" — the point of this default is narrower: 'supervisor' resolves
  // to 0.90 (`DEFAULT_AUTO_APPROVE_THRESHOLDS.supervisor`), the SAME value
  // as `LEGACY_AUTO_APPROVE_THRESHOLD`, so a tenant with no mode loader
  // configured sees byte-identical behavior to the pre-commit-1 fallback.
  supervisorMode?: Mode,
) {
  const lastUser = [...messages].reverse().find((m) => m.role === 'user');
  const lastUserText = lastUser?.content ?? '';

  // ── Intent path: AST-01b ──────────────────────────────────────────
  // Run the same classifier the voice pipeline uses. If the message is
  // a recognized action (today: create_customer), build a real proposal
  // and return it instead of a free-text LLM reply. Other intents fall
  // through to the LLM — separate stories wire them into the chat.
  //
  // Honest-failure guard state, hoisted OUT of the try below so the fallback
  // path can tell WHY the intent path produced no proposal. Without this the
  // fallback LLM cannot distinguish "I didn't understand you" from "the
  // classifier threw", and it answered both by inventing a confirmation.
  let guardIntent: string | undefined;
  let guardConfidence: number | undefined;
  let guardIntentError: string | undefined;
  // #913 — what the top-level classify call on this turn actually spent.
  // Every reply built after that call reports it (the chain path adds each
  // segment's classify on top); the pre-classifier deterministic paths and
  // the error-fallback envelope keep their honest zeros.
  let classifierUsage: AssistantUsage = usageOf(undefined);
  if (lastUserText.trim().length > 0) {
    try {
      // §3B/3D/3E — resolve the tenant's vertical context (terminology +
      // intake questions + objection scripts) once per request. The
      // resolver memoizes internally; a failure falls back to the bare
      // classifier rather than breaking the chat.
      let verticalPromptSection: string | undefined;
      if (deps.verticalPromptResolver) {
        try {
          verticalPromptSection = await deps.verticalPromptResolver(tenantId);
        } catch {
          verticalPromptSection = undefined;
        }
      }

      // UB-A3 — resolve the tenant's active standing instructions once per
      // turn (mirrors verticalPromptResolver). Failure-soft: drafting
      // proceeds without owner instructions rather than breaking the chat.
      let activeStandingInstructions: StandingInstruction[] | undefined;
      if (deps.standingInstructionsResolver) {
        try {
          activeStandingInstructions = await deps.standingInstructionsResolver(tenantId);
        } catch {
          activeStandingInstructions = undefined;
        }
      }

      // Tenant IANA timezone, resolved once per turn (same shape/posture as
      // the two resolvers above) and threaded onto EVERY drafting TaskContext
      // below. `create_appointment` resolves spoken times ("Thursday at ten")
      // against it; without it this route booked at a hardcoded US-East
      // default. Failure-soft: a resolver hiccup leaves it undefined and the
      // scheduling handler gates rather than guessing a zone.
      let tenantTimezone: string | undefined;
      if (deps.tenantTimezoneResolver) {
        try {
          tenantTimezone = await deps.tenantTimezoneResolver(tenantId);
        } catch {
          tenantTimezone = undefined;
        }
      }
      const timezoneContext = tenantTimezone ? { timezone: tenantTimezone } : {};

      // Phase 12 supervisor gate — mirrors workers/voice-action-router.ts's
      // identical call, but LAZY (minor fix, post-C1 review): read-only
      // paths below (the deterministic unpaid-invoices query, `lookup_*`
      // dispatch) never create a proposal and must never pay for a
      // supervisor-presence read at all. Resolved at most once per turn —
      // memoized so every dispatch site downstream awaits the SAME promise
      // instead of re-querying. Reads the singleton wired in app.ts
      // (pgSupervisorPresenceLoader); with no loader wired (in-memory dev
      // mode, most tests) this returns the permissive `true` default,
      // preserving existing fixtures exactly the same way the voice
      // worker's tests are preserved.
      let supervisorPresentPromise: Promise<boolean> | undefined;
      const getSupervisorPresent = (): Promise<boolean> => {
        if (!supervisorPresentPromise) supervisorPresentPromise = isSupervisorPresent(tenantId);
        return supervisorPresentPromise;
      };

      // I3 — tenant auto-approve threshold override, same lazy/memoized
      // shape as supervisorPresent above and for the identical reason
      // (read-only paths never need it). Best-effort: a resolver that
      // throws or returns undefined falls through to
      // DEFAULT_AUTO_APPROVE_THRESHOLDS, same posture as every other
      // caller of this dep.
      let tenantThresholdOverridePromise:
        | Promise<Partial<Record<Mode, number>> | undefined>
        | undefined;
      const getTenantThresholdOverride = (): Promise<Partial<Record<Mode, number>> | undefined> => {
        if (!tenantThresholdOverridePromise) {
          tenantThresholdOverridePromise = deps.thresholdResolver
            ? deps.thresholdResolver(tenantId).catch(() => undefined)
            : Promise.resolve(undefined);
        }
        return tenantThresholdOverridePromise;
      };

      // QA-2026-06-05 (AST-05): deterministic read-only query — answer from
      // data, never propose. Runs before classification so phrasing variance
      // in the classifier can't turn a question into a mutation proposal.
      if (deps.invoiceRepo && UNPAID_QUERY_RE.test(lastUserText)) {
        const content = await answerUnpaidInvoicesQuery(deps.invoiceRepo, tenantId);
        return {
          taskType: 'assistant.query.unpaid_invoices',
          model: 'data-lookup',
          usage: { input: 0, output: 0, total: 0 },
          message: { role: 'assistant' as const, content, reasoning: 'Answered from invoice records (read-only query intent).' },
        };
      }

      // #909 — DISAMBIGUATION FOLLOW-UP, before the classifier.
      //
      // When the previous turn asked "which lead did you mean?", this turn is
      // the answer, and re-classifying "the second one" as a fresh intent is
      // how the question gets lost. The in-app voice adapter routes on FSM
      // state for exactly this reason and skips the classifier entirely on a
      // disambiguation turn (inapp-adapter.ts); chat has no FSM, so the state
      // is the pending question stamped on the proposal the answer unblocks.
      //
      // The matching is `resolveDisambiguationFollowUp` — the SAME
      // deterministic matcher the voice surface uses (ordinal, then distinct
      // name, then address/phone hint, then a resolver re-resolve INTERSECTED
      // with the pending candidate set). It can never return an id outside
      // the candidates that were offered, so this turn cannot select a record
      // the operator was never shown.
      //
      // Bounded by MAX_DISAMBIGUATION_ATTEMPTS, the voice constant: an
      // operator who ignores the question and types a new request loses at
      // most two turns before the pending state is dropped and their message
      // is classified normally. Unbounded, a stale question would swallow the
      // conversation.
      // RECALL IS GATED ON THE TURN, NOT ON PENDENCY. `isDisambiguationAnswer`
      // is the precision filter (see its doc comment for the three hijack
      // paths it closes — a request that merely CONTAINS a candidate name
      // used to resolve the question and discard the request). A turn that
      // does not look like an answer never reaches the matcher: it is
      // classified normally and the question is left standing, uncounted.
      const followUp = await findPendingClarification(deps, tenantId, conversationId);
      if (followUp && isDisambiguationAnswer(lastUserText, followUp.pending)) {
        const reply = await applyDisambiguationAnswer(
          deps,
          tenantId,
          userId,
          correlationId,
          followUp.proposal,
          followUp.pending,
          lastUserText,
        );
        if (reply) return reply;
        // Fell through: the operator kept answering with things that did not
        // match, the attempt bound was reached, and the question has been
        // cleared. This turn is classified as an ordinary new request below.
      }

      // `extendedIntents` is set unconditionally on THIS surface. That flag's
      // real job is (a) keeping the TELEPHONY classifier's prompt messages
      // byte-identical so voice-quality cassette hashes / gateway cache keys
      // don't move, and (b) keeping an ANONYMOUS phone caller away from
      // owner-grade reports. Neither concern exists for an authenticated
      // operator on their own dashboard — and leaving it off would mean
      // lookup_day_overview / lookup_digest / lookup_pending_items are never
      // even EMITTED by the classifier, so "what does my day look like?"
      // could never be answered here. Authorization is not weakened by this:
      // owner-grade lookups are gated downstream on the operator's
      // DB-authoritative RBAC role (`reports:view`), which fails closed.
      const classifyContext = {
        tenantId,
        extendedIntents: true,
        ...(verticalPromptSection ? { verticalPromptSection } : {}),
      };

      const classification = await classifyIntent(lastUserText, classifyContext, deps.gateway);
      classifierUsage = usageOf(classification.tokenUsage);
      guardIntent = classification.intentType;
      guardConfidence = classification.confidence;

      // ── Lookup path ────────────────────────────────────────────────
      // Runs BEFORE the chain split and both dispatch maps: a lookup is a
      // read-only question with one answer, and the chain splitter would
      // shred "what's my day look like, then what am I owed" into segments
      // that match no chain handler and get dropped silently.
      //
      // `dispatchAssistantLookup` NEVER throws and returns null only when
      // the intent genuinely has no wired skill here. Everything else —
      // found, empty, refused, FAILED — comes back as a reply we return
      // immediately, so a lookup can never be swallowed by this block's
      // outer `catch { }` and re-answered by the DB-less generic LLM.
      if (deps.lookups && isLookupIntent(classification.intentType)) {
        const lookupReply = await dispatchAssistantLookup(
          {
            tenantId,
            userId,
            intent: classification.intentType,
            ...(classification.extractedEntities
              ? { extractedEntities: classification.extractedEntities as Record<string, unknown> }
              : {}),
          },
          deps.lookups,
        );
        if (lookupReply) {
          if (lookupReply.degraded) {
            logger.error('assistant/chat: lookup failed', {
              correlationId,
              tenantId,
              intent: classification.intentType,
              reason: lookupReply.message.reasoning,
            });
          }
          // The lookup itself is deterministic (zero usage); the classify
          // call that routed here was not.
          return { ...lookupReply, usage: sumUsage(classifierUsage, lookupReply.usage) };
        }
        logger.info('assistant/chat: lookup intent has no wired skill on this surface', {
          correlationId,
          tenantId,
          intent: classification.intentType,
        });
      }

      // ── en_route path (#847) ───────────────────────────────────────
      // "On my way" is a DIRECT status act (F-3): the technician IS the
      // human acting, so it fires the SAME audited act as the app en-route
      // button — never a proposal, never the LLM. Runs before the chain
      // split for the same reason the lookup path does, and before the
      // unmapped-capability refusal below, which is where this intent used
      // to land ("I can't do that from here" — on the surface a technician
      // in the field is most likely to be holding). Identity is
      // default-deny: the auth subject must resolve to a canonical
      // TECHNICIAN row (the SMS keyword leg's anti-spoofing rule), and
      // every outcome is an honest, deterministic reply — the ambiguous and
      // no-appointment cases included. Gated on the wired bundle so
      // deployments without it keep today's refusal.
      //
      // #914 (C01) — OR'd with EN_ROUTE_PHRASE_RE (see its own comment
      // above): a high-precision deterministic phrase match reaches this
      // branch even when the classifier missed en_route on the broad
      // operator-profile taxonomy. `jobReference` (below) still comes from
      // `classification.extractedEntities` when the classifier DID tag the
      // turn en_route; a phrase-only match simply resolves the technician's
      // bare next appointment today, same as the SMS leg.
      if (
        deps.enRoute &&
        (classification.intentType === 'en_route' || EN_ROUTE_PHRASE_RE.test(lastUserText))
      ) {
        const enRouteReply = (
          content: string,
          reasoning: string,
          degraded?: boolean,
        ) => ({
          taskType: 'assistant.en_route',
          model: 'direct-act',
          usage: classifierUsage,
          ...(degraded ? { degraded: true, fallbackStage: 'en-route-unavailable' } : {}),
          message: { role: 'assistant' as const, content, reasoning },
        });
        try {
          const actor = await resolveCanonicalUser(deps.enRoute.userRepo, tenantId, userId);
          if (!actor || actor.role !== 'technician') {
            return enRouteReply(
              "On-my-way texts are sent by the technician on the job, and your account isn't matched to one — nothing was sent.",
              actor
                ? `en_route requires role 'technician'; your role is '${actor.role}'.`
                : 'en_route requires a canonical technician user; none matched your account.',
            );
          }
          const extractedEntities = (classification.extractedEntities ?? {}) as Record<
            string,
            unknown
          >;
          const jobReference =
            typeof extractedEntities.jobReference === 'string' &&
            extractedEntities.jobReference.trim().length > 0
              ? extractedEntities.jobReference.trim()
              : undefined;
          const technicianName = technicianNameIfKnown(actor);
          const outcome = await handleEnRouteForTechnician(deps.enRoute, {
            tenantId,
            technicianId: actor.id,
            ...(technicianName ? { technicianName } : {}),
            ...(jobReference ? { jobReference } : {}),
          });
          if (outcome.kind === 'unavailable') {
            if (outcome.reason === 'no_timezone') {
              return enRouteReply(
                "I can't tell which of your appointments is today because this workspace has no timezone set, so nothing was sent. Set the business timezone in Settings and try again.",
                'Tenant timezone unset — "today" is undefined and a UTC fallback could text the wrong day\'s customer.',
                true,
              );
            }
            logger.warn('assistant/chat: en_route unavailable — core repos not wired', {
              correlationId,
              tenantId,
              reason: outcome.reason,
            });
            return enRouteReply(
              "I can't send an on-my-way text from here right now — nothing was sent. Use the en-route button on the appointment instead.",
              `en_route core unavailable: ${outcome.reason}.`,
              true,
            );
          }
          if (outcome.kind === 'ambiguous') {
            return enRouteReply(
              ambiguousReferenceLine(outcome.reference, outcome.candidates),
              'More than one of your appointments today matches — asked instead of guessing.',
            );
          }
          return enRouteReply(
            outcome.answer.summary,
            outcome.answer.result === 'found'
              ? 'Direct status act — fired the same audited en-route notice as the app button (appointment.en_route_triggered).'
              : 'No eligible appointment today — said so instead of pretending to act.',
          );
        } catch (err) {
          // A VISIBLE failure — never fall through to the DB-less LLM,
          // which would happily claim the text was sent.
          logger.error('assistant/chat: en_route failed', {
            correlationId,
            tenantId,
            error: err instanceof Error ? err.message : String(err),
          });
          return enRouteReply(
            "I couldn't send the on-my-way text just now — that action failed, and nothing was sent. Try the en-route button on the appointment.",
            `en_route act failed: ${err instanceof Error ? err.message : String(err)}`,
            true,
          );
        }
      }

      // UB-B3 — voice-mode approval guard. approve/reject/edit_proposal are
      // NOT routed in this chat handler; before this guard they fell through
      // to the generic LLM path, so a spoken "approve it" got a free-form LLM
      // reply. Intercept HERE — before the chain/handler/LLM paths — so a
      // voice turn gets a deterministic refusal, never an approval action and
      // never an LLM improvisation. In-app voice approval stays deferred
      // (RV-071/RV-225: approve/reject/edit by voice is owner-telephony only).
      if (
        inputMode === 'voice' &&
        (isVoiceApprovalIntent(classification.intentType) ||
          isVoiceEditIntent(classification.intentType))
      ) {
        if (deps.auditRepo) {
          try {
            await deps.auditRepo.create(createAuditEvent({
              tenantId,
              actorId: userId,
              actorRole: 'user',
              eventType: 'assistant.voice_approval_refused',
              entityType: 'assistant_chat',
              entityId: correlationId,
              metadata: { intentType: classification.intentType },
            }));
          } catch {
            // Audit failures must not block the refusal reply.
          }
        }
        return {
          taskType: 'assistant.voice_approval_refused',
          model: 'policy-guard',
          usage: classifierUsage,
          message: {
            role: 'assistant' as const,
            content: VOICE_APPROVAL_REFUSAL,
            reasoning:
              'Voice approvals are not enabled on this surface; approvals require a screen tap.',
          },
        };
      }

      // QA-2026-06-05 (AST-07, scoped): multi-step asks ("…, then …") are
      // decomposed into SEQUENTIAL linked proposals sharing a chainId in
      // sourceContext. Each step executes per its action class: capture
      // steps auto-approve at confidence and the worker executes them;
      // money/comms steps land ready_for_review — the HITL contract is
      // never bypassed (the original matrix expectation of a fully-executed
      // invoice without approval contradicts 'money never auto-approves').
      const chainSegments = lastUserText.split(/(?:,\s*)?\bthen\b\s+/i).map((seg) => seg.trim()).filter(Boolean);
      if (chainSegments.length >= 2 && chainSegments.length <= 4) {
        // PR-0a (#967, #962) — a real uuid, matching the id shape
        // applyChainMetadata/findByChain expect elsewhere (voice/memo
        // chains already mint theirs via uuidv4 in voice-action-router.ts).
        // Nothing parses the old `chain_${Date.now()}_${random}` string
        // format, so switching it is safe.
        const chainId = uuidv4();
        const chainCards: AssistantProposal[] = [];
        const carried: Record<string, unknown> = {};
        // #913 — top-level classify plus every segment classify that landed.
        let chainUsage = classifierUsage;
        for (const segment of chainSegments) {
          let segClass;
          try {
            // Same context object as the top-level classification above so
            // the two can't drift on which intents are even emittable.
            segClass = await classifyIntent(segment, classifyContext, deps.gateway);
          } catch {
            continue;
          }
          chainUsage = sumUsage(chainUsage, usageOf(segClass.tokenUsage));
          // create_customer is the one documented exception to
          // CHAT_INTENT_TO_REGISTRY_KEY (see that constant's doc comment) —
          // the chain path has no conversational "ask for a name" fallback,
          // so it dispatches create_customer straight to the plain shared
          // handler rather than skipping it.
          const registryKey =
            segClass.intentType === 'create_customer'
              ? 'create_customer'
              : CHAT_INTENT_TO_REGISTRY_KEY[segClass.intentType];
          if (!registryKey) continue;
          const factory = () => sharedHandlers.get(registryKey)!;
          const segEntities: Record<string, unknown> = { ...carried, ...(segClass.extractedEntities ?? {}) };
          if (segClass.intentType === 'create_customer' && segEntities.displayName && !segEntities.name) {
            segEntities.name = segEntities.displayName;
          }
          // UB-A3 — thread the applicable standing instructions (≤5, keyed
          // on this segment's classified intent) into the drafting handler.
          const segStandingInstructions = selectInjectedStandingInstructions(
            activeStandingInstructions,
            segClass.intentType,
          );
          // U1 — voice-worker parity: resolve free-text references to
          // verified tenant ids BEFORE drafting; the resolved ids ride
          // `existingEntities` (the seam the task handlers consume) and are
          // stamped into verifiedIds below so the scrub preserves them.
          const segVerifiedIds = await resolveVerifiedIdsForDraft(
            deps.entityResolver,
            tenantId,
            segClass.intentType,
            segEntities,
          );
          // I3 — resolved once (memoized) and reused across every segment.
          const segTenantThresholdOverride = await getTenantThresholdOverride();
          const { proposal } = await factory().handle({
            tenantId,
            userId,
            message: segment,
            conversationId,
            // Task 15 (2026-08-07 tradesperson plan), Task 11 parity — the
            // raw classified intent, for handlers that alias multiple
            // intents onto the same taskType (log_mileage vs log_expense
            // both drive LogExpenseTaskHandler; see TaskContext.intent's doc
            // comment, ai/tasks/task-handlers.ts). The memo worker has
            // always threaded this; this chat path never did, so
            // log_mileage would have silently drafted a plain, wrong-
            // category log_expense once dispatched.
            intent: segClass.intentType,
            existingEntities: { ...segEntities, ...segVerifiedIds },
            // Task 15 quality-review fix (C1/C2) — `context.customerId` is
            // threaded ONLY for the CHAT_CONTEXT_CUSTOMER_ID_INTENTS
            // allowlist (see that constant's doc comment for why this is
            // deliberately narrow, not a blanket "mirror the memo worker's
            // precedence" thread: several already-shipped intents read this
            // same field as an exclusive, unrelated side channel — a
            // held-slot calendar write, an unsupervised appointment
            // auto-pick — that a dispatch-wiring task must not silently
            // activate).
            ...(CHAT_CONTEXT_CUSTOMER_ID_INTENTS.has(segClass.intentType) && segVerifiedIds.customerId
              ? { customerId: segVerifiedIds.customerId }
              : {}),
            // Tenant zone for the scheduling handlers in this chain.
            ...timezoneContext,
            ...(segStandingInstructions
              ? { standingInstructions: segStandingInstructions }
              : {}),
            // Phase 12 supervisor gate (commit 1) — see the isSupervisorPresent
            // import comment above. Threaded unconditionally: harmless for
            // every handler that never sets sourceTrustTier (the vast
            // majority), load-bearing for the six that do. Lazy (minor fix,
            // post-C1 review) — only resolved now that we're genuinely
            // about to dispatch a proposal-creating handler.
            supervisorPresent: await getSupervisorPresent(),
            ...(supervisorMode ? { supervisorMode } : {}),
            // I3 — Settings UI per-tenant threshold override.
            ...(segTenantThresholdOverride
              ? { tenantThresholdOverride: segTenantThresholdOverride }
              : {}),
          });
          if (!proposal) continue;
          stampVerifiedIds(proposal, segVerifiedIds);
          dropUnverifiedIds(proposal.payload, segment, segEntities, proposal.sourceContext);
          // PR-0a (#967, #962) — stamp the TOP-LEVEL chainId (the same
          // helper + column the voice/memo path uses) so
          // ProposalRepository.findByChain and the web Inbox's
          // groupIntoFeed (which both key on Proposal.chainId, not
          // sourceContext) actually find chat-produced chains.
          //
          // chainRefs stays empty here: the chat path threads dependent
          // entities forward via the `carried` object below (customerName
          // only, resolved before drafting), not applyChainMetadata's
          // `$ref:chain[n]` token machinery — so `chainRefs.length > 0`
          // never fires and this can't force a proposal back to 'draft'
          // out from under the dependency-gate status handling that
          // follows.
          applyChainMetadata(proposal, {
            chainId,
            chainIndex: chainCards.length,
            chainLength: chainSegments.length,
            dependsOnChainIndices: [],
            chainRefs: [],
          });
          // Back-compat: chainStep (1-based) predates chainIndex
          // (0-based, applyChainMetadata's convention) — keep both so any
          // existing reader of the old field still works.
          proposal.sourceContext = {
            ...(proposal.sourceContext ?? {}),
            chainStep: chainCards.length + 1,
          };
          // #909 — the same post-draft resolution the single-intent path
          // runs, so a chained "reschedule the Miller job, then text them"
          // gets its ids resolved too and the two halves of THIS route can't
          // drift on how a reference is resolved.
          //
          // But it does NOT ask, and does NOT stamp a pending question
          // (`askClarification: false`). Two reasons, and the second is the
          // decisive one:
          //
          //   1. A chain turn answers with N cards. The reply is a summary,
          //      not a conversation, and appending "which Miller?" to it
          //      hands the operator a question and a pile of cards at once.
          //   2. REFERENT COLLISION. In a multi-card reply the most natural
          //      reading of "the second one" is THE SECOND CARD — which is
          //      exactly the phrasing the disambiguation matcher treats as
          //      an ordinal answer about candidates. Stamping a question
          //      here would arm a matcher whose highest-precision input is
          //      ambiguous in precisely this context.
          //
          // So an ambiguous reference in a chain keeps today's behavior: the
          // gated card with its own candidate picker, which is unambiguous
          // no matter how many cards sit beside it. Resolution still runs,
          // so unambiguous references in a chain are filled exactly as they
          // are on the single-intent path.
          await resolveGatedReferencesForChat(
            deps,
            tenantId,
            userId,
            correlationId,
            proposal,
            segEntities,
            false,
          );
          // Dependency gate: steps after the first reference results that
          // don't exist yet (the customer, their job). Auto-approval would
          // send them into doomed executions — hold every dependent step
          // (and any draft) in ready_for_review for sequential operator
          // approval as predecessors materialize.
          if (chainCards.length >= 1 && proposal.status === 'approved') {
            proposal.status = 'ready_for_review';
            proposal.approvedAt = undefined;
          }
          // I4 (post-C1 review) — chokepoint backstop, mirroring
          // workers/voice-action-router.ts's holdIfUnsupervised: every
          // dispatched handler forwards supervisorPresent today, but this
          // is the ONE place every chat-sourced proposal flows through, so
          // a future CHAT_INTENT_TO_REGISTRY_KEY entry that forgets to
          // forward it can't slip an auto-approved proposal past an
          // unsupervised tenant. No-op when the handler already agreed
          // (the normal case). Already resolved (memoized) by the dispatch
          // call above, so this await is free.
          Object.assign(proposal, holdIfUnsupervised(proposal, await getSupervisorPresent()));
          // A caller without the direct permission never gets a self-executing
          // proposal — their draft waits for the approval tap instead.
          downgradeIfCallerLacksDirectPermission(proposal, callerRole);
          await deps.proposalRepo.create(proposal);
          if (proposal.status === 'draft') {
            await deps.proposalRepo.updateStatus(tenantId, proposal.id, 'ready_for_review');
          }
          // Carry the customer reference into later steps so "for her" /
          // "their estimate" resolves at execution time.
          if (typeof segEntities.name === 'string') carried.customerName = segEntities.name;
          if (typeof segEntities.displayName === 'string') carried.customerName = segEntities.displayName;
          chainCards.push(proposalToUI(proposal, segment));
        }
        if (chainCards.length === 1) {
          // Only one segment produced a proposal — return it directly so the
          // single-intent path doesn't mint a duplicate.
          return {
            taskType: 'assistant.chain',
            model: 'intent-classifier',
            usage: chainUsage,
            message: {
              role: 'assistant' as const,
              content: `${chainCards[0].title}. ${proposalReplySuffix(chainCards[0].status)}`,
              proposal: chainCards[0],
            },
          };
        }
        if (chainCards.length >= 2) {
          return {
            taskType: 'assistant.chain',
            model: 'intent-classifier',
            usage: chainUsage,
            message: {
              role: 'assistant' as const,
              content:
                `Created ${chainCards.length} linked steps: ` +
                chainCards.map((c, i) => `${i + 1}) ${c.title}`).join('; ') +
                '. Capture steps run after approval windows; money steps wait for your approval.',
              proposal: chainCards[0],
            },
          };
        }
      }

      // QA-2026-06-05 (AST-02/03/04): estimate/invoice intents go through
      // the REAL task handlers and persist — the generic LLM path returned
      // unpersisted JSON cards whose ids 404'd on approve. `create_customer`
      // is the one documented exception to CHAT_INTENT_TO_REGISTRY_KEY (see
      // that constant's doc comment) — it's dispatched from its own branch
      // below instead, so it's absent from this lookup on purpose.
      const registryKey = CHAT_INTENT_TO_REGISTRY_KEY[classification.intentType];
      const handlerFactory = registryKey ? () => sharedHandlers.get(registryKey)! : undefined;
      if (handlerFactory) {
        const handler = handlerFactory();
        // UB-A3 — thread the applicable standing instructions (≤5, keyed on
        // the classified intent) into the drafting handler.
        const standingInstructions = selectInjectedStandingInstructions(
          activeStandingInstructions,
          classification.intentType,
        );
        const extractedEntities: Record<string, unknown> = {
          ...(classification.extractedEntities ?? {}),
        };
        // U1 — voice-worker parity: resolve free-text references to verified
        // tenant ids BEFORE drafting (see resolveVerifiedIdsForDraft).
        const verifiedIds = await resolveVerifiedIdsForDraft(
          deps.entityResolver,
          tenantId,
          classification.intentType,
          extractedEntities,
        );
        // I3 — resolved once (memoized).
        const singleIntentTenantThresholdOverride = await getTenantThresholdOverride();
        const { proposal } = await handler.handle({
          tenantId,
          userId,
          message: lastUserText,
          conversationId,
          // Task 15 (2026-08-07 tradesperson plan) / Task 11 parity — see the
          // identical comment on the chain-segment `.handle()` call above.
          intent: classification.intentType,
          existingEntities: { ...extractedEntities, ...verifiedIds },
          // Task 15 quality-review fix (C1/C2) — see the identical comment +
          // CHAT_CONTEXT_CUSTOMER_ID_INTENTS doc comment on the
          // chain-segment `.handle()` call above: this is an explicit
          // allowlist, not a blanket thread.
          ...(CHAT_CONTEXT_CUSTOMER_ID_INTENTS.has(classification.intentType) && verifiedIds.customerId
            ? { customerId: verifiedIds.customerId }
            : {}),
          // Tenant zone — `create_appointment` resolves the spoken time
          // against it. Absent ⇒ the handler gates instead of guessing.
          ...timezoneContext,
          ...(standingInstructions ? { standingInstructions } : {}),
          // Phase 12 supervisor gate (commit 1) — see the isSupervisorPresent
          // import comment above. Lazy (minor fix, post-C1 review).
          supervisorPresent: await getSupervisorPresent(),
          ...(supervisorMode ? { supervisorMode } : {}),
          // I3 — Settings UI per-tenant threshold override.
          ...(singleIntentTenantThresholdOverride
            ? { tenantThresholdOverride: singleIntentTenantThresholdOverride }
            : {}),
        });
        stampVerifiedIds(proposal, verifiedIds);
        dropUnverifiedIds(
          proposal.payload,
          lastUserText,
          extractedEntities,
          proposal.sourceContext,
        );
        // #909 — post-draft resolution, AFTER the scrub on purpose: a
        // hallucinated id the scrub just deleted leaves the gate standing,
        // and this loop then fills it from a real DB lookup instead. Its own
        // ids are DB-verified by construction, so they are never subject to
        // the scrub.
        const clarification = await resolveGatedReferencesForChat(
          deps,
          tenantId,
          userId,
          correlationId,
          proposal,
          extractedEntities,
          // This path returns ONE card and speaks the question in its reply,
          // so a pending question here is one the operator provably saw.
          true,
        );
        // I4 (post-C1 review) — chokepoint backstop; see the identical
        // comment on the chain-segment path above. Already resolved
        // (memoized) by the dispatch call above.
        Object.assign(proposal, holdIfUnsupervised(proposal, await getSupervisorPresent()));
        // A caller without the direct permission never gets a self-executing
        // proposal — their draft waits for the approval tap instead.
        downgradeIfCallerLacksDirectPermission(proposal, callerRole);
        await deps.proposalRepo.create(proposal);
        if (proposal.status === 'draft') {
          await deps.proposalRepo.updateStatus(tenantId, proposal.id, 'ready_for_review');
        }
        const uiProposal = proposalToUI(proposal, lastUserText);
        return {
          taskType: `assistant.${handler.taskType}`,
          model: 'intent-classifier',
          usage: classifierUsage,
          message: {
            role: 'assistant' as const,
            // #909 — an ambiguous reference asks ONE question instead of
            // announcing a card the operator cannot approve. The card still
            // rides along: the question is the fast path, the picker on the
            // card is the fallback if they would rather point at it.
            content: clarification
              ? `${uiProposal.title}.\n\n${clarification}`
              : `${uiProposal.title}. ${proposalReplySuffix(uiProposal.status)}`,
            reasoning: classification.reasoning,
            proposal: uiProposal,
          },
        };
      }

      if (classification.intentType === 'create_customer') {
        // B8 — dedup-aware handler (same construction as the telephony FSM
        // and the chain map above), drawn from sharedHandlers so this
        // surface can't drift from the worker's create_customer handling.
        const handler = sharedHandlers.get('create_customer')!;
        const entities = classification.extractedEntities;
        // Same translation the voice-action-router does: classifier
        // surfaces `displayName`, the create_customer contract wants
        // `name`.
        const customerPayload: Record<string, unknown> = {};
        if (entities?.displayName) customerPayload.name = entities.displayName;
        if (entities?.email) customerPayload.email = entities.email;
        if (entities?.phone) customerPayload.phone = entities.phone;

        // A create_customer intent classified from an under-specified command
        // ("Add a new customer" — e.g. the one-tap assistant suggestion chip)
        // extracts no name. Drafting from the empty payload is a dead-end: the
        // review card would either let the operator Approve it into a hard
        // execution failure ("Payload must include a non-empty name"), or — if
        // we marked it missingFields — block Approve with no way to clear the
        // marker (editProposal updates payload only, so approveProposal keeps
        // rejecting on the stale sourceContext.missingFields). Ask for the name
        // conversationally instead; the operator's reply re-enters
        // create_customer WITH a name and drafts a real, approvable proposal.
        if (!customerPayload.name) {
          return {
            taskType: 'assistant.create_customer.needs_name',
            model: 'intent-classifier',
            usage: classifierUsage,
            message: {
              role: 'assistant' as const,
              content:
                "Sure — what's the customer's name? Share it (and their phone or email if you have them) and I'll draft the new customer for you to approve.",
              reasoning:
                'create_customer intent without an extracted name — asking for it instead of drafting an unapprovable empty proposal.',
            },
          };
        }

        const { proposal } = await handler.handle({
          tenantId,
          userId,
          message: lastUserText,
          existingEntities: customerPayload,
          // Minor fix (post-C1 review) — thread supervision here too for
          // consistency with the other two dispatch sites, even though
          // CreateCustomerTaskHandler never sets `sourceTrustTier` and so
          // can never reach the auto-approve branch (this proposal always
          // lands 'draft', promoted to 'ready_for_review' just below).
          // Inert today; kept in step so a future change to this handler
          // doesn't silently inherit the exact gap commit 1 fixed.
          supervisorPresent: await getSupervisorPresent(),
          ...(supervisorMode ? { supervisorMode } : {}),
          // I3 — same consistency rationale as supervisorPresent above.
          ...((await getTenantThresholdOverride())
            ? { tenantThresholdOverride: await getTenantThresholdOverride() }
            : {}),
        });
        await deps.proposalRepo.create(proposal);
        // QA-2026-06-05: parity with the guardrail promote step (see
        // inapp-adapter.handleCreateProposal). create-customer-task builds
        // proposals without a trust tier, so they land 'draft' — invisible
        // to the inbox and unapprovable under the lifecycle guard. Promote
        // complete drafts so the operator can act on them.
        if (proposal.status === 'draft') {
          await deps.proposalRepo.updateStatus(tenantId, proposal.id, 'ready_for_review');
        }

        const uiProposal = customerProposalToUI({
          proposalId: proposal.id,
          payload: proposal.payload,
          sourceMessage: lastUserText,
          confidenceScore: classification.confidence,
          sourceContext: proposal.sourceContext,
          // F1 — the handler's own reasoning, which this serializer used to
          // discard. See `cardExplanation`.
          explanation: proposal.explanation,
        });

        return {
          taskType: 'assistant.create_customer',
          model: 'intent-classifier',
          usage: classifierUsage,
          message: {
            role: 'assistant' as const,
            content: uiProposal.title + '. Review and approve to add them to your CRM.',
            reasoning: classification.reasoning,
            proposal: uiProposal,
          },
        };
      }

      // ── Honest-failure guard, layer 1: UNMAPPED CAPABILITY ─────────
      // Nothing above matched. If the classifier was CONFIDENT about a real
      // write intent and this surface simply has no handler wired for it —
      // today that means a CHAT_DISPATCH_EXCLUDED_INTENTS member
      // (`emergency_dispatch`, `update_brand_voice`, `respond_to_review`,
      // `create_standing_instruction` — see that constant's doc comment for
      // why each is excluded) or a genuinely new, not-yet-wired taxonomy
      // intent — the only honest answer is "I can't do that from here", and
      // it must be said deterministically.
      //
      // This is the door PR #776 left open. That change closed the
      // low-confidence hole ('unknown' → clarification) but a CONFIDENT
      // unmapped intent still fell through to the generic LLM path below,
      // which is handed the raw imperative and asked for "concise operational
      // help". A past-tense confirmation is that prompt's most natural
      // completion, and it is exactly what production produced, for the
      // THEN-unmapped `add_crew_member` (wired since Task 15, 2026-08-07
      // tradesperson plan):
      //   "put Dave on the crew"  → "I've added Dave to the crew."
      // No row was written. The tradesperson drives away believing it was.
      //
      // Refusing HERE — before the gateway is touched — is what makes this
      // structural rather than a hope: the model is never consulted, so it
      // cannot improvise. `isActionIntent` is a deny-list, so a newly added
      // taxonomy intent defaults to "action" and is refused until it is
      // wired, never fabricated.
      //
      // 'unknown' is deliberately NOT handled here. It is a failure to
      // classify, not a capability gap, and the operator is better served by
      // the LLM's answer when that answer is honest ("Nothing has been
      // scheduled yet — tell me the customer"). Layers 2 and 3 below cover
      // it: the fallback prompt is told it has done nothing, and any reply
      // that claims otherwise is replaced with buildNotUnderstoodReply.
      if (classification.intentType !== 'unknown' && isActionIntent(classification.intentType)) {
        logger.warn('assistant/chat: confident write intent with no handler — refusing', {
          correlationId,
          tenantId,
          intent: classification.intentType,
          confidence: classification.confidence,
        });
        return buildUnmappedCapabilityReply(classification.intentType);
      }
    } catch (err) {
      // Classifier failure should never break the chat — drop into the
      // generic LLM path so the operator still gets a response. But it must
      // never be SILENT: this catch previously swallowed every classifier
      // exception with no log at all, so the resulting generic-LLM reply
      // (which can no longer claim an action, but still answers from nothing)
      // was indistinguishable from a healthy turn in production.
      //
      // Honest-failure guard state: record WHY there is no proposal. This is
      // what lets layer 3 below tell "I didn't understand you" apart from
      // "the intent path broke" — the 429 that produced "I have scheduled the
      // appointment for Thursday at 10 AM." landed here, and answering it
      // with a clarification would have been a second, quieter lie: the
      // operator was not unclear, we were broken.
      guardIntentError = err instanceof Error ? err.message : String(err);
      logger.error('assistant/chat: intent path failed, falling back to generic LLM', {
        correlationId,
        tenantId,
        error: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? err.stack : undefined,
      });
    }
  }

  // ── Fallback path: generic LLM text reply ────────────────────────
  const taskType = inferTaskType(lastUserText);
  const systemPrompt = getSystemPrompt(taskType);

  try {
    const response = await deps.gateway.complete({
      taskType,
      // Top-level tenantId — the quota/cache resilience wrappers key on
      // this, not metadata.tenantId (see gateway.ts's tenant-id guard).
      // `assistant.*` taskTypes aren't in the guard's tracked TASK_TYPES
      // allow-list (they're dynamically constructed), but this route is
      // still genuinely per-tenant chat traffic.
      tenantId,
      responseFormat: 'json',
      messages: [
        // Honest-failure guard, layer 2. This path has no tools and writes
        // nothing; the model is the only participant that doesn't know that,
        // so it is told. A directive alone is not the fix — the model can
        // ignore it, which is exactly what the two observed fabrications
        // were — so layer 3 below verifies the answer regardless.
        {
          role: 'system',
          content: `${systemPrompt}\n\n${NO_ACTION_TAKEN_DIRECTIVE}\n\n${outputContract}`,
        },
        ...messages.filter((m) => m.role !== 'system'),
      ],
      temperature: 0.2,
      maxTokens: 700,
      metadata: { source: 'assistant-chat-route', tenantId, correlationId },
    });

    const parsed = assistantReplySchema.parse(JSON.parse(response.content));

    // ── Honest-failure guard, layer 3 ────────────────────────────────
    // Nothing on this path persists anything — `deps.proposalRepo.create`
    // is never called anywhere in this function. So a reply that claims a
    // completed action in its TEXT, or that carries a `proposal` object AT
    // ALL, is false by construction — we do not need to guess, we know.
    // Verify rather than trust: the two production fabrications came from a
    // model that had every opportunity to behave and didn't, and a prompt
    // instruction cannot be relied on to change that (`outputContract`
    // above now also tells the model "proposal" must always be null here —
    // belt, not the buckle).
    //
    // 2026-08-29 live sweep, row A02 ("Draft an estimate for {customer}:
    // two lines…"): this used to read `parsed.proposal ? null :
    // detectFabricatedActionClaim(...)` — SKIPPING the check entirely
    // whenever the model included a `proposal` object, on the theory that
    // "a reply that carries a proposal legitimately says 'I've drafted…',
    // because it has." That is true on every OTHER path this route returns
    // from (the registry-dispatch and chain paths below persist a REAL
    // proposal before building their reply), but false HERE — this
    // fallback has no handler, no repo call, nothing to draft with. The
    // model used the opening to invent a whole proposal card, id
    // "estimate-001" included, that 404'd on approve. So: a `proposal` on
    // THIS path is stripped unconditionally before it ever reaches the
    // operator, and its mere presence is itself a fabrication signal —
    // on top of, not instead of, the text-claim scan.
    const fabricatedProposalId = parsed.proposal?.id;
    const fabricated = fabricatedProposalId
      ? `proposal id "${fabricatedProposalId}"`
      : detectFabricatedActionClaim(parsed.content);
    if (fabricated) {
      logger.error('assistant/chat: suppressed fabricated action confirmation', {
        correlationId,
        tenantId,
        taskType,
        intent: guardIntent,
        confidence: guardConfidence,
        intentError: guardIntentError,
        claim: fabricated,
      });
      // Three failures, three experiences. Layer 1 already took "I can't do
      // that" (a confident, unmapped write intent never reaches here), so
      // what is left is the other two — and they are genuinely different
      // things to say to an operator standing in someone's kitchen.
      return guardIntentError
        ? buildClassifierErrorReply(guardIntentError)
        : buildNotUnderstoodReply(guardConfidence);
    }

    return {
      taskType,
      model: response.model,
      // #913 — an 'unknown' classify still paid for its tokens before
      // falling through to this generic reply.
      usage: sumUsage(classifierUsage, response.tokenUsage),
      degraded: response.degraded ?? false,
      fallbackStage: response.fallbackStage,
      message: {
        role: 'assistant' as const,
        ...parsed,
        // This path never persists a proposal (see layer 3 above) — never
        // forward whatever the model put in `parsed.proposal`, even a
        // shape that happened to dodge the id check.
        proposal: undefined,
      },
    };
  } catch (err) {
    // Log the real failure server-side (BUG-5) — the client only ever sees
    // the degraded envelope, so without this the root cause (missing/invalid
    // provider key, JSON parse failure, provider outage) is invisible.
    logger.error('assistant/chat: LLM completion failed', {
      correlationId,
      taskType,
      tenantId,
      error: err instanceof Error ? err.message : String(err),
    });
    return {
      taskType,
      model: 'fallback',
      usage: { input: 0, output: 0, total: 0 },
      degraded: true,
      fallbackStage: 'error-envelope',
      message: {
        role: 'assistant' as const,
        content: 'I can help with invoices, scheduling, follow-ups, estimates, and creating customers. Tell me what you want to do next.',
        reasoning: 'AI provider unavailable, returned fallback response.',
      },
    };
  }
}

function writeSse(res: Response, event: string, data: unknown): void {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

export function createAssistantRouter(deps: AssistantRouterDeps): Router {
  const router = Router();

  // B5 — the scheduling family / create_job / invoice-follow-up intents this
  // route was missing draft through the SAME shared registry the voice worker
  // uses (see the import comment above). Built ONCE at composition time
  // (handler construction does no I/O) — the registry doc says
  // composition-time, and the voice worker already does this in
  // createVoiceActionRouterWorker. Building it here (rather than per-turn
  // inside generateAssistantReply) is also what lets BOTH dispatch maps draw
  // every registry-covered type from ONE map, so the single-intent and chain
  // surfaces can't drift on handler construction. `invoicingDeps` is assembled
  // inline (mirrors VoiceActionRouterDeps' separation of the narrow
  // estimateRepo/invoiceRepo from the full trio findJobsRequiringInvoicing
  // needs) and is only passed when all three repos are wired — absent,
  // batch_invoice degrades to its own "not available" clarification.
  // B4 — issue_invoice is built by the shared registry too (proposalRepo
  // threaded through), so "issue the one we just drafted" resolves from
  // conversation context on THIS surface the same way it does on the voice
  // worker — same handler instance shape, same gate.
  const sharedHandlers = buildTaskHandlers({
    gateway: deps.gateway,
    catalogRepo: deps.catalogRepo,
    estimateRepo: deps.estimateRepo,
    invoiceRepo: deps.invoiceRepo,
    appointmentRepo: deps.appointmentRepo,
    jobRepo: deps.jobRepo,
    dunningEventRepo: deps.dunningEventRepo,
    invoicingDeps:
      deps.jobRepo && deps.invoiceRepo && deps.estimateRepo
        ? { jobRepo: deps.jobRepo, invoiceRepo: deps.invoiceRepo, estimateRepo: deps.estimateRepo }
        : undefined,
    proposalRepo: deps.proposalRepo,
    // B8 — create_customer draft-time duplicate detection parity.
    customerRepo: deps.customerRepo,
    // Draft-time bookability gate for create_appointment (no service
    // location ⇒ missingFields, never an auto-approved doomed execution).
    ...(deps.locationRepo ? { locationRepo: deps.locationRepo } : {}),
  });

  router.post(
    '/chat',
    requireAuth,
    requireTenant,
    requirePermission('ai:run'),
    async (req: AuthenticatedRequest, res: Response) => {
      // Story 3.12 — one correlation id per chat turn, threaded into the gateway
      // call + every error log so a failure is traceable end-to-end. Honors an
      // inbound x-correlation-id when the caller supplies one.
      const correlationId =
        req.header('x-correlation-id') || `assistant-${req.auth!.userId}-${uuidv4()}`;
      try {
        const parsed = assistantChatRequestSchema.parse(req.body);

        // #909 (2026-08-31) — resolve (or MINT) the conversation id BEFORE
        // drafting, not after. This used to draft with `parsed.
        // conversationId` verbatim (undefined on a brand-new conversation's
        // first turn) and only resolve/mint the REAL id afterward via
        // `recordAssistantTurn`, returning THAT id to the client — so a
        // proposal drafted on a conversation's opening turn was stamped
        // with NO conversation id at all (task-input.ts's
        // `baseSourceContext` only stamps `sourceContext.conversationId`
        // when one is present). `findPendingClarification` (below) and
        // `ProposalRepository.findByConversation` key on exactly that
        // field, so a D-029 clarification ask drafted on turn 1 could never
        // be found by turn 2's plain-text answer — it landed as a fresh,
        // unrelated utterance instead (live sweep 2026-08-31T01-33, rows
        // A12/A20: "the tune-up one" / "the most recent one" both got
        // generic-LLM confusion, never `applyDisambiguationAnswer`).
        //
        // Only the ABSENT case is minted here — a present value (whatever
        // shape) passes through unchanged, exactly as before: a caller that
        // already tracks conversations by its own non-UUID key (a test
        // fixture, or a future non-Postgres-backed caller) must keep
        // working unmodified. `recordAssistantTurn` below still
        // self-corrects a value it can't honor (see the reassignment and
        // its own doc comment, conversations/conversation-service.ts) —
        // this fix is strictly about the one case that was never resolved
        // AT ALL before drafting: absent.
        let conversationId = parsed.conversationId ?? uuidv4();

        const result = await generateAssistantReply(
          parsed.messages,
          req.auth!.tenantId,
          req.auth!.userId,
          deps,
          correlationId,
          sharedHandlers,
          parsed.inputMode,
          // B4 — threads into TaskContext.conversationId for every drafting
          // handler (baseSourceContext stamps sourceContext.conversationId
          // from this), and for handlers like IssueInvoiceTaskHandler that
          // resolve "the one we just drafted" from same-conversation
          // proposal history. Always defined now (see above) — never the
          // bare, possibly-absent `parsed.conversationId`.
          conversationId,
          // DB-authoritative role (requireTenant overwrites req.auth.role with
          // the membership row's role), so a stale/forged `owner` token claim
          // cannot buy a self-executing proposal.
          req.auth!.role,
          // P12-001/P12-004 wiring gap (commit 1) — `requireTenant` (above)
          // already attaches `req.auth.mode` from `users.current_mode`
          // (defaulting to 'supervisor' with no loader wired); it just had
          // no downstream reader until now. `AuthWithMode` is a local,
          // unexported cast type in middleware/auth.ts (its `mode` field is
          // exactly `Mode` from proposals/auto-approve.ts), so the shape is
          // mirrored here via the shared `Mode` type rather than a fresh
          // hand-rolled union (minor fix, post-C1 review).
          (req.auth as { mode?: Mode } | undefined)?.mode,
        );

        // Story 3.11 — persist the turn so the conversation survives reload and
        // is searchable. Failure-soft: a persistence error must not drop the
        // reply the operator is waiting on.
        //
        // Still reassigns `conversationId` from the result, same as before
        // this fix — `recordAssistantTurn` is the SOURCE OF TRUTH for what
        // actually got persisted, and in the one case it can legitimately
        // still diverge (a present-but-non-UUID-shaped value it can't
        // safely reuse as a primary key — see its own doc comment) this is
        // what makes the client-visible id match reality. In the common
        // case (absent → minted above, or an already-real conversation id)
        // it is a no-op: `recordAssistantTurn` returns exactly what it was
        // given.
        if (deps.conversationRepo) {
          try {
            const lastUserText =
              [...parsed.messages].reverse().find((m) => m.role === 'user')?.content ?? '';
            conversationId = await recordAssistantTurn(
              deps.conversationRepo,
              {
                tenantId: req.auth!.tenantId,
                userId: req.auth!.userId,
                conversationId,
                userText: lastUserText,
                assistantText: result.message.content,
              },
              deps.auditRepo,
            );
          } catch (persistErr) {
            logger.error('assistant/chat: conversation persist failed', {
              correlationId,
              tenantId: req.auth!.tenantId,
              error: persistErr instanceof Error ? persistErr.message : String(persistErr),
            });
          }
        }

        // The reply envelope carries the conversation id (so the client pins the
        // thread) and the correlation id (traceability).
        const envelope = { ...result, conversationId, correlationId };

        if (parsed.stream) {
          res.setHeader('Content-Type', 'text/event-stream');
          res.setHeader('Cache-Control', 'no-cache, no-transform');
          res.setHeader('Connection', 'keep-alive');
          res.flushHeaders();

          const content = result.message.content;
          const chunks = content.match(/.{1,18}(\s|$)/g) ?? [content];
          // Mirror the SSE token stream onto the client WS gateway,
          // scoped to the user-specific target so concurrent operators
          // in the same tenant don't see each other's tokens.
          const { publish } = await import('../ws/client-gateway');
          const userTarget = req.auth!.userId;
          for (const chunk of chunks) {
            writeSse(res, 'token', { delta: chunk });
            publish(
              'assistant',
              userTarget,
              {
                kind: 'assistant.token',
                channel: 'assistant',
                delta: chunk,
                correlationId,
                degraded: result.degraded ?? false,
              },
              req.auth!.tenantId,
            );
          }
          writeSse(res, 'done', envelope);
          publish(
            'assistant',
            userTarget,
            {
              kind: 'assistant.done',
              channel: 'assistant',
              finalText: content,
              correlationId,
              degraded: result.degraded ?? false,
              fallbackStage: result.fallbackStage,
            },
            req.auth!.tenantId,
          );
          res.end();
          return;
        }

        res.json(envelope);
      } catch (err) {
        logger.error('assistant/chat: request failed', {
          correlationId,
          tenantId: req.auth?.tenantId,
          error: err instanceof Error ? err.message : String(err),
        });
        const { statusCode, body } = toErrorResponse(err);
        res.status(statusCode).json(body);
      }
    }
  );

  return router;
}
