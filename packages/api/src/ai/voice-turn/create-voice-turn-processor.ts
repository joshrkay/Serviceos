/**
 * VoiceTurnProcessor — closure-captured agent loop extracted from
 * `TwilioGatherAdapter` so both production AND the Layer 2 voice-quality
 * harness can drive the real agent through a single factory.
 *
 * Production (`app.ts`) wires `attachMediaStreamServer` with a `speechTurn`
 * that delegates to `TwilioGatherAdapter#processCallerUtterance`. That
 * method (~170 LOC) plus the helpers it transitively reaches
 * (`recordCost`, `executeSideEffects`, `handleAuditLog`,
 * `handleCreateProposal`, `handleNotifyOncall`, the prompt/threshold
 * resolvers, the FSM-confirm-template expansion, the terminated-session
 * finalize, and the end-of-call summary) all lived on the adapter class
 * and so could not be reused without instantiating the whole adapter.
 *
 * This module re-homes that surface as a closure-captured factory:
 *
 *   - `speechTurn`               — the SpeechTurnHandler the media-streams
 *                                  adapter calls; same body as the old
 *                                  `processCallerUtterance` minus the
 *                                  `session` lookup (the WS adapter already
 *                                  resolves it from `start.callSid`).
 *   - `finalizeTerminatedSession`— derive + stash CallOutcome + best-effort
 *                                  persist to voice_sessions. Same
 *                                  signature `(session, sideEffects, reason)`
 *                                  the route layer + media-streams `finalizeOnClose`
 *                                  expect.
 *   - `executeSideEffects`,
 *     `recordCost`,
 *     `expandIntentConfirmTemplate`,
 *     `resolveVerticalPromptSection`,
 *     `resolvePlanPromptSection`,
 *     `resolveThresholdOverride`,
 *     `runSummary`               — exposed so the rest of `TwilioGatherAdapter`
 *                                  (handleInbound, _handleGatherLocked,
 *                                  initializeStreamSession, queueCallbackProposal,
 *                                  finalizeTwiml) can call them directly
 *                                  instead of duplicating logic.
 *
 * The ephemeral `pendingTransferTwiml` session map is accepted as a dep
 * so the adapter and processor share the same Map instance. When the
 * adapter omits it, a fresh empty Map is created — useful for tests.
 *
 * Production behavior is preserved verbatim: same audit emissions, same
 * proposal payload shape, same FSM dispatch order, same cost tracking,
 * same voice-event emissions.
 */

import type { Pool } from 'pg';
import { appendAgentTts, callerTranscriptText } from './transcript-append';
import { classifyIntent, isVoiceApprovalIntent, isVoiceEditIntent } from '../orchestration/intent-classifier';
import {
  AI_BUSY_HOLD_LINE,
  classifyInfraFailure,
  isTransientInfraFailure,
  systemFailureReasonForInfra,
} from './classify-infra-failure';
import {
  startVoiceApproval,
  startVoiceBatchApproval,
  continueVoiceApproval,
  continueVoiceBatchApproval,
  isBatchActive,
  startVoiceEdit,
  type OneTapFallbackDeps,
  type VoiceApprovalDeps,
  type VoiceApprovalTurnResult,
} from '../tasks/proposal-approval-task';
import { createLlmEditInterpreter } from '../../proposals/edit-interpreter';
import type {
  CustomerNegotiationContext,
  CustomerNegotiationContextProvider,
} from '../../customers/customer-negotiation-context';
import {
  brandVoiceNegotiationTts,
  NEGOTIATION_HOLDING_TTS_SOURCE,
} from '../../conversations/negotiation/acknowledgment';
import type { ProposalSmsEventRepository } from '../../proposals/sms/sms-event';
import { confirmIntent } from '../skills/confirm-intent';
import { summarizeSession } from '../skills/summarize-session';
import {
  escalateToHuman,
  emergencyImmediateDial,
  EMERGENCY_INTENTS,
} from '../skills/escalate-to-human';
import { estimateCostCents } from '../skills/session-cost-tracker';
import {
  intentClassifiedEvent,
  costIncurredEvent,
  sessionTerminatedEvent,
  escalationStartedEvent,
} from '../voice-quality/events';
import { VOICE_EVENT_CHANNEL } from '../voice-quality/event-bus';
import { buildEscalationSummary } from '../agents/customer-calling/escalation-summary-builder';
import { buildCallerContextFromSession } from '../agents/customer-calling/escalation-context-from-session';
import {
  hydrateEscalationCrm,
  mergeCallerContextWithCrm,
} from '../agents/customer-calling/hydrate-escalation-crm';
import type { TagRepository } from '../../customers/tag';
import type { WhisperCache } from '../../telephony/whisper-cache';
import type { PanelData } from '../agents/customer-calling/escalation-summary-builder';
import {
  TAU_INT,
  MAX_REFINEMENTS_PER_CALL,
  REFINEMENT_CAP_LINE,
} from '../agents/customer-calling/transitions';
import {
  classifyPostQuoteUtterance,
  type PostQuoteEdit,
} from './post-quote-precheck';
import { recordSmsConsentFromVoice } from '../../voice/outbound-consent';
import type { ConsentEventRepository } from '../../compliance/consent-events';
import {
  evaluateAutonomousCloseLane,
  type AutonomousCloseEvaluation,
  type AutonomousCloseIneligibleReason,
} from '../../proposals/autonomous-close-lane';
import {
  queueCloseFallbackChain,
  AUTONOMOUS_CLOSE_ACTOR,
} from '../../proposals/autonomous-close-execution';
import { resolveAndPlaceAppointmentHold } from '../scheduling/place-hold';
import { formatForReadback } from '../scheduling/resolve-datetime';
import { checkBusinessHours } from '../../compliance/business-hours';
import { parseOnboardingBusinessHours } from '../../telephony/business-hours-loader';
import { updateAppointment } from '../../appointments/appointment';
import type { TenantSettings } from '../../settings/settings';
import {
  bookingSpeechForLane,
  buildLaneInputFromSettings,
  laneStampIfPresent,
  timeReadbackFromHold,
} from './inbound-booking-completion';
import type {
  CallingAgentChannel,
  CallingAgentEvent,
  SideEffect,
} from '../agents/customer-calling/types';
import type {
  VoiceSession,
  VoiceSessionStore,
} from '../agents/customer-calling/voice-session-store';
import { deriveCallOutcome } from '../agents/customer-calling/outcome-mapper';
import type { VoiceSessionRepository } from '../../voice/voice-session';
import type {
  Proposal,
  ProposalRepository,
  ProposalStatus,
  ProposalType,
} from '../../proposals/proposal';
import { createProposal as buildProposal } from '../../proposals/proposal';
import {
  isProposalTypeAllowedOnSurface,
  type ProposalSurface,
} from '../../proposals/surface';
import {
  buildNegotiationCallbackContent,
  evaluateNegotiationDiscount,
} from '../../proposals/guardrails/negotiation-guardrail';
import {
  complaintSeverity,
  COMPLAINT_HIGH_SEVERITY_REASON,
} from '../tasks/complaint-task';
import {
  buildAllowDiscountCallbackContent,
  buildDiscountClarificationPayload,
  discountAuditMetadata,
  DISCOUNT_CLARIFICATION_QUESTION,
} from '../../conversations/negotiation/discount-proposal-content';
import type { CurrentQuoteResolver } from '../../conversations/negotiation/current-quote-resolver';
import type { LeadRepository } from '../../leads/lead';
import type { AuditRepository } from '../../audit/audit';
import { createAuditEvent } from '../../audit/audit';
import type { OnCallRepository } from '../../oncall/rotation';
import type { TwilioCallControl } from '../../telephony/twilio-call-control';
import { maskPhone } from '../../telephony/twilio-call-control';
import type { DispatcherPhoneResolver } from '../skills/escalate-to-human';
import type { TenantCredentialResolver } from '../../integrations/credentials';
import type { JobRepository } from '../../jobs/job';
import type { AppointmentRepository } from '../../appointments/appointment';
import type { InvoiceRepository } from '../../invoices/invoice';
import type { AgreementRepository } from '../../agreements/agreement';
import type { Customer, CustomerRepository } from '../../customers/customer';
import type { ConversationRepository } from '../../conversations/conversation-service';
import { findOrCreateCustomerByPhone } from '../skills/find-or-create-customer';
import { logInboundCallOnCustomerTimeline } from '../../telephony/inbound-call-log';
import type { EstimateRepository } from '../../estimates/estimate';
import type { LookupEventService } from '../../lookup-events/lookup-event-service';
import type { CatalogItemRepository } from '../../catalog/catalog-item';
import {
  groundLineItemPricing,
  lineItemConfidenceSignals,
  UNCATALOGUED_CONFIDENCE_CAP,
} from '../resolution/catalog-resolver';
import { getConfidenceLevel } from '../guardrails/confidence';
import type { ProposalConfidenceMeta } from '../../proposals/contracts';
import { buildVoiceProposalPayload } from '../../proposals/voice-payload';
import {
  intentToProposalType,
  voiceProposalSummary,
} from '../../proposals/voice-intent-map';
import { buildVoiceClarificationPayload } from '../../proposals/voice-clarification';
import type { EntityResolver } from '../resolution/entity-resolver';
import {
  resolveSchedulingEntities,
  type SchedulingEntityResolution,
} from '../agents/customer-calling/entity-resolution';
import { preloadSessionCatalog, resolveSessionCatalog } from './session-catalog';
import { buildQuoteReadback, type QuoteReadbackLine } from './quote-readback';
import { parseLeadingQuantity } from './quantity-parse';
import type { LLMGateway } from '../gateway/gateway';
import type {
  VoiceRepository,
  CallOutcome,
} from '../../voice/voice-service';
import type { VoicePersonaResolver } from '../../settings/voice-persona-resolver';
import type { SettingsRepository } from '../../settings/settings';
import { resolveEscalationSettings } from '../../settings/settings';
import { isRuntimeTimezone } from '../../shared/timezone';
import type { CallMeBackRepository } from '../../voice/call-me-back/call-me-back';
import type { DeviceTokenRepository } from '../../push/device-token-service';
import type { PushDeliveryProvider } from '../../notifications/push-delivery-provider';
import type { SpeechTurnHandler } from '../../telephony/media-streams/mediastream-adapter';
import { createLogger } from '../../logging/logger';

const logger = createLogger({
  service: 'ai.voice-turn.processor',
  environment: process.env.NODE_ENV || 'development',
});

/**
 * XML-escape (mirrors `twilio-adapter.ts#xmlEscape`). Re-implemented
 * locally so this module never imports back from `telephony/twilio-adapter`,
 * which would create a circular import once the adapter delegates here.
 */
function mapNotifyReasonToSkillReason(
  reason: string,
): Parameters<typeof escalateToHuman>[0]['reason'] {
  if (reason === 'operator_request') return 'caller_requested';
  if (reason === 'emergency_dispatch') return 'emergency_dispatch';
  if (reason === 'cost_cap_exceeded') return 'cost_cap_exceeded';
  if (reason.startsWith('abuse')) return 'abuse_detected';
  if (reason === 'keyword_frustration' || reason === 'llm_sentiment') {
    return 'caller_requested';
  }
  if (reason === 'max_retries_exceeded') return 'max_retries_exceeded';
  return 'low_confidence';
}

/**
 * Voice-parity (Feature 7): the receiving CSR must get the context SMS BEFORE
 * the call bridges. We await provider acceptance of the SMS, but bound the wait
 * so a slow/hung provider can never exceed Twilio's webhook budget — past this
 * deadline we bridge anyway (a late text beats a dropped transfer).
 */
const SMS_BEFORE_BRIDGE_TIMEOUT_MS = 4000;

/**
 * Honest acknowledgment spoken when the caller assents to book a live quote but
 * a pre-consent gate failed (or a repeated affirmative arrives after the owner
 * chain was already queued). The drafted quote is staged for OWNER approval; we
 * make NO booking claim — nothing is confirmed until the owner taps approve.
 */
const POST_QUOTE_AFFIRMATIVE_INTERIM =
  "Perfect — I'll have the owner finalize that and send you the full quote and booking link by text.";

/**
 * WS18 — spoken to ASK for SMS consent before texting the quote + booking link.
 * Set alongside session.pendingConsentCapture (the close flow, WS18c). The
 * caller's next turn is the answer, evaluated by strict confirmIntent.
 */
export const SMS_CONSENT_ASK =
  'Great — I can text the full quote and a link to lock in your booking. Is it okay to send that to the number you\'re calling from?';

/** Plain-capture ack after a GRANT (non-close captures only — the close flow speaks its own outcome). */
const SMS_CONSENT_GRANT_ACK = "Perfect — you'll get that text shortly.";

/** WS18 — decline / ambiguous → hand the send to the owner. Design-exact copy. */
export const SMS_CONSENT_DECLINE_FALLBACK =
  "No problem — I'll have the owner send that over, and you'll get a text shortly.";

/**
 * WS2 — honest line spoken once the close is STAGED for owner approval (consent
 * captured, owner one-tap chain queued). The text promise is legitimate (consent
 * granted), but the booking is confirmed only when the owner taps approve — so
 * this never claims the caller is booked.
 */
export const CLOSE_FALLBACK_LINE =
  "Great — I'll have the owner confirm your booking, and you'll get the quote by text shortly.";

