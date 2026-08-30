/**
 * In-app voice session adapter.
 *
 * Bridges HTTP/SSE I/O to the channel-agnostic CallingAgentStateMachine
 * for the *inapp* channel. The adapter:
 *
 *  1. Owns lookup/lifecycle into the VoiceSessionStore.
 *  2. Runs the intent classifier on user text and translates the result
 *     into FSM events.
 *  3. Executes the SideEffect[] returned by the FSM (TTS, audit, proposal
 *     creation, escalation, end-session).
 *  4. Emits per-turn events on the session's EventEmitter so the SSE
 *     route can stream FSM transitions to the browser.
 *
 * No real-time microphone capture — that's P8-012. This phase is
 * text-in / TTS-out, exposed at /api/voice/sessions.
 */

import type { Pool } from 'pg';
import type { LLMGateway } from '../../gateway/gateway';
import type { TtsProvider } from '../../tts/tts-provider';
import type { ProposalRepository } from '../../../proposals/proposal';
import { createProposal as buildProposal } from '../../../proposals/proposal';
import type { ProposalType } from '../../../proposals/proposal';
import type { ProposalSurface } from '../../../proposals/surface';
// THE shared voice → proposal payload contract, also used by the real Twilio
// path (ai/voice-turn/create-voice-turn-processor.ts). Exactly one copy of the
// promotion / alias / line-item translation exists, and it lives next to the
// per-type contracts it has to satisfy.
import { buildVoiceProposalPayload } from '../../../proposals/voice-payload';
// A48 fix — the dedicated spoken-instruction → typed-payload mapping
// update_brand_voice needs (see extractBrandVoiceProposalFields's doc
// comment for why buildVoiceProposalPayload's generic promotion can't do
// this on its own).
import { extractBrandVoiceProposalFields } from '../../tasks/brand-voice-task';
import type { BrandVoiceProposalFields } from '../../tasks/brand-voice-task';
import {
  intentToProposalType,
  voiceProposalSummary,
} from '../../../proposals/voice-intent-map';
import { buildVoiceClarificationPayload } from '../../../proposals/voice-clarification';
import {
  buildAndPersistNegotiationProposal,
  buildAndPersistComplaintProposal,
} from '../../../proposals/guardrails/voice-protection-proposal';
import type { CustomerNegotiationContextProvider } from '../../../customers/customer-negotiation-context';
import type { CurrentQuoteResolver } from '../../../conversations/negotiation/current-quote-resolver';
import type { TaskHandler } from '../../tasks/task-handlers';
import type { AuditRepository } from '../../../audit/audit';
import { createAuditEvent } from '../../../audit/audit';
import type { OnCallRepository } from '../../../oncall/rotation';
import { classifyIntent } from '../../orchestration/intent-classifier';
import { isDeadlineExceeded } from '../../gateway/deadline';
import { escalateToHuman } from '../../skills/escalate-to-human';
import type { EscalationReason } from '../../skills/escalate-to-human';
import { summarizeSession } from '../../skills/summarize-session';
import { estimateCostCents } from '../../skills/session-cost-tracker';
import {
  intentClassifiedEvent,
  costIncurredEvent,
  sessionTerminatedEvent,
  languageSwitchedEvent,
} from '../../voice-quality/events';
import { TAU_INT } from './transitions';
import type { CallingAgentContext, CallingAgentEvent, SideEffect } from './types';
import type { VoiceSession, VoiceSessionStore } from './voice-session-store';
import type { VoiceSessionRepository } from '../../../voice/voice-session';
import type { CallOutcome } from '../../../voice/voice-service';
import { deriveCallOutcome } from './outcome-mapper';
import { resolveSchedulingEntities, requiresExistingEntity } from './entity-resolution';
import type { SchedulingEntityResolution } from './entity-resolution';
import type { SettingsRepository } from '../../../settings/settings';
import { isRuntimeTimezone } from '../../../shared/timezone';
import {
  MAX_DISAMBIGUATION_ATTEMPTS,
  refKeyForEntityKind,
  resolveDisambiguationFollowUp,
} from './entity-resolution';
import type { PendingEntityAmbiguity } from './entity-resolution';
import { withTenantConnection } from '../../../db/tenant-transaction';
import { PgEntityResolver } from '../../resolution/pg-entity-resolver';
import type { EntityCandidate, EntityResolver } from '../../resolution/entity-resolver';
import {
  groundLineItemPricing,
  UNCATALOGUED_CONFIDENCE_CAP,
} from '../../resolution/catalog-resolver';
import type { CatalogPricingOutcome } from '../../resolution/catalog-resolver';
import type { CatalogItemRepository } from '../../../catalog/catalog-item';
import {
  detectLanguage,
  renderTtsText,
  LANGUAGE_SWITCH_ACK,
  LANGUAGE_SWITCH_CAP_LINE,
  LANGUAGE_UNSUPPORTED_LINE,
  VOICE_APPROVAL_REFUSAL,
} from './tts-copy';
import type { SessionLanguage } from './tts-copy';
import type { Language } from '../../i18n/i18n';
import {
  detectLanguageSwitchIntent,
  isLanguageSupported,
  MAX_LANGUAGE_SWITCHES_PER_CALL,
} from '../../orchestration/language-detector';
import {
  isVoiceApprovalIntent,
  isVoiceEditIntent,
} from '../../orchestration/intent-classifier';
import type { VoicePersona, VoicePersonaResolver } from '../../../settings/voice-persona-resolver';
import type { RepairTemplate } from '../../../verticals/registry';
import type { DroppedCallScheduler } from '../../../sms/recovery/scheduler';
import { buildRecoveryContext } from '../../../sms/recovery/scheduler';
import type { CustomerRepository } from '../../../customers/customer';
import { normalizePhone } from '../../../customers/dedup';

export interface InAppAdapterDeps {
  store: VoiceSessionStore;
  gateway: LLMGateway;
  ttsProvider?: TtsProvider;
  proposalRepo: ProposalRepository;
  auditRepo: AuditRepository;
  onCallRepo: OnCallRepository;
  /**
   * Postgres pool — when present, end-of-call summaries are persisted to
   * call_summaries. Optional so dev mode (no DB) still works.
   *
   * Also used to self-construct the entity resolver (see `entityResolver`)
   * when one isn't injected, so production wiring needs no change.
   */
  pool?: Pool;
  /**
   * P0 voice-safety — shared, tenant-scoped entity resolver (production:
   * `PgEntityResolver`, pg_trgm, τ_ent=0.80). Free-text
   * customer/job/appointment references on the scheduling path resolve
   * through this so ambiguity becomes a one-tap voice_clarification instead
   * of a silent "newest match" guess (CLAUDE.md invariant).
   *
   * Optional and self-constructed from `pool` when omitted (see
   * `getEntityResolver`), so app.ts needs no wiring change; tests inject a
   * mock resolver directly (no DB required). When neither a resolver nor a
   * pool is present, resolution is skipped and references pass through
   * unresolved (proposal surfaces for operator review) — never guessed.
   */
  entityResolver?: EntityResolver;
  /**
   * U4 (Part E punch #1) — tenant settings for spoken-datetime resolution.
   * The tenant's IANA zone is resolved ONCE per session and threaded into
   * `resolveSchedulingEntities` so "Thursday at 2pm" spoken on the in-app
   * live path books in the TENANT's timezone, exactly like the recorded-memo
   * path. Optional and failure-soft: absent (or no configured zone) ⇒ spoken
   * times stay unresolved and the proposal gates downstream (B5.5 precedent
   * — never a silent UTC parse).
   */
  settingsRepo?: SettingsRepository;
  /** Used for `actorId` on proposal/audit rows. */
  systemActorId?: string;
  /**
   * §3B + §3D vertical-aware classifier prompt. Resolves the tenant's
   * active vertical pack and returns a prompt-shaped section (see
   * `formatVerticalForCallerPrompt` in `verticals/context-assembly.ts`,
   * which now also embeds the pack's intake_questions per §3D).
   * Pluggable so app.ts can wire in its own pack lookup and tests can
   * stub a fixed string. Returns undefined when the tenant has no
   * active pack — the classifier falls back to its base prompt.
   */
  verticalPromptResolver?: (tenantId: string) => Promise<string | undefined>;
  /**
   * §3C caller-plan / membership classifier prompt. Resolved per
   * (tenantId, customerId) once the caller is identified — for
   * unknown callers or operator-side flows without a customerId, the
   * resolver is not consulted. Returns undefined when the customer
   * has no active maintenance plan.
   */
  callerPlanResolver?: (
    tenantId: string,
    customerId: string,
  ) => Promise<string | undefined>;
  /**
   * Tier 4 / PR B — per-tenant auto-approve threshold override
   * resolver. When present, the adapter loads the override before
   * `createProposal` and threads it through `tenantThresholdOverride`
   * so the persisted Settings UI value actually affects the
   * threshold decision. Optional: when absent the adapter omits the
   * override and proposals fall back to DEFAULT_AUTO_APPROVE_THRESHOLDS.
   */
  thresholdResolver?: (tenantId: string) => Promise<
    Partial<Record<'supervisor' | 'tech' | 'both', number>> | undefined
  >;
  /**
   * B2 — persistent outcome stamping. When wired, the adapter inserts a
   * voice_sessions row on session start and stamps the typed CallOutcome
   * + ended_reason on session end (before store.delete()). Optional so
   * pre-existing test fixtures continue to work without DI'ing a stub.
   */
  voiceSessionRepo?: VoiceSessionRepository;
  /**
   * B1 — Per-tenant voice persona. When present, consulted during
   * `startSession` to personalize the greeting. Failures fall back to
   * the default text — voice service is never blocked by a settings
   * lookup failure.
   */
  voicePersonaResolver?: VoicePersonaResolver;
  /**
   * §P2-3 — Resolves the vertical-specific repair templates for a tenant.
   * When present, the templates are threaded into the FSM context at
   * session creation so low-confidence reprompts use vertical-aware copy.
   * When absent, the FSM falls back to the generic "say that again" prompt.
   */
  repairTemplatesResolver?: (tenantId: string) => Promise<ReadonlyArray<RepairTemplate>>;
  /**
   * P8-015 — Dropped-call SMS recovery scheduler. When wired, the adapter
   * fires it at the terminal hook (after `session.terminalOutcome` is set)
   * for outcomes in {dropped, failed} so a caller who hung up before booking
   * gets a brand-voice recovery SMS ~60s later. The scheduler itself
   * persists a durable row (queue), so the call-teardown path stays fast and
   * a restart never loses the pending recovery. Optional: absent in fixtures
   * that don't exercise recovery. `schedule()` is swallow-on-error, so the
   * adapter never has to guard the call.
   */
  droppedCallScheduler?: DroppedCallScheduler;
  /**
   * P8-015 — Resolves the caller's E.164 from a terminal session so recovery
   * can be addressed. Optional: when absent (or when it returns undefined),
   * recovery is silently skipped — there is no one to text.
   */
  callerPhoneResolver?: (session: VoiceSession) => string | undefined;
  /**
   * Voice-parity — resolves the tenant's opt-in language stack
   * (`tenant_settings.supported_languages`). When wired, the result is stored
   * on the session and the first-utterance language gate only switches a call
   * to Spanish if 'es' is in the stack. Optional: when absent, the session's
   * `supportedLanguages` stays undefined and Spanish detection is permissive
   * (legacy behavior), so existing fixtures keep working unchanged.
   */
  supportedLanguagesResolver?: (tenantId: string) => Promise<Language[] | undefined>;
  extendedIntentsEnabled?: (tenantId: string) => Promise<boolean>;
  /**
   * Read-only owner/operator lookups bypass the mutation confirmation FSM.
   * The authenticated in-app route supplies a tenant-scoped resolver.
   */
  ownerLookupResolver?: (
    tenantId: string,
    sessionId: string,
    intentType: string,
  ) => Promise<string | undefined>;
  /**
   * QA-2026-07-26 — catalog item repository used to ground voice-drafted
   * estimate line items (entities.lineItemDescriptions on a draft_estimate
   * intent) against the tenant's real price book via the SAME
   * `groundLineItemPricing` pass the non-voice draft_estimate task
   * (ai/tasks/estimate-task.ts) already runs. Optional: when absent, the
   * grounding call's `loadActiveCatalog` is `null`, which
   * `groundLineItemPricing` treats identically to "catalog read failed" —
   * every drafted line is stamped `uncatalogued` / `requiresReview: true`
   * rather than silently keeping an ungrounded guess.
   */
  catalogRepo?: CatalogItemRepository;
  /**
   * QA-2026-07-26 — tenant-scoped customer repository, consulted at
   * `startSession` when the caller supplies a `callerPhone`: exactly one
   * `findByPhoneNormalized` match resolves the session's caller identity the
   * SAME way telephony/text-mode sessions do (see `TextModeDriver.startSession`
   * and `TwilioGatherAdapter` caller-ID resolution) — via a `caller_known`
   * FSM dispatch instead of `operator_session`. Optional: when absent (or when
   * `callerPhone` is omitted, or the match count isn't exactly 1), the adapter
   * falls back to the existing `operator_session` path unchanged. Never
   * guesses — 0 or 2+ matches are left unresolved for the operator to specify.
   */
  customerRepo?: CustomerRepository;
  /**
   * #883/#914 — negotiation guardrail enrichment, shared with the telephony
   * leg (ai/voice-turn/create-voice-turn-processor.ts). Optional and
   * best-effort: when either is absent, `buildAndPersistNegotiationProposal`
   * falls back to the V1 bare-callback content (see
   * proposals/guardrails/voice-protection-proposal.ts).
   */
  customerNegotiationContextProvider?: CustomerNegotiationContextProvider;
  negotiationQuoteResolver?: CurrentQuoteResolver;
  /**
   * A46 — `respond_to_review`'s only correct drafting path, shared with the
   * telephony leg. See the identically-named field's doc comment in
   * ai/voice-turn/create-voice-turn-processor.ts for the full history.
   * Optional: when absent, the branch below degrades honestly to a
   * `voice_clarification` instead of falling through to the generic
   * payload-promotion path, which cannot draft `publicResponse`.
   */
  respondToReviewTaskHandler?: Pick<TaskHandler, 'handle'>;
}