function xmlEscape(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

// `intentToProposalType` + `voiceProposalSummary` are imported from
// `proposals/voice-intent-map.ts` — this file used to carry a private
// 17-case copy of the map that had drifted from the router's canonical 35.
// Every intent the shared map newly covers here resolves to a type that is
// NOT on the S1 allowlist, so the surface gate below coerces it to a
// clarification exactly as the fall-through used to; see that module's header.

/**
 * The CANONICAL clarification a live call degrades to when the built payload
 * cannot satisfy its proposal contract.
 *
 * The shape itself lives in `proposals/voice-clarification.ts` — it is SHARED
 * with the in-app adapter, which had the same second-order hole for any intent
 * that falls through to the `voice_clarification` default. This wrapper only
 * adapts the `VoiceSession` to that module's session-free input (`proposals/`
 * must not import `ai/`).
 */
function buildContractFailureClarification(
  session: VoiceSession,
  intent: string | undefined,
  entities: Record<string, unknown>,
  requestedProposalType: ProposalType,
): Record<string, unknown> {
  return buildVoiceClarificationPayload({
    transcript: session.transcript,
    intent,
    entities,
    requestedProposalType,
    sessionId: session.id,
    ...(session.callSid !== undefined ? { callSid: session.callSid } : {}),
  });
}

/**
 * WS5 / WS17 / WS18 — turn a catalog-grounding `outcome` into the operator-side
 * `_meta`/confidence signals AND the spoken read-back + structured lines the
 * caller hears. Extracted so BOTH the initial grounding (`groundVoiceQuote`)
 * AND the live-quote refinement path (`applyQuoteRefinement`) compute the read-
 * back and the money-correctness gate identically. Pure — no I/O.
 */
function finalizeGroundedQuote(
  outcome: Awaited<ReturnType<typeof groundLineItemPricing>>,
  catalogAvailable: boolean,
  priceField: 'unitPrice' | 'unitPriceCents',
  baseConfidence: number | undefined,
): {
  lineItems: Array<Record<string, unknown>>;
  meta: ProposalConfidenceMeta;
  missingFields: string[];
  catalogResolution?: Record<
    number,
    Array<{ id: string; name: string; unitPriceCents: number; score: number }>
  >;
  confidenceScore?: number;
  utterance: string;
  groundedClean: boolean;
  totalCents: number;
  readbackLines: QuoteReadbackLine[];
} {
  const lineItems = outcome.lineItems;
  // Same money-correctness gate the task handlers apply: an uncatalogued (or
  // unconsulted-catalog) price caps confidence and forces overallConfidence
  // 'low' so it always reaches a human; per-line pricingSource → `_meta`
  // markers for the operator draft.
  let confidenceScore = baseConfidence;
  if (outcome.anyUncatalogued && typeof confidenceScore === 'number') {
    confidenceScore = Math.min(confidenceScore, UNCATALOGUED_CONFIDENCE_CAP);
  }
  const signals = lineItemConfidenceSignals(lineItems, priceField);
  const groundedClean = catalogAvailable && !outcome.requiresReview;
  // The persisted 'low' stamp derives from anyUncatalogued (like the task
  // handlers), NOT requiresReview/groundedClean: resolveProposalLine clears
  // missingFields but never lifts the stamp, so stamping a missingFields-only
  // outcome (ambiguity / price conflict) 'low' would keep chain-set/SMS
  // approval blocked after the operator resolves it. groundedClean stays on
  // requiresReview for the STRUCTURAL gates (autonomous close, quote flow).
  const stampClean = catalogAvailable && !outcome.anyUncatalogued;
  const meta: ProposalConfidenceMeta = {
    overallConfidence:
      stampClean && typeof confidenceScore === 'number'
        ? getConfidenceLevel(confidenceScore)
        : 'low',
    ...(Object.keys(signals.fieldConfidence).length > 0
      ? { fieldConfidence: signals.fieldConfidence }
      : {}),
    ...(signals.markers.length > 0 ? { markers: signals.markers } : {}),
  };

  // WS17 I3 — the read-back reads `unitPrice` (integer cents). Invoice lines
  // carry the cents under `unitPriceCents`, so map onto the read-back's field.
  // BOTH are integer cents (`formatCents` divides by 100), so this is a pure
  // field rename — a 185000-cent line speaks $1850.00, never $185,000.
  const readbackLines: QuoteReadbackLine[] = lineItems.map((li) => ({
    ...(typeof li.pricingSource === 'string' ? { pricingSource: li.pricingSource } : {}),
    ...(typeof li.unitPrice === 'number'
      ? { unitPrice: li.unitPrice }
      : typeof li.unitPriceCents === 'number'
        ? { unitPrice: li.unitPriceCents }
        : {}),
    ...(typeof li.quantity === 'number' ? { quantity: li.quantity } : {}),
    ...(typeof li.description === 'string' ? { description: li.description } : {}),
  }));
  const utterance = buildQuoteReadback({ lineItems: readbackLines, catalogAvailable });
  // WS18 — the spoken total (integer cents; formatCents divides by 100). Sum of
  // each line's unit price × quantity, exactly what buildQuoteReadback recites.
  const totalCents = readbackLines.reduce((sum, li) => {
    const qty = typeof li.quantity === 'number' && li.quantity > 0 ? li.quantity : 1;
    return sum + (typeof li.unitPrice === 'number' ? li.unitPrice * qty : 0);
  }, 0);

  return {
    lineItems,
    meta,
    missingFields: outcome.missingFields,
    ...(outcome.catalogResolution ? { catalogResolution: outcome.catalogResolution } : {}),
    ...(confidenceScore !== undefined ? { confidenceScore } : {}),
    utterance,
    groundedClean,
    totalCents,
    readbackLines,
  };
}

/**
 * I6 — the ALLOWLIST of channels whose sessions are trusted by default.
 * `inapp` is the owner's own authenticated app surface. Everything else is
 * untrusted until it is consciously added here.
 */
const TRUSTED_CHANNELS: ReadonlySet<CallingAgentChannel> = new Set<CallingAgentChannel>([
  'inapp',
]);

/**
 * True when this session is the untrusted inbound-customer (S1) surface: a
 * session arriving on a channel that is NOT on the trusted allowlist and that
 * was not placed from an authenticated approver number. Owner (approver) calls
 * are the RV-070/RV-071 elevated exception and are not S1.
 *
 * Fail-CLOSED by construction: a channel added later (sms, web_chat, …) is S1
 * from the moment it exists and stays S1 until someone deliberately puts it in
 * `TRUSTED_CHANNELS`. The previous `channel === 'telephony'` form failed OPEN —
 * any new channel would have silently skipped the S1 proposal-type gate.
 */
function isUntrustedS1Session(session: VoiceSession): boolean {
  return (
    !TRUSTED_CHANNELS.has(session.channel) &&
    session.machine.currentContext.ownerSession !== true
  );
}

export interface VoiceTurnProcessorDeps {
  store: VoiceSessionStore;
  gateway: LLMGateway;
  pool?: Pool;
  auditRepo?: AuditRepository;
  proposalRepo?: ProposalRepository;
  onCallRepo?: OnCallRepository;
  leadRepo?: LeadRepository;
  /**
   * N-003 (P2-036) — when wired, a live-call negotiation guardrail callback is
   * enriched with the caller's LTV/recency (resolved via the session customerId).
   */
  customerNegotiationContextProvider?: CustomerNegotiationContextProvider;
  /** P2-036 V2 — resolves the live caller's current quote for the discount engine. */
  negotiationQuoteResolver?: CurrentQuoteResolver;
  /**
   * P0 voice-safety — shared, tenant-scoped entity resolver. Production wires
   * the SAME `AliasFirstEntityResolver → PgEntityResolver` the voice-action-
   * router uses (app.ts), so a tenant alias resolves before the pg_trgm search
   * (the in-app adapter's bare `PgEntityResolver` silently misses alias-first
   * resolution — deliberately not copied here).
   *
   * Without it the phone path echoed the classifier's free text back as
   * "resolved" refs, so no spoken reference ever became an id and no spoken
   * time ever became an ISO instant. Optional: when absent, resolution
   * degrades to the deterministic parts only (datetime phrases, already-UUID
   * ids) — references pass through unresolved and the payload contract, not a
   * guess, decides what happens next.
   */
  entityResolver?: EntityResolver;
  systemActorId?: string;
  businessName: string;
  publicBaseUrl?: string;
  callControl?: TwilioCallControl;
  dispatcherPhoneResolver?: DispatcherPhoneResolver;
  businessPhoneFallbackResolver?: (tenantId: string) => Promise<string | null>;
  recordingCallbackPath?: string;
  jobRepo?: JobRepository;
  appointmentRepo?: AppointmentRepository;
  invoiceRepo?: InvoiceRepository;
  agreementRepo?: AgreementRepository;
  customerRepo?: CustomerRepository;
  /** Customer tags for escalation CRM hydration (handoff context pack). */
  tagRepo?: TagRepository;
  /**
   * When wired (with customerRepo), an unknown inbound caller who gives their
   * info at `ask_caller` gets a CUSTOMER resolved/created by phone and the call
   * logged on its timeline, so a booking that follows attaches to a real
   * customer record (the inbound-booking goal). Without it, unknown callers
   * fall back to the retry/escalate path.
   */
  conversationRepo?: ConversationRepository;
  estimateRepo?: EstimateRepository;
  /**
   * WS5 — tenant catalog repo for in-call grounded quoting. When wired, a
   * drafted estimate's spoken line items are resolved against the tenant's
   * active catalog synchronously (via a per-session preload) so the caller
   * hears a catalog-grounded price — never an LLM-invented number — and the
   * stored proposal payload carries the grounded pricing. Optional: without
   * it, estimates fall back to the generic confirmation (no price spoken).
   */
  catalogRepo?: CatalogItemRepository;
  /**
   * WS18 — append-only consent ledger. When wired (with customerRepo), the
   * on-call SMS consent capture writes the grant (kind:'sms', source:'voice')
   * and flips customers.sms_consent so the GatedMessageDelivery gate passes
   * legitimately for the deposit/quote text.
   */
  consentEventRepo?: ConsentEventRepository;
  /**
   * QUALITY-2026-07-12 WS2 — on-call close PREPARATION (supersedes the D-018
   * autonomous close). When wired, a caller's strict-confirmed, consent-gated
   * affirmative on a grounded quote holds the slot and STAGES the close for the
   * owner: a draft chain (draft_estimate → send_estimate → create_booking, all
   * DRAFT/blocked) plus ONE owner one-tap approval SMS. Nothing is approved or
   * executed by the system — the owner's tap is the only approval. Absent → the
   * affirmative keeps the safe owner-finalizes interim behavior.
   */
  autonomousClose?: {
    /** AUTONOMOUS_CLOSE_DISABLED === 'true' — checked FIRST, pre-consent. */
    platformDisabled?: boolean;
    /** AUTONOMOUS_BOOKING_DISABLED === 'true' — the composed D-015 leg. */
    bookingPlatformDisabled?: boolean;
    /** Owner phone for the one-tap approval chain SMS. */
    ownerPhoneResolver?: (tenantId: string) => Promise<string | null | undefined>;
    /** Owner-class SMS sender (never customer-gated). */
    sendOwnerSms?: (to: string, body: string) => Promise<void>;
    /** One-tap HMAC secret (approve token). */
    oneTapSecret?: string;
    buildApproveUrl?: (token: string) => string;
  };
  lookupEvents?: LookupEventService;
  credentialResolver?: TenantCredentialResolver;
  verticalPromptResolver?: (tenantId: string) => Promise<string | undefined>;
  callerPlanResolver?: (
    tenantId: string,
    customerId: string,
  ) => Promise<string | undefined>;
  thresholdResolver?: (
    tenantId: string,
  ) => Promise<
    Partial<Record<'supervisor' | 'tech' | 'both', number>> | undefined
  >;
  voiceSessionRepo?: VoiceSessionRepository;
  voiceRepo?: VoiceRepository;
  voicePersonaResolver?: VoicePersonaResolver;
  /**
   * Optional shared map. When the host (TwilioGatherAdapter) provides
   * its own Map instance, the processor reads/writes the same instance
   * so the host's other entry points (handleInbound, handleNotifyOncall,
   * etc.) see the same state. When omitted, a fresh empty Map is
   * created — appropriate for tests and standalone harness use.
   */
  pendingTransferTwiml?: Map<string, string>;
  /**
   * Optional callback fired when a session terminates so the host can
   * trigger any post-terminate work. The adapter wires this so its
   * existing `runSummary` path still kicks off after a terminal turn.
   *
   * `speechTurn` `await`s this callback (wrapped in try/catch). The
   * callback may return immediately by spawning its own background work
   * (production keeps fire-and-forget summary inside the adapter's
   * wiring to preserve Twilio webhook latency), OR it may await its
   * own work (Layer 2 awaits `runSummary` so the runner's per-run
   * suite-cost-tracker snapshot includes the summary's gateway spend).
   *
   * When omitted, the processor falls back to a fire-and-forget
   * `runSummary` for parity with the adapter's legacy behavior.
   */
  onSessionTerminated?: (session: VoiceSession) => void | Promise<void>;
  /**
   * F8 — when wired, `handleNotifyOncall` loads per-tenant escalation
   * settings and threads channel preferences into `escalateToHuman`.
   * Optional: when absent, all three channels default to enabled.
   */
  settingsRepo?: SettingsRepository;
  /** F3 — whisper TwiML cache for dispatcher ear-only context. */
  whisperCache?: WhisperCache;
  /** F4 — outbound SMS to dispatcher on escalation. */
  deliveryProvider?: { sendSms(args: { to: string; body: string }): Promise<unknown> };
  /**
   * ANS-001 — durable URGENT follow-up tasks (the same repo the call-me-back
   * worker sweeps and the emergency page ladder falls back to). Wired so an E1
   * alert that can't be delivered, and an E1 booking that can't be revoked,
   * both leave a human-visible task instead of only a log line.
   */
  callMeBackRepo?: CallMeBackRepository;
  /**
   * ANS-001 — registered mobile devices for the tenant, for the E1 push
   * fan-out. Structural (listByTenant only) so tests can pass a stub.
   */
  deviceTokenRepo?: Pick<DeviceTokenRepository, 'listByTenant'>;
  /**
   * ANS-001 — push transport for the E1 alert (main's Expo-backed
   * PushDeliveryProvider; the same instance the proposal-push notifier uses).
   * Best-effort: per-token failures come back as results, not throws.
   */
  pushDeliveryProvider?: PushDeliveryProvider;
  /**
   * Caller E.164 for the active leg. When set, used to build escalation
   * summaries; otherwise a placeholder is used.
   */
  callerPhoneResolver?: (session: VoiceSession) => string | undefined;
  /**
   * RV-071 — pending-edit parity guard for voice approvals (same repo
   * method the SMS reply transport and the one-tap route use). Optional:
   * without it the guard is skipped, mirroring pre-P2-034 wiring.
   * RV-225 — `create` (when wired, i.e. the full repo) additionally lets
   * the voice edit dialogue record edit_request / reapproval_rendered
   * events so unapplied voice edits block approval on every channel.
   */
  smsEventRepo?: Pick<ProposalSmsEventRepository, 'hasUnappliedEditRequest'> &
    Partial<Pick<ProposalSmsEventRepository, 'create'>>;
  /**
   * RV-071 — one-tap SMS fallback wiring for refused money/irreversible
   * voice approvals. Same values app.ts already wires for P12-004
   * unsupervised routing (secret, sender, URL builder, owner phone,
   * P2-034 render recording).
   */
  voiceApprovalOneTap?: OneTapFallbackDeps;
}

export interface VoiceTurnProcessor {
  /**
   * Drives a single speech turn through the FSM and returns the
   * resulting side effects. Matches the `SpeechTurnHandler` contract
   * `attachMediaStreamServer` accepts so it can be wired directly.
   */
  speechTurn: SpeechTurnHandler;
  /**
   * Derive + stash the typed CallOutcome on the session and kick off
   * the best-effort `voice_sessions` persist. Idempotent.
   */
  finalizeTerminatedSession(
    session: VoiceSession,
    sideEffects: ReadonlyArray<SideEffect>,
    fallbackReason: string,
  ): void;
  /**
   * Resolve a classified turn's free-text references + spoken times into the
   * `entity_resolved` refs the FSM merges onto `extractedEntities`. Shared with
   * `TwilioGatherAdapter` so the Gather transport and the media-streams
   * transport resolve identically instead of the Gather path echoing the
   * classifier back at itself.
   */
  resolveTurnEntities(
    session: VoiceSession,
    tenantId: string,
    intent: string,
    entities: Record<string, unknown>,
  ): Promise<Record<string, string>>;
  /** Execute audit/proposal/notify_oncall side effects against wired repos. */
  executeSideEffects(
    session: VoiceSession,
    sideEffects: SideEffect[],
    tenantId: string,
  ): Promise<void>;
  /** Push token usage into the cost tracker. Returns true on cap exceeded. */
  recordCost(
    session: VoiceSession,
    usage: { input: number; output: number } | undefined,
  ): boolean;
  /** Replace a placeholder `intent_confirm` tts_play with a concrete readback. */
  expandIntentConfirmTemplate(
    sideEffects: SideEffect[],
    intentType: string,
  ): void;
  resolveVerticalPromptSection(
    tenantId: string,
  ): Promise<string | undefined>;
  resolvePlanPromptSection(
    tenantId: string,
    customerId: string | undefined,
  ): Promise<string | undefined>;
  resolveThresholdOverride(
    tenantId: string,
  ): Promise<
    Partial<Record<'supervisor' | 'tech' | 'both', number>> | undefined
  >;
  /** Persist the end-of-call summary. Best-effort. */
  runSummary(session: VoiceSession): Promise<void>;
  /**
   * RV-071 — consume the turn when an owner voice-approval dialogue is
   * pending on the session (confirm / disambiguate / challenge stage).
   * Returns the side effects to render, or null when no dialogue is
   * pending (caller proceeds with the normal turn). Shared by
   * `speechTurn` (WS path) and the Gather adapter so both transports run
   * the identical safety flow.
   */
  handlePendingVoiceApproval(
    session: VoiceSession,
    speechResult: string,
    tenantId: string,
  ): Promise<SideEffect[] | null>;
  /**
   * WS18 — consume the turn when an on-call SMS-consent capture is pending
   * on the session (the caller's utterance is the yes/no answer to "is it
   * okay to text you the quote?"). Returns the side effects to render, or
   * null when no capture is pending. Exported (parallel to
   * `handlePendingVoiceApproval`) so a transport that only owns a bare
   * `speechTurn` callback — e.g. the media-streams silence-reprompt timer,
   * which must drive an empty-utterance turn through the SAME pending
   * handlers `speechTurn` runs, in the SAME order, so a silent caller
   * mid-dialogue gets keep-pending / fail-closed semantics instead of the
   * low-STT-confidence reprompt/escalation ladder — can reach it directly
   * without a full `speechTurn` dispatch.
   */
  handlePendingConsentCapture(
    session: VoiceSession,
    speechResult: string,
    tenantId: string,
  ): Promise<SideEffect[] | null>;
  /**
   * RV-071 — route a classified `approve_proposal` / `reject_proposal`
   * intent. HARD-GATED on the session's RV-070 `ownerSession` flag (not
   * just the classifier prompt): non-owner callers fall into the FSM's
   * normal `confidence_low` reprompt path and no approval flow starts.
   */
  handleVoiceApprovalIntent(
    session: VoiceSession,
    args: {
      intentType: string;
      entities: Record<string, unknown>;
      utterance: string;
      tenantId: string;
    },
  ): Promise<SideEffect[]>;
  /**
   * RV-225 — route a classified `edit_proposal` intent ("change the
   * second line to $200"). Same layered gating as the approval intents:
   * HARD-GATED on the session's RV-070 `ownerSession` flag, never
   * prompt-only. The edit applies through the existing `editProposal`
   * path and the proposal STAYS pending (an edit never approves).
   */
  handleVoiceEditIntent(
    session: VoiceSession,
    args: {
      entities: Record<string, unknown>;
      utterance: string;
      tenantId: string;
    },
  ): Promise<SideEffect[]>;
  /**
   * ask_caller handler shared by BOTH voice transports. Resolves (or creates)
   * the unknown caller to a real customer keyed by phone, logs the call on
   * their timeline, and dispatches `caller_known` so the FSM advances to
   * intent capture (falls back to `unknown_caller` without a repo/phone or on
   * failure). Returns the dispatched side effects; the CALLER executes them.
   * Ported to the Gather adapter so PSTN callers advance out of ask_caller
   * instead of looping forever on a bare reprompt.
   */
  handleAskCaller(
    session: VoiceSession,
    tenantId: string,
  ): Promise<SideEffect[]>;
}

export function createVoiceTurnProcessor(
  deps: VoiceTurnProcessorDeps,
): VoiceTurnProcessor {
  const pendingTransferTwiml =
    deps.pendingTransferTwiml ?? new Map<string, string>();

  /**
   * U4 (Part E punch #1) — tenant timezone for spoken-datetime resolution,
   * resolved ONCE per session (E1-script precedent: settings read per
   * session, not per utterance). Keyed by the live session OBJECT so
   * entries are garbage-collected with the session — no eviction hook
   * needed. `undefined` (no settings repo, no configured zone, or a
   * settings-read failure) is cached too: the session then refuses to
   * resolve spoken times rather than guessing a zone (B5.5 precedent),
   * and the next session retries the read.
   */
  const sessionTimezones = new WeakMap<VoiceSession, Promise<string | undefined>>();

  function resolveSessionTimezone(
    session: VoiceSession,
    tenantId: string,
  ): Promise<string | undefined> {
    const cached = sessionTimezones.get(session);
    if (cached) return cached;
    const pending = (async () => {
      if (!deps.settingsRepo) return undefined;
      try {
        const settings = await deps.settingsRepo.findByTenant(tenantId);
        const tz = settings?.timezone;
        return typeof tz === 'string' && isRuntimeTimezone(tz.trim()) ? tz.trim() : undefined;
      } catch (err) {
        logger.warn('tenant timezone lookup failed; spoken times stay unresolved', {
          tenantId,
          sessionId: session.id,
          error: err instanceof Error ? err.message : String(err),
        });
        return undefined;
      }
    })();
    sessionTimezones.set(session, pending);
    return pending;
  }

  // ─── Helpers (formerly private methods on TwilioGatherAdapter) ──────

  async function resolveVerticalPromptSection(
    tenantId: string,
  ): Promise<string | undefined> {
    if (!deps.verticalPromptResolver) return undefined;
    try {
      return await deps.verticalPromptResolver(tenantId);
    } catch {
      return undefined;
    }
  }

  async function resolvePlanPromptSection(
    tenantId: string,
    customerId: string | undefined,
  ): Promise<string | undefined> {
    if (!deps.callerPlanResolver || !customerId) return undefined;
    try {
      return await deps.callerPlanResolver(tenantId, customerId);
    } catch {
      return undefined;
    }
  }

  async function resolveThresholdOverride(
    tenantId: string,
  ): Promise<
    Partial<Record<'supervisor' | 'tech' | 'both', number>> | undefined
  > {
    if (!deps.thresholdResolver) return undefined;
    try {
      return await deps.thresholdResolver(tenantId);
    } catch {
      return undefined;
    }
  }

  function recordCost(
    session: VoiceSession,
    usage: { input: number; output: number } | undefined,
  ): boolean {
    if (!usage) return false;
    const cents = estimateCostCents(usage.input, usage.output);
    const events = session.costTracker.recordUsage({
      inputTokens: usage.input,
      outputTokens: usage.output,
      costCents: cents,
    });
    session.events.emit(
      'voice-event',
      costIncurredEvent(cents, session.costTracker.totals.costCents),
    );
    const exceeded = events.some((e) => e.type === 'cost_cap_exceeded');
    if (exceeded) {
      session.events.emit('voice-event', sessionTerminatedEvent('cap_exceeded'));
    }
    return exceeded;
  }

  function expandIntentConfirmTemplate(
    sideEffects: SideEffect[],
    intentType: string,
  ): void {
    for (const fx of sideEffects) {
      if (
        fx.type === 'tts_play' &&
        (fx.payload.text === 'intent_confirm' ||
          fx.payload.template === 'confirm_intent')
      ) {
        fx.payload.text = `Just to confirm — ${intentType.replace(/_/g, ' ')}. Is that right?`;
      }
    }
  }

  async function handleAuditLog(
    session: VoiceSession,
    fx: SideEffect,
    tenantId: string,
  ): Promise<void> {
    if (!deps.auditRepo) {
      logger.debug('audit_log (no auditRepo wired)', {
        tenantId,
        payload: fx.payload,
      });
      return;
    }
    const eventType =
      typeof fx.payload.eventType === 'string'
        ? fx.payload.eventType
        : 'agent.calling.unknown';
    try {
      const ev = createAuditEvent({
        tenantId,
        actorId: deps.systemActorId ?? 'calling-agent',
        actorRole: 'system',
        eventType,
        entityType: 'voice_session',
        entityId: session.id,
        correlationId: session.id,
        metadata: fx.payload,
      });
      await deps.auditRepo.create(ev);
    } catch (err) {
      logger.warn('audit_log persist failed', {
        error: err instanceof Error ? err.message : String(err),
        sessionId: session.id,
      });
    }
  }

  /**
   * WS5 / WS17 — synchronous in-call quote grounding for a drafted estimate OR
   * invoice. Builds line items from the classifier's spoken descriptions
   * (WS17 I1: recovering a leading quantity — "three smoke detectors" — from
   * the text, since the classifier emits descriptions only), resolves them
   * against the preloaded tenant catalog, and returns the grounded lineItems +
   * confidence `_meta` + the spoken quote read-back. Returns `undefined` when
   * the intent carried no line descriptions, so the generic (non-grounded)
   * proposal path runs unchanged and the caller hears the fixed confirmation.
   *
   * `priceField` selects the document contract (WS17 I3): estimates use
   * `unitPrice` (integer cents, no per-line total); invoices use
   * `unitPriceCents` + a recomputed `totalCents` — exactly what the operator
   * InvoiceTaskHandler does. See
   * docs/solutions/conventions/line-item-price-field-estimate-vs-invoice.md.
   *
   * Reuses the task handlers' exact grounding + confidence helpers
   * (`groundLineItemPricing`, `lineItemConfidenceSignals`,
   * `UNCATALOGUED_CONFIDENCE_CAP`) so the voice and operator paths agree.
   */
  async function groundVoiceQuote(
    session: VoiceSession,
    entities: Record<string, unknown>,
    fx: SideEffect,
    priceField: 'unitPrice' | 'unitPriceCents',
  ): Promise<
    | {
        lineItems: Array<Record<string, unknown>>;
        meta: ProposalConfidenceMeta;
        missingFields: string[];
        catalogResolution?: Record<
          number,
          Array<{ id: string; name: string; unitPriceCents: number; score: number }>
        >;
        confidenceScore?: number;
        utterance: string;
        // WS18 — surfaced (finding 9: computed but previously not returned) so
        // the FSM can stash them on `pendingQuote`. `groundedClean` gates the
        // D-018 autonomous close; `totalCents` is the spoken total (integer
        // cents), `readbackLines` are the structured lines the caller heard.
        groundedClean: boolean;
        totalCents: number;
        readbackLines: QuoteReadbackLine[];
      }
    | undefined
  > {
    const descriptions = Array.isArray(entities.lineItemDescriptions)
      ? entities.lineItemDescriptions.filter(
          (d): d is string => typeof d === 'string' && d.trim().length > 0,
        )
      : [];
    if (descriptions.length === 0) return undefined;
    // Voice never carries an LLM price — descriptions only; the catalog sets
    // every price. WS17 I1: recover a leading quantity ("three smoke
    // detectors" → qty 3, "2 inch pipe fitting" → qty 1) deterministically;
    // the remainder is what we match against the catalog.
    const rawLines = descriptions.map((raw) => {
      const { quantity, description } = parseLeadingQuantity(raw);
      return { description, quantity };
    });

    // Establishment kicks the preload off; this is the defensive net for
    // paths/tests that didn't. Then resolve within a tight budget so the
    // caller's turn is never blocked — a timeout/unwired repo → null →
    // treated as "catalog unavailable" (no number spoken, never fabricated).
    preloadSessionCatalog(session, deps.catalogRepo);
    const catalog = await resolveSessionCatalog(session);
    const catalogAvailable = catalog !== null;

    const outcome = await groundLineItemPricing(
      rawLines,
      priceField,
      catalog ? () => Promise.resolve(catalog) : null,
    );

    const baseConfidence =
      typeof fx.payload.confidence === 'number' ? fx.payload.confidence : undefined;
    return finalizeGroundedQuote(outcome, catalogAvailable, priceField, baseConfidence);
  }

  /**
   * WS18 — apply a deterministic live-quote refinement to the pending draft
   * estimate and persist it. Re-grounds the edited line set against the tenant
   * catalog (so a newly-added line gets a catalog price, never an LLM number),
   * writes the new lineItems + `_meta` back onto the draft proposal in place,
   * and returns the fresh read-back to speak. Returns null when there is no
   * catalog resolvable / the edit can't be applied — the caller then defers to
   * the classifier path.
   *
   * NOTE: this uses `proposalRepo.update` rather than `editProposal`
   * (proposals/actions.ts): the live voice draft_estimate payload is
   * deliberately partial (no top-level `customerId` — the operator fills it at
   * review), so `editProposal`'s contract validation would reject it. We
   * preserve the same "edit the draft in place + audit" behavior without the
   * review-time contract gate, matching how the create path persists the draft.
   */
  async function applyQuoteRefinement(
    session: VoiceSession,
    tenantId: string,
    edit: PostQuoteEdit,
  ): Promise<
    | { readbackLines: QuoteReadbackLine[]; groundedClean: boolean; totalCents: number; utterance: string }
    | null
  > {
    const pq = session.machine.currentContext.pendingQuote;
    if (!pq || !deps.proposalRepo) return null;

    // Rebuild the raw (description, quantity) lines from the last grounded quote.
    const rawLines: Array<{ description: string; quantity: number }> = pq.groundedLines
      .filter((li): li is QuoteReadbackLine & { description: string } => typeof li.description === 'string')
      .map((li) => ({
        description: li.description,
        quantity: typeof li.quantity === 'number' && li.quantity > 0 ? li.quantity : 1,
      }));

    if (edit.type === 'set_quantity') {
      if (rawLines.length === 0) return null;
      // Apply to the last line (the most-recently-discussed item).
      rawLines[rawLines.length - 1]!.quantity = edit.quantity;
    } else if (edit.type === 'add_line') {
      rawLines.push({ description: edit.description, quantity: edit.quantity });
    } else {
      // remove_line — drop the line whose description contains the noun.
      const noun = edit.noun.toLowerCase();
      const remaining = rawLines.filter(
        (li) => !li.description.toLowerCase().includes(noun),
      );
      // Never empty the quote; if the noun matched nothing, defer to classifier.
      if (remaining.length === 0 || remaining.length === rawLines.length) return null;
      rawLines.length = 0;
      rawLines.push(...remaining);
    }

    preloadSessionCatalog(session, deps.catalogRepo);
    const catalog = await resolveSessionCatalog(session);
    const catalogAvailable = catalog !== null;
    const outcome = await groundLineItemPricing(
      rawLines,
      'unitPrice',
      catalog ? () => Promise.resolve(catalog) : null,
    );

    // Preserve the draft's original confidence as the base (the cap re-applies
    // if the refinement introduced an uncatalogued line).
    let baseConfidence: number | undefined;
    try {
      const existing = await deps.proposalRepo.findById(tenantId, pq.proposalId);
      // WS18d — only a still-pending draft may be refined (mirrors
      // editProposal's status gate). Once the close chain approved/executed
      // the proposal, a further "make it two" must NOT rewrite executed money
      // state — defer to the classifier path instead.
      if (existing && existing.status !== 'draft' && existing.status !== 'ready_for_review') {
        return null;
      }
      if (existing && typeof existing.confidenceScore === 'number') {
        baseConfidence = existing.confidenceScore;
      }
      const grounded = finalizeGroundedQuote(outcome, catalogAvailable, 'unitPrice', baseConfidence);
      if (existing) {
        const nextPayload: Record<string, unknown> = {
          ...(existing.payload as Record<string, unknown>),
          lineItems: grounded.lineItems,
          _meta: grounded.meta,
        };
        // Direct repo.update rather than editProposal (proposals/actions.ts):
        // the refined payload is SYSTEM-CONSTRUCTED from catalog grounding —
        // never owner-typed input — and the live voice draft is deliberately
        // partial (no top-level customerId until close/review), so
        // editProposal's review-time contract validation does not apply here.
        await deps.proposalRepo.update(tenantId, pq.proposalId, { payload: nextPayload });
      }
      if (deps.auditRepo) {
        try {
          await deps.auditRepo.create(
            createAuditEvent({
              tenantId,
              actorId: deps.systemActorId ?? 'calling-agent',
              actorRole: 'system',
              eventType: 'agent.calling.quote_refined',
              entityType: 'proposal',
              entityId: pq.proposalId,
              correlationId: session.id,
              metadata: {
                editType: edit.type,
                totalCents: grounded.totalCents,
                groundedClean: grounded.groundedClean,
              },
            }),
          );
        } catch {
          /* audit is best-effort */
        }
      }
      return {
        readbackLines: grounded.readbackLines,
        groundedClean: grounded.groundedClean,
        totalCents: grounded.totalCents,
        utterance: grounded.utterance,
      };
    } catch (err) {
      logger.warn('applyQuoteRefinement failed', {
        error: err instanceof Error ? err.message : String(err),
        sessionId: session.id,
      });
      return null;
    }
  }

  /**
   * REAL entity resolution for a classified turn (replaces the blind echo the
   * Gather/media-streams paths used to run inline).
   *
   * The old code copied every string entity into `refs` verbatim — but
   * `intent_classified` has ALREADY put those same entities on the FSM context
   * (`transitions.ts` line ~299), so the echo overlaid identical values and
   * resolved nothing: a spoken "my Tuesday furnace appointment" never became an
   * appointmentId and "Tuesday at 2pm" never became an ISO instant, which is
   * why every phone-originated scheduling proposal was unexecutable.
   *
   * Delegates to the SHARED `resolveSchedulingEntities` that already serves the
   * in-app adapter and the voice-action-router — no new resolution logic here.
   * Terminal outcomes (ambiguous / not_found / low_confidence) return the
   * PARTIAL refs: the unresolved id is simply absent, never guessed, and the
   * payload contract downstream turns "absent" into a clarification rather than
   * a malformed proposal.
   */
  async function resolveTurnEntities(
    session: VoiceSession,
    tenantId: string,
    intent: string,
    entities: Record<string, unknown>,
  ): Promise<Record<string, string>> {
    let resolution: SchedulingEntityResolution;
    try {
      // U4 — tenant zone (resolved once per session) so "Thursday at 2pm"
      // books in the TENANT's timezone, matching the recorded-memo path.
      // Unresolved zone ⇒ spoken times stay unresolved (never silent UTC)
      // and the booking gates downstream instead of mis-booking.
      const timezone = await resolveSessionTimezone(session, tenantId);
      resolution = await resolveSchedulingEntities(
        deps.entityResolver,
        tenantId,
        intent,
        entities,
        // SCH-03 — sticky job anchor for "the appointment for that job".
        session.machine.currentContext.jobId,
        timezone ? { timezone } : undefined,
      );
    } catch (err) {
      // A resolver hiccup must never strand a live caller. The classifier's
      // entities are already on the FSM context, so an empty overlay simply
      // leaves the turn unresolved (operator review) instead of escalating.
      logger.warn('entity resolution failed; continuing with unresolved references', {
        error: err instanceof Error ? err.message : String(err),
        sessionId: session.id,
        intent,
      });
      return {};
    }
    return resolution.refs;
  }

  async function handleCreateProposal(
    session: VoiceSession,
    fx: SideEffect,
    tenantId: string,
    sideEffectsSink: SideEffect[],
  ): Promise<void> {
    if (!deps.proposalRepo) {
      logger.info('create_proposal (no proposalRepo wired)', {
        tenantId,
        payload: fx.payload,
      });
      return;
    }
    const intent =
      typeof fx.payload.intent === 'string' ? fx.payload.intent : undefined;
    const entities =
      typeof fx.payload.entities === 'object' && fx.payload.entities !== null
        ? (fx.payload.entities as Record<string, unknown>)
        : {};
    try {
      const tenantThresholdOverride = await resolveThresholdOverride(tenantId);

      // N-003 (P2-036) — negotiation guardrail. The FSM emits this when the
      // caller pushes on price/scope/terms. Build the rich owner `callback`
      // (shared with the SMS + voice-action-router surfaces) and DO NOT dispatch
      // `proposal_queued`: the negotiation guard stays in the current state, so
      // a proposal_queued transition would be wrong here.
      if (intent === 'negotiation') {
        const askText = typeof entities.negotiationAsk === 'string' ? entities.negotiationAsk : '';
        const transcript = typeof entities.transcript === 'string' ? entities.transcript : '';
        const detectText = `${askText} ${transcript}`.trim();
        const customerName =
          typeof entities.customerName === 'string' ? entities.customerName : undefined;
        const conversationId =
          typeof fx.payload.conversationId === 'string' ? fx.payload.conversationId : undefined;
        const negotiationCustomerId =
          typeof fx.payload.customerId === 'string' ? fx.payload.customerId : undefined;
        // Best-effort LTV/recency enrichment — a read failure never blocks the callback.
        let customerContext: CustomerNegotiationContext | null = null;
        if (negotiationCustomerId && deps.customerNegotiationContextProvider) {
          try {
            customerContext = await deps.customerNegotiationContextProvider.getContext(
              tenantId,
              negotiationCustomerId,
            );
          } catch {
            customerContext = null;
          }
        }
        // U6 (P2-036 V2) — additive discount evaluation on the live call. Only
        // engages when fully wired AND a customer is resolved; a null result
        // (unconfigured tenant / no quote / error) keeps the V1 path identical.
        const evaluation =
          negotiationCustomerId && deps.settingsRepo && deps.negotiationQuoteResolver
            ? await evaluateNegotiationDiscount({
                tenantId,
                customerId: negotiationCustomerId,
                askText: detectText || askText,
                settingsRepo: deps.settingsRepo,
                quoteResolver: deps.negotiationQuoteResolver,
              })
            : null;

        let proposalType: 'callback' | 'voice_clarification' = 'callback';
        let payload: Record<string, unknown>;
        let summary: string;
        let explanation: string;
        if (evaluation?.decision.kind === 'CLARIFY') {
          // Couldn't parse the target price — ask, never guess.
          proposalType = 'voice_clarification';
          payload = buildDiscountClarificationPayload({
            transcript: detectText || askText,
            ...(conversationId ? { conversationId } : {}),
          });
          summary = DISCOUNT_CLARIFICATION_QUESTION;
          explanation =
            'Heard a discount ask but couldn\'t make out the price they named. Tap to tell me what to quote — I never guess a discount.';
        } else if (evaluation?.decision.kind === 'ALLOW') {
          // Within policy — a CONFIDENCE-CAPPED one-tap owner action (never auto-applies).
          const allow = buildAllowDiscountCallbackContent({
            decision: evaluation.decision,
            quote: evaluation.quote,
            askText: askText || detectText,
            ...(customerName ? { customerName } : {}),
            ...(conversationId ? { conversationId } : {}),
          });
          payload = allow.payload;
          summary = allow.summary;
          explanation = allow.explanation;
        } else {
          // NEEDS_APPROVAL / REJECT_WITH_COUNTER → enriched callback; null → V1.
          const content = buildNegotiationCallbackContent({
            detectText,
            ...(askText ? { askText } : {}),
            ...(customerName ? { customerName } : {}),
            ...(conversationId ? { conversationId } : {}),
            customerContext,
            ...(evaluation
              ? { decision: evaluation.decision, quote: evaluation.quote }
              : {}),
          });
          payload = content.payload;
          summary = content.summary;
          explanation = content.explanation;
        }

        if (evaluation && deps.auditRepo) {
          try {
            await deps.auditRepo.create(
              createAuditEvent({
                tenantId,
                actorId: deps.systemActorId ?? 'calling-agent',
                actorRole: 'system',
                eventType: 'negotiation.discount_evaluated',
                entityType: 'voice_session',
                entityId: session.id,
                metadata: discountAuditMetadata(
                  evaluation.decision,
                  evaluation.quote.quotedCents,
                ),
              }),
            );
          } catch {
            /* audit is best-effort */
          }
        }

        const negotiationProposal = buildProposal({
          tenantId,
          proposalType,
          payload,
          summary,
          explanation,
          sourceContext: {
            source: 'calling-agent',
            channel: 'telephony',
            // RIVET P4 — negotiation always routes to a human `callback` /
            // clarification (both S1-safe), but the surface still travels with
            // the proposal for audit + the execution-boundary re-check.
            surface: (session.machine.currentContext.ownerSession === true
              ? 'S2'
              : 'S1') as ProposalSurface,
            sessionId: session.id,
          },
          // proposals.ai_run_id has an FK to ai_runs(id). Use the REAL run id
          // threaded from the classify call (surfaced via the gateway →
          // classifyIntent → intent_classified event → side-effect payload);
          // never fabricate one — a random uuid violates the FK and the
          // swallowed insert error silently drops the proposal on Postgres.
          // Left null when no run was persisted for this turn.
          ...(typeof fx.payload.aiRunId === 'string' && fx.payload.aiRunId
            ? { aiRunId: fx.payload.aiRunId }
            : {}),
          createdBy:
            typeof fx.payload.customerId === 'string'
              ? fx.payload.customerId
              : deps.systemActorId ?? 'calling-agent',
          ...(tenantThresholdOverride ? { tenantThresholdOverride } : {}),
        });
        const storedNegotiation = await deps.proposalRepo.create(negotiationProposal);
        session.proposalIds.push(storedNegotiation.id);
        return;
      }

      // #846 — complaint guardrail. The FSM emits this when the caller
      // reports dissatisfaction (transitions.ts, next to the negotiation
      // guard). The recorded-memo path (ComplaintTaskHandler) mints a
      // pinned-prefix `add_note` PLUS an owner `callback` — but `add_note`
      // is NOT S1-allowed, so the generic path below would coerce the live
      // caller's complaint to a bare clarification: the exact silent degrade
      // this branch exists to prevent. The live leg therefore mints only the
      // `callback` follow-up (S1-allowed — it routes a human, never a
      // mutation), carrying the SAME deterministic severity markers the memo
      // path stamps, and does NOT dispatch `proposal_queued`: the guard
      // stays in the current state, so a proposal_queued transition would be
      // wrong here.
      if (intent === 'complaint') {
        const description = typeof entities.noteBody === 'string' ? entities.noteBody : '';
        const transcript = typeof entities.transcript === 'string' ? entities.transcript : '';
        const detectText = `${description} ${transcript}`.trim();
        const customerName =
          typeof entities.customerName === 'string' ? entities.customerName : undefined;
        const conversationId =
          typeof fx.payload.conversationId === 'string' ? fx.payload.conversationId : undefined;
        // Same deterministic keyword severity the memo path uses, so the
        // review surfaces (cards, SMS render, digest) flag both legs alike.
        const severity = complaintSeverity(detectText);
        const severityMeta =
          severity === 'high'
            ? {
                _meta: {
                  // Required by the _meta contract; 'medium' is neutral (only
                  // low/very_low gate anything). The marker is the payload.
                  overallConfidence: 'medium',
                  markers: [{ path: 'body', reason: COMPLAINT_HIGH_SEVERITY_REASON }],
                },
              }
            : {};
        const who = customerName ?? 'the customer';
        const complaintProposal = buildProposal({
          tenantId,
          proposalType: 'callback',
          payload: {
            reason: 'customer_complaint_followup',
            transcript:
              detectText ||
              'Caller reported a complaint on a live call — no details were captured; check the call transcript.',
            ...(conversationId ? { conversationId } : {}),
            ...severityMeta,
          },
          summary:
            severity === 'high'
              ? `HIGH-SEVERITY complaint — call ${who} back`
              : `Complaint follow-up — call ${who} back`,
          explanation:
            'Heard on a live call. The transcript carries the details; this callback is the owner follow-up. No note is drafted on the live-caller surface (add_note is operator-only).',
          sourceContext: {
            source: 'calling-agent',
            channel: 'telephony',
            // A complaint always routes to a human `callback` (S1-safe), but
            // the surface still travels with the proposal for audit + the
            // execution-boundary re-check — same convention as negotiation.
            surface: (session.machine.currentContext.ownerSession === true
              ? 'S2'
              : 'S1') as ProposalSurface,
            sessionId: session.id,
          },
          // Real classify-run id or null — never fabricated (FK to ai_runs).
          ...(typeof fx.payload.aiRunId === 'string' && fx.payload.aiRunId
            ? { aiRunId: fx.payload.aiRunId }
            : {}),
          createdBy:
            typeof fx.payload.customerId === 'string'
              ? fx.payload.customerId
              : deps.systemActorId ?? 'calling-agent',
          ...(tenantThresholdOverride ? { tenantThresholdOverride } : {}),
        });
        const storedComplaint = await deps.proposalRepo.create(complaintProposal);
        session.proposalIds.push(storedComplaint.id);
        // Session-bus telemetry: a dead complaint branch must be a metric,
        // not an audit finding. (The Gather adapter executes no
        // emit_quality_event, so this is the phone leg's observable signal.)
        session.events.emit('voice-event', {
          type: 'proposal_created',
          proposalId: storedComplaint.id,
        });
        return;
      }

      // WS5 / WS17 I3 — in-call grounded quoting for a drafted estimate OR
      // invoice. Grounds the spoken line items against the preloaded tenant
      // catalog so the stored payload carries catalog-authoritative pricing
      // (the operator draft matches what was said) and the caller hears a
      // grounded read-back. The price-field contract differs by document:
      // estimates use `unitPrice`, invoices `unitPriceCents` (+ recomputed
      // totalCents) — see the convention doc. Undefined for every other intent
      // / a quote with no line items — the generic path then runs unchanged.
      // RIVET P4 / spec §2 — the inbound voice-turn processor drives the live
      // caller FSM. A verified owner calling in carries `ownerSession`
      // (RV-070, from caller-ID identity, never transcript content); everyone
      // else is an unauthenticated S1 caller. Derive the surface from that
      // session identity and enforce the S1 allowlist at creation: an intent
      // that maps to a non-allowlisted (S2-only) proposal type is coerced to a
      // `voice_clarification` so no actionable S2 proposal is ever minted from
      // a caller's transcript. The execution boundary re-checks the stamped
      // surface (I6) as defense-in-depth.
      // I6 (merged) — the surface derives from the fail-closed
      // `isUntrustedS1Session` predicate rather than the bare ownerSession
      // flag: identical for all telephony traffic (the only production
      // consumer of this processor — ownerSession ⇒ S2, everyone else S1),
      // and any future channel is S1 from the moment it exists until it is
      // deliberately added to TRUSTED_CHANNELS.
      const surface: ProposalSurface = isUntrustedS1Session(session) ? 'S1' : 'S2';
      const requestedProposalType = intentToProposalType(intent);
      // The deterministic emergency-keyword path (transitions.ts) marks its
      // side effect systemDetected — a server-side safety detection, not a
      // transcript-classified intent — so it is exempt from the S1 coercion
      // that guards operator-only actions. The marker travels onto the
      // proposal's sourceContext (systemDetectedSafety) so the execution
      // boundary (I6) honors the same exemption; it only unlocks the narrow
      // safety-exempt types (surface.ts) and is never caller-forgeable.
      const systemDetectedSafety = fx.payload.systemDetected === true;
      const surfaceAllowed = isProposalTypeAllowedOnSurface(
        surface,
        requestedProposalType,
        systemDetectedSafety ? { systemDetectedSafety: true } : undefined,
      );
      if (!surfaceAllowed && deps.auditRepo) {
        try {
          await deps.auditRepo.create(
            createAuditEvent({
              tenantId,
              actorId: deps.systemActorId ?? 'calling-agent',
              actorRole: 'system',
              eventType: 'voice.surface_violation_blocked',
              entityType: 'voice_session',
              entityId: session.id,
              metadata: { intent: intent ?? null, requestedProposalType, surface },
            }),
          );
        } catch {
          /* audit is best-effort */
        }
      }
      const effectiveProposalType: ProposalType = surfaceAllowed
        ? requestedProposalType
        : 'voice_clarification';

      const estimateQuote =
        surfaceAllowed && intent === 'draft_estimate'
          ? await groundVoiceQuote(session, entities, fx, 'unitPrice')
          : surfaceAllowed && intent === 'create_invoice'
            ? await groundVoiceQuote(session, entities, fx, 'unitPriceCents')
            : undefined;

      // A blocked S1 request must persist as a CANONICAL clarification —
      // voiceClarificationPayloadSchema requires `transcript` + `reason`, and
      // clarifications have no execution handler, so a generic
      // {intent, entities} payload would be a malformed, approve-to-fail card.
      // The classifier usually supplies STRUCTURED entities (invoice ref,
      // channel, …) rather than entities.transcript, so both are preserved:
      // the caller's words (or an entity-derived summary) as `transcript`, and
      // the raw entities as `requestedEntities` — otherwise the operator's
      // card says only "caller asked for send_invoice" with no way to tell
      // WHICH invoice or channel was asked for. Caller-derived data is fine to
      // STORE and display (I13) — it just never becomes instructions.
      const entityDetails = Object.entries(entities)
        .filter(([, v]) => typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean')
        .map(([k, v]) => `${k}=${String(v)}`)
        .join(', ');
      const blockedTranscript =
        typeof entities.transcript === 'string' && entities.transcript.trim().length > 0
          ? entities.transcript.trim()
          : `Caller asked for '${intent ?? 'unknown'}' — an operator-only action.` +
            (entityDetails ? ` Details heard: ${entityDetails}.` : '');
      // THE PAYLOAD CONTRACT. Every execution handler reads FLAT keys; the FSM
      // hands us a nested `{intent, entities, …}` envelope. `buildVoiceProposalPayload`
      // (proposals/voice-payload.ts) owns that translation — promotion, the
      // classifier→contract aliases, the caller-identity customerId bridge, the
      // grounded line items — and gates the result on the type's own schema.
      //
      // It NEVER throws: a throw here would strand a live caller mid-call.
      // Two failure modes, chosen by whether an operator has anything to fix:
      //
      //   - NAMEABLE gaps (the contract points at payload keys) → persist the
      //     real proposal type but stamp those keys as `missingFields`.
      //     `approveProposal` (proposals/actions.ts) REFUSES a proposal with
      //     unfilled missingFields, so the approve-to-fail card this branch
      //     exists to prevent cannot happen, while the operator still gets an
      //     editable draft of what the caller actually asked for — the same
      //     partial-draft contract the AI task handlers already emit.
      //   - NOTHING nameable (a whole-object refine failed, or the type is
      //     `voice_clarification` itself, which has no execution handler and no
      //     review-completion path) → degrade to a CANONICAL clarification and
      //     hand it to a human. That closes the second-order hole where
      //     `intentToProposalType`'s `voice_clarification` DEFAULT persisted a
      //     `{intent, entities}` payload that `voiceClarificationPayloadSchema`
      //     (transcript + reason) rejects outright.
      let payload: Record<string, unknown>;
      let payloadProposalType: ProposalType = effectiveProposalType;
      let degradedFromContract = false;
      let payloadConfidence: number | undefined;
      let contractMissingFields: string[] = [];

      if (surfaceAllowed) {
        const built = await buildVoiceProposalPayload(
          {
            intent,
            proposalType: effectiveProposalType,
            // POST-resolution: `entities` already carries whatever
            // `resolveTurnEntities` folded onto the FSM context this turn.
            entities,
            envelope: {
              sessionId: session.id,
              ...(session.callSid !== undefined ? { callSid: session.callSid } : {}),
              ...(typeof fx.payload.conversationId === 'string'
                ? { conversationId: fx.payload.conversationId }
                : {}),
            },
            ...(typeof fx.payload.customerId === 'string' && fx.payload.customerId
              ? { callerCustomerId: fx.payload.customerId }
              : session.customerId
                ? { callerCustomerId: session.customerId }
                : {}),
          },
          {
            tenantId,
            // WS5 — the catalog grounding is INJECTED (proposals/ must not
            // import ai/resolution/*). `groundVoiceQuote` already ran above for
            // the read-back the caller heard; hand back that exact outcome so
            // the spoken quote and the stored payload can never disagree.
            ...(estimateQuote ? { groundLineItems: async () => estimateQuote } : {}),
          },
        );
        payloadConfidence = built.confidence;
        if (built.ok) {
          payload = built.payload;
        } else {
          const gateable =
            effectiveProposalType !== 'voice_clarification' &&
            built.missingFieldPaths.length > 0;
          if (gateable) {
            payload = built.payload;
            contractMissingFields = built.missingFieldPaths;
          } else {
            degradedFromContract = true;
            payloadProposalType = 'voice_clarification';
            payloadConfidence = undefined;
            payload = buildContractFailureClarification(
              session,
              intent,
              entities,
              requestedProposalType,
            );
          }
          // Always diagnosable: the operator-visible outcome differs, the log
          // and the audit row do not.
          logger.warn('voice payload failed its proposal contract', {
            sessionId: session.id,
            tenantId,
            intent: intent ?? null,
            requestedProposalType,
            outcome: gateable ? 'gated_with_missing_fields' : 'degraded_to_clarification',
            errors: built.errors,
          });
          if (deps.auditRepo) {
            try {
              await deps.auditRepo.create(
                createAuditEvent({
                  tenantId,
                  actorId: deps.systemActorId ?? 'calling-agent',
                  actorRole: 'system',
                  eventType: 'voice.payload_contract_failed',
                  entityType: 'voice_session',
                  entityId: session.id,
                  metadata: {
                    intent: intent ?? null,
                    requestedProposalType,
                    outcome: gateable
                      ? 'gated_with_missing_fields'
                      : 'degraded_to_clarification',
                    errors: built.errors,
                    missingFields: built.missingFieldPaths,
                  },
                }),
              );
            } catch {
              /* audit is best-effort */
            }
          }
        }
      } else {
        payload = {
          transcript: blockedTranscript,
          reason: 'surface_restricted',
          ...(intent ? { suggestedIntents: [intent] } : {}),
          requestedProposalType,
          ...(Object.keys(entities).length > 0 ? { requestedEntities: entities } : {}),
          sessionId: session.id,
          callSid: session.callSid,
        };
      }

      // U3 — live inbound book completion. When create_appointment has a
      // verified customer + spoken time + job, place a hold and evaluate
      // D-015 so opt-in tenants can confirm on-call. Always speak an honest
      // outcome (confirmed vs pending) — never silent drop.
      let bookingUtterance: string | undefined;
      let autonomousLaneForCreate:
        | { eligible: true; threshold: number }
        | undefined;
      let laneSourceStamp: Record<string, unknown> | undefined;
      if (
        !degradedFromContract &&
        surfaceAllowed &&
        payloadProposalType === 'create_appointment' &&
        session.channel === 'telephony' &&
        session.machine.currentContext.ownerSession !== true &&
        deps.appointmentRepo &&
        deps.settingsRepo
      ) {
        const customerId =
          (typeof payload.customerId === 'string' && payload.customerId) ||
          session.customerId ||
          (typeof fx.payload.customerId === 'string' ? fx.payload.customerId : undefined);
        const jobId =
          typeof payload.jobId === 'string' ? payload.jobId : undefined;
        const dateTimeDescription = [
          payload.dateTimeDescription,
          payload.dateTimePhrase,
          entities.dateTimeDescription,
          entities.dateTimePhrase,
        ].find((v): v is string => typeof v === 'string' && v.trim().length > 0);
        if (customerId && jobId && dateTimeDescription) {
          try {
            const settings = await deps.settingsRepo.findByTenant(tenantId).catch(() => null);
            const hold = await resolveAndPlaceAppointmentHold(
              {
                appointmentRepo: deps.appointmentRepo,
                ...(deps.jobRepo ? { jobRepo: deps.jobRepo } : {}),
              },
              {
                tenantId,
                jobId,
                customerId,
                dateTimeDescription,
                ...(settings?.timezone ? { timezone: settings.timezone } : {}),
                createdBy: deps.systemActorId ?? 'calling-agent',
                idempotencyKey: `inbound-book:${session.id}:${jobId}`,
              },
            );
            if (hold.ok) {
              const timeReadback = timeReadbackFromHold(
                hold.scheduledStart,
                hold.timezone,
              );
              const slotWithinBusinessHours = checkBusinessHours(
                parseOnboardingBusinessHours(settings?.businessHours, hold.timezone),
                new Date(hold.scheduledStart),
              ).isOpen;
              // Contract: `_meta.overallConfidence` is a label, not a 0–1 score
              // (see packages/api/src/proposals/contracts.ts confidence envelope).
              // Lane eval still uses the numeric score via confidenceScore below.
              const bookingPayload: Record<string, unknown> = {
                appointmentId: hold.appointmentId,
                ...(typeof payloadConfidence === 'number'
                  ? { _meta: { overallConfidence: getConfidenceLevel(payloadConfidence) } }
                  : {}),
              };
              const laneEval = buildLaneInputFromSettings({
                platformDisabled: process.env.AUTONOMOUS_BOOKING_DISABLED === 'true',
                settings: {
                  enabled: settings?.autonomousBookingEnabled ?? false,
                  ...(settings?.autonomousBookingThreshold !== undefined
                    ? { threshold: settings.autonomousBookingThreshold }
                    : {}),
                },
                confidenceScore: payloadConfidence,
                customerId,
                holdExpiryAt: hold.holdExpiryAt,
                now: new Date(),
                slotWithinBusinessHours,
                pendingReferenceCount: 0,
                negotiationFlagged:
                  session.machine.currentContext.negotiationFlagged === true,
                payload: bookingPayload,
              });
              laneSourceStamp = laneStampIfPresent(laneEval) as
                | Record<string, unknown>
                | undefined;
              bookingUtterance = bookingSpeechForLane(laneEval, timeReadback);
              payloadProposalType = 'create_booking';
              payload = bookingPayload;
              if (laneEval.eligible) {
                autonomousLaneForCreate = laneEval;
              } else if (!laneEval.eligible) {
                // Hold stays for owner confirmation window (24h); ineligible
                // lane means draft create_booking, not auto-approve.
              }
            } else {
              bookingUtterance = bookingSpeechForLane(undefined, undefined);
            }
          } catch {
            bookingUtterance = bookingSpeechForLane(undefined, undefined);
          }
        } else if (payloadProposalType === 'create_appointment') {
          bookingUtterance = bookingSpeechForLane(undefined, undefined);
        }
      }

      const proposal = buildProposal({
        tenantId,
        proposalType: payloadProposalType,
        payload,
        // `voiceProposalSummary` (proposals/voice-intent-map.ts) — SHARED with
        // the in-app adapter, which always had the better template. This is
        // not cosmetic on the phone path: CreateAppointmentExecutionHandler
        // names an auto-opened job from `proposal.summary` when the classifier
        // emitted no `jobTitle`, so a caller who booked by phone used to get a
        // job called "Voice intent: create_appointment". It now reads
        // "Schedule appointment for Jane Smith".
        summary: surfaceAllowed
          ? degradedFromContract
            ? `Caller's '${intent ?? 'unknown'}' request needs a human — details were incomplete`
            : voiceProposalSummary(intent, entities)
          : `Caller requested an operator-only action (${intent ?? 'unknown'})`,
        sourceContext: {
          source: 'calling-agent',
          channel: 'telephony',
          // RIVET P4 — the caller's surface travels with the proposal so the
          // execution boundary can re-check it (I6).
          surface,
          // Server-set safety provenance (deterministic emergency-keyword
          // path). Travels to the executor so it honors the same S1 exemption
          // isProposalTypeAllowedOnSurface applied at creation. Only ever set
          // by trusted server code — never from transcript content.
          ...(systemDetectedSafety ? { systemDetectedSafety: true } : {}),
          // The IDENTIFIED caller's customer id (caller-ID match / self-signup
          // — session identity, never transcript content). S1 self-service
          // ops that target existing records (reschedule own appointment)
          // verify ownership against this at execution; absent → those ops
          // fail closed.
          ...(typeof fx.payload.customerId === 'string' && fx.payload.customerId
            ? { callerCustomerId: fx.payload.customerId }
            : session.customerId
              ? { callerCustomerId: session.customerId }
              : {}),
          sessionId: session.id,
          // Ambiguous-line candidates for the review UI (same shape the
          // EstimateTaskHandler stores) — only present when a line was
          // ambiguous.
          ...(!degradedFromContract && estimateQuote?.catalogResolution
            ? { catalogResolution: estimateQuote.catalogResolution }
            : {}),
          ...(laneSourceStamp ?? {}),
        },
        // WS5 — thread the (uncatalogued-capped) confidence and force 'draft'
        // for an ambiguous line, matching the EstimateTaskHandler. The voice
        // path never sets sourceTrustTier, so the proposal is born 'draft'
        // regardless; these keep the operator-side signals consistent.
        // `payloadConfidence` is the builder's echo of the same
        // uncatalogued-capped score `groundVoiceQuote` produced; a degraded
        // clarification carries neither it nor the quote's missingFields,
        // because there is no quote on that payload to qualify.
        ...(!degradedFromContract && payloadConfidence !== undefined
          ? { confidenceScore: payloadConfidence }
          : {}),
        // Ambiguous catalog lines AND unmet contract keys both land here:
        // `approveProposal` refuses a proposal with unfilled missingFields, so
        // this is the gate that keeps a contract-incomplete voice draft out of
        // the executor while still showing the operator what to fill.
        ...(() => {
          const missing = degradedFromContract
            ? []
            : [
                ...new Set([
                  ...(estimateQuote?.missingFields ?? []),
                  ...contractMissingFields,
                ]),
              ];
          return missing.length > 0 ? { missingFields: missing } : {};
        })(),
        // proposals.ai_run_id has an FK to ai_runs(id). Use the REAL run id
        // threaded from the classify call (gateway → classifyIntent →
        // intent_classified event → this side-effect payload); never
        // fabricate one — a random uuid violates the FK and the swallowed
        // insert error silently drops the proposal on Postgres. Left null
        // when no run was persisted for this turn.
        ...(typeof fx.payload.aiRunId === 'string' && fx.payload.aiRunId
          ? { aiRunId: fx.payload.aiRunId }
          : {}),
        createdBy:
          typeof fx.payload.customerId === 'string'
            ? fx.payload.customerId
            : deps.systemActorId ?? 'calling-agent',
        ...(tenantThresholdOverride ? { tenantThresholdOverride } : {}),
        // D-015 — only when every autonomous booking gate passed.
        //
        // followup-autoapprove-default audit — this call site never threads
        // supervisorMode/supervisorPresent (intentionally left as-is; see
        // that investigation), so decideInitialStatus's generic
        // shouldAutoApprove(confidence, LEGACY_AUTO_APPROVE_THRESHOLD) check
        // runs here instead of the lane's own dedicated threshold. Currently
        // harmless only because AUTONOMOUS_BOOKING_THRESHOLD_FLOOR ===
        // LEGACY_AUTO_APPROVE_THRESHOLD — see the doc comments on both
        // constants (proposals/autonomous-lane.ts /
        // proposals/auto-approve.ts) and the pinned invariant in
        // test/proposals/autonomous-lane.test.ts before changing either.
        ...(autonomousLaneForCreate
          ? {
              autonomousLane: autonomousLaneForCreate,
              sourceTrustTier: 'autonomous' as const,
            }
          : {}),
      });
      const stored = await deps.proposalRepo.create(proposal);
      session.proposalIds.push(stored.id);
      const followUps = session.machine.dispatch({
        type: 'proposal_queued',
        proposalId: stored.id,
        // WS5 — the grounded quote read-back the caller hears. Absent for
        // non-estimate proposals (and for a contract-degraded clarification,
        // which quoted nothing) → the FSM speaks the fixed confirmation.
        // U3 — booking paths override with honest confirmed/pending copy.
        ...(estimateQuote && !degradedFromContract
          ? { utterance: estimateQuote.utterance }
          : bookingUtterance
            ? { utterance: bookingUtterance }
            : {}),
        // WS18 — a grounded ESTIMATE (only) becomes a live, refinable/closeable
        // pendingQuote on the FSM. Scoped to draft_estimate: an invoice quote is
        // for completed work, not a sale to close on the call.
        ...(estimateQuote && intent === 'draft_estimate' && !degradedFromContract
          ? {
              groundedLines: estimateQuote.readbackLines,
              groundedClean: estimateQuote.groundedClean,
              totalCents: estimateQuote.totalCents,
            }
          : {}),
      });
      sideEffectsSink.push(...followUps);
    } catch (err) {
      logger.warn('create_proposal persist failed', {
        error: err instanceof Error ? err.message : String(err),
        sessionId: session.id,
      });
      const recovery = session.machine.dispatch({
        type: 'system_failure',
        reason: 'proposal_persist_failed',
      });
      sideEffectsSink.push(...recovery);
    }
  }

  function dialResultUrl(sessionId: string): string {
    const path = `/api/telephony/dial-result?sid=${encodeURIComponent(sessionId)}`;
    if (deps.publicBaseUrl) {
      return `${deps.publicBaseUrl.replace(/\/+$/, '')}${path}`;
    }
    return path;
  }

  async function handleNotifyOncall(
    session: VoiceSession,
    fx: SideEffect,
    tenantId: string,
  ): Promise<void> {
    if (!deps.onCallRepo || !deps.auditRepo) {
      logger.warn('notify_oncall (oncall/audit repos not wired)', {
        tenantId,
        payload: fx.payload,
      });
      return;
    }
    const rawReason =
      typeof fx.payload.reason === 'string' ? fx.payload.reason : 'low_confidence';
    const skillReason = mapNotifyReasonToSkillReason(rawReason);
    try {
      // F8: resolve per-tenant channel preferences for this escalation.
      let channelPreferences: { sms: boolean; in_app: boolean; whisper: boolean } = {
        sms: true,
        in_app: true,
        whisper: true,
      };
      // Voice-parity (Feature 7) — single warm-transfer line. When configured
      // it replaces the on-call rotation for this handoff.
      let transferNumber: string | undefined;
      if (deps.settingsRepo) {
        try {
          const tenantSettings = await deps.settingsRepo.findByTenant(tenantId);
          const escSettings = resolveEscalationSettings(tenantSettings);
          channelPreferences = {
            sms: escSettings.channel_sms,
            in_app: escSettings.channel_in_app,
            whisper: escSettings.channel_whisper,
          };
          transferNumber = tenantSettings?.transferNumber ?? undefined;
        } catch {
          // Best-effort: if settings lookup fails, fall back to all-enabled.
        }
      }

      const callerPhone =
        deps.callerPhoneResolver?.(session) ??
        (typeof fx.payload.callerPhone === 'string'
          ? fx.payload.callerPhone
          : 'unknown');

      const callerBundle = buildCallerContextFromSession(
        session,
        callerPhone,
        rawReason,
      );

      const crm = await hydrateEscalationCrm(
        tenantId,
        {
          ...(callerBundle.caller.customerId
            ? { customerId: callerBundle.caller.customerId }
            : {}),
          ...(callerPhone !== 'unknown' ? { phone: callerPhone } : {}),
        },
        {
          ...(deps.customerRepo ? { customerRepo: deps.customerRepo } : {}),
          ...(deps.tagRepo ? { tagRepo: deps.tagRepo } : {}),
          ...(deps.jobRepo ? { jobRepo: deps.jobRepo } : {}),
          ...(deps.agreementRepo ? { agreementRepo: deps.agreementRepo } : {}),
        },
      );
      const enrichedCaller = mergeCallerContextWithCrm(callerBundle, crm);

      const result = await escalateToHuman({
        tenantId,
        sessionId: session.id,
        reason: skillReason,
        channel: 'telephony',
        onCallRepo: deps.onCallRepo,
        auditRepo: deps.auditRepo,
        session,
        ...(deps.callControl ? { callControl: deps.callControl } : {}),
        ...(deps.dispatcherPhoneResolver
          ? { dispatcherPhoneResolver: deps.dispatcherPhoneResolver }
          : {}),
        ...(deps.businessPhoneFallbackResolver
          ? { businessPhoneFallbackResolver: deps.businessPhoneFallbackResolver }
          : {}),
        ...(transferNumber ? { transferNumber } : {}),
        ...(session.callSid ? { callSid: session.callSid } : {}),
        dialActionUrl: dialResultUrl(session.id),
        channelPreferences,
        buildSummary: buildEscalationSummary,
        callerContext: {
          caller: enrichedCaller.caller,
          ...(enrichedCaller.customer ? { customer: enrichedCaller.customer } : {}),
          intent: enrichedCaller.intent,
          transcriptSnapshot: enrichedCaller.transcriptSnapshot,
        },
        shopName: deps.businessName,
        ...(deps.publicBaseUrl ? { publicWebBaseUrl: deps.publicBaseUrl } : {}),
      });

      if (result.transfer) {
        const { transfer } = result;
        const escalationId = transfer.escalationId;
        const summary = transfer.summary;

        if (
          escalationId &&
          summary &&
          channelPreferences.whisper &&
          deps.whisperCache
        ) {
          deps.whisperCache.set(escalationId, summary.whisper);
        }

        if (
          channelPreferences.sms &&
          deps.deliveryProvider &&
          summary
        ) {
          const smsBody = summary.sms.replace('<escalationId>', escalationId ?? '');
          // Deliver the context SMS to the CSR BEFORE bridging — await provider
          // acceptance so the <Dial> TwiML isn't exposed first, but bound the
          // wait so a slow/hung provider can't hang the webhook. A send
          // failure (or the deadline) never blocks the transfer itself.
          const smsSend = deps.deliveryProvider
            .sendSms({ to: transfer.dispatcherPhone, body: smsBody })
            .catch((err) => {
              logger.warn('notify_oncall: SMS dispatch failed', {
                sessionId: session.id,
                error: err instanceof Error ? err.message : String(err),
              });
            });
          await Promise.race([
            smsSend,
            new Promise<void>((resolve) =>
              setTimeout(resolve, SMS_BEFORE_BRIDGE_TIMEOUT_MS),
            ),
          ]);
        }

        if (channelPreferences.in_app && escalationId && summary) {
          session.events.emit(
            VOICE_EVENT_CHANNEL,
            escalationStartedEvent({
              escalationId,
              reason: summary.panel.reason.code,
              dispatcherUserId: transfer.dispatcherUserId,
              tenantId,
              panel: summary.panel as unknown as PanelData,
            }),
          );
        }

        // fallbackTwiml is undefined when callControl was not wired (summary-only
        // path). Only populate the map when we have actual TwiML to emit.
        if (transfer.fallbackTwiml !== undefined) {
          pendingTransferTwiml.set(session.id, transfer.fallbackTwiml);
        }
        logger.info('notify_oncall: dialing dispatcher', {
          sessionId: session.id,
          rotationIndex: transfer.rotationIndex,
          dispatcherPhone: maskPhone(transfer.dispatcherPhone),
          hasSummary: Boolean(summary),
        });
      } else if (!result.escalated && deps.callControl) {
        await queueCallbackProposalInternal(
          session,
          tenantId,
          rawReason,
          'rotation_empty',
        );
        const safeName = xmlEscape(deps.businessName);
        pendingTransferTwiml.set(
          session.id,
          `<?xml version="1.0" encoding="UTF-8"?>` +
            `<Response>` +
            `<Say voice="Polly.Joanna">I'm sorry, no one is available right now. ${safeName} will call you back as soon as possible. Thank you for calling.</Say>` +
            `<Hangup/>` +
            `</Response>`,
        );
        session.ended = true;
      }
    } catch (err) {
      logger.warn('escalateToHuman failed', {
        error: err instanceof Error ? err.message : String(err),
        sessionId: session.id,
      });
    }
  }

  /**
   * Internal duplicate of the adapter's `queueCallbackProposal` used by
   * `handleNotifyOncall` when the rotation cascade is empty. The adapter
   * retains its public `queueCallbackProposal` for the route layer; both
   * paths build the same proposal shape.
   */
  async function queueCallbackProposalInternal(
    session: VoiceSession,
    tenantId: string,
    reason: string,
    outcome: 'rotation_empty' | 'rotation_exhausted',
  ): Promise<void> {
    if (!deps.proposalRepo) {
      logger.warn('queueCallbackProposal: proposalRepo not wired', {
        sessionId: session.id,
        outcome,
      });
      return;
    }
    try {
      const tenantThresholdOverride = await resolveThresholdOverride(tenantId);
      const proposal = buildProposal({
        tenantId,
        proposalType: 'voice_clarification',
        payload: {
          intent: 'customer_callback_required',
          reason,
          outcome,
          sessionId: session.id,
          callSid: session.callSid,
        },
        summary: `Customer callback required (${outcome})`,
        sourceContext: {
          source: 'calling-agent',
          channel: 'telephony',
          sessionId: session.id,
          escalationReason: reason,
        },
        // This callback proposal is generated internally (rotation empty/
        // exhausted) with no associated ai_runs row, so ai_run_id stays null —
        // never fabricate a uuid (FK to ai_runs(id) would reject it).
        createdBy: deps.systemActorId ?? 'calling-agent',
        ...(tenantThresholdOverride ? { tenantThresholdOverride } : {}),
      });
      const stored = await deps.proposalRepo.create(proposal);
      session.proposalIds.push(stored.id);
      if (deps.auditRepo) {
        try {
          const auditEvent = createAuditEvent({
            tenantId,
            actorId: deps.systemActorId ?? 'calling-agent',
            actorRole: 'system',
            eventType: 'customer_callback_required',
            entityType: 'voice_session',
            entityId: session.id,
            correlationId: session.id,
            metadata: {
              proposalId: stored.id,
              reason,
              outcome,
              callSid: session.callSid,
            },
          });
          await deps.auditRepo.create(auditEvent);
        } catch (err) {
          logger.warn('queueCallbackProposal: audit persist failed', {
            error: err instanceof Error ? err.message : String(err),
            sessionId: session.id,
          });
        }
      }
      deps.callControl?.clearCursor(session.id);
    } catch (err) {
      logger.warn('queueCallbackProposal failed', {
        error: err instanceof Error ? err.message : String(err),
        sessionId: session.id,
      });
    }
  }

  // ANS-001 — booking proposal types that would put a caller on the schedule.
  // On an E1 life-safety signal these are revoked so a hazard call is never
  // booked (goal clause 2). emergency_dispatch/callback are NOT booking writes.
  const REVOCABLE_BOOKING_TYPES: ReadonlySet<ProposalType> = new Set<ProposalType>([
    'create_appointment',
    'create_booking',
    'create_job',
    'create_customer',
    'confirm_appointment',
    'reschedule_appointment',
  ]);
  // Proposal statuses past the point where revoking is meaningful/safe.
  const TERMINAL_PROPOSAL_STATUSES: ReadonlySet<string> = new Set([
    'executed',
    'executing',
    'rejected',
    'undone',
    'expired',
    'execution_failed',
  ]);
  // The complement of TERMINAL_PROPOSAL_STATUSES — the statuses a booking may
  // still be revoked FROM. Passed as the precondition of the conditional write
  // so a proposal that moves on mid-revocation is never clobbered.
  const REVOCABLE_FROM_STATUSES: ProposalStatus[] = [
    'draft',
    'ready_for_review',
    'approved',
  ];
  const UUID_RE =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  /**
   * ANS-001 — durable URGENT follow-up for an E1 call. Mirrors the emergency
   * page ladder's exhaustion fallback (`telephony/emergency-page-retry.ts`):
   * the same `call_me_back` task the CSR sweep already surfaces, so a human
   * still sees the problem when every live channel failed. Best-effort — the
   * caller is on the life-safety path and nothing here may throw.
   *
   * The repo dedups on (tenant_id, session_id, REASON) — see migration 268.
   * Keying on the session alone silently discarded the second task, and since
   * the FSM emits revoke_pending_bookings before notify_tenant_emergency, the
   * one that lost was always the life-safety ALERT. Distinct reasons now each
   * get a task; a retry of the same reason still dedups.
   */
  async function createE1FollowUpTask(
    session: VoiceSession,
    tenantId: string,
    reason: string,
    callbackMessage: string,
  ): Promise<void> {
    if (!deps.callMeBackRepo) {
      logger.error('E1 follow-up task NOT created (no callMeBackRepo wired)', {
        tenantId,
        sessionId: session.id,
        reason,
      });
      return;
    }
    try {
      await deps.callMeBackRepo.create({
        tenantId,
        sessionId: session.id,
        ...(session.callSid ? { callSid: session.callSid } : {}),
        // caller_phone is NOT NULL; an unresolvable caller still gets a task
        // (the message carries the detail the CSR needs).
        callerPhone: deps.callerPhoneResolver?.(session) ?? 'unknown',
        callbackMessage,
        intentSummary: 'emergency_dispatch',
        reason,
        scheduledFor: new Date(),
      });
    } catch (err) {
      logger.error('E1 follow-up task create failed', {
        error: err instanceof Error ? err.message : String(err),
        tenantId,
        sessionId: session.id,
        reason,
      });
    }
  }

  /**
   * ANS-001 — compensation for a booking that could NOT be revoked: it already
   * executed, or a racing writer moved it past the revocable window. That
   * leaves a live appointment attached to a life-safety call, so it is never
   * silent — an audit event records it and a durable URGENT task puts it in
   * front of a human.
   */
  async function recordRevokeBlocked(
    session: VoiceSession,
    tenantId: string,
    proposal: Proposal,
  ): Promise<void> {
    const metadata = {
      proposalId: proposal.id,
      status: proposal.status,
      resultEntityId: proposal.resultEntityId ?? null,
    };
    logger.error('revoke_pending_bookings: booking still LIVE on an E1 call', {
      sessionId: session.id,
      tenantId,
      ...metadata,
    });
    if (deps.auditRepo) {
      try {
        await deps.auditRepo.create(
          createAuditEvent({
            tenantId,
            actorId: deps.systemActorId ?? 'calling-agent',
            actorRole: 'system',
            eventType: 'agent.calling.e1_revoke_blocked_terminal',
            entityType: 'voice_session',
            entityId: session.id,
            correlationId: session.id,
            metadata,
          }),
        );
      } catch (err) {
        logger.warn('e1_revoke_blocked_terminal audit persist failed', {
          error: err instanceof Error ? err.message : String(err),
          sessionId: session.id,
        });
      }
    }
    await createE1FollowUpTask(
      session,
      tenantId,
      'life_safety_e1_booking_live',
      `EMERGENCY (E1): a booking from this call could NOT be revoked ` +
        `(proposal ${proposal.id}, status ${proposal.status}). Cancel it by hand.`,
    );
  }

  /**
   * ANS-001 — E1 booking revocation. Rejects every still-live booking proposal
   * created this session and best-effort releases any tentative appointment
   * hold on a known job. A life-safety call must never leave a booking behind.
   */
  async function handleRevokePendingBookings(
    session: VoiceSession,
    fx: SideEffect,
    tenantId: string,
  ): Promise<void> {
    const reason =
      typeof fx.payload.reason === 'string' ? fx.payload.reason : 'life_safety_e1';
    if (deps.proposalRepo) {
      for (const id of [...session.proposalIds]) {
        try {
          const p = await deps.proposalRepo.findById(tenantId, id);
          if (!p) continue;
          if (!REVOCABLE_BOOKING_TYPES.has(p.proposalType)) continue;
          if (TERMINAL_PROPOSAL_STATUSES.has(p.status)) {
            // Already past revocation — compensate instead of skipping.
            await recordRevokeBlocked(session, tenantId, p);
            continue;
          }
          // CONDITIONAL write: the execution worker can move this proposal
          // approved → executing → executed between the read above and the
          // write. `updateStatusIf` folds the precondition into the UPDATE, so
          // a lost race returns null rather than rejecting an executed booking.
          const revoked = await deps.proposalRepo.updateStatusIf(
            tenantId,
            id,
            REVOCABLE_FROM_STATUSES,
            'rejected',
            {
              rejectionReason: 'life_safety_emergency',
              rejectionDetails: `Booking revoked — E1 life-safety signal (${reason}) during the call; a hazard call is never booked.`,
            },
          );
          if (revoked) {
            // Repo rule: all mutations emit an audit event. Cancelling a
            // customer's booking is exactly what an operator reconstructing an
            // E1 call will need to see.
            if (deps.auditRepo) {
              try {
                await deps.auditRepo.create(
                  createAuditEvent({
                    tenantId,
                    actorId: deps.systemActorId ?? 'calling-agent',
                    actorRole: 'system',
                    eventType: 'agent.calling.e1_booking_revoked',
                    entityType: 'proposal',
                    entityId: revoked.id,
                    correlationId: session.id,
                    metadata: {
                      proposalId: revoked.id,
                      proposalType: revoked.proposalType,
                      fromStatus: p.status,
                      reason,
                    },
                  }),
                );
              } catch (err) {
                logger.warn('e1_booking_revoked audit persist failed', {
                  error: err instanceof Error ? err.message : String(err),
                  sessionId: session.id,
                  proposalId: revoked.id,
                });
              }
            }
          } else {
            // Lost the race. Re-read so the audit/task carry the real status.
            const current = await deps.proposalRepo.findById(tenantId, id);
            await recordRevokeBlocked(session, tenantId, current ?? p);
          }
        } catch (err) {
          logger.warn('revoke_pending_bookings: proposal void failed', {
            error: err instanceof Error ? err.message : String(err),
            sessionId: session.id,
            proposalId: id,
          });
        }
      }
    }
    // Best-effort: release a tentative hold on a known (owned) job. The narrow
    // held-appointment path only fires for an identified caller whose jobId is
    // a UUID in the FSM context; otherwise the hold auto-expires via the reaper.
    const jobId = session.machine.currentContext.extractedEntities?.['jobId'];
    if (deps.appointmentRepo && typeof jobId === 'string' && UUID_RE.test(jobId)) {
      try {
        const appts = await deps.appointmentRepo.findByJob(tenantId, jobId);
        for (const a of appts) {
          if (a.holdPendingApproval === true) {
            await deps.appointmentRepo.update(tenantId, a.id, {
              holdPendingApproval: false,
              status: 'canceled',
            });
          }
        }
      } catch (err) {
        logger.warn('revoke_pending_bookings: hold release failed', {
          error: err instanceof Error ? err.message : String(err),
          sessionId: session.id,
        });
      }
    }
  }

  /**
   * ANS-001 — push half of the E1 tenant alert. Reaches the owner's phone even
   * when the text channel is degraded, and reaches every staff device the
   * tenant registered rather than one number. Additive to the SMS below and
   * best-effort: a push failure never changes the SMS/fallback outcome.
   */
  async function pushE1AlertToDevices(
    session: VoiceSession,
    tenantId: string,
    keyword: string,
    callerPhone: string | undefined,
  ): Promise<void> {
    if (!deps.deviceTokenRepo || !deps.pushDeliveryProvider) return;
    try {
      const devices = await deps.deviceTokenRepo.listByTenant(tenantId);
      if (devices.length === 0) return;
      const results = await deps.pushDeliveryProvider.sendPush(
        devices.map((d) => ({
          to: d.expoPushToken,
          // "E1" is an internal tier label — a contractor's lock screen gets
          // plain language.
          title: '⚠️ EMERGENCY — life-safety call',
          // Same I13 discipline as the SMS body: detected keyword + masked
          // number only, never the caller's own words.
          body:
            `Detected: "${keyword}"` +
            (callerPhone ? ` from ${maskPhone(callerPhone)}` : '') +
            `. Caller directed to 911/the utility — follow up immediately.`,
        })),
      );
      const failed = results.filter((r) => !r.ok).length;
      if (failed > 0) {
        logger.warn('notify_tenant_emergency: some push sends failed', {
          tenantId,
          sessionId: session.id,
          failed,
          total: results.length,
        });
      }
    } catch (err) {
      logger.warn('notify_tenant_emergency: push fan-out failed', {
        error: err instanceof Error ? err.message : String(err),
        tenantId,
        sessionId: session.id,
      });
    }
  }

  /**
   * ANS-001 — E1 tenant alert. Notifies the tenant that a life-safety call came
   * in, WITHOUT bridging the caller into a live transfer (no <Dial>): the caller
   * has been directed to 911/the utility and the call is closing. The durable
   * "logged as E1" record is the FSM's audit_log side effect; this fans the
   * alert out over the tenant's text + push channels, and falls back to a
   * durable URGENT task when the text channel can't be used at all.
   * Best-effort — never throws.
   */
  async function handleNotifyTenantEmergency(
    session: VoiceSession,
    fx: SideEffect,
    tenantId: string,
  ): Promise<void> {
    const keyword =
      typeof fx.payload.keyword === 'string' ? fx.payload.keyword : 'emergency';
    let recipients: string[] = [];
    if (deps.settingsRepo) {
      try {
        const settings = await deps.settingsRepo.findByTenant(tenantId);
        // A life-safety alert goes to EVERY configured number, not a
        // preference chain. ownerPhone (P8-016) is the owner's personal
        // emergency cell but doubles as an approver-identity field that can go
        // stale; transferNumber is a proven delivery target — and a
        // Twilio-ACCEPTED send to a stale number throws nothing, so a
        // preference chain can silently alert nobody. A duplicate text is
        // free; a missed E1 alert is not.
        recipients = [
          ...new Set(
            [settings?.ownerPhone, settings?.transferNumber].filter(
              (n): n is string => typeof n === 'string' && n.length > 0,
            ),
          ),
        ];
      } catch {
        // best-effort — fall through to the durable fallback below
      }
    }
    const callerPhone = deps.callerPhoneResolver?.(session);
    // The caller's own words are UNTRUSTED (I13) and are NOT echoed into the
    // alert body — only the detected keyword + masked caller number, so the
    // tenant's tooling never renders instruction-eligible caller content here.
    const body =
      `⚠️ EMERGENCY (E1 life-safety) call just came in` +
      (callerPhone ? ` from ${maskPhone(callerPhone)}` : '') +
      `. Detected: "${keyword}". The caller was directed to 911/the utility. ` +
      `Please follow up immediately.`;

    // Push and SMS are independent channels, so START the push without
    // awaiting it: a slow Expo endpoint costs up to 4s per 100-device batch,
    // and awaiting it first would push the owner's TEXT behind that. Both are
    // settled before returning; neither can throw.
    const push = pushE1AlertToDevices(session, tenantId, keyword, callerPhone);
    const provider = deps.deliveryProvider;
    const sms = (async (): Promise<void> => {
      if (recipients.length === 0 || !provider) {
        logger.error('notify_tenant_emergency: no owner number / delivery provider', {
          tenantId,
          sessionId: session.id,
          hasNumber: recipients.length > 0,
        });
        await createE1FollowUpTask(session, tenantId, 'life_safety_e1', body);
        return;
      }
      const sends = await Promise.allSettled(
        recipients.map((to) => provider.sendSms({ to, body })),
      );
      const failures = sends.filter((s) => s.status === 'rejected');
      for (const f of failures) {
        logger.error('notify_tenant_emergency: SMS dispatch failed', {
          error:
            f.reason instanceof Error ? f.reason.message : String(f.reason),
          tenantId,
          sessionId: session.id,
        });
      }
      // The durable fallback fires only when NO text went out at all — one
      // delivered alert is a notified tenant.
      if (failures.length === sends.length) {
        await createE1FollowUpTask(session, tenantId, 'life_safety_e1', body);
      }
    })();
    await Promise.allSettled([push, sms]);
  }

  async function executeSideEffects(
    session: VoiceSession,
    sideEffects: SideEffect[],
    tenantId: string,
  ): Promise<void> {
    if (sideEffects.length > 0) {
      deps.store.touch(session.id);
    }
    // N-003 (P2-036) — brand-voice the FSM's fixed negotiation holding line at
    // this settings-aware layer so the live call matches the SMS channel. The
    // guard keeps this a no-op (no settings read) on non-negotiation turns.
    if (
      deps.settingsRepo &&
      sideEffects.some(
        (s) => s.type === 'tts_play' && s.payload?.source === NEGOTIATION_HOLDING_TTS_SOURCE,
      )
    ) {
      try {
        const settings = await deps.settingsRepo.findByTenant(tenantId);
        brandVoiceNegotiationTts(sideEffects, {
          brandVoice: settings?.brandVoice ?? null,
          businessName: settings?.businessName ?? null,
        });
      } catch {
        // Keep the FSM's fixed holding line if settings can't be loaded.
      }
    }
    for (const fx of sideEffects) {
      if (fx.type === 'audit_log') {
        await handleAuditLog(session, fx, tenantId);
      } else if (fx.type === 'create_proposal') {
        await handleCreateProposal(session, fx, tenantId, sideEffects);
      } else if (fx.type === 'notify_oncall') {
        await handleNotifyOncall(session, fx, tenantId);
      } else if (fx.type === 'revoke_pending_bookings') {
        await handleRevokePendingBookings(session, fx, tenantId);
      } else if (fx.type === 'notify_tenant_emergency') {
        await handleNotifyTenantEmergency(session, fx, tenantId);
      }
    }
  }

  // ─── Outcome / persistence ──────────────────────────────────────────

  async function persistSessionEnded(
    session: VoiceSession,
    endedReason: string,
    outcome: CallOutcome,
  ): Promise<void> {
    if (!deps.voiceSessionRepo) return;
    try {
      await deps.voiceSessionRepo.markEnded(session.tenantId, session.id, {
        endedAt: new Date(),
        endedReason,
        outcome,
        state: session.machine.currentState,
        channel:
          session.channel === 'telephony' ? 'voice_inbound' : 'inapp_voice',
        ...(session.callSid !== undefined ? { callSid: session.callSid } : {}),
        // 15.8/15.9 — persist the in-memory transcript so /api/interactions
        // can surface the full conversation without relying on the
        // process-scoped VoiceSessionStore. (Mirrors the adapter's
        // legacy persistSessionEnded; that path is now bypassed because
        // the processor sets terminalOutcome first, so without these
        // fields transcript+customerId were silently dropped from
        // voice_sessions for any session ending via the extracted
        // speechTurn.)
        ...(session.transcript.length > 0
          ? { transcript: [...session.transcript] }
          : {}),
        // Stamp the customer FK so the interactions list can join to
        // the customers table and surface the linked customer.
        ...(session.customerId !== undefined
          ? { customerId: session.customerId }
          : {}),
        // I13 (FIX 10ii) — the FSM context's injectionFlagged was write-only
        // (set by the prompt_injection_detected guard, never read). Stamp it
        // into the durable end-of-call record so a caller injection attempt
        // is discoverable without replaying the transcript. Sticky: once
        // flagged this session, always flagged on the persisted row.
        ...(session.machine.currentContext.injectionFlagged
          ? { contentProvenance: 'untrusted' as const }
          : {}),
      });
    } catch {
      /* swallow — outcome stamping is best-effort */
    }
  }

  function finalizeTerminatedSession(
    session: VoiceSession,
    sideEffects: ReadonlyArray<SideEffect>,
    fallbackReason: string,
  ): void {
    if (session.terminalOutcome) return;
    const endSessionEffect = [...sideEffects]
      .reverse()
      .find((e) => e.type === 'end_session');
    const reason =
      (endSessionEffect && typeof endSessionEffect.payload.reason === 'string'
        ? endSessionEffect.payload.reason
        : undefined) ?? fallbackReason;
    const outcome = deriveCallOutcome({
      finalState: session.machine.currentState,
      endedReason: reason,
      context: session.machine.currentContext,
      transcript: session.transcript,
      proposalIds: session.proposalIds,
    });
    session.terminalOutcome = outcome;
    session.terminalReason = reason;
    void persistSessionEnded(session, reason, outcome);
    // Dropped-call recovery is DURABLE and host-owned (UC-5b): the adapter
    // stamps a dropped_call_recoveries row via its DroppedCallScheduler —
    // both through its finalizeTerminatedSession wrapper and through the
    // onSessionTerminated callback fired below for the internal speechTurn
    // path — so the 60s recovery SMS survives restarts and any replica's
    // dropped-call-worker sweep can send it. The superseded in-process
    // setTimeout MVP (telephony/dropped-call-recovery.ts) was deleted; it
    // double-texted callers on this path and lost recoveries on deploy.
  }

  async function runSummary(session: VoiceSession): Promise<void> {
    const durationMs = Date.now() - session.createdAt.getTime();

    if (session.transcript.length === 0) {
      logger.info('runSummary: skipping (empty transcript)', {
        sessionId: session.id,
      });
    } else {
      const intentDetected = session.machine.currentContext.currentIntent;
      const SUMMARY_RETRY_DELAYS_MS = [200, 800];
      let lastErr: unknown = null;
      for (let attempt = 0; attempt <= SUMMARY_RETRY_DELAYS_MS.length; attempt++) {
        try {
          await summarizeSession({
            tenantId: session.tenantId,
            sessionId: session.id,
            transcript: session.transcript,
            proposalIds: session.proposalIds,
            durationMs,
            gateway: deps.gateway,
            ...(intentDetected ? { intentDetected } : {}),
            ...(deps.pool ? { pool: deps.pool } : {}),
          });
          lastErr = null;
          break;
        } catch (err) {
          lastErr = err;
          if (attempt < SUMMARY_RETRY_DELAYS_MS.length) {
            await new Promise((r) => {
              const t = setTimeout(r, SUMMARY_RETRY_DELAYS_MS[attempt]);
              if (typeof t.unref === 'function') t.unref();
            });
          }
        }
      }
      if (lastErr) {
        logger.warn('summarizeSession failed after retries', {
          error: lastErr instanceof Error ? lastErr.message : String(lastErr),
          sessionId: session.id,
          attempts: SUMMARY_RETRY_DELAYS_MS.length + 1,
        });
      }
    }

    const callSid = session.machine.currentContext.callSid;
    if (deps.voiceRepo?.stampOutcomeByCallSid && callSid) {
      try {
        await deps.voiceRepo.stampOutcomeByCallSid(
          session.tenantId,
          callSid,
          deriveOutcomeFromSession(session),
        );
      } catch (err) {
        logger.warn('stampOutcomeByCallSid failed', {
          error: err instanceof Error ? err.message : String(err),
          callSid,
        });
      }
    }
  }

  /**
   * Local duplicate of the adapter's `deriveCallOutcome` for use inside
   * `runSummary`. The adapter retains its own (used by
   * `stampCallOutcomeByCallSid`); both branches return the same value
   * for the same session.
   */
  function deriveOutcomeFromSession(session: VoiceSession): CallOutcome {
    const ctx = session.machine.currentContext;
    if (ctx.escalationReason) {
      if (ctx.escalationReason.startsWith('system_failure')) return 'failed';
      if (ctx.escalationReason.startsWith('cost_cap_exceeded')) return 'failed';
      if (ctx.escalationReason.startsWith('callback_required'))
        return 'callback_required';
      if (ctx.escalationReason.startsWith('abuse_detected')) return 'failed';
      return 'escalated_to_human';
    }
    if (session.proposalIds.length > 0) return 'completed';
    if (ctx.currentIntent && ctx.currentIntent !== 'unknown') return 'completed';
    const hadCallerSpeech = session.transcript.some((line) =>
      line.startsWith('caller:'),
    );
    if (!hadCallerSpeech) return 'dropped';
    return 'no_intent';
  }

  // ─── RV-071 — owner voice-approval dialogue ─────────────────────────

  /** Assembled lazily — voice approval needs a proposalRepo to exist. */
  function voiceApprovalDeps(): VoiceApprovalDeps | null {
    if (!deps.proposalRepo) return null;
    return {
      proposalRepo: deps.proposalRepo,
      ...(deps.auditRepo ? { auditRepo: deps.auditRepo } : {}),
      ...(deps.settingsRepo ? { settingsRepo: deps.settingsRepo } : {}),
      ...(deps.smsEventRepo ? { smsEventRepo: deps.smsEventRepo } : {}),
      ...(deps.appointmentRepo ? { appointmentRepo: deps.appointmentRepo } : {}),
      ...(deps.voiceApprovalOneTap ? { oneTapFallback: deps.voiceApprovalOneTap } : {}),
      // RV-225 — the voice edit dialogue interprets deltas through the
      // SAME LLM seam as the SMS EDIT reply (proposals/edit-interpreter.ts).
      editInterpreter: createLlmEditInterpreter(deps.gateway),
    };
  }

  function applyVoiceApprovalResult(
    session: VoiceSession,
    result: VoiceApprovalTurnResult,
  ): SideEffect[] {
    session.pendingVoiceApproval = result.pending ?? undefined;
    // Merge (never replace) session-level mutations: a turn that only
    // bumps challengeFailCount must not drop an earlier challengeLockedOut.
    if (result.sessionState) {
      session.voiceApprovalState = {
        ...session.voiceApprovalState,
        ...result.sessionState,
      };
    }
    return [{ type: 'tts_play', payload: { text: result.speak, source: 'voice_approval' } }];
  }

  async function handlePendingVoiceApproval(
    session: VoiceSession,
    speechResult: string,
    tenantId: string,
  ): Promise<SideEffect[] | null> {
    const pending = session.pendingVoiceApproval;
    if (!pending) return null;
    const approvalDeps = voiceApprovalDeps();
    if (!approvalDeps) {
      session.pendingVoiceApproval = undefined;
      return null;
    }
    // WS19 — a batch walk carries its cursor on voiceApprovalState. When one is
    // active the batch continuation drives the turn (global stop / per-item
    // skip / edit / delegate-to-single-item + cursor advance); otherwise the
    // single-item engine handles it byte-identically.
    const continueTurn = isBatchActive(session.voiceApprovalState)
      ? continueVoiceBatchApproval
      : continueVoiceApproval;
    const result = await continueTurn(approvalDeps, {
      tenantId,
      sessionId: session.id,
      ownerSession: session.machine.currentContext.ownerSession === true,
      // Session-level lockout / fail-counter state — without this the
      // challenge lockout is dead code (the task can't see prior failures).
      sessionState: session.voiceApprovalState,
      utterance: speechResult,
      pending,
    });
    return applyVoiceApprovalResult(session, result);
  }

  async function handleVoiceApprovalIntent(
    session: VoiceSession,
    args: {
      intentType: string;
      entities: Record<string, unknown>;
      utterance: string;
      tenantId: string;
    },
  ): Promise<SideEffect[]> {
    const ownerSession = session.machine.currentContext.ownerSession === true;
    const approvalDeps = ownerSession ? voiceApprovalDeps() : null;

    // The HARD gate (never prompt-only): a non-owner caller uttering
    // "approve ..." — or a deployment without a proposalRepo — never
    // starts an approval flow. The FSM's bounded reprompt path answers.
    if (!ownerSession || !approvalDeps) {
      const sideEffects: SideEffect[] = [
        {
          type: 'audit_log',
          payload: {
            eventType: 'agent.calling.voice_approval_denied',
            reason: ownerSession ? 'not_configured' : 'not_owner_session',
            intentType: args.intentType,
            sessionId: session.id,
            tenantId: args.tenantId,
            ts: Date.now(),
          },
        },
      ];
      sideEffects.push(
        ...session.machine.dispatch({ type: 'confidence_low', threshold: TAU_INT, score: 0 }),
      );
      return sideEffects;
    }

    const reference =
      typeof args.entities.proposalReference === 'string' &&
      args.entities.proposalReference.trim().length > 0
        ? args.entities.proposalReference
        : args.utterance;

    // WS19 — deterministic batch trigger (NOT a classifier-prompt change, so
    // cassettes stay byte-stable): an approve on an owner session whose
    // reference OR raw utterance names the whole queue ("approve all",
    // "everything", "what's waiting", "go through them") starts a batch walk
    // over the full pending set instead of resolving a single target. Reject
    // stays single-target — a batch is an approve-all pass.
    const isApprove = args.intentType !== 'reject_proposal';
    const batchTrigger = /\b(all|everything|queue|what'?s\s+waiting|go\s+through)\b/i;
    if (isApprove && (batchTrigger.test(reference) || batchTrigger.test(args.utterance))) {
      const batchResult = await startVoiceBatchApproval(approvalDeps, {
        tenantId: args.tenantId,
        sessionId: session.id,
        ownerSession,
        sessionState: session.voiceApprovalState,
      });
      return applyVoiceApprovalResult(session, batchResult);
    }

    const result = await startVoiceApproval(approvalDeps, {
      tenantId: args.tenantId,
      sessionId: session.id,
      ownerSession,
      // Session-level lockout state: a locked session refuses fresh
      // money/irreversible dialogues immediately (capture-class still works).
      sessionState: session.voiceApprovalState,
      action: args.intentType === 'reject_proposal' ? 'reject' : 'approve',
      reference,
    });
    // The FSM deliberately stays in intent_capture / closing (the
    // lookup-skill pattern): the dialogue is session-scoped adapter
    // state, so existing FSM flows are untouched.
    return applyVoiceApprovalResult(session, result);
  }

  /**
   * RV-225 — owner voice edit ("change the second line to $200"). Same
   * layered gating as approve/reject: the classifier only sees the intent
   * on an owner session (prompt section), and this handler HARD-gates on
   * ownerSession + a wired proposalRepo — a non-owner "change ..." gets
   * the normal bounded reprompt, never an edit.
   */
  async function handleVoiceEditIntent(
    session: VoiceSession,
    args: {
      entities: Record<string, unknown>;
      utterance: string;
      tenantId: string;
    },
  ): Promise<SideEffect[]> {
    const ownerSession = session.machine.currentContext.ownerSession === true;
    const approvalDeps = ownerSession ? voiceApprovalDeps() : null;

    if (!ownerSession || !approvalDeps) {
      const sideEffects: SideEffect[] = [
        {
          type: 'audit_log',
          payload: {
            eventType: 'agent.calling.voice_edit_denied',
            reason: ownerSession ? 'not_configured' : 'not_owner_session',
            intentType: 'edit_proposal',
            sessionId: session.id,
            tenantId: args.tenantId,
            ts: Date.now(),
          },
        },
      ];
      sideEffects.push(
        ...session.machine.dispatch({ type: 'confidence_low', threshold: TAU_INT, score: 0 }),
      );
      return sideEffects;
    }

    const reference =
      typeof args.entities.proposalReference === 'string' &&
      args.entities.proposalReference.trim().length > 0
        ? args.entities.proposalReference
        : args.utterance;
    const instruction =
      typeof args.entities.editInstruction === 'string' &&
      args.entities.editInstruction.trim().length > 0
        ? args.entities.editInstruction
        : args.utterance;
    const result = await startVoiceEdit(approvalDeps, {
      tenantId: args.tenantId,
      sessionId: session.id,
      ownerSession,
      sessionState: session.voiceApprovalState,
      reference,
      instruction,
    });
    return applyVoiceApprovalResult(session, result);
  }

  /**
   * WS2 — stage the owner-approval close chain for the live quote and send the
   * owner ONE one-tap approval SMS. The estimate stays a draft, a send_estimate
   * draft is chained to it, and — when a hold was placed (the eligible path) —
   * a create_booking draft for the held slot is chained too so the owner's tap
   * confirms the booking. Nothing is approved or executed here. Idempotent
   * (skips a head that is already chained). Best-effort: a queue failure must
   * never strand the caller — the honest line is spoken regardless.
   */
  async function queueOwnerCloseChain(
    session: VoiceSession,
    tenantId: string,
    evaluation: AutonomousCloseEvaluation,
    booking?: { appointmentId: string; holdExpiryAt: Date; summary: string },
  ): Promise<void> {
    const pq = session.machine.currentContext.pendingQuote;
    if (!pq || !deps.proposalRepo) return;
    const ac = deps.autonomousClose;
    try {
      await queueCloseFallbackChain(
        {
          proposalRepo: deps.proposalRepo,
          ...(deps.auditRepo ? { auditRepo: deps.auditRepo } : {}),
          ...(deps.auditRepo && ac
            ? {
                routing: {
                  auditRepo: deps.auditRepo,
                  ...(ac.sendOwnerSms ? { sendSms: ac.sendOwnerSms } : {}),
                  ...(ac.oneTapSecret ? { secret: ac.oneTapSecret } : {}),
                  ...(ac.buildApproveUrl ? { buildApproveUrl: ac.buildApproveUrl } : {}),
                  ...(ac.ownerPhoneResolver
                    ? { ownerPhoneResolver: ac.ownerPhoneResolver }
                    : {}),
                },
              }
            : {}),
        },
        {
          tenantId,
          draftEstimateProposalId: pq.proposalId,
          ...(session.customerId ? { customerId: session.customerId } : {}),
          ...((deps.callerPhoneResolver?.(session) ?? session.callerPhone)
            ? { callerPhone: deps.callerPhoneResolver?.(session) ?? session.callerPhone }
            : {}),
          sessionId: session.id,
          evaluation,
          ...(booking ? { booking } : {}),
        },
      );
      session.closeState = 'fallback';
    } catch (err) {
      logger.warn('close owner-chain queue failed', {
        error: err instanceof Error ? err.message : String(err),
        sessionId: session.id,
      });
    }
  }

  /** A failed gate → stage the two-member owner chain (no held booking). */
  async function runCloseFallback(
    session: VoiceSession,
    tenantId: string,
    reason: AutonomousCloseIneligibleReason,
  ): Promise<void> {
    await queueOwnerCloseChain(session, tenantId, { eligible: false, reason });
  }

  /**
   * WS2 — the caller assented to book the live quote. The FSM records the
   * assent (keeping pendingQuote) and stays in `closing`; the processor owns
   * the spoken close.
   *
   * Pre-consent gate ladder (cheap checks BEFORE asking for anything):
   * platform kill switch → tenant opt-in → groundedClean → close cap → strict
   * confirmIntent on the affirmative (authoritative — the deterministic
   * pre-check was necessary, not sufficient) → an identified caller with a
   * phone. Any failure keeps the honest owner-finalizes interim line and stages
   * the owner chain. All pre-gates passing asks the caller for SMS consent; the
   * NEXT turn's grant continues into owner-approval close staging
   * (handlePendingConsentCapture → runOwnerApprovedClose).
   */
  async function handlePostQuoteClose(
    session: VoiceSession,
    tenantId: string,
    speechResult: string,
  ): Promise<SideEffect[]> {
    const out: SideEffect[] = [];
    out.push(...session.machine.dispatch({ type: 'post_quote_affirmative' }));

    // Repeated affirmative after the owner chain was already staged this
    // session — nothing more to do here; the owner still owns the approval.
    if (session.closeState === 'fallback') {
      out.push({
        type: 'tts_play',
        payload: { text: POST_QUOTE_AFFIRMATIVE_INTERIM, source: 'post_quote_close' },
      });
      return out;
    }

    const pq = session.machine.currentContext.pendingQuote;
    const ac = deps.autonomousClose;
    const callerPhone = deps.callerPhoneResolver?.(session) ?? session.callerPhone;
    const customerId = session.customerId ?? session.machine.currentContext.customerId;

    // Authoritative strict confirm. Run before the settings gates so its verdict
    // is available for the ladder; a gateway error fails closed.
    let strictConfirmed = false;
    try {
      const confirmation = await confirmIntent({
        intentSummary: 'lock in this quote and book the work',
        callerResponse: speechResult,
        tenantId,
        gateway: deps.gateway,
      });
      const capExceeded = recordCost(session, confirmation.tokenUsage);
      if (capExceeded) {
        out.push(...session.machine.dispatch({ type: 'cost_cap_exceeded' }));
        return out;
      }
      strictConfirmed = confirmation.confirmed;
    } catch (err) {
      logger.warn('post-quote close: strict confirm failed — treating as not confirmed', {
        error: err instanceof Error ? err.message : String(err),
        sessionId: session.id,
      });
      strictConfirmed = false;
    }

    // Pre-consent gate ladder (first-failing wins, matching the lane order).
    let preGateFailure: AutonomousCloseIneligibleReason | null = null;
    let settings: TenantSettings | null = null;
    if (!ac || ac.platformDisabled === true) {
      preGateFailure = 'platform_disabled';
    } else {
      settings = deps.settingsRepo
        ? await deps.settingsRepo.findByTenant(tenantId).catch(() => null)
        : null;
      if (!(settings?.autonomousCloseEnabled ?? false)) {
        preGateFailure = 'tenant_not_opted_in';
      } else if (!pq?.groundedClean) {
        preGateFailure = 'quote_not_grounded_clean';
      } else if (
        typeof settings?.autonomousCloseMaxCents === 'number' &&
        pq.totalCents > settings.autonomousCloseMaxCents
      ) {
        preGateFailure = 'above_close_cap';
      } else if (!strictConfirmed) {
        preGateFailure = 'not_strict_confirmed';
      } else if (!customerId || !callerPhone) {
        // Can't legitimately capture consent without an identified caller.
        preGateFailure = 'sms_consent_not_captured';
      }
    }

    if (preGateFailure) {
      out.push({
        type: 'audit_log',
        payload: {
          eventType: 'agent.calling.close_pre_gate_failed',
          sessionId: session.id,
          tenantId,
          reason: preGateFailure,
          ...(pq ? { proposalId: pq.proposalId } : {}),
          ts: Date.now(),
        },
      });
      await runCloseFallback(session, tenantId, preGateFailure);
      out.push({
        type: 'tts_play',
        payload: { text: POST_QUOTE_AFFIRMATIVE_INTERIM, source: 'post_quote_close' },
      });
      return out;
    }

    // All pre-gates pass → ask for on-call SMS consent (WS18b mini-dialogue).
    session.pendingConsentCapture = {
      customerId: customerId!,
      phone: callerPhone!,
      close: { proposalId: pq!.proposalId, strictConfirmed: true },
    };
    out.push({
      type: 'tts_play',
      payload: { text: SMS_CONSENT_ASK, source: 'sms_consent_capture' },
    });
    return out;
  }

  /**
   * WS2 — the close continuation, run on the consent-grant turn. Hold placement
   * → lane evaluation (composed D-015 booking leg, used here as telemetry +
   * whether to include the held booking in the owner chain) → stage the
   * owner-approval chain + ONE one-tap approval SMS. NOTHING is approved or
   * executed by the system — the owner's tap is the only approval. When a gate
   * fails the fresh hold is released and a two-member owner chain is staged;
   * either way the honest CLOSE_FALLBACK_LINE is spoken.
   */
  async function runOwnerApprovedClose(
    session: VoiceSession,
    tenantId: string,
    pending: { customerId: string; phone: string; close: { proposalId: string; strictConfirmed: boolean } },
  ): Promise<SideEffect[]> {
    const out: SideEffect[] = [];
    const ctx = session.machine.currentContext;
    const pq = ctx.pendingQuote;
    const ac = deps.autonomousClose;

    const fallback = async (reason: AutonomousCloseIneligibleReason): Promise<SideEffect[]> => {
      await runCloseFallback(session, tenantId, reason);
      out.push({
        type: 'audit_log',
        payload: {
          eventType: 'agent.calling.close_gate_failed',
          sessionId: session.id,
          tenantId,
          reason,
          ts: Date.now(),
        },
      });
      out.push({
        type: 'tts_play',
        payload: { text: CLOSE_FALLBACK_LINE, source: 'post_quote_close' },
      });
      return out;
    };

    if (!pq || !ac || !deps.proposalRepo) {
      // Quote vanished / close unwired mid-flight — owner mode.
      return fallback('scheduling_incomplete');
    }

    const settings: TenantSettings | null = deps.settingsRepo
      ? await deps.settingsRepo.findByTenant(tenantId).catch(() => null)
      : null;

    // Scheduling inputs. The spoken time rides the classifier's whitelisted
    // `dateTimeDescription` entity (verbatim phrase; sanitizeExtractedEntities
    // admits no other time key). The classifier NEVER emits ids, so the job is
    // resolved HERE: an explicit entities.jobId (programmatic paths) wins;
    // otherwise the verified caller's SINGLE active job. Zero or multiple
    // active jobs → fallback — ambiguity is never a silent guess (CLAUDE.md),
    // and the hold's ownership guard re-verifies whatever we picked.
    const entities = ctx.extractedEntities ?? {};
    const dateTimeDescription = [
      entities.dateTimeDescription,
      entities.dateTimePhrase,
    ].find((v): v is string => typeof v === 'string' && v.trim().length > 0);

    let jobId = typeof entities.jobId === 'string' ? entities.jobId : undefined;
    if (!jobId && deps.jobRepo?.findByCustomer) {
      try {
        const jobs = await deps.jobRepo.findByCustomer(tenantId, pending.customerId);
        const active = jobs.filter((j) =>
          ['new', 'scheduled', 'dispatched', 'in_progress'].includes(j.status),
        );
        if (active.length === 1) jobId = active[0]!.id;
      } catch {
        /* fall through to scheduling_incomplete */
      }
    }

    if (!jobId || !dateTimeDescription || !deps.appointmentRepo) {
      return fallback('scheduling_incomplete');
    }

    const hold = await resolveAndPlaceAppointmentHold(
      {
        appointmentRepo: deps.appointmentRepo,
        ...(deps.jobRepo ? { jobRepo: deps.jobRepo } : {}),
      },
      {
        tenantId,
        jobId,
        customerId: pending.customerId,
        dateTimeDescription,
        ...(settings?.timezone ? { timezone: settings.timezone } : {}),
        createdBy: AUTONOMOUS_CLOSE_ACTOR,
        // Deterministic per-session key: a retried close turn returns the
        // existing hold instead of double-holding the slot.
        idempotencyKey: `autonomous-close:${session.id}`,
      },
    );
    if (!hold.ok) {
      return fallback(
        // `timezone_unconfigured` takes the same chute as an unparseable
        // phrase: the turn declines to book and declines to speak a time.
        // The caller is not told the business is misconfigured — that is the
        // operator's problem, surfaced to them elsewhere — but nothing wrong
        // is written or read aloud, which is the point.
        hold.failed === 'unresolved_datetime' || hold.failed === 'timezone_unconfigured'
          ? 'scheduling_incomplete'
          : 'hold_not_placed',
      );
    }

    // Full D-018 lane — composed D-015 booking leg included. No configured
    // hours parse to null and checkBusinessHours fails OPEN (D-015).
    const slotWithinBusinessHours = checkBusinessHours(
      parseOnboardingBusinessHours(settings?.businessHours, hold.timezone),
      new Date(hold.scheduledStart),
    ).isOpen;
    const draft = await deps.proposalRepo.findById(tenantId, pq.proposalId);
    const now = new Date();
    const evaluation = evaluateAutonomousCloseLane({
      platformDisabled: ac.platformDisabled === true,
      tenantOptedIn: settings?.autonomousCloseEnabled ?? false,
      ...(typeof settings?.autonomousCloseMaxCents === 'number'
        ? { closeCapCents: settings.autonomousCloseMaxCents }
        : {}),
      groundedClean: pq.groundedClean,
      quoteTotalCents: pq.totalCents,
      strictConfirmed: pending.close.strictConfirmed,
      smsConsentCaptured: true,
      schedulingComplete: true,
      holdPlaced: true,
      holdExpiryAt: hold.holdExpiryAt,
      now,
      booking: {
        platformDisabled: ac.bookingPlatformDisabled === true,
        settings: {
          enabled: settings?.autonomousBookingEnabled ?? false,
          ...(settings?.autonomousBookingThreshold !== undefined
            ? { threshold: settings.autonomousBookingThreshold }
            : {}),
        },
        proposalType: 'create_booking',
        inboundReceptionistSource: true,
        ...(typeof draft?.confidenceScore === 'number'
          ? { confidenceScore: draft.confidenceScore }
          : {}),
        payload: { appointmentId: hold.appointmentId },
        pendingReferenceCount: 0,
        customerId: pending.customerId,
        holdPlaced: true,
        holdExpiryAt: hold.holdExpiryAt,
        now,
        slotWithinBusinessHours,
      },
      // Live-session risk flags. Negotiation rides the FSM context; a
      // vulnerability/emergency session never reaches `closing` with a
      // pendingQuote (both fast-path to escalating).
      flags: { negotiation: ctx.negotiationFlagged === true },
    });

    out.push({
      type: 'audit_log',
      payload: {
        eventType: 'agent.calling.autonomous_close_evaluated',
        sessionId: session.id,
        tenantId,
        evaluation,
        proposalId: pq.proposalId,
        appointmentId: hold.appointmentId,
        ts: Date.now(),
      },
    });

    if (!evaluation.eligible) {
      // Release the fresh hold — nothing will ever confirm it in owner mode,
      // and a 24h phantom hold would block the calendar.
      try {
        await updateAppointment(
          tenantId,
          hold.appointmentId,
          { status: 'canceled', holdPendingApproval: false },
          deps.appointmentRepo,
        );
      } catch {
        /* best-effort — the hold reaper releases it at expiry regardless */
      }
      return fallback(evaluation.reason);
    }

    // Lane-eligible: the held slot is safe to stage as a create_booking DRAFT
    // in the owner chain, so the owner's ONE one-tap approval confirms the
    // booking too. The hold is KEPT (the caller confirmed it); if the owner
    // never approves, the create_booking proposal + the hold expire naturally.
    const resolvedTime = formatForReadback(hold.scheduledStart, hold.timezone);
    const summary = `Booked ${resolvedTime}`;

    await queueOwnerCloseChain(session, tenantId, evaluation, {
      appointmentId: hold.appointmentId,
      holdExpiryAt: hold.holdExpiryAt,
      summary,
    });

    out.push({
      type: 'audit_log',
      payload: {
        eventType: 'agent.calling.close_owner_chain_staged',
        sessionId: session.id,
        tenantId,
        chainHeadProposalId: pq.proposalId,
        appointmentId: hold.appointmentId,
        ts: Date.now(),
      },
    });

    // Never claims the caller is booked — the owner still has to approve.
    out.push({
      type: 'tts_play',
      payload: { text: CLOSE_FALLBACK_LINE, source: 'post_quote_close' },
    });
    return out;
  }

  /**
   * WS18 — consume an in-flight on-call SMS consent capture. Modeled on
   * handlePendingVoiceApproval: when session.pendingConsentCapture is set, the
   * caller's utterance is the answer to "is it okay to text you the quote?".
   * Strict confirmIntent (ambiguous → no). A GRANT writes the consent (ledger +
   * customers.sms_consent) via the recordSmsConsentFromVoice seam so the
   * GatedMessageDelivery gate later passes legitimately; a DECLINE / ambiguous /
   * unwired-persistence hands the send to the owner. Returns the turn's side
   * effects, or null when no capture is pending.
   */
  async function handlePendingConsentCapture(
    session: VoiceSession,
    speechResult: string,
    tenantId: string,
  ): Promise<SideEffect[] | null> {
    const pending = session.pendingConsentCapture;
    if (!pending) return null;

    let granted = false;
    try {
      const confirmation = await confirmIntent({
        intentSummary: 'text you the full quote and a link to book',
        callerResponse: speechResult,
        tenantId,
        gateway: deps.gateway,
      });
      recordCost(session, confirmation.tokenUsage);
      granted = confirmation.confirmed;
    } catch (err) {
      // Fail closed — an evaluation error is treated as "no consent".
      logger.warn('consent capture: confirmIntent failed', {
        error: err instanceof Error ? err.message : String(err),
        sessionId: session.id,
      });
      granted = false;
    }

    session.pendingConsentCapture = undefined;

    if (granted) {
      if (deps.consentEventRepo && deps.customerRepo) {
        try {
          await recordSmsConsentFromVoice(
            {
              consentLedger: deps.consentEventRepo,
              customerRepo: deps.customerRepo,
              ...(deps.auditRepo ? { auditRepo: deps.auditRepo } : {}),
            },
            {
              tenantId,
              customerId: pending.customerId,
              phone: pending.phone,
              voiceSessionId: session.id,
              actorId: deps.systemActorId ?? 'calling-agent',
            },
          );
        } catch (err) {
          // Couldn't persist consent → do NOT claim we'll text; fall to owner.
          logger.warn('consent capture: recordSmsConsentFromVoice failed', {
            error: err instanceof Error ? err.message : String(err),
            sessionId: session.id,
          });
          granted = false;
        }
      } else {
        // No persistence wired → cannot legitimately pass the gate → owner path.
        granted = false;
      }
    }

    const captureAudit: SideEffect = {
      type: 'audit_log',
      payload: {
        eventType: 'agent.calling.sms_consent_captured',
        sessionId: session.id,
        tenantId,
        customerId: pending.customerId,
        outcome: granted ? 'granted' : 'declined',
        ts: Date.now(),
      },
    };

    // WS2 — a capture initiated by the close flow continues into the
    // owner-approval close staging on a grant; a decline (or persistence
    // failure) queues the owner-finalizes fallback and speaks the decline copy.
    if (pending.close) {
      if (granted) {
        const closeFx = await runOwnerApprovedClose(session, tenantId, {
          customerId: pending.customerId,
          phone: pending.phone,
          close: pending.close,
        });
        return [captureAudit, ...closeFx];
      }
      await runCloseFallback(session, tenantId, 'sms_consent_not_captured');
      return [
        captureAudit,
        {
          type: 'tts_play',
          payload: { text: SMS_CONSENT_DECLINE_FALLBACK, source: 'sms_consent_capture' },
        },
      ];
    }

    return [
      captureAudit,
      {
        type: 'tts_play',
        payload: {
          text: granted ? SMS_CONSENT_GRANT_ACK : SMS_CONSENT_DECLINE_FALLBACK,
          source: 'sms_consent_capture',
        },
      },
    ];
  }

  /**
   * ask_caller handler shared by BOTH voice adapters (media-streams
   * `speechTurn` and the PSTN/Gather adapter's `_handleGatherLocked`). An
   * unknown caller who has just given their info is resolved (or created) to a
   * real CUSTOMER keyed by their phone so the booking that follows attaches to
   * a customer record; the call is logged on that customer's timeline and the
   * FSM advances via `caller_known` so intent capture can proceed. Without a
   * customerRepo + phone (or on failure) we fall back to the FSM's existing
   * `unknown_caller` retry/escalate path.
   */
  /**
   * The caller's number matched several accounts in this tenant. Surface the
   * candidate list for a one-tap operator pick instead of ranking them — the
   * same choice `identify-caller` makes on `status:'multiple'` and that
   * customer-MMS intake makes on a multi-match photo. Candidates carry equal
   * scores because there is genuinely no ordering to express: the underlying
   * query has no ORDER BY. Best-effort — a failure here must not break the
   * call, which continues down the unknown_caller path either way.
   */
  async function raiseCallerClarification(
    session: VoiceSession,
    tenantId: string,
    callerPhone: string,
    candidates: Customer[],
  ): Promise<void> {
    if (!deps.proposalRepo) return;
    try {
      const proposal = buildProposal({
        tenantId,
        proposalType: 'voice_clarification',
        payload: {
          transcript: `Inbound call from ${maskPhone(callerPhone)}`,
          reason: 'ambiguous_entity',
          entityReference: callerPhone,
          entityCandidates: candidates.map((c) => ({
            id: c.id,
            label: c.displayName,
            ...(c.primaryPhone ? { hint: c.primaryPhone } : {}),
            score: 0,
          })),
        },
        summary: `Caller ${maskPhone(callerPhone)} matched ${candidates.length} customers — pick which one before this call is attached.`,
        createdBy: deps.systemActorId ?? 'system:inbound-call',
        ...(session.callSid
          ? { idempotencyKey: `voice-caller-clarify:${session.callSid}` }
          : {}),
      });
      const stored = await deps.proposalRepo.create(proposal);
      if (deps.auditRepo) {
        await deps.auditRepo.create(
          createAuditEvent({
            tenantId,
            actorId: deps.systemActorId ?? 'system:inbound-call',
            actorRole: 'system',
            eventType: 'voice.caller_clarification_raised',
            entityType: 'proposal',
            entityId: stored.id,
            metadata: { candidateCount: candidates.length, sessionId: session.id },
          }),
        );
      }
    } catch (err) {
      logger.error('ask_caller: ambiguous-caller clarification failed', {
        error: err instanceof Error ? err.message : String(err),
        sessionId: session.id,
      });
    }
  }

  async function handleAskCaller(
    session: VoiceSession,
    tenantId: string,
  ): Promise<SideEffect[]> {
    const out: SideEffect[] = [];
    const callerPhone = deps.callerPhoneResolver?.(session) ?? session.callerPhone;
    if (deps.customerRepo && callerPhone) {
      try {
        const resolved = await findOrCreateCustomerByPhone({
          tenantId,
          fromPhone: callerPhone,
          customerRepo: deps.customerRepo,
          ...(deps.auditRepo ? { auditRepo: deps.auditRepo } : {}),
          systemActorId: deps.systemActorId ?? 'system:inbound-call',
        });
        if (resolved.status === 'ambiguous') {
          // This number belongs to several accounts in this tenant. Binding
          // session.customerId here would scope every later balance/invoice
          // lookup — and this call's timeline entry — to an arbitrary one of
          // them, inside a single tenant where RLS cannot see the mistake.
          // Raise a clarification and fall back to the FSM's existing
          // unknown_caller retry/escalate path instead of guessing.
          await raiseCallerClarification(session, tenantId, callerPhone, resolved.candidates);
          out.push(...session.machine.dispatch({ type: 'unknown_caller' }));
          return out;
        }
        session.customerId = resolved.customerId;
        if (deps.conversationRepo) {
          try {
            await logInboundCallOnCustomerTimeline({
              conversationRepo: deps.conversationRepo,
              tenantId,
              customerId: resolved.customerId,
              fromPhone: callerPhone,
              ...(session.callSid ? { callSid: session.callSid } : {}),
              actorId: deps.systemActorId ?? 'system:inbound-call',
              ...(deps.auditRepo ? { auditRepo: deps.auditRepo } : {}),
            });
          } catch (err) {
            logger.error('ask_caller: inbound call timeline log failed', {
              error: err instanceof Error ? err.message : String(err),
              sessionId: session.id,
            });
          }
        }
        out.push(
          ...session.machine.dispatch({ type: 'caller_known', customerId: resolved.customerId }),
        );
      } catch (err) {
        logger.error('ask_caller: find-or-create customer failed', {
          error: err instanceof Error ? err.message : String(err),
          sessionId: session.id,
        });
        out.push(...session.machine.dispatch({ type: 'unknown_caller' }));
      }
    } else {
      // No customer repo / phone wired — keep the existing retry/escalate path.
      out.push(...session.machine.dispatch({ type: 'unknown_caller' }));
    }
    return out;
  }

  // ─── Speech turn (formerly processCallerUtterance) ──────────────────

  const speechTurn: SpeechTurnHandler = async ({
    session,
    speechResult,
    callSid: _callSid,
    tenantId,
  }): Promise<SideEffect[]> => {
    // Note: `processCallerUtterance` historically took `sessionId` and
    // looked up the session via the store. The mediastream adapter
    // already resolves the session before invoking us, so we accept it
    // directly. The unknown-session fallback is preserved for the
    // (rare) case where callers pass through a stale session.
    if (!session) {
      logger.warn('speechTurn: missing session');
      return [
        {
          type: 'tts_play',
          payload: {
            text: "I'm sorry, your session has ended. Please call again.",
          },
        },
        { type: 'end_session', payload: { reason: 'session_not_found' } },
      ];
    }

    // 1. Append caller utterance to transcript.
    // #850 — redacted when the session is awaiting a spoken money-approval
    // challenge. This site is REACHED TWICE on the media-streams path (the
    // adapter routes through TwilioGatherAdapter#processCallerUtterance, which
    // appends first), so an unguarded append here re-leaked the secret that
    // the other site had just redacted.
    deps.store.appendTranscript(session.id, {
      speaker: 'caller',
      text: callerTranscriptText(session, speechResult),
      ts: Date.now(),
    });

    // RV-071 — an in-flight owner approval dialogue consumes the turn
    // BEFORE the FSM-state branch (including silence: an empty utterance
    // is "anything else" → no action, keep for later).
    const approvalTurn = await handlePendingVoiceApproval(session, speechResult, tenantId);
    if (approvalTurn) {
      await executeSideEffects(session, approvalTurn, tenantId);
      appendAgentTts(deps.store, session.id, approvalTurn);
      return approvalTurn;
    }

    // WS18 — an in-flight on-call SMS consent capture also consumes the turn
    // before the FSM-state branch (the caller's utterance is the yes/no answer).
    const consentTurn = await handlePendingConsentCapture(session, speechResult, tenantId);
    if (consentTurn) {
      await executeSideEffects(session, consentTurn, tenantId);
      appendAgentTts(deps.store, session.id, consentTurn);
      return consentTurn;
    }

    const sideEffectsAll: SideEffect[] = [];
    const currentState = session.machine.currentState;

    if (speechResult.trim().length === 0) {
      sideEffectsAll.push(
        ...session.machine.dispatch({
          type: 'confidence_low',
          threshold: TAU_INT,
          score: 0,
        }),
      );
      await executeSideEffects(session, sideEffectsAll, tenantId);
      return sideEffectsAll;
    }

    if (currentState === 'ask_caller') {
      sideEffectsAll.push(...(await handleAskCaller(session, tenantId)));
      await executeSideEffects(session, sideEffectsAll, tenantId);
      return sideEffectsAll;
    }

    if (currentState === 'intent_confirm') {
      try {
        const ctx = session.machine.currentContext;
        const intentSummary = ctx.currentIntent ?? 'that';
        const confirmation = await confirmIntent({
          intentSummary,
          callerResponse: speechResult,
          tenantId,
          gateway: deps.gateway,
        });
        const capExceeded = recordCost(session, confirmation.tokenUsage);
        if (capExceeded) {
          sideEffectsAll.push(
            ...session.machine.dispatch({ type: 'cost_cap_exceeded' }),
          );
        } else if (confirmation.confirmed) {
          sideEffectsAll.push(
            ...session.machine.dispatch({ type: 'confirmed' }),
          );
        } else {
          sideEffectsAll.push(
            ...session.machine.dispatch({
              type: 'correction',
              newTranscript: confirmation.correction ?? speechResult,
            }),
          );
        }
      } catch (err) {
        logger.error('speechTurn: confirmIntent failed', {
          error: err instanceof Error ? err.message : String(err),
          sessionId: session.id,
        });
        sideEffectsAll.push(
          ...session.machine.dispatch({
            type: 'correction',
            newTranscript: speechResult,
          }),
        );
      }
    } else if (currentState === 'intent_capture' || currentState === 'closing') {
      // WS18 — deterministic post-quote pre-check. Runs ONLY in `closing` with a
      // live pendingQuote, BEFORE the classifier (the classifier prompt/schema
      // stay byte-stable). Closes the discard bug: "yes, book it" and "make it
      // two" are handled here instead of being misread as a second intent that
      // silently drops the quote.
      const pendingQuote = session.machine.currentContext.pendingQuote;
      if (currentState === 'closing' && pendingQuote) {
        const decision = classifyPostQuoteUtterance(speechResult);
        if (decision.kind === 'affirmative') {
          sideEffectsAll.push(...(await handlePostQuoteClose(session, tenantId, speechResult)));
          await executeSideEffects(session, sideEffectsAll, tenantId);
          appendAgentTts(deps.store, session.id, sideEffectsAll);
          return sideEffectsAll;
        }
        if (decision.kind === 'refine') {
          if (pendingQuote.refinementCount >= MAX_REFINEMENTS_PER_CALL) {
            // At the cap — don't re-ground; the FSM speaks the deferral line
            // (utterance is ignored on the capped branch).
            sideEffectsAll.push(
              ...session.machine.dispatch({
                type: 'refine_pending_quote',
                proposalId: pendingQuote.proposalId,
                groundedLines: pendingQuote.groundedLines,
                groundedClean: pendingQuote.groundedClean,
                totalCents: pendingQuote.totalCents,
                utterance: REFINEMENT_CAP_LINE,
              }),
            );
            await executeSideEffects(session, sideEffectsAll, tenantId);
            appendAgentTts(deps.store, session.id, sideEffectsAll);
            return sideEffectsAll;
          }
          const refined = await applyQuoteRefinement(session, tenantId, decision.edit);
          if (refined) {
            sideEffectsAll.push(
              ...session.machine.dispatch({
                type: 'refine_pending_quote',
                proposalId: pendingQuote.proposalId,
                groundedLines: refined.readbackLines,
                groundedClean: refined.groundedClean,
                totalCents: refined.totalCents,
                utterance: refined.utterance,
              }),
            );
            await executeSideEffects(session, sideEffectsAll, tenantId);
            appendAgentTts(deps.store, session.id, sideEffectsAll);
            return sideEffectsAll;
          }
          // refined === null (unresolvable edit) → fall through to the classifier.
        }
        // passthrough / unresolved refine → continue to the classifier below.
      }

      let classifierEvent: CallingAgentEvent | null = null;
      const verticalPromptSection = await resolveVerticalPromptSection(tenantId);
      const planPromptSection = await resolvePlanPromptSection(
        tenantId,
        session.customerId,
      );
      try {
        const classification = await classifyIntent(
          speechResult,
          {
            tenantId,
            verticalPromptSection,
            planPromptSection,
            // RV-071 — the owner-approval prompt section is appended ONLY
            // on a recognized owner line (caller-ID match; see
            // approver-identity.ts), keeping every other call's
            // prompt byte-identical (cassettes / gateway cache).
            ...(session.machine.currentContext.ownerSession === true
              ? { ownerSession: true }
              : {}),
            ...(session.machine.currentContext.extendedIntents === true
              ? { extendedIntents: true }
              : {}),
            ...(session.machine.currentContext.customerProtectionIntents === true
              ? { customerProtectionIntents: true }
              : {}),
          },
          deps.gateway,
        );
        // Successful classify clears infra-retry budget for this session.
        session.aiInfraRetryCount = 0;
        session.events.emit(
          'voice-event',
          intentClassifiedEvent({
            intentType: classification.intentType,
            confidence: classification.confidence,
            tokenUsage: classification.tokenUsage,
          }),
        );
        const capExceeded = recordCost(session, classification.tokenUsage);
        if (capExceeded) {
          classifierEvent = { type: 'cost_cap_exceeded' };
        } else if (
          classification.confidence >= TAU_INT &&
          classification.intentType !== 'unknown'
        ) {
          classifierEvent = {
            type: 'intent_classified',
            intentType: classification.intentType,
            entities: (classification.extractedEntities ?? {}) as Record<
              string,
              unknown
            >,
            confidence: classification.confidence,
            // Thread the classify call's REAL ai_runs id so a proposal born
            // from this intent links to its run row (proposals.ai_run_id FK).
            ...(classification.aiRunId ? { aiRunId: classification.aiRunId } : {}),
          };
        } else {
          // Low / unknown intent → intent_classified so FSM uses
          // low_intent_confidence repair (not low_audio / "trouble hearing").
          classifierEvent = {
            type: 'intent_classified',
            intentType:
              classification.intentType === 'unknown'
                ? 'unknown'
                : classification.intentType,
            entities: (classification.extractedEntities ?? {}) as Record<
              string,
              unknown
            >,
            confidence: classification.confidence,
          };
        }
      } catch (err) {
        // Never map quota/breaker/provider brownouts to "didn't catch that".
        const infraKind = classifyInfraFailure(err);
        logger.error('speechTurn: classifyIntent failed', {
          error: err instanceof Error ? err.message : String(err),
          sessionId: session.id,
          infraKind,
        });
        if (isTransientInfraFailure(infraKind) && (session.aiInfraRetryCount ?? 0) < 1) {
          session.aiInfraRetryCount = (session.aiInfraRetryCount ?? 0) + 1;
          sideEffectsAll.push({
            type: 'tts_play',
            payload: { text: AI_BUSY_HOLD_LINE, source: 'ai_infrastructure_hold' },
          });
          await executeSideEffects(session, sideEffectsAll, tenantId);
          appendAgentTts(deps.store, session.id, sideEffectsAll);
          return sideEffectsAll;
        }
        sideEffectsAll.push(
          ...session.machine.dispatch({
            type: 'system_failure',
            reason: systemFailureReasonForInfra(infraKind),
          }),
        );
        await executeSideEffects(session, sideEffectsAll, tenantId);
        appendAgentTts(deps.store, session.id, sideEffectsAll);
        return sideEffectsAll;
      }

      // RV-071 — owner voice approval. Routed OUTSIDE the FSM (the
      // lookup-skill pattern: the FSM state is untouched and the dialogue
      // lives on the session). handleVoiceApprovalIntent hard-gates on
      // ownerSession — a non-owner "approve" gets the normal reprompt.
      if (
        classifierEvent.type === 'intent_classified' &&
        isVoiceApprovalIntent(classifierEvent.intentType)
      ) {
        const approvalFx = await handleVoiceApprovalIntent(session, {
          intentType: classifierEvent.intentType,
          entities: classifierEvent.entities,
          utterance: speechResult,
          tenantId,
        });
        sideEffectsAll.push(...approvalFx);
        await executeSideEffects(session, sideEffectsAll, tenantId);
        appendAgentTts(deps.store, session.id, sideEffectsAll);
        return sideEffectsAll;
      }

      // RV-225 — owner voice edit. Same out-of-FSM routing as the approval
      // dialogue; handleVoiceEditIntent hard-gates on ownerSession.
      if (
        classifierEvent.type === 'intent_classified' &&
        isVoiceEditIntent(classifierEvent.intentType)
      ) {
        const editFx = await handleVoiceEditIntent(session, {
          entities: classifierEvent.entities,
          utterance: speechResult,
          tenantId,
        });
        sideEffectsAll.push(...editFx);
        await executeSideEffects(session, sideEffectsAll, tenantId);
        appendAgentTts(deps.store, session.id, sideEffectsAll);
        return sideEffectsAll;
      }

      // P12-004 — emergency-intent immediate Dial. When the classified
      // intent is in the emergency set AND the tenant is unsupervised
      // (checked inside the wrapper via isSupervisorPresent), bypass the
      // FSM/booking path entirely and Dial the on-call rotation now.
      // The wrapper emits the `emergency_immediate_dial` audit event.
      // Supervised tenants and non-emergency intents fall through to the
      // unchanged FSM dispatch below.
      if (
        classifierEvent.type === 'intent_classified' &&
        EMERGENCY_INTENTS.has(classifierEvent.intentType) &&
        deps.onCallRepo
      ) {
        try {
          const immediate = await emergencyImmediateDial({
            intent: classifierEvent.intentType,
            tenantId,
            sessionId: session.id,
            channel: 'telephony',
            onCallRepo: deps.onCallRepo,
            ...(deps.auditRepo ? { auditRepo: deps.auditRepo } : {}),
            session,
            ...(deps.callControl ? { callControl: deps.callControl } : {}),
            ...(deps.dispatcherPhoneResolver
              ? { dispatcherPhoneResolver: deps.dispatcherPhoneResolver }
              : {}),
            ...(deps.businessPhoneFallbackResolver
              ? { businessPhoneFallbackResolver: deps.businessPhoneFallbackResolver }
              : {}),
            ...(session.callSid ? { callSid: session.callSid } : {}),
            dialActionUrl: dialResultUrl(session.id),
          });
          if (immediate.dialed && immediate.escalation) {
            if (immediate.escalation.transfer?.fallbackTwiml !== undefined) {
              pendingTransferTwiml.set(
                session.id,
                immediate.escalation.transfer.fallbackTwiml,
              );
            }
            sideEffectsAll.push({
              type: 'tts_play',
              payload: { text: immediate.escalation.message },
            });
            await executeSideEffects(session, sideEffectsAll, tenantId);
            return sideEffectsAll;
          }
        } catch (err) {
          // Best-effort: an immediate-Dial failure must never strand the
          // caller — fall through to the normal FSM path (whose own
          // emergency fast-path still escalates via notify_oncall).
          logger.warn('speechTurn: emergencyImmediateDial failed, falling through', {
            error: err instanceof Error ? err.message : String(err),
            sessionId: session.id,
          });
        }
      }

      sideEffectsAll.push(...session.machine.dispatch(classifierEvent));

      if (
        classifierEvent.type === 'intent_classified' &&
        session.machine.currentState === 'entity_resolution'
      ) {
        const refs = await resolveTurnEntities(
          session,
          tenantId,
          classifierEvent.intentType,
          classifierEvent.entities as Record<string, unknown>,
        );
        sideEffectsAll.push(
          ...session.machine.dispatch({ type: 'entity_resolved', refs }),
        );
        expandIntentConfirmTemplate(sideEffectsAll, classifierEvent.intentType);
      }
    } else {
      logger.info('speechTurn: unhandled state, treating as confidence_low', {
        state: currentState,
        sessionId: session.id,
      });
      sideEffectsAll.push(
        ...session.machine.dispatch({
          type: 'confidence_low',
          threshold: TAU_INT,
          score: 0,
        }),
      );
    }

    await executeSideEffects(session, sideEffectsAll, tenantId);

    appendAgentTts(deps.store, session.id, sideEffectsAll);
    if (session.machine.currentState === 'terminated' && !session.ended) {
      session.ended = true;
      finalizeTerminatedSession(session, sideEffectsAll, 'caller_hangup');
      // Defer summary kick-off to the host so it can decide on retry /
      // background semantics. We `await` the callback so hosts that
      // need summary spend to land within a snapshot window (Layer 2
      // entry test) can do so deterministically; production keeps the
      // fire-and-forget tradeoff inside its callback wiring to preserve
      // Twilio webhook latency. When no host hook is wired we run
      // summary inline (still fire-and-forget) for parity with the
      // adapter's legacy behavior.
      if (deps.onSessionTerminated) {
        try {
          await deps.onSessionTerminated(session);
        } catch (err) {
          logger.warn('onSessionTerminated callback threw', {
            error: err instanceof Error ? err.message : String(err),
            sessionId: session.id,
          });
        }
      } else {
        void runSummary(session).catch(() => {
          /* swallow — summary is best-effort */
        });
      }
    }

    return sideEffectsAll;
  };

  return {
    speechTurn,
    finalizeTerminatedSession,
    // Exposed so TwilioGatherAdapter's Gather entry point runs the SAME real
    // resolution as speechTurn instead of its own duplicated blind echo.
    resolveTurnEntities,
    executeSideEffects,
    recordCost,
    expandIntentConfirmTemplate,
    resolveVerticalPromptSection,
    resolvePlanPromptSection,
    resolveThresholdOverride,
    runSummary,
    handlePendingVoiceApproval,
    handlePendingConsentCapture,
    handleVoiceApprovalIntent,
    handleVoiceEditIntent,
    handleAskCaller,
  };
}