export interface StartSessionResult {
  sessionId: string;
  state: string;
  greetingAudio?: Buffer;
  greetingText?: string;
}

export interface HandleInputResult {
  state: string;
  sideEffects: SideEffect[];
  ttsAudio?: Buffer;
  ttsText?: string;
  proposalIds: string[];
  ended: boolean;
}

const DEFAULT_GREETING_INAPP = 'Hi, this is your assistant. How can I help today?';

type ClassifierFailureClass =
  | 'parse_failed'
  | 'deadline'
  | 'quota'
  | 'rate_limited'
  | 'provider';

const CLASSIFIER_FAILURE_EVENT: Record<ClassifierFailureClass, string> = {
  parse_failed: 'classifier_parse_failure',
  deadline: 'classifier_deadline_failure',
  quota: 'classifier_quota_failure',
  rate_limited: 'classifier_rate_limit_failure',
  provider: 'classifier_provider_failure',
};

const CLASSIFIER_QUOTA_CODES = new Set([
  'TENANT_CONCURRENCY_EXCEEDED',
  'TENANT_TOKEN_BUDGET_EXCEEDED',
]);

/**
 * Upstream provider throttles. Distinct from `CLASSIFIER_QUOTA_CODES` (which
 * are OUR per-tenant caps) and from `provider` (which means the AI is
 * genuinely broken): a throttle is transient and self-healing, and an operator
 * looking at the audit trail needs to be able to tell the three apart.
 * `LLM_RATE_LIMITED` is what the failover layer raises; `PROVIDER_RATE_LIMITED`
 * is the raw adapter error, which reaches here when only one attempt ran.
 */
const CLASSIFIER_RATE_LIMIT_CODES = new Set([
  'LLM_RATE_LIMITED',
  'PROVIDER_RATE_LIMITED',
]);

function classifierErrorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

/**
 * A48 fallback — `entities.brandVoiceInstruction` is populated verbatim by
 * the classifier for every `update_brand_voice` turn (see
 * ai/orchestration/intent-taxonomy-blocks.ts / intent-classifier.ts), so
 * this should not normally be reached; kept as defense-in-depth (mirrors
 * `UpdateBrandVoiceTaskHandler`'s own `context.message` fallback) rather
 * than assuming the field is always present.
 */
function lastCallerTranscriptLine(session: VoiceSession): string | undefined {
  for (let i = session.transcript.length - 1; i >= 0; i -= 1) {
    const line = session.transcript[i];
    if (line.startsWith('caller: ')) return nonEmptyString(line.slice('caller: '.length));
  }
  return undefined;
}

function classifierFailureFromError(
  error: unknown,
): { failureClass: ClassifierFailureClass; errorCode?: string } {
  const code = classifierErrorCode(error);
  if (code === 'DEADLINE_EXCEEDED') {
    return { failureClass: 'deadline', errorCode: code };
  }
  if (code && CLASSIFIER_QUOTA_CODES.has(code)) {
    return { failureClass: 'quota', errorCode: code };
  }
  // Upstream throttle — checked BEFORE the provider-failure branch so a 429
  // is never audited as "the AI is broken".
  if (code && CLASSIFIER_RATE_LIMIT_CODES.has(code)) {
    return { failureClass: 'rate_limited', errorCode: code };
  }
  // Breaker / failover exhaustion can wrap a prior abort message
  // ("Last error: Request was aborted.") — keep those as provider, not deadline.
  if (code === 'BREAKER_OPEN' || code === 'LLM_PROVIDER_UNAVAILABLE') {
    return { failureClass: 'provider', errorCode: code };
  }
  if (isDeadlineExceeded(error)) {
    return { failureClass: 'deadline', errorCode: code ?? 'DEADLINE_EXCEEDED' };
  }
  return { failureClass: 'provider' };
}

function classifierFailureAuditEffect(
  failureClass: ClassifierFailureClass,
  errorCode?: string,
): SideEffect {
  return {
    type: 'audit_log',
    payload: {
      eventType: CLASSIFIER_FAILURE_EVENT[failureClass],
      failureClass,
      ...(errorCode ? { errorCode } : {}),
    },
  };
}

export function buildInappGreeting(persona?: VoicePersona | null): string {
  if (persona?.greeting) return persona.greeting;
  if (persona?.agentName) return `Hi, I'm ${persona.agentName}. How can I help today?`;
  return DEFAULT_GREETING_INAPP;
}

/**
 * Map a classifier intent + entities into the FSM event shape.
 *
 * Always emits `intent_classified` (including unknown) so the FSM uses the
 * `low_intent_confidence` repair path. STT/empty-speech paths emit
 * `confidence_low` separately for `low_audio_confidence` copy.
 *
 * TAU_INT (0.75) is the FSM's "act on this intent" gate in
 * transitionIntentCapture — confidence below that band is reprompted.
 */
export function classifierToFsmEvent(
  intentType: string,
  confidence: number,
  entities: Record<string, unknown> | undefined,
  /**
   * The user's raw message for the classified turn. Optional so legacy
   * callers stay valid; pass it whenever it is in hand — guards that persist
   * caller words (complaint severity detection) read it off the event.
   */
  utterance?: string
): CallingAgentEvent {
  // Unknown / below-threshold intent stays on the intent_classified path so
  // the FSM fires `low_intent_confidence` repair copy — not
  // `low_audio_confidence` ("trouble hearing you"), which is reserved for
  // STT/empty-speech `confidence_low` events.
  return {
    type: 'intent_classified',
    intentType,
    entities: entities ?? {},
    confidence,
    ...(utterance ? { utterance } : {}),
  };
}

// `intentToProposalType` (this file's 25-case copy) and `summaryFor` moved to
// `proposals/voice-intent-map.ts` as `intentToProposalType` /
// `voiceProposalSummary`. The summary template was always the better of the
// two implementations and is now what the real phone path uses as well; the
// map gains the 10 cases the router carried and this copy had not (update_job,
// batch_invoice, the crew pair, the collections trio, and the taxonomy-1.2.0
// on-ramp trio), each of which previously degraded a real OPERATOR request
// into a clarification card. In-app is surface S2, so no allowlist applies —
// these now mint the proposal the operator actually asked for.

/**
 * Map FSM escalation reasons to the strict EscalationReason union the
 * escalate-to-human skill accepts.
 */
export function toEscalationReason(reason: string | undefined): EscalationReason {
  switch (reason) {
    case 'caller_requested':
    case 'low_confidence':
    case 'cost_cap_exceeded':
    case 'emergency_dispatch':
    case 'abuse_detected':
    case 'provider_failure':
    case 'max_retries_exceeded':
      return reason;
    case 'low_confidence_intent':
      return 'low_confidence';
    case 'caller_identity_unresolved':
      return 'max_retries_exceeded';
    default:
      return 'low_confidence';
  }
}

/**
 * Whole-utterance affirmations recognized when the caller answers the
 * intent_confirm readback ("...Is that right?"). Kept deterministic so the
 * confirm turn needs no LLM round-trip. Anything NOT clearly affirmative is
 * treated as a correction (safe default: re-capture rather than queue the
 * wrong proposal) — mirrors the confirm-intent skill's "ambiguous → no" rule.
 */
const AFFIRMATION_PHRASES = new Set([
  'yes', 'yeah', 'yep', 'yup', 'yea', 'sure', 'correct', 'right', 'ok', 'okay',
  'confirm', 'confirmed', 'go ahead', 'sounds good', 'that works', 'looks good',
  'do it', 'please do', 'affirmative', 'of course', 'absolutely', 'perfect',
  "that's right", 'thats right', 'that is right', 'exactly', 'yes please',
  // es
  'si', 'sí', 'claro', 'correcto', 'de acuerdo', 'está bien', 'esta bien',
  'adelante', 'perfecto', 'así es', 'asi es',
]);

/** Leading affirmative tokens ("yes, that's the one" / "sí, adelante"). */
const AFFIRMATION_LEAD_TOKENS = new Set([
  'yes', 'yeah', 'yep', 'yup', 'yea', 'sure', 'correct', 'confirm', 'confirmed',
  'ok', 'okay', 'absolutely', 'affirmative', 'si', 'sí', 'claro', 'correcto',
  'adelante', 'perfecto',
]);

/**
 * True when the caller's readback response is a clear affirmation. Default is
 * FALSE (→ correction) for anything ambiguous, so we never queue a proposal
 * off an unclear "yes".
 */
export function isAffirmation(text: string): boolean {
  const normalized = text.trim().toLowerCase().replace(/[.!?,]+$/g, '').trim();
  if (!normalized) return false;
  if (AFFIRMATION_PHRASES.has(normalized)) return true;
  const first = normalized.split(/\s+/)[0].replace(/[.!?,]+$/g, '');
  return AFFIRMATION_LEAD_TOKENS.has(first);
}

/**
 * D01 — explicit rejections of the intent_confirm readback. Only needed
 * because the confirm turn is no longer "affirmation or correction": a
 * non-affirmative answer that carries new SLOTS is now a slot-fill
 * continuation (see `confirmTurnSlotFillEvent`), so the caller needs a
 * deterministic way to say "no, that's not it" and get the pre-D01
 * correction — without paying a classifier round-trip to be told so.
 */
const NEGATION_PHRASES = new Set([
  'no', 'nope', 'nah', 'negative', 'wrong', 'incorrect', 'cancel', 'cancel that',
  "that's wrong", 'thats wrong', 'that is wrong', "that's not right",
  'thats not right', 'that is not right', "that's not it", 'thats not it',
  'not right', 'not correct', 'start over', 'never mind', 'nevermind',
  // es
  'no gracias', 'incorrecto', 'no es correcto', 'cancelar', 'olvídalo', 'olvidalo',
]);

/** Leading negative tokens ("no, that's the wrong customer"). */
const NEGATION_LEAD_TOKENS = new Set(['no', 'nope', 'nah', 'negative', 'incorrecto']);

/** True when the caller's readback response is a clear rejection. */
export function isNegation(text: string): boolean {
  const normalized = text.trim().toLowerCase().replace(/[.!?,]+$/g, '').trim();
  if (!normalized) return false;
  if (NEGATION_PHRASES.has(normalized)) return true;
  const first = normalized.split(/\s+/)[0].replace(/[.!?,]+$/g, '');
  return NEGATION_LEAD_TOKENS.has(first);
}

/**
 * D01 — the intents whose `intent_confirm` readback may be answered with
 * MORE DETAIL rather than a yes/no. Deliberately just the creation family:
 * these are the requests a caller builds up across turns ("book a visit" →
 * "Jordan Lee, 480-555-0199, next Tuesday" → "furnace diagnostic at their
 * home"), and they are the family for which "no such record yet" is the
 * NORMAL outcome (see `requiresExistingEntity` / toResolutionEvent). Every
 * other intent keeps the pre-D01 behavior byte-for-byte: anything that is
 * not a clear affirmation is a correction.
 */
const SLOT_FILL_INTENTS: ReadonlySet<string> = new Set([
  'create_appointment',
  'create_booking',
  'create_job',
  'create_customer',
  'draft_estimate',
]);

export class InAppVoiceAdapter {
  constructor(private readonly deps: InAppAdapterDeps) {}

  /**
   * Lazily-constructed PgEntityResolver when `pool` is wired but no explicit
   * resolver was injected. Cached so we don't allocate one per turn.
   */
  private pgResolver?: EntityResolver;

  /**
   * Resolve the entity resolver to use: an explicitly injected one (tests),
   * else a PgEntityResolver built from the pool (production), else undefined
   * (dev/no-DB — resolution is skipped, never guessed).
   */
  private getEntityResolver(): EntityResolver | undefined {
    if (this.deps.entityResolver) return this.deps.entityResolver;
    if (this.pgResolver) return this.pgResolver;
    if (this.deps.pool) {
      this.pgResolver = new PgEntityResolver(this.deps.pool);
      return this.pgResolver;
    }
    return undefined;
  }

  /**
   * U4 — tenant timezone for spoken-datetime resolution, memoized per
   * SESSION (settings read once per session, the E1-script convention).
   * Keyed by the live session OBJECT via WeakMap — the same shape as
   * create-voice-turn-processor.ts — so entries are garbage-collected
   * with the session. This replaces a string-keyed Map whose
   * `${tenantId}:${sessionId ?? ''}` key pinned ONE tenant-lifetime value
   * whenever a session id was absent, and whose >500 clear() dumped every
   * LIVE session's memo (review finding). `undefined` outcomes are still
   * memoized: the session then refuses to resolve spoken times (never a
   * silent UTC/default-zone parse) and the NEXT session retries the read.
   * A rare session-less caller gets an unmemoized read — correct, just
   * uncached.
   */
  private readonly sessionTimezones = new WeakMap<
    VoiceSession,
    Promise<string | undefined>
  >();

  private resolveSessionTimezone(
    tenantId: string,
    session: VoiceSession | undefined,
  ): Promise<string | undefined> {
    const cached = session ? this.sessionTimezones.get(session) : undefined;
    if (cached) return cached;
    const pending = (async () => {
      if (!this.deps.settingsRepo) return undefined;
      try {
        const settings = await this.deps.settingsRepo.findByTenant(tenantId);
        const tz = settings?.timezone;
        return typeof tz === 'string' && isRuntimeTimezone(tz.trim()) ? tz.trim() : undefined;
      } catch {
        return undefined;
      }
    })();
    if (session) this.sessionTimezones.set(session, pending);
    return pending;
  }

  /**
   * Resolve scheduling entity references, translating the resolver outcome
   * into the FSM event the transition table expects. Resolution failure is
   * non-fatal: we fall back to a best-effort "resolved with no refs" (the
   * proposal then surfaces for operator review) rather than escalating on an
   * infra hiccup — but we NEVER guess an id.
   */
  private async resolveEntities(
    tenantId: string,
    intent: string,
    entities: Record<string, unknown>,
    // SCH-03 — the FSM's sticky context.jobId (set whenever a job was
    // resolved on any earlier turn this call). Only consulted by
    // resolveSchedulingEntities for cancel/reschedule/reassign_appointment
    // when the appointment reference isn't a date phrase.
    stickyJobId?: string,
    // U4 — memo key for the once-per-session tenant-zone read above (the
    // live session OBJECT, so the WeakMap entry dies with the session).
    session?: VoiceSession,
  ): Promise<SchedulingEntityResolution> {
    const resolver = this.getEntityResolver();
    try {
      const timezone = await this.resolveSessionTimezone(tenantId, session);
      return await resolveSchedulingEntities(
        resolver,
        tenantId,
        intent,
        entities,
        stickyJobId,
        timezone ? { timezone } : undefined,
      );
    } catch {
      return { status: 'resolved', refs: {} };
    }
  }

  /**
   * Map a resolution outcome to the FSM event. The disambiguation TTS expects
   * candidates shaped `{ id, name, score }`, so the resolver's EntityCandidate
   * `label` is mapped to `name`.
   */
  private async toResolutionEvent(
    tenantId: string,
    intent: string,
    resolution: SchedulingEntityResolution,
  ): Promise<CallingAgentEvent> {
    if (resolution.status === 'ambiguous' && resolution.ambiguous) {
      const refKey = refKeyForEntityKind(resolution.ambiguous.entityKind);
      if (!refKey) {
        return { type: 'entity_resolved', refs: resolution.refs };
      }
      const candidates = await this.enrichCandidatesForDisambiguation(
        tenantId,
        resolution.ambiguous.entityKind,
        resolution.ambiguous.candidates,
      );
      return {
        type: 'entity_ambiguous',
        candidates,
        entityKind: resolution.ambiguous.entityKind,
        reference: resolution.ambiguous.reference,
        refKey,
        partialRefs: resolution.refs,
      };
    }
    // Middle confidence band: exactly one candidate, but not confident
    // enough to act on silently. Ask the caller to confirm it (entity_confirm)
    // rather than either guessing (resolved) or giving up (not_found).
    if (resolution.status === 'low_confidence' && resolution.lowConfidence) {
      const refKey = refKeyForEntityKind(resolution.lowConfidence.entityKind);
      if (!refKey) {
        return { type: 'entity_resolved', refs: resolution.refs };
      }
      return {
        type: 'entity_confirm_candidate',
        entityKind: resolution.lowConfidence.entityKind,
        candidate: resolution.lowConfidence.candidate,
        reference: resolution.lowConfidence.reference,
        refKey,
        partialRefs: resolution.refs,
      };
    }
    // No candidate reached even the lower confidence band. For intents that
    // operate on a record that must ALREADY exist (send_estimate,
    // record_payment, cancel_appointment, …) the request cannot proceed, so
    // escalate rather than silently falling through to entity_resolved with
    // no refs — that previously masked a not_found as a "success" (46a954e1).
    if (resolution.status === 'not_found' && requiresExistingEntity(intent)) {
      return { type: 'entity_not_found' };
    }
    // Everything else — including CREATION intents (create_appointment,
    // create_job, create_customer, draft_estimate), where "no such record"
    // is the normal, expected outcome — proceeds to intent_confirm with the
    // partial refs. The proposal surfaces pendingReference for operator
    // review instead of escalating to on-call (matches voice-action-router
    // policy), and create_appointment auto-opens a job from jobTitle at
    // execution time (95a260cd).
    return { type: 'entity_resolved', refs: resolution.refs };
  }

  /**
   * Attach service-location addresses to customer candidates so address-style
   * follow-ups ("104 Cedar") can be matched deterministically.
   */
  private async enrichCandidatesForDisambiguation(
    tenantId: string,
    entityKind: EntityCandidate['kind'],
    candidates: EntityCandidate[],
  ): Promise<Array<{ id: string; name: string; score: number; hint?: string }>> {
    if (entityKind !== 'customer' || !this.deps.pool || candidates.length === 0) {
      return candidates.map((candidate) => ({
        id: candidate.id,
        name: candidate.label,
        score: candidate.score,
        hint: candidate.hint,
      }));
    }

    const customerIds = candidates.map((candidate) => candidate.id);
    const rows = await withTenantConnection(this.deps.pool, tenantId, (client) =>
      client
        .query<{ customer_id: string; street1: string; city: string }>(
          `SELECT customer_id, street1, city
             FROM service_locations
            WHERE tenant_id = $1
              AND customer_id = ANY($2::uuid[])
              AND is_archived = false`,
          [tenantId, customerIds],
        )
        .then((result) => result.rows),
    );
    const addressByCustomer = new Map(
      rows.map((row) => [row.customer_id, `${row.street1}, ${row.city}`]),
    );

    return candidates.map((candidate) => {
      const address = addressByCustomer.get(candidate.id);
      const hintParts = [candidate.hint, address].filter(
        (part): part is string => typeof part === 'string' && part.length > 0,
      );
      return {
        id: candidate.id,
        name: candidate.label,
        score: candidate.score,
        hint: hintParts.length > 0 ? hintParts.join(' · ') : undefined,
      };
    });
  }

  private buildDisambiguationRetryEvent(
    pending: NonNullable<CallingAgentContext['pendingEntityAmbiguity']>,
  ): CallingAgentEvent {
    return {
      type: 'entity_ambiguous',
      candidates: pending.candidates,
      entityKind: pending.entityKind,
      reference: pending.reference,
      refKey: pending.refKey,
      partialRefs: pending.partialRefs,
      retry: true,
    };
  }

  /**
   * Rehydrate pending ambiguity from the parked intent + entities when the FSM
   * is still in entity_resolution (e.g. session context dropped between HTTP
   * turns). Never guesses — re-runs the same resolver lookups as turn 1.
   */
  private async resolvePendingForDisambiguation(
    tenantId: string,
    context: CallingAgentContext,
    session?: VoiceSession,
  ): Promise<PendingEntityAmbiguity | undefined> {
    if (context.pendingEntityAmbiguity) {
      return context.pendingEntityAmbiguity;
    }
    const intent = context.currentIntent;
    const entities = context.extractedEntities;
    if (!intent || !entities || typeof entities !== 'object') {
      return undefined;
    }

    const resolution = await this.resolveEntities(
      tenantId,
      intent,
      entities as Record<string, unknown>,
      context.jobId,
      session,
    );
    if (resolution.status !== 'ambiguous' || !resolution.ambiguous) {
      return undefined;
    }

    const refKey = refKeyForEntityKind(resolution.ambiguous.entityKind);
    if (!refKey) return undefined;

    const candidates = await this.enrichCandidatesForDisambiguation(
      tenantId,
      resolution.ambiguous.entityKind,
      resolution.ambiguous.candidates,
    );

    return {
      entityKind: resolution.ambiguous.entityKind,
      reference: resolution.ambiguous.reference,
      refKey,
      candidates,
      partialRefs: resolution.refs,
      attemptCount: 0,
    };
  }

  /**
   * D01 — decide what a non-yes/no answer to the `intent_confirm` readback
   * MEANS, given the re-classification of that turn.
   *
   * Slot-fill (`intent_details_supplied`) when the turn produced at least
   * one usable slot AND does not name a DIFFERENT actionable request:
   *   - `unknown` — the classifier could not name an intent for a bare
   *     detail fragment ("Jordan Lee, 480-555-0199, next Tuesday morning
   *     works"); that is exactly what a slot-only turn looks like;
   *   - the SAME intent we are confirming;
   *   - a sibling of the same creation family — while confirming a booking,
   *     "Jordan Lee, 480-555-0199" reads to the classifier as
   *     `create_customer` and "furnace diagnostic at their home" as
   *     `create_job`, but both are describing THIS booking's customer and
   *     work, not asking for a second proposal.
   *
   * Everything else — no new slots at all, or a clearly different intent
   * (`send_invoice`, `cancel_appointment`, a lookup) — stays `correction`,
   * the pre-D01 behavior: re-capture rather than fold a foreign request's
   * entities into the pending one.
   */
  private confirmTurnSlotFillEvent(
    session: VoiceSession,
    classification: Awaited<ReturnType<typeof classifyIntent>>,
    text: string,
  ): CallingAgentEvent {
    const pendingIntent = session.machine.currentContext.currentIntent;
    const entities = (classification.extractedEntities ?? {}) as Record<string, unknown>;
    const newSlots = Object.fromEntries(
      Object.entries(entities).filter(
        ([, value]) => value !== undefined && value !== null && value !== '',
      ),
    );
    const sameRequest =
      classification.intentType === 'unknown' ||
      classification.intentType === pendingIntent ||
      (SLOT_FILL_INTENTS.has(classification.intentType) &&
        SLOT_FILL_INTENTS.has(pendingIntent ?? ''));
    if (!sameRequest || Object.keys(newSlots).length === 0) {
      return { type: 'correction', newTranscript: text };
    }
    return { type: 'intent_details_supplied', entities: newSlots };
  }

  private async classifyIntentWithRetry(
    text: string,
    context: Parameters<typeof classifyIntent>[1],
  ): Promise<Awaited<ReturnType<typeof classifyIntent>>> {
    try {
      return await classifyIntent(text, context, this.deps.gateway);
    } catch (error) {
      const failure = classifierFailureFromError(error);
      const code = failure.errorCode;
      // Quota / rate-limit / breaker-open / failover exhaustion: retrying
      // burns load and cannot succeed until the cell recovers (FM-06).
      //
      // `rate_limited` belongs in this set for the same reason: the gateway
      // has ALREADY waited out any retry-after that fit inside the deadline
      // (see gateway/retry.ts planRateLimitWait). A second full-budget attempt
      // from here would just re-queue against the same exhausted quota and
      // hold another per-tenant concurrency lease while doing it — the exact
      // pile-up that tripped `Per-tenant concurrency cap exceeded`.
      if (
        failure.failureClass === 'quota' ||
        failure.failureClass === 'rate_limited' ||
        code === 'BREAKER_OPEN' ||
        code === 'LLM_PROVIDER_UNAVAILABLE'
      ) {
        throw error;
      }
      // One fresh-budget retry for transient provider/deadline aborts.
      return classifyIntent(text, context, this.deps.gateway);
    }
  }

  /**
   * ADAPTER ACTS — the intents a live surface must answer ITSELF, before the
   * turn reaches the FSM and the proposal path.
   *
   * `proposals/voice-intent-map.ts` already states the invariant this
   * implements. `confirm`, `language_switch` and `operator_request` are
   * omitted from that map on purpose, and its doc comment says why: they are
   * "real, understood intents that simply have no recorded-memo action ... On
   * a live call all three DO have a real target (the in-progress dialogue,
   * the live call's language, the on-call human), so **every live surface
   * must intercept them BEFORE reaching this map's lookup** — an intent that
   * falls through here silently becomes a clarification card." The same holds
   * for `approve_proposal` / `reject_proposal` / `edit_proposal`, which both
   * telephony adapters route out-of-FSM to the RV-071/RV-225 owner dialogue.
   *
   * In-app was the one live surface with no branch, and the fall-through was
   * precisely the failure that comment predicts — twice over. Live evidence
   * (sweep 2026-08-29, rows C03/C05/C07): "Approve it", "Change the amount to
   * 300" and "Can we talk in Spanish?" were each classified correctly, read
   * back by the FSM, and the operator's confirming "yes" then minted a
   * `voice_clarification` card, after which the closing state said "Great,
   * I've got that taken care of. You'll receive a confirmation shortly." No
   * proposal was approved, no amount was changed, no language was switched.
   * A card nobody asked for, plus a sentence claiming work that never
   * happened — the exact class of lie `assistant-honesty-guard.ts` exists to
   * make impossible on the chat surface.
   *
   * Returns the side effects to speak when this turn is an adapter act, or
   * `undefined` to dispatch into the FSM as normal. Never throws, never mints
   * a proposal, and never advances the FSM — the session stays where it is
   * and the next turn is captured normally, the same shape as the read-only
   * `ownerLookupText` branch below.
   */
  private handleAdapterAct(
    session: VoiceSession,
    intentType: string,
    utterance: string,
  ): SideEffect[] | undefined {
    if (isVoiceApprovalIntent(intentType) || isVoiceEditIntent(intentType)) {
      return this.refuseVoiceApproval(session, intentType);
    }
    if (intentType === 'language_switch') {
      return this.switchSessionLanguage(session, utterance);
    }
    return undefined;
  }

  /**
   * RV-071 / RV-225 — approve / reject / edit by voice is refused on the
   * in-app surface, and the operator is pointed at the card.
   *
   * WHY A REFUSAL RATHER THAN THE SPOKEN DIALOGUE. D-025 ratified owner voice
   * approval, but scoped it to "a human owner on a transport-identified owner
   * line": RV-070 caller-ID is what authorises it, and the money-class spoken
   * challenge is what makes approving something irreversible over a phone
   * safe. Neither exists in-app, and neither is needed — the operator is
   * already authenticated in an app that is showing the proposal card with a
   * tap-to-approve button. Porting the PIN dialogue here would add a static
   * secret, re-spoken into a stored transcript on every approval (the
   * accumulating exposure D-025's own constraints flag under #850), to buy a
   * capability the screen already provides one tap away.
   *
   * The refusal is deliberately the SAME sentence the assistant-chat route
   * speaks for a voice-mode turn (UB-B3, `VOICE_APPROVAL_REFUSAL`) — one
   * posture across both in-app voice seams, and one string so they cannot
   * drift.
   *
   * NOT gated on `ownerSession`. That flag CAN be true here (`startSession`
   * sets it for `role === 'owner'`), and gating on it would read as "we would
   * have approved it if you were the owner" — which is not the rule. The rule
   * is about the SURFACE: RV-071's threat model is the caller line, so the
   * audit reason is `inapp_surface`, distinct from the processor's
   * `not_owner_session` / `not_configured`. An operator's denied attempt is
   * still recorded, which is what D-028 means when it lists these intents as
   * gates "which audit denied attempts".
   */
  private refuseVoiceApproval(session: VoiceSession, intentType: string): SideEffect[] {
    return [
      {
        type: 'audit_log',
        payload: {
          eventType: 'agent.calling.voice_approval_denied',
          reason: 'inapp_surface',
          intentType,
          sessionId: session.id,
          tenantId: session.tenantId,
          ts: Date.now(),
        },
      },
      { type: 'tts_play', payload: { text: VOICE_APPROVAL_REFUSAL } },
    ];
  }

  /**
   * #846 — mid-session language switch on the in-app transport.
   *
   * This one WORKS rather than refusing, because the in-app session really
   * does render in the session language: every spoken line goes through
   * `renderTtsText(..., session.language)`, which localizes the FSM's
   * template keys and its fixed sentences via `SENTENCE_CATALOG_ES`. The
   * surface already flips to Spanish on its own when the operator's words are
   * Spanish (the sticky `detectLanguage` gate in `_handleInputLocked`), so
   * honoring an EXPLICIT request is not new capability — it is the same
   * capability, reachable by asking. Refusing here would have been the
   * dishonest answer: "I can't" is false when the very next Spanish utterance
   * would have switched anyway.
   *
   * Policy mirrors `TwilioGatherAdapter.handleLanguageSwitchGather` — same
   * `supported_languages` opt-in gate, same per-call flap cap, same three
   * copy lines — with two deliberate differences:
   *
   *  1. No TTS voice re-resolution. Gather re-resolves `session.ttsVoice`
   *     because `<Say voice>` would otherwise read Spanish in an English
   *     Polly voice; the in-app provider is called as
   *     `synthesize({ text, tenantId })` with no per-language voice, so there
   *     is nothing to re-resolve. Adding a field the provider ignores would
   *     be cargo cult.
   *  2. The unresolved-stack default is PERMISSIVE (`['en', 'es']`), where
   *     Gather passes `null` (English-only). That is not drift — it is this
   *     surface's own existing rule: the sticky first-utterance gate a few
   *     lines into `_handleInputLocked` already uses
   *     `session.supportedLanguages ?? ['en', 'es']`. Passing `null` here
   *     would produce an incoherent surface, where a Spanish SENTENCE flips
   *     the session but "can we talk in Spanish?" is refused.
   */
  private switchSessionLanguage(session: VoiceSession, utterance: string): SideEffect[] {
    const current: SessionLanguage = session.language === 'es' ? 'es' : 'en';
    // The requested language when the heuristic can name it, else the other
    // half of the en/es pair — the classifier has already said this turn IS a
    // switch request, so "not English" means Spanish. Same fallback as both
    // telephony transports.
    const target = detectLanguageSwitchIntent(utterance) ?? (current === 'es' ? 'en' : 'es');

    if (target === current) {
      // Already in the requested language — acknowledge without spending a
      // switch from the flap budget.
      return [{ type: 'tts_play', payload: { text: LANGUAGE_SWITCH_ACK[current] } }];
    }
    if (!isLanguageSupported(target, session.supportedLanguages ?? ['en', 'es'])) {
      return [{ type: 'tts_play', payload: { text: LANGUAGE_UNSUPPORTED_LINE[current] } }];
    }
    const switchCount = session.languageSwitchCount ?? 0;
    if (switchCount >= MAX_LANGUAGE_SWITCHES_PER_CALL) {
      return [{ type: 'tts_play', payload: { text: LANGUAGE_SWITCH_CAP_LINE[current] } }];
    }

    session.language = target;
    session.languageSwitchCount = switchCount + 1;
    session.events.emit(
      'voice-event',
      languageSwitchedEvent({
        from: current,
        to: target,
        trigger: 'classified_intent',
        switchCount: session.languageSwitchCount,
      }),
    );
    // Acknowledge in the language being switched TO — the operator just told
    // us that's the one they want. Same copy as both telephony transports.
    return [{ type: 'tts_play', payload: { text: LANGUAGE_SWITCH_ACK[target] } }];
  }

  /**
   * Open a new in-app session. Drives the FSM through the
   * idle → greeting → identifying transitions and synthesizes the
   * greeting audio if a TTS provider is wired.
   *
   * Recording disclosure is intentionally skipped for the inapp channel
   * (consent is captured at account creation; see disclose_recording).
   */
  async startSession(
    tenantId: string,
    userId: string,
    conversationId?: string,
    role?: string,
    callerPhone?: string,
  ): Promise<StartSessionResult> {
    const repairTemplates = this.deps.repairTemplatesResolver
      ? await this.deps.repairTemplatesResolver(tenantId).catch(() => [])
      : [];
    const ownerSession = role === 'owner';
    const extendedIntents =
      ownerSession && this.deps.extendedIntentsEnabled
        ? await this.deps.extendedIntentsEnabled(tenantId).catch(() => false)
        : false;
    // #914 — customer protection (complaint/negotiation) must be "always
    // on" for inapp the same way twilio-adapter.ts hardcodes it for
    // telephony (`const customerProtectionIntents = true`). Before this fix
    // it was never set here, so `classifyIntent`'s `protectionOn` gate
    // (customerProtectionIntents === true || extendedIntents === true) —
    // see intent-classifier.ts — only opened for an OWNER session on a
    // tenant with extendedIntents enabled, and the CUSTOMER_PROTECTION_
    // PROMPT_SECTION was omitted for every other inapp caller. D-028 pins
    // 'inapp' to the 'operator' classifier profile (all 78 intents already
    // ACCEPTED, complaint/negotiation included) regardless of actor role —
    // this was purely a missing PROMPT section, not an accept-gate issue,
    // so a customer or owner's "I'm really unhappy" / "knock $50 off"
    // silently missed the dedicated _complaint/_negotiation handlers and
    // fell through to the generic low-confidence reprompt. Safe to set
    // unconditionally: `protectionOn` also requires `profile !==
    // 'field_tech'`, and `classifierProfileForSession` never returns
    // 'field_tech' for the trusted 'inapp' channel (only 'operator' /
    // 'owner_line'), so this cannot leak the section into a phone-actor
    // technician's taxonomy.
    const session = this.deps.store.create(tenantId, 'inapp', {
      ...(repairTemplates.length > 0 ? { repairTemplates } : {}),
      ...(ownerSession ? { ownerSession: true } : {}),
      ...(extendedIntents ? { extendedIntents: true } : {}),
      customerProtectionIntents: true,
    });
    const convId = conversationId ?? session.id;

    // Voice-parity — resolve the tenant's opt-in language stack so the
    // first-utterance gate (below in handleInput) can honor it. Best-effort:
    // a resolver failure leaves the stack undefined (permissive legacy
    // behavior) rather than blocking the call.
    if (this.deps.supportedLanguagesResolver) {
      const stack = await this.deps
        .supportedLanguagesResolver(tenantId)
        .catch(() => undefined);
      if (stack && stack.length > 0) session.supportedLanguages = stack;
    }

    // B2: persist a voice_sessions row at session start. Fire-and-forget
    // so a transient repo error never blocks the call.
    if (this.deps.voiceSessionRepo) {
      void this.deps.voiceSessionRepo
        .create({
          id: session.id,
          tenantId,
          channel: 'inapp_voice',
          state: session.machine.currentState,
        })
        .catch(() => {
          /* swallow — outcome stamping is best-effort */
        });
    }

    // Drive: idle → greeting → identifying. We treat the in-app caller
    // as already identified (they're authenticated via the API client),
    // so we skip the ask_caller branch.
    const startEffects = session.machine.dispatch({
      type: 'session_started',
      userId,
      tenantId,
      conversationId: convId,
    });
    await this.executeSideEffects(session, startEffects);

    const greetedEffects = session.machine.dispatch({ type: 'greeted_ok' });
    await this.executeSideEffects(session, greetedEffects);

    // QA-2026-07-26 — when the caller supplies a phone number at session
    // start (e.g. the operator is on a call with a customer and starts the
    // assistant with that number in hand) and it matches EXACTLY ONE
    // existing tenant customer, resolve it now via the same
    // findByPhoneNormalized path telephony/text-mode sessions use for
    // caller-ID identification (see TextModeDriver.startSession). This is
    // NOT the operator-as-customerId antipattern the comment below warns
    // about — it's a real, resolver-matched CRM customer — so a later
    // generic reference like "our customer" (GENERIC_CUSTOMER_REFS in
    // entity-resolution.ts skips ANY name-based lookup for these phrases)
    // still attaches to the right customer via the transitionIntentConfirm
    // entities bridge. 0 or 2+ matches are left unresolved — never guessed.
    let resolvedCustomerId: string | undefined;
    if (callerPhone && this.deps.customerRepo?.findByPhoneNormalized) {
      try {
        const matches = await this.deps.customerRepo.findByPhoneNormalized(
          tenantId,
          normalizePhone(callerPhone),
        );
        if (matches.length === 1) {
          resolvedCustomerId = matches[0].id;
        }
      } catch {
        resolvedCustomerId = undefined;
      }
    }

    if (resolvedCustomerId) {
      session.callerPhone = callerPhone;
      session.customerId = resolvedCustomerId;
      const callerKnownEffects = session.machine.dispatch({
        type: 'caller_known',
        customerId: resolvedCustomerId,
      });
      await this.executeSideEffects(session, callerKnownEffects);
    } else {
      // An authenticated operator is the proposal actor, not a CRM caller.
      // Treating their Clerk user id as customerId poisoned downstream entity
      // resolution and caller-plan lookups for every in-app session.
      const operatorSessionEffects = session.machine.dispatch({ type: 'operator_session' });
      await this.executeSideEffects(session, operatorSessionEffects);
    }

    // B1 — resolve per-tenant voice persona (best-effort).
    let persona: VoicePersona | null | undefined;
    if (this.deps.voicePersonaResolver) {
      try {
        persona = await this.deps.voicePersonaResolver(tenantId);
      } catch {
        persona = undefined;
      }
    }
    const greetingText = buildInappGreeting(persona);

    session.transcript.push(`agent: ${greetingText}`);

    let greetingAudio: Buffer | undefined;
    if (this.deps.ttsProvider) {
      try {
        const synth = await this.deps.ttsProvider.synthesize({ text: greetingText, tenantId });
        greetingAudio = synth.audio;
      } catch {
        // TTS is best-effort: callers always get the greeting text back.
      }
    }

    const result: StartSessionResult = {
      sessionId: session.id,
      state: session.machine.currentState,
      greetingText,
    };
    if (greetingAudio) result.greetingAudio = greetingAudio;
    return result;
  }

  async handleInput(sessionId: string, text: string): Promise<HandleInputResult> {
    return this.deps.store.withSessionLock(sessionId, () => this._handleInputLocked(sessionId, text));
  }

  private async _handleInputLocked(sessionId: string, text: string): Promise<HandleInputResult> {
    const session = this.deps.store.get(sessionId);
    if (!session) {
      throw new Error(`voice session not found: ${sessionId}`);
    }
    if (session.ended) {
      throw new Error(`voice session already ended: ${sessionId}`);
    }

    session.transcript.push(`caller: ${text}`);
    // VOX-02: sticky language detection from the caller's own words.
    // Voice-parity — only switch to Spanish when the tenant opted into 'es'
    // (session.supportedLanguages). When the stack is unresolved (undefined),
    // treat it as permissive so legacy sessions keep auto-detecting Spanish.
    if (
      detectLanguage(text) === 'es' &&
      isLanguageSupported('es', session.supportedLanguages ?? ['en', 'es'])
    ) {
      session.language = 'es';
    } else if (!session.language) {
      session.language = 'en';
    }

    // Decide the primary FSM event for this turn:
    //  A) intent_confirm — yes/no readback answer (no classifier).
    //  A2) entity_confirm — yes/no middle-confidence-candidate answer (no classifier).
    //  B) entity_resolution — disambiguation follow-up (no classifier).
    //  C) everything else — classify the utterance as an intent.
    const stateBeforeTurn: string = session.machine.currentState;
    let fsmEvent: CallingAgentEvent;
    let classifierFailureEffect: SideEffect | undefined;
    let ownerLookupText: string | undefined;
    /**
     * Set when this turn is an adapter act (see `handleAdapterAct`) — the
     * approve/reject/edit refusal or the language switch. Non-undefined means
     * the FSM is NOT dispatched for this turn.
     */
    let adapterActEffects: SideEffect[] | undefined;

    /**
     * D01 — a confirm turn that is neither a clear "yes" nor a clear "no",
     * for an intent whose readback may legitimately be answered with more
     * detail. It falls through to the classifier below (branch C) purely to
     * EXTRACT SLOTS; `confirmTurnSlotFillEvent` then decides whether the
     * caller is still describing the same request (merge + re-resolve) or
     * has moved on (correction, exactly as before this fix).
     */
    const confirmSlotFillTurn =
      stateBeforeTurn === 'intent_confirm' &&
      !isAffirmation(text) &&
      !isNegation(text) &&
      SLOT_FILL_INTENTS.has(session.machine.currentContext.currentIntent ?? '');

    if (stateBeforeTurn === 'intent_confirm' && !confirmSlotFillTurn) {
      fsmEvent = isAffirmation(text)
        ? { type: 'confirmed' }
        : { type: 'correction', newTranscript: text };
    } else if (stateBeforeTurn === 'entity_confirm') {
      fsmEvent = isAffirmation(text)
        ? { type: 'entity_confirm_affirmed' }
        : { type: 'entity_confirm_declined' };
    } else if (stateBeforeTurn === 'entity_resolution') {
      const pending = await this.resolvePendingForDisambiguation(
        session.tenantId,
        session.machine.currentContext,
        session,
      );
      if (!pending) {
        fsmEvent = { type: 'correction', newTranscript: text };
      } else {
        const match = await resolveDisambiguationFollowUp(
          this.getEntityResolver(),
          session.tenantId,
          text,
          pending,
        );
        if (match.status === 'resolved') {
          fsmEvent = {
            type: 'entity_resolved',
            refs: {
              ...pending.partialRefs,
              [pending.refKey]: match.candidateId,
            },
          };
        } else if (pending.attemptCount >= MAX_DISAMBIGUATION_ATTEMPTS) {
          fsmEvent = { type: 'entity_resolved', refs: pending.partialRefs };
        } else {
          fsmEvent = this.buildDisambiguationRetryEvent(pending);
        }
      }
    } else {
      // §3B + §3D: vertical + intake-question prompt section.
      // §3C: caller-plan prompt section (only when caller is identified).
      // Both best-effort: a resolver that throws or returns undefined
      // silently degrades to base-prompt classification rather than
      // failing the turn (callers don't lose voice service over a
      // contextual lookup hiccup).
      let verticalPromptSection: string | undefined;
      if (this.deps.verticalPromptResolver) {
        try {
          verticalPromptSection = await this.deps.verticalPromptResolver(session.tenantId);
        } catch {
          verticalPromptSection = undefined;
        }
      }
      let planPromptSection: string | undefined;
      if (this.deps.callerPlanResolver && session.customerId) {
        try {
          planPromptSection = await this.deps.callerPlanResolver(
            session.tenantId,
            session.customerId,
          );
        } catch {
          planPromptSection = undefined;
        }
      }

      // Classify intent. Failures fall back to a low-confidence event so
      // the FSM still progresses (and the operator gets a clarification
      // prompt) instead of silently dropping the turn.
      let classifierUsage: { input: number; output: number } | undefined;
      try {
        const classification = await this.classifyIntentWithRetry(
          text,
          {
            tenantId: session.tenantId,
            verticalPromptSection,
            planPromptSection,
            ...(session.machine.currentContext.ownerSession ? { ownerSession: true } : {}),
            ...(session.machine.currentContext.extendedIntents ? { extendedIntents: true } : {}),
            // #914 — forward the "always on" flag stamped at startSession()
            // into the classify call, mirroring create-voice-turn-
            // processor.ts's speechTurn (the telephony/media-streams seam)
            // so both live classify seams pass it the same way.
            ...(session.machine.currentContext.customerProtectionIntents
              ? { customerProtectionIntents: true }
              : {}),
          },
        );
        classifierUsage = classification.tokenUsage
          ? { input: classification.tokenUsage.input, output: classification.tokenUsage.output }
          : undefined;
        if (classification.unknownReason === 'parse_failed') {
          classifierFailureEffect = classifierFailureAuditEffect('parse_failed');
        }
        // VQ-003: announce the classifier outcome on the session bus so
        // the harness can grade intent-recognition independently of the
        // FSM transition that follows.
        session.events.emit(
          'voice-event',
          intentClassifiedEvent({
            intentType: classification.intentType,
            confidence: classification.confidence,
            tokenUsage: classifierUsage,
          }),
        );
        if (confirmSlotFillTurn) {
          // D01 — the caller is answering OUR readback, not opening a new
          // request. The classification is used only to tell "more detail"
          // from "different request"; adapter acts and owner lookups stay
          // out of a confirm turn exactly as they did before this fix (the
          // confirm branch never reached them).
          fsmEvent = this.confirmTurnSlotFillEvent(session, classification, text);
        } else {
          fsmEvent = classifierToFsmEvent(
            classification.intentType,
            classification.confidence,
            classification.extractedEntities as Record<string, unknown> | undefined,
            text
          );
          // Adapter acts (approve/reject/edit refusal, language switch) are
          // decided here, before the FSM sees the turn. Gated on TAU_INT for
          // the same reason the FSM gates on it: below the band we do not
          // claim to know what was asked, so the bounded reprompt path answers
          // — and it mints nothing, so the C03/C05/C07 failure cannot recur
          // through the low-confidence door either.
          if (classification.confidence >= TAU_INT) {
            adapterActEffects = this.handleAdapterAct(
              session,
              classification.intentType,
              text,
            );
          }
          if (
            !adapterActEffects &&
            classification.confidence >= TAU_INT &&
            session.machine.currentContext.ownerSession === true &&
            classification.intentType.startsWith('lookup_') &&
            this.deps.ownerLookupResolver
          ) {
            ownerLookupText = await this.deps.ownerLookupResolver(
              session.tenantId,
              session.id,
              classification.intentType,
            );
          }
        }
      } catch (error) {
        const failure = classifierFailureFromError(error);
        classifierFailureEffect = classifierFailureAuditEffect(
          failure.failureClass,
          failure.errorCode,
        );
        // Prefer intent_classified/unknown over confidence_low so repair
        // templates use low_intent_confidence (text path), not low_audio.
        // D01 — on a confirm slot-fill turn the classifier is only there to
        // extract slots; if it fails we have none, so fall back to the
        // pre-D01 confirm-turn outcome (correction) rather than speaking a
        // capture-state reprompt at someone answering a readback.
        fsmEvent = confirmSlotFillTurn
          ? { type: 'correction', newTranscript: text }
          : {
              type: 'intent_classified',
              intentType: 'unknown',
              entities: {},
              confidence: 0,
            };
      }

      // Wire the classifier's token usage into the cost tracker. If the
      // cap is exceeded, dispatch the global cost_cap_exceeded event so
      // the FSM escalates instead of finishing the turn normally.
      if (classifierUsage) {
        const cents = estimateCostCents(classifierUsage.input, classifierUsage.output);
        const capEvents = session.costTracker.recordUsage({
          inputTokens: classifierUsage.input,
          outputTokens: classifierUsage.output,
          costCents: cents,
        });
        // VQ-003: emit cost_incurred for the harness's running tally.
        // deltaCents is the just-recorded turn; totalCents is read off
        // the tracker so it stays in lockstep.
        session.events.emit(
          'voice-event',
          costIncurredEvent(cents, session.costTracker.totals.costCents),
        );
        const exceeded = capEvents.find((e) => e.type === 'cost_cap_exceeded');
        if (exceeded) {
          // Override the classifier's event — escalation supersedes the
          // intent dispatch for the current turn.
          fsmEvent = { type: 'cost_cap_exceeded' };
          // VQ-003: surface session_terminated so graders see WHY the
          // session is ending without inferring it from FSM transitions.
          session.events.emit('voice-event', sessionTerminatedEvent('cap_exceeded'));
        }
      }
    }

    const allSideEffects: SideEffect[] = [];
    if (classifierFailureEffect) {
      allSideEffects.push(classifierFailureEffect);
      await this.executeSideEffects(session, [classifierFailureEffect]);
    }

    // Dispatch the primary event (classifier-derived, or the confirm/correct
    // event from the intent_confirm branch).
    // Read-only owner lookups answer immediately and leave the FSM ready for
    // the next request. They must never enter intent_confirm, which is the
    // safety gate for proposal-producing mutations.
    // Adapter acts and read-only owner lookups both answer WITHOUT touching
    // the FSM: the session stays in intent_capture/closing, ready for the
    // next request, and no proposal can be minted for this turn.
    const effects1: SideEffect[] = ownerLookupText
      ? [{ type: 'tts_play', payload: { text: ownerLookupText } }]
      : (adapterActEffects ?? session.machine.dispatch(fsmEvent));
    allSideEffects.push(...effects1);
    const aggregate1 = await this.executeSideEffects(session, effects1);
    let lastProposalId = aggregate1.lastProposalId;

    // Path A — a freshly classified intent landed us in entity_resolution.
    // Resolve the customer/job/appointment references through the shared
    // tenant-scoped resolver (τ_ent=0.80). THREE outcomes, NEVER a silent
    // guess (CLAUDE.md invariant):
    //   resolved  → entity_resolved → intent_confirm readback. We STOP here:
    //               the caller confirms on the NEXT turn (we no longer
    //               synthesize `confirmed`), so a wrong match can be caught.
    //   ambiguous → entity_ambiguous with the candidate set — the FSM asks a
    //               one-tap disambiguation question and stays in
    //               entity_resolution.
    //   not_found → VOX-02: split by intent family (requiresExistingEntity).
    //               Record-OPERATING intents (send_estimate, record_payment,
    //               cancel_appointment, …) → entity_not_found → escalate to
    //               on-call: the request can never execute without the record.
    //               CREATION intents (create_appointment, create_job,
    //               create_customer, draft_estimate) → entity_resolved with
    //               partial refs — intent_confirm readback; the proposal
    //               carries pendingReference for operator review. A caller
    //               booking NEW work must never be escalated for it.
    //
    // D01 — `intent_details_supplied` re-enters entity_resolution from
    // intent_confirm with the ACCUMULATED entities, so the same three
    // outcomes apply to the enriched set: the customer named on turn 2 gets
    // a verified id if they exist, a "which one?" if several match, and the
    // gated-draft path if they're genuinely new. The intent/entities are
    // read off the FSM context (the transition merged them) rather than off
    // the event, which carries only this turn's delta.
    const resolutionInput: { intent: string; entities: Record<string, unknown> } | undefined =
      fsmEvent.type === 'intent_classified'
        ? { intent: fsmEvent.intentType, entities: fsmEvent.entities }
        : fsmEvent.type === 'intent_details_supplied' &&
            session.machine.currentContext.currentIntent
          ? {
              intent: session.machine.currentContext.currentIntent,
              entities: (session.machine.currentContext.extractedEntities ?? {}) as Record<
                string,
                unknown
              >,
            }
          : undefined;
    if (session.machine.currentState === 'entity_resolution' && resolutionInput) {
      const resolution = await this.resolveEntities(
        session.tenantId,
        resolutionInput.intent,
        resolutionInput.entities,
        session.machine.currentContext.jobId,
        session,
      );
      const resolutionEvent = await this.toResolutionEvent(
        session.tenantId,
        resolutionInput.intent,
        resolution,
      );
      const effects2 = session.machine.dispatch(resolutionEvent);
      allSideEffects.push(...effects2);
      const aggregate2 = await this.executeSideEffects(session, effects2);
      lastProposalId = aggregate2.lastProposalId ?? lastProposalId;
    }

    // Path B — the caller confirmed at intent_confirm, so the FSM created the
    // proposal and moved to proposal_draft. Queue it so the flow proceeds to
    // closing. Reached only via a GENUINE `confirmed` event from the caller —
    // never a synthesized one.
    if (session.machine.currentState === 'proposal_draft' && lastProposalId) {
      const effects3 = session.machine.dispatch({
        type: 'proposal_queued',
        proposalId: lastProposalId,
      });
      allSideEffects.push(...effects3);
      await this.executeSideEffects(session, effects3);
    }

    const ttsLast = [...allSideEffects].reverse().find((e) => e.type === 'tts_play');
    let ttsAudio: Buffer | undefined;
    let ttsText: string | undefined;
    if (ttsLast && typeof ttsLast.payload.text === 'string') {
      // VOX-02: expand template keys ('intent_confirm', 'greeting', …) into
      // localized human copy — callers were literally hearing the raw key.
      ttsText = renderTtsText(ttsLast.payload.text, ttsLast.payload, session.language ?? 'en');
      session.transcript.push(`agent: ${ttsText}`);
      if (this.deps.ttsProvider) {
        try {
          const synth = await this.deps.ttsProvider.synthesize({
            text: ttsText,
            tenantId: session.tenantId,
          });
          ttsAudio = synth.audio;
        } catch {
          // Non-fatal — text is still returned to the caller.
        }
      }
    }

    // If end_session fired, mark the session ended and run summary.
    const endedNow = allSideEffects.some((e) => e.type === 'end_session') ||
      session.machine.currentState === 'terminated';
    if (endedNow) {
      session.ended = true;
      // B2: extract the FSM-supplied end_session.payload.reason (e.g.
      // 'abuse_detected:profanity') so deriveCallOutcome maps it to the
      // correct CallOutcome — flattening to 'session_ended' here would
      // lose abuse / system_failure signal.
      const endFx = [...allSideEffects].reverse().find((e) => e.type === 'end_session');
      const endReason =
        endFx && typeof endFx.payload.reason === 'string'
          ? endFx.payload.reason
          : 'closed';
      session.events.emit('voice-event', { type: 'ended', reason: endReason });
      // Stamp voice_sessions.outcome here so a client that drops the
      // connection after seeing `ended: true` (without calling DELETE)
      // still produces a finalized row. _endSessionLocked's later call
      // is short-circuited by the session.terminalOutcome guard.
      this.finalizeTerminalOutcome(session, endReason);
      // Best-effort summary (P8-010 — skill is already in tree).
      void this.runSummary(session).catch(() => {
        /* never block the response on summary failures */
      });
    }

    // Push transition event for SSE subscribers.
    session.events.emit('voice-event', {
      type: 'transition',
      state: session.machine.currentState,
      event: fsmEvent.type,
      sideEffects: allSideEffects,
    });

    const result: HandleInputResult = {
      state: session.machine.currentState,
      sideEffects: allSideEffects,
      proposalIds: [...session.proposalIds],
      ended: session.ended,
    };
    if (ttsAudio) result.ttsAudio = ttsAudio;
    if (ttsText) result.ttsText = ttsText;
    return result;
  }

  async endSession(sessionId: string): Promise<void> {
    return this.deps.store.withSessionLock(sessionId, () => this._endSessionLocked(sessionId));
  }

  private async _endSessionLocked(sessionId: string): Promise<void> {
    const session = this.deps.store.peek(sessionId);
    if (!session) return;
    if (!session.ended) {
      const effects = session.machine.dispatch({ type: 'session_ended' });
      await this.executeSideEffects(session, effects);
      session.ended = true;
      // Run summary in background — the route returns 204 immediately.
      void this.runSummary(session).catch(() => {
        /* swallow — summary is best-effort */
      });
    }
    // B2: derive + stash the typed terminal outcome BEFORE delete() so
    // the recording-webhook → onPersisted path can still read it. The DB
    // write is fire-and-forget so a slow Postgres can't delay session
    // teardown (route returns 204 immediately on the inapp channel).
    this.finalizeTerminalOutcome(session, 'session_ended');
    session.events.emit('voice-event', { type: 'ended', reason: 'manual_end' });
    // store.delete() also drops the per-session lock entry.
    this.deps.store.delete(sessionId);
  }

  /**
   * B2 — compute the typed CallOutcome from FSM state, stash it on the
   * session synchronously, and kick off the persist to voice_sessions
   * in the background. Idempotent: `session.terminalOutcome` short-
   * circuits a duplicate derive, and `markEnded`'s upsert+endedAt guard
   * makes the DB write idempotent too.
   */
  private finalizeTerminalOutcome(session: VoiceSession, endedReason: string): void {
    if (session.terminalOutcome) return;
    const outcome = deriveCallOutcome({
      finalState: session.machine.currentState,
      endedReason,
      context: session.machine.currentContext,
      transcript: session.transcript,
      proposalIds: session.proposalIds,
    });
    session.terminalOutcome = outcome;
    session.terminalReason = endedReason;
    void this.persistSessionEnded(session, endedReason, outcome);
    // P8-015 — arm a dropped-call recovery SMS. Detection (outcome ∈
    // {dropped, failed}, voice channel, usable caller id) lives inside the
    // scheduler; `schedule()` is swallow-on-error and persists a durable
    // queue row, so this never blocks or breaks call teardown.
    this.scheduleDroppedCallRecovery(session, outcome);
  }

  /**
   * P8-015 — fire the recovery scheduler when wired. Resolves the caller's
   * E.164 via the injected resolver; if either the scheduler or the resolver
   * is absent (or there is no caller id), recovery is silently skipped.
   */
  private scheduleDroppedCallRecovery(
    session: VoiceSession,
    outcome: CallOutcome,
  ): void {
    const scheduler = this.deps.droppedCallScheduler;
    if (!scheduler) return;
    const callerE164 = this.deps.callerPhoneResolver?.(session);
    if (!callerE164) return;
    // RV-115 — snapshot the FSM into the durable row so the recovery SMS
    // and the inbound resume handler (RV-116) can compose state-aware cues.
    const fsmContext = session.machine.currentContext;
    void scheduler
      .schedule({
        tenantId: session.tenantId,
        voiceSessionId: session.id,
        callerE164,
        outcome,
        channel: session.channel,
        context: buildRecoveryContext({
          state: session.machine.currentState,
          ...(fsmContext.currentIntent ? { currentIntent: fsmContext.currentIntent } : {}),
          ...(fsmContext.extractedEntities
            ? { extractedEntities: fsmContext.extractedEntities }
            : {}),
          proposalIds: session.proposalIds,
        }),
      })
      .catch(() => {
        /* swallow — scheduler already logs; recovery is best-effort */
      });
  }

  /**
   * B2 — async DB-write half of `finalizeTerminalOutcome`. Always
   * fire-and-forget; errors are swallowed because outcome stamping is
   * best-effort and must never break a call flow.
   */
  private async persistSessionEnded(
    session: VoiceSession,
    endedReason: string,
    outcome: CallOutcome,
  ): Promise<void> {
    if (!this.deps.voiceSessionRepo) return;
    try {
      await this.deps.voiceSessionRepo.markEnded(session.tenantId, session.id, {
        endedAt: new Date(),
        endedReason,
        outcome,
        state: session.machine.currentState,
        channel: 'inapp_voice',
        ...(session.transcript.length > 0
          ? { transcript: [...session.transcript] }
          : {}),
        ...(session.customerId !== undefined
          ? { customerId: session.customerId }
          : {}),
      });
    } catch {
      /* swallow — outcome stamping is best-effort */
    }
  }

  /**
   * Execute the SideEffect[] returned from a single FSM dispatch.
   * Returns aggregates the route may need (e.g., the most recent
   * proposalId so it can be threaded into a follow-up FSM event).
   */
  private async executeSideEffects(
    session: VoiceSession,
    effects: SideEffect[]
  ): Promise<{ lastProposalId?: string }> {
    let lastProposalId: string | undefined;
    if (effects.length > 0) {
      // Bump activity from the side-effect path so a slow turn (TTS
      // synthesis, LLM call) doesn't let the idle reaper steal the
      // session out from under us mid-execution.
      this.deps.store.touch(session.id);
    }
    for (const effect of effects) {
      switch (effect.type) {
        case 'audit_log':
          await this.handleAuditLog(session, effect);
          break;
        case 'create_proposal': {
          const proposalId = await this.handleCreateProposal(session, effect);
          if (proposalId) lastProposalId = proposalId;
          break;
        }
        case 'notify_oncall':
          await this.handleNotifyOncall(session, effect);
          break;
        case 'tts_play':
          // TTS synthesis happens in handleInput so the caller can
          // ship audio in the response body. No-op here.
          break;
        case 'end_session':
          // handleInput / endSession set `session.ended` based on the
          // FSM state, so the side-effect itself is a no-op here.
          break;
        case 'start_transcription':
          // Telephony-only; ignored on the in-app channel (P8-012 will
          // wire mic-streaming).
          break;
        case 'emit_quality_event':
          // Quality telemetry events are no-ops on the in-app channel;
          // the event bus is telephony-specific. Handled here to satisfy
          // the exhaustiveness guard.
          break;
        case 'escalate_with_context':
          // Section 7 will wire the full escalate_with_context fan-out
          // (SMS, whisper, in-app panel) in the telephony adapter.
          // No-op here until the in-app channel gets escalation support.
          break;
        case 'revoke_pending_bookings':
          // ANS-001 — E1 life-safety booking revocation. The in-app AssistantPage
          // is the authenticated operator (S2) channel; a caller E1 hazard is an
          // S1/telephony concept and does not arise here, so there is no caller
          // booking to revoke. The shared audit_log records the E1 event. If the
          // in-app channel ever surfaces caller hazards, wire the telephony
          // processor's handleRevokePendingBookings equivalent here.
          break;
        case 'notify_tenant_emergency':
          // ANS-001 — E1 tenant alert. Telephony-only (no in-app SMS fan-out
          // path); the shared audit_log is the durable E1 record on this channel.
          break;
        default: {
          // Exhaustiveness guard: future SideEffectType additions
          // surface as a typecheck error here.
          const _exhaustive: never = effect.type;
          void _exhaustive;
        }
      }
    }
    return lastProposalId !== undefined ? { lastProposalId } : {};
  }

  private async handleAuditLog(session: VoiceSession, effect: SideEffect): Promise<void> {
    const payload = effect.payload;
    const eventType = typeof payload.eventType === 'string' ? payload.eventType : 'agent.calling.unknown';
    try {
      const ev = createAuditEvent({
        tenantId: session.tenantId,
        actorId: this.deps.systemActorId ?? 'calling-agent',
        actorRole: 'system',
        eventType,
        entityType: 'voice_session',
        entityId: session.id,
        correlationId: session.id,
        metadata: payload,
      });
      await this.deps.auditRepo.create(ev);
    } catch {
      // Audit failures must never break the call flow.
    }
  }

  /**
   * QA-2026-07-26 — build a draft line-items array from voice-classified
   * `entities.lineItemDescriptions`, then ground it through the shared
   * `groundLineItemPricing` pass (ai/resolution/catalog-resolver.ts) — the
   * SAME function `ai/tasks/estimate-task.ts` already calls for the
   * non-voice draft_estimate path — before it reaches the proposal payload.
   *
   * `amount` (when present) is `entities.amount`: the caller-quoted TOTAL
   * across every drafted line (integer cents — see intent-classifier.ts
   * `ExtractedEntities`), split evenly as each line's STARTING guess (the
   * remainder folded into the last line so the guesses always sum back to
   * the quoted total exactly). A catalog match still overwrites that guess
   * outright; a >=10%-and->=$1 conflict between the guess and a catalog
   * match surfaces as a one-tap "did you mean" instead of silently snapping
   * (see catalog-resolver.ts `isPriceConflict`).
   *
   * When `amount` is absent there is no number to guess from, so the
   * starting price is left UNSET rather than invented. `groundLineItemPricing`
   * still resolves the real price when there's a catalog match (its
   * exact/high tier sets `[priceField]` unconditionally); when there isn't,
   * the line is stamped `uncatalogued` / folds into `requiresReview: true`
   * instead of getting a fabricated number.
   */
  private async buildVoiceDraftLineItems(
    tenantId: string,
    descriptions: string[],
    amount: unknown,
  ): Promise<CatalogPricingOutcome> {
    const totalCents =
      typeof amount === 'number' && Number.isFinite(amount) && amount > 0
        ? Math.round(amount)
        : undefined;
    const perItemCents =
      totalCents !== undefined ? Math.floor(totalCents / descriptions.length) : undefined;
    const draftLineItems: Array<Record<string, unknown>> = descriptions.map((description, idx) => ({
      description,
      quantity: 1,
      ...(perItemCents !== undefined
        ? {
            unitPrice:
              idx === descriptions.length - 1
                ? totalCents! - perItemCents * (descriptions.length - 1)
                : perItemCents,
          }
        : {}),
    }));
    return groundLineItemPricing(
      draftLineItems,
      'unitPrice',
      this.deps.catalogRepo ? () => this.deps.catalogRepo!.listByTenant(tenantId) : null,
    );
  }

  private async handleCreateProposal(
    session: VoiceSession,
    effect: SideEffect
  ): Promise<string | undefined> {
    const payload = effect.payload;
    const intent = typeof payload.intent === 'string' ? payload.intent : undefined;
    const entities = (typeof payload.entities === 'object' && payload.entities !== null)
      ? payload.entities as Record<string, unknown>
      : {};
    const proposalType = intentToProposalType(intent);
    const summary = voiceProposalSummary(intent, entities);

    try {
      // PR B — load the tenant threshold override. Best-effort: a resolver
      // that throws or returns undefined falls through to
      // DEFAULT_AUTO_APPROVE_THRESHOLDS — never blocks proposal creation on
      // a settings-lookup hiccup.
      //
      // I3 correction (post-C1 review, followup-autoapprove-default) — the
      // ORIGINAL comment here claimed this makes "the Settings UI value
      // actually flow into the proposal's auto-approve decision." That was
      // never true and still isn't: `resolveAutoApproveThreshold`
      // (proposals/auto-approve.ts) returns `LEGACY_AUTO_APPROVE_THRESHOLD`
      // and returns EARLY — before ever indexing `tenantOverride` by mode —
      // whenever `supervisorMode` is undefined. This call site never sets
      // `supervisorMode` (no caller on this path does), so `tenantOverride`
      // is loaded, threaded, and then structurally never read. It is also
      // moot for a second, independent reason: `sourceTrustTier` itself is
      // forced `undefined` here by `createProposal`'s `voiceMutation` guard
      // (this is an in-app voice call — see C1's investigation and the
      // pinned test in test/proposals/proposal.test.ts), so this proposal
      // never reaches the auto-approve branch at all, threshold or no
      // threshold. Left wired (rather than removed) because it's harmless
      // and correctly-shaped for the day `supervisorMode` is threaded on a
      // voice-mutation-exempt path (e.g. the D-015 booking lane) — but
      // today, for THIS call site, the Settings UI value has no effect.
      let tenantThresholdOverride;
      if (this.deps.thresholdResolver) {
        try {
          tenantThresholdOverride = await this.deps.thresholdResolver(session.tenantId);
        } catch {
          tenantThresholdOverride = undefined;
        }
      }

      // #883/#914 (A49/A50) — negotiation/complaint bypass the generic map
      // entirely, exactly like the telephony leg
      // (ai/voice-turn/create-voice-turn-processor.ts handleCreateProposal):
      // neither intent is in `intentToProposalType`'s map (its documented
      // default is `voice_clarification`), so without this branch the FSM's
      // complaint/negotiation guard (transitions.ts) — now firing in-app too
      // via #914's `customerProtectionIntents` fix — minted a dead
      // `voice_clarification` card with no execution handler instead of the
      // dedicated owner `callback` (live evidence: sweep rows A49/A50,
      // 2026-08-30). One core (proposals/guardrails/voice-protection-
      // proposal.ts) shared with the telephony path so this can't drift a
      // third time.
      const protectionCallContext = {
        tenantId: session.tenantId,
        sessionId: session.id,
        channel: 'inapp' as const,
        // RIVET P4 — in-app voice is always the authenticated operator (S2).
        surface: 'S2' as ProposalSurface,
        customerId: typeof payload.customerId === 'string' ? payload.customerId : undefined,
        conversationId:
          typeof payload.conversationId === 'string' ? payload.conversationId : undefined,
        aiRunId: typeof payload.aiRunId === 'string' && payload.aiRunId ? payload.aiRunId : undefined,
        createdBy:
          typeof payload.customerId === 'string'
            ? payload.customerId
            : this.deps.systemActorId ?? 'calling-agent',
        tenantThresholdOverride,
      };
      const protectionDeps = {
        proposalRepo: this.deps.proposalRepo,
        auditRepo: this.deps.auditRepo,
        customerNegotiationContextProvider: this.deps.customerNegotiationContextProvider,
        settingsRepo: this.deps.settingsRepo,
        negotiationQuoteResolver: this.deps.negotiationQuoteResolver,
      };
      if (intent === 'negotiation') {
        const storedNegotiation = await buildAndPersistNegotiationProposal(
          entities,
          protectionCallContext,
          protectionDeps,
        );
        session.proposalIds.push(storedNegotiation.id);
        session.events.emit('voice-event', {
          type: 'proposal_created',
          proposalId: storedNegotiation.id,
        });
        return storedNegotiation.id;
      }
      if (intent === 'complaint') {
        const storedComplaint = await buildAndPersistComplaintProposal(
          entities,
          typeof payload.utterance === 'string' ? payload.utterance : undefined,
          protectionCallContext,
          protectionDeps,
        );
        session.proposalIds.push(storedComplaint.id);
        session.events.emit('voice-event', {
          type: 'proposal_created',
          proposalId: storedComplaint.id,
        });
        return storedComplaint.id;
      }

      // A46 — respond_to_review's only correct drafting path, shared with
      // the telephony leg (ai/voice-turn/create-voice-turn-processor.ts —
      // see its `respondToReviewTaskHandler` doc comment for the full
      // history). The generic buildVoiceProposalPayload promotion below
      // cannot draft `publicResponse.text` — that needs the deterministic
      // review-resolution ladder + an LLM draft over the ACTUAL matched
      // review, which `RespondToReviewTaskHandler` already does correctly
      // for the recorded-memo path. Reusing it here (rather than a THIRD
      // copy of that ladder) is what makes a live-call draft stop being
      // missing `publicResponse` (sweep row A46, 2026-08-30).
      if (intent === 'respond_to_review') {
        if (!this.deps.respondToReviewTaskHandler) {
          // Gate honestly instead of falling through to the generic path,
          // which would persist the same broken payload A46 caught live.
          const clarification = buildProposal({
            tenantId: session.tenantId,
            proposalType: 'voice_clarification',
            payload: buildVoiceClarificationPayload({
              transcript: session.transcript,
              intent,
              entities,
              requestedProposalType: 'review_response_proposal',
              sessionId: session.id,
            }),
            summary: "Review response drafting isn't available on this call yet.",
            sourceContext: {
              source: 'calling-agent',
              channel: session.channel,
              surface: 'S2' as ProposalSurface,
              sessionId: session.id,
            },
            createdBy:
              typeof payload.customerId === 'string'
                ? payload.customerId
                : this.deps.systemActorId ?? 'calling-agent',
          });
          const storedClarification = await this.deps.proposalRepo.create(clarification);
          session.proposalIds.push(storedClarification.id);
          return storedClarification.id;
        }
        const result = await this.deps.respondToReviewTaskHandler.handle({
          tenantId: session.tenantId,
          message: typeof entities.reviewReference === 'string' ? entities.reviewReference : '',
          ...(typeof payload.conversationId === 'string'
            ? { conversationId: payload.conversationId }
            : {}),
          existingEntities: entities,
          userId:
            typeof payload.customerId === 'string'
              ? payload.customerId
              : this.deps.systemActorId ?? 'calling-agent',
          intent: 'respond_to_review',
          ...(tenantThresholdOverride ? { tenantThresholdOverride } : {}),
        });
        const storedReview = await this.deps.proposalRepo.create(result.proposal);
        session.proposalIds.push(storedReview.id);
        return storedReview.id;
      }

      // QA-2026-06-05 / QA-2026-07-26 — THE PAYLOAD CONTRACT. Execution
      // handlers read the FLAT task contract (create_customer wants
      // payload.name; create_appointment wants payload.jobId/scheduledStart —
      // see proposals/execution/*), but the FSM hands this adapter a NESTED
      // `{intent, entities, …}` envelope, so every voice execution used to
      // fail its handler validation.
      //
      // That promotion / alias / line-item translation is no longer written
      // here: it is owned by `buildVoiceProposalPayload`
      // (proposals/voice-payload.ts), which was modelled on this very
      // function and is now SHARED with the real Twilio phone path
      // (ai/voice-turn/create-voice-turn-processor.ts) so the two voice
      // surfaces can never drift apart again. Every QA-2026-* fix this block
      // used to carry — displayName→name, sendChannel→channel, the resolved
      // customerId, and grounded lineItems for draft_estimate AND
      // draft_invoice — lives there now, next to the contract it satisfies.
      //
      // What stays HERE is what the module deliberately does not own:
      // session/FSM concerns, the summary, status decisions, sourceContext,
      // and the in-app line-item grounding wrapper injected below.
      const rawConfidence = typeof payload.confidence === 'number' ? payload.confidence : undefined;

      // A48 fix — update_brand_voice's payload isn't a flat classifier→
      // contract alias problem the generic buildVoiceProposalPayload
      // scalar-promotion loop below can solve: turning "friendly,
      // plain-spoken, sign off Thanks" into { register, signoff, ... }
      // needs the SAME dedicated LLM mapping pass ai/tasks/brand-voice-task.ts
      // already runs for the memo/phone voice path AND the chat path
      // (extractBrandVoiceProposalFields — see its doc comment for the full
      // "Payload carries no brand-voice fields to apply" defect history this
      // closes). `opening_lines`/`banned_phrases` are ARRAYS the generic
      // promotion loop explicitly never lifts (only scalars), so pre-merging
      // a mapped payload into `entities` and letting the generic loop run
      // would silently drop them — this proposal type is routed around that
      // loop entirely instead, reusing the identical downstream persist/
      // promote pipeline below via a `built`-shaped result.
      let brandVoiceFields: BrandVoiceProposalFields | undefined;
      let built: Awaited<ReturnType<typeof buildVoiceProposalPayload>>;
      if (proposalType === 'update_brand_voice') {
        const spoken =
          nonEmptyString(entities.brandVoiceInstruction) ?? lastCallerTranscriptLine(session) ?? '';
        brandVoiceFields = await extractBrandVoiceProposalFields(this.deps.gateway, session.tenantId, spoken);
        built = { payload: brandVoiceFields.payload, confidence: brandVoiceFields.confidenceScore, ok: true };
      } else {
        built = await buildVoiceProposalPayload(
        {
          intent,
          proposalType,
          // POST-resolution entities: the FSM's `entity_resolved` handler has
          // already folded resolver-validated refs (including a validated
          // customerId) into `extractedEntities` before this side effect is
          // emitted (transitions.ts).
          entities,
          envelope: {
            sessionId: session.id,
            ...(typeof payload.conversationId === 'string'
              ? { conversationId: payload.conversationId }
              : {}),
          },
          ...(rawConfidence !== undefined ? { confidence: rawConfidence } : {}),
          // DELIBERATELY NO `callerCustomerId`. On the telephony path that
          // argument is the IDENTIFIED CALLER's customer id. In-app is the
          // other way round: this envelope's top-level `payload.customerId`
          // is context.customerId — the AUTHENTICATED OPERATOR's identity
          // (used only for `createdBy` below, and undefined for every in-app
          // session by design; see the operator_session comment earlier in
          // this file). Passing it here would write an OPERATOR id into
          // `payload.customerId`, which every record-linking execution
          // handler reads as the CRM CUSTOMER. The only customer id an in-app
          // payload may carry is the resolved `entities.customerId`, which
          // the module already prefers on its own.
          //
          // QA-2026-07-26: that resolved id is what makes voice estimates
          // executable at all — DraftEstimateExecutionHandler
          // (proposals/execution/handlers.ts) reads payload.customerId
          // directly and otherwise throws "Estimate draft has neither a
          // customerId nor a jobId" (the live VOX-05 / create_booking /
          // SMS-01 QA-matrix failures).
        },
        {
          tenantId: session.tenantId,
          // The catalog grounding is INJECTED (proposals/ must not import
          // ai/resolution/* — the catalog resolver imports back through the
          // proposal contracts). This is the IN-APP wrapper
          // (`buildVoiceDraftLineItems`); the telephony path injects its own
          // (`groundVoiceQuote`), which additionally produces the spoken
          // read-back. Both bottom out in the same `groundLineItemPricing`;
          // unifying the two wrappers is a separate step.
          //
          // An uncatalogued (LLM/heuristic-priced) line must never ride the
          // raw classifier confidence into auto-approval — cap it exactly
          // like estimate-task.ts's UNCATALOGUED_CONFIDENCE_CAP, and stamp
          // the RV-007 `_meta.overallConfidence = 'low'` hard block
          // (proposals/auto-approve.ts confidenceMetaBlocksAutoApprove) so
          // decideInitialStatus can never return 'approved' for it,
          // regardless of any tenant threshold override.
          groundLineItems: async (descriptions) => {
            const outcome = await this.buildVoiceDraftLineItems(
              session.tenantId,
              descriptions,
              entities.amount,
            );
            return {
              lineItems: outcome.lineItems,
              ...(outcome.anyUncatalogued
                ? { meta: { overallConfidence: 'low' as const } }
                : {}),
              missingFields: outcome.missingFields,
              ...(outcome.anyUncatalogued && rawConfidence !== undefined
                ? { confidenceScore: Math.min(rawConfidence, UNCATALOGUED_CONFIDENCE_CAP) }
                : {}),
            };
          },
        },
        );
      }
      // The module gates every payload on its type's own schema. The inbound
      // CALLER path ACTS on a failure (persist the real type with the unmet
      // keys as `missingFields`, or degrade to a clarification card) because
      // nobody is watching a live phone call. In-app is an AUTHENTICATED
      // OPERATOR (surface S2) who reads and can edit the proposal card before
      // approving, and `approveProposal` re-validates at the execution
      // boundary regardless — so a contract gap here does NOT change what is
      // persisted. It must still be diagnosable, hence the audit row.
      //
      // ONE exception, and only one: `voice_clarification` itself. That is
      // the map's DEFAULT for an intent nobody mapped (a `lookup_*`, or
      // anything outside the shared map), and unlike every real type it has
      // NO execution handler and no review-completion path — so there is no
      // editable draft to preserve and nothing an operator could complete.
      // The raw `{intent, entities}` envelope simply fails
      // `voiceClarificationPayloadSchema` (transcript + reason) and lands in
      // the queue as a malformed card. Degrade it to the CANONICAL
      // clarification instead — the same shape, from the same shared module,
      // that the phone path already degrades to.
      //
      // Deliberately NOT applied to real proposal types: those keep the
      // persist-unchanged behaviour above, because destroying an operator's
      // editable draft would be strictly worse than handing them one with a
      // gap in it.
      let effectivePayload = built.payload;
      // D01 (2026-08-30) — a contract gap this module CAN name (e.g.
      // create_appointment with neither jobId/linkedJobId nor customerId —
      // see voice-payload.ts's `contractGapFields`) gates the draft with
      // `missingFields` instead of "persisted unchanged": without this, a
      // new-caller booking with a free-text name and no resolvable
      // customerId sailed through with no missingFields, could auto-approve,
      // and guaranteed an `execution_failed` downstream
      // (CreateAppointmentExecutionHandler: "Payload must include a valid
      // jobId" — live evidence, sweep row D01). Mirrors the telephony leg's
      // `gateable` decision (create-voice-turn-processor.ts) exactly, so the
      // two live surfaces stop drifting on this specific gap.
      let contractMissingFields: string[] = [];
      if (!built.ok) {
        const degradeToClarification = proposalType === 'voice_clarification';
        const gateable = !degradeToClarification && built.missingFieldPaths.length > 0;
        if (degradeToClarification) {
          effectivePayload = buildVoiceClarificationPayload({
            transcript: session.transcript,
            intent,
            entities,
            requestedProposalType: proposalType,
            sessionId: session.id,
          });
        } else if (gateable) {
          contractMissingFields = built.missingFieldPaths;
        }
        await this.handleAuditLog(session, {
          type: 'audit_log',
          payload: {
            eventType: 'voice.payload_contract_failed',
            intent,
            proposalType,
            outcome: degradeToClarification
              ? 'degraded_to_clarification'
              : 'persisted_unchanged',
            errors: built.errors,
            missingFields: built.missingFieldPaths,
            sessionId: session.id,
          },
        } as SideEffect);
      }
      const voiceLineItemOutcome = built.lineItemOutcome;
      const confidenceScore = built.confidence;
      const proposal = buildProposal({
        tenantId: session.tenantId,
        proposalType,
        // Flat, contract-checked, built by the shared module above (or the
        // canonical clarification, for the unmapped-intent fall-through).
        payload: effectivePayload,
        // A48 — the brand-voice mapping pass computes its own summary
        // ("Update brand voice — friendly") from the mapped register/
        // persona_name; voiceProposalSummary has no notion of those fields.
        summary: brandVoiceFields?.summary ?? summary,
        // QA-2026-06-04: mirror the AI task handlers (create-appointment-task
        // et al.) — calling-agent proposals are capture-class from the
        // autonomous tier with a real classifier confidence. Without these,
        // initialProposalStatus always returned 'draft', which the approval
        // guard correctly refuses to approve — voice proposals were stuck.
        ...(confidenceScore !== undefined ? { confidenceScore } : {}),
        // Ambiguous catalog matches (two-plus plausible items, or a
        // price-conflict "did you mean") require the operator to pick —
        // forces 'draft' regardless of trust tier / confidence, same as
        // estimate-task.ts.
        ...(voiceLineItemOutcome?.missingFields && voiceLineItemOutcome.missingFields.length > 0
          ? { missingFields: voiceLineItemOutcome.missingFields }
          : {}),
        // D01 — the contract-gap fields identified above (create_appointment
        // with no jobId/linkedJobId/customerId). Mutually exclusive with the
        // line-item / brand-voice missingFields (different proposal types) —
        // only one of the three branches can be non-empty for a given
        // proposalType.
        ...(contractMissingFields.length > 0 ? { missingFields: contractMissingFields } : {}),
        // A48 — the brand-voice gate (BRAND_VOICE_GATE_FIELD /
        // FREE_TEXT_GATE_FIELD; see extractBrandVoiceProposalFields) blocks
        // approval of a payload that would deterministically fail execution
        // — an empty patch, or a mapped-but-mixed one that would silently
        // drop unmapped content. Mutually exclusive with the line-item
        // missingFields above (different proposal types).
        ...(brandVoiceFields && brandVoiceFields.missingFields.length > 0
          ? { missingFields: brandVoiceFields.missingFields }
          : {}),
        sourceTrustTier: 'autonomous',
        sourceContext: {
          source: 'calling-agent',
          channel: session.channel,
          voiceMutation: true,
          // RIVET P4 — in-app voice is an AUTHENTICATED operator (surface S2);
          // stamp it explicitly so the execution boundary never has to infer.
          surface: 'S2' as ProposalSurface,
          sessionId: session.id,
        },
        // QA-2026-06-04: do NOT fabricate an aiRunId. proposals.ai_run_id has
        // an FK to ai_runs(id); a random uuid violates it and the swallowed
        // error silently dropped EVERY voice proposal on Postgres-backed envs
        // (in-memory repos don't enforce the FK, which is why tests passed).
        // Use a real run id when the engine provides one, else leave it null.
        ...(typeof payload.aiRunId === 'string' && payload.aiRunId ? { aiRunId: payload.aiRunId } : {}),
        createdBy: typeof payload.customerId === 'string'
          ? payload.customerId
          : this.deps.systemActorId ?? 'calling-agent',
        ...(tenantThresholdOverride ? { tenantThresholdOverride } : {}),
      });
      let stored = await this.deps.proposalRepo.create(proposal);
      // QA-2026-06-05: parity with the AI-task pipeline's guardrail promote
      // step (ai/guardrails/low-confidence.ts) which the calling-agent path
      // does not run. Proposals that initialProposalStatus left in 'draft'
      // despite a complete, caller-confirmed payload (e.g. irreversible
      // classes like cancel_appointment that must never auto-approve) have
      // to surface in the operator inbox — the inbox reads
      // 'ready_for_review' and the lifecycle guard refuses to approve a
      // 'draft'. Without this promote, non-capture voice intents were
      // permanently invisible AND unapprovable.
      if (stored.status === 'draft') {
        const promoted = await this.deps.proposalRepo.updateStatus(
          session.tenantId,
          stored.id,
          'ready_for_review'
        );
        if (promoted) stored = promoted;
      }
      session.proposalIds.push(stored.id);
      session.events.emit('voice-event', { type: 'proposal_created', proposalId: stored.id });
      return stored.id;
    } catch (err) {
      // Proposal creation failure should never break the flow — the
      // operator can re-state the request — but it must never be silent
      // either: a swallowed FK violation hid the dropped-proposal defect
      // for every voice session. Surface it in the audit log.
      await this.handleAuditLog(session, {
        type: 'audit_log',
        payload: {
          eventType: 'agent.calling.proposal_persist_failed',
          intent,
          proposalType,
          error: err instanceof Error ? err.message : String(err),
          sessionId: session.id,
        },
      } as SideEffect);
      return undefined;
    }
  }

  private async handleNotifyOncall(session: VoiceSession, effect: SideEffect): Promise<void> {
    const reasonRaw = typeof effect.payload.reason === 'string' ? effect.payload.reason : 'low_confidence';
    const reason = toEscalationReason(reasonRaw);
    try {
      await escalateToHuman({
        tenantId: session.tenantId,
        sessionId: session.id,
        reason,
        channel: session.channel,
        onCallRepo: this.deps.onCallRepo,
        auditRepo: this.deps.auditRepo,
        // VQ-003: pass the session so escalateToHuman can emit
        // `escalation_triggered` on the session bus.
        session,
        ...(typeof effect.payload.conversationId === 'string'
          ? { conversationId: effect.payload.conversationId }
          : {}),
      });
    } catch {
      // Escalation failures are surfaced via audit; never break the
      // FSM flow on them.
    }
  }

  private async runSummary(session: VoiceSession): Promise<void> {
    const durationMs = Date.now() - session.createdAt.getTime();
    try {
      // recordingId is intentionally omitted: in-app sessions don't have
      // a voice_recordings row (P8-014 wires that for telephony only).
      // Persisting NULL into call_summaries.call_id keeps the FK happy.
      const intentDetected = session.machine.currentContext.currentIntent;
      await summarizeSession({
        tenantId: session.tenantId,
        sessionId: session.id,
        transcript: session.transcript,
        proposalIds: session.proposalIds,
        durationMs,
        gateway: this.deps.gateway,
        ...(intentDetected ? { intentDetected } : {}),
        ...(this.deps.pool ? { pool: this.deps.pool } : {}),
        // RIVET I13 — this is an authenticated in-app OPERATOR session. The
        // adapter stores the operator's own turns with a `caller:` prefix, so
        // they must NOT be fenced as untrusted caller content.
        inboundCallerSession: false,
      });
    } catch {
      // Summary is best-effort — the call still ended successfully.
    }
  }
}
