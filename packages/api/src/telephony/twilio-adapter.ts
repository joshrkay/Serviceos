/**
 * Twilio `<Gather>` adapter for the customer-calling FSM.
 *
 * This is the higher-latency, simpler telephony adapter. It uses Twilio's
 * built-in speech recognition (`<Gather input="speech">`) to capture the
 * caller's utterance, runs it through the channel-agnostic FSM, and
 * returns TwiML that either prompts again or hangs up.
 *
 * Real-time STT / barge-in / streaming TTS lives in P8-012 (Media Streams).
 *
 * Architecture
 * ────────────
 * - Each Twilio HTTP webhook is a single FSM "tick": pull session →
 *   dispatch event → execute side effects → emit TwiML.
 * - All side effects are returned as data by the FSM (`SideEffect[]`).
 *   This adapter knows how to map each side-effect type to TwiML or
 *   to a real outbound call (audit log, proposal create, etc.).
 * - No real-time / streaming work happens here. That's P8-012.
 */

import { v4 as uuidv4 } from 'uuid';
import type { Pool } from 'pg';
import { classifyIntent, isLookupIntent, isVoiceApprovalIntent } from '../ai/orchestration/intent-classifier';
import {
  CreateCustomerVoiceTaskHandler,
  CREATE_CUSTOMER_CONFIRMATION_TTS,
} from '../ai/tasks/create-customer-task';
import { lookupAppointments } from '../ai/skills/lookup-appointments';
import { lookupInvoices } from '../ai/skills/lookup-invoices';
import { lookupBalance } from '../ai/skills/lookup-balance';
import { lookupJobs } from '../ai/skills/lookup-jobs';
import { lookupAgreements } from '../ai/skills/lookup-agreements';
import { lookupAccountSummary } from '../ai/skills/lookup-account-summary';
import { lookupCustomer } from '../ai/skills/lookup-customer';
import { lookupEstimates } from '../ai/skills/lookup-estimates';
import { lookupLeads } from '../ai/skills/lookup-leads';
import { lookupRevenue } from '../ai/skills/lookup-revenue';
import { lookupCatalog } from '../ai/skills/lookup-catalog';
import { lookupAvailability } from '../ai/skills/lookup-availability';
import type { AvailabilityFinder } from '../ai/tasks/availability-finder';
import type { MoneyDashboardRepository } from '../reports/money-dashboard';
import type { CatalogItemRepository } from '../catalog/catalog-item';
import type { JobRepository } from '../jobs/job';
import type { AppointmentRepository } from '../appointments/appointment';
import type { InvoiceRepository } from '../invoices/invoice';
import type { AgreementRepository } from '../agreements/agreement';
import type { CustomerRepository } from '../customers/customer';
import type { EstimateRepository } from '../estimates/estimate';
import type { LookupEventService } from '../lookup-events/lookup-event-service';
import type { LLMGateway } from '../ai/gateway/gateway';
import { discloseRecording } from '../ai/skills/disclose-recording';
import { t, type Language } from '../ai/i18n/i18n';
import { identifyCaller } from '../ai/skills/identify-caller';
import { findOrCreateLeadByPhone } from '../ai/skills/find-or-create-lead';
import { confirmIntent } from '../ai/skills/confirm-intent';
import { summarizeSession } from '../ai/skills/summarize-session';
import {
  intentClassifiedEvent,
  lookupExecutedEvent,
} from '../ai/voice-quality/events';
import { TAU_INT } from '../ai/agents/customer-calling/transitions';
import type {
  CallingAgentContext,
  CallingAgentEvent,
  SideEffect,
} from '../ai/agents/customer-calling/types';
import type { VoiceSession, VoiceSessionStore } from '../ai/agents/customer-calling/voice-session-store';
// Aliased to avoid name collision with the private `deriveCallOutcome` method
// on this class — see line 1828. The imported function takes the typed
// options object (DeriveOutcomeInput); the instance method takes a
// VoiceSession. They are NOT interchangeable. Pre-existing fix from cf76752
// that got reverted in a subsequent merge to main.
import { deriveCallOutcome as deriveCallOutcomeFromState } from '../ai/agents/customer-calling/outcome-mapper';
import type { VoiceSessionRepository } from '../voice/voice-session';
import type { ProposalRepository, ProposalType } from '../proposals/proposal';
import { createProposal as buildProposal } from '../proposals/proposal';
import type { LeadRepository } from '../leads/lead';
import type { AuditRepository } from '../audit/audit';
import { createAuditEvent } from '../audit/audit';
import type { OnCallRepository } from '../oncall/rotation';
import type { TwilioCallControl } from './twilio-call-control';
import type { DispatcherPhoneResolver } from '../ai/skills/escalate-to-human';
import { createLogger } from '../logging/logger';
import type { TenantCredentialResolver } from '../integrations/credentials';
import { MEDIA_STREAM_PATH } from './media-streams/twilio-mediastream-server';
import type { VoiceRepository, CallOutcome } from '../voice/voice-service';
import type { VoicePersona, VoicePersonaResolver } from '../settings/voice-persona-resolver';
import { resolveEscalationSettings } from '../settings/settings';
import type { WhisperCache } from './whisper-cache';
import {
  createVoiceTurnProcessor,
  appendAgentTts,
  type VoiceTurnProcessor,
} from '../ai/voice-turn';
import type { RepairTemplate } from '../verticals/registry';
import { detectFrustration } from '../ai/agents/customer-calling/frustration-detector';
import type { SettingsRepository } from '../settings/settings';
import type { UserRepository } from '../users/user';
import { isApproverPhone } from '../proposals/approver-identity';
import type { ProposalSmsEventRepository } from '../proposals/sms/sms-event';
import type { OneTapFallbackDeps } from '../ai/tasks/proposal-approval-task';

const logger = createLogger({
  service: 'telephony.twilio-adapter',
  environment: process.env.NODE_ENV || 'development',
});

// ─── Deps ────────────────────────────────────────────────────────────────────

export interface TwilioAdapterDeps {
  store: VoiceSessionStore;
  gateway: LLMGateway;
  /** Postgres pool — passed to identifyCaller and summarizeSession. */
  pool?: Pool;
  /** Repos used to persist side-effect rows (audit/proposal/escalation). */
  proposalRepo?: ProposalRepository;
  auditRepo?: AuditRepository;
  onCallRepo?: OnCallRepository;
  /**
   * When wired, unknown callers are auto-created as `phone_call` leads
   * during `handleInbound` so they show up in the CRM kanban. Returning
   * unknown callers are deduped by normalized phone.
   */
  leadRepo?: LeadRepository;
  /** Used as actorId on proposal/audit rows when none is in scope. */
  systemActorId?: string;
  /** Business name used in recording disclosure copy. */
  businessName: string;
  /**
   * Public base URL used when building the absolute `<Gather action="...">`
   * URL Twilio will POST to. Twilio requires an absolute URL when the
   * webhook is hit from a public IP. Falls back to a relative path.
   */
  publicBaseUrl?: string;
  /**
   * Twilio call-control surface used by the escalation path to emit
   * `<Dial>` TwiML. When undefined, `notify_oncall` keeps its v1
   * audit-only behavior. P8-013 wires this in.
   */
  callControl?: TwilioCallControl;
  /**
   * Resolves a rotation entry's userId → phone number. Required to
   * actually `<Dial>` a dispatcher. Without it, the escalation
   * silently degrades to the v1 in-app behavior. P8-013 wires this in.
   */
  dispatcherPhoneResolver?: DispatcherPhoneResolver;
  /**
   * P8-014: when set, the initial inbound TwiML emits a
   * `<Start><Record recordingStatusCallback="..."/></Start>` block so
   * Twilio asynchronously records the entire call and POSTs the
   * finalized metadata to the recording webhook. Should be the absolute
   * URL of `POST /api/telephony/recording`. Falls back to a relative
   * path when `publicBaseUrl` is unset.
   *
   * When unset, no recording block is emitted — useful for tests and
   * dev environments without a recording sink.
   */
  recordingCallbackPath?: string;
  /**
   * P11-001: voice lookup-skill family wiring. When set, classifier
   * results whose intentType starts with `lookup_` are dispatched to
   * the corresponding skill — the skill's TTS-ready `summary` becomes
   * the next utterance and the FSM stays in `intent_capture` so the
   * caller is re-prompted ("Anything else I can help you with?").
   *
   * When ANY of the four entity repos are missing, the lookup branch
   * silently degrades to a generic "let me get someone to help" line
   * so a partial wiring never crashes a live call.
   */
  jobRepo?: JobRepository;
  appointmentRepo?: AppointmentRepository;
  invoiceRepo?: InvoiceRepository;
  agreementRepo?: AgreementRepository;
  /** VQ-006: read-only customer + estimate lookups. */
  customerRepo?: CustomerRepository;
  estimateRepo?: EstimateRepository;
  /** Full-app voice coverage: owner-scoped revenue + catalog lookups. */
  moneyDashboardRepo?: MoneyDashboardRepository;
  catalogRepo?: CatalogItemRepository;
  /** When wired, lookup_availability speaks the next open slots. */
  availabilityFinder?: AvailabilityFinder;
  /** P11-001: when wired, every lookup invocation writes a row. */
  lookupEvents?: LookupEventService;
  /**
   * Phase C: per-tenant integration resolver for runtime auth lookups.
   * Wiring is optional in this adapter phase; consumers can inject and
   * use it for tenant-specific Twilio auth outside this gather loop.
   */
  credentialResolver?: TenantCredentialResolver;
  /**
   * §3B + §3D vertical-aware classifier prompt. Same shape as the
   * in-app adapter's `verticalPromptResolver` — resolves the tenant's
   * active vertical pack into a prompt-shaped section (vertical block
   * + intake_questions block) that gets appended as a system message
   * to `classifyIntent`. Optional: returning undefined leaves the
   * classifier on its base prompt.
   */
  verticalPromptResolver?: (tenantId: string) => Promise<string | undefined>;
  /**
   * §3C caller-plan / membership classifier prompt. Resolved per
   * (tenantId, customerId) once the caller is identified.
   */
  callerPlanResolver?: (
    tenantId: string,
    customerId: string,
  ) => Promise<string | undefined>;
  /**
   * Tier 4 / PR B — per-tenant auto-approve threshold override
   * resolver. When wired, the adapter loads the override before
   * building each proposal and threads it through
   * `tenantThresholdOverride`. Optional: when absent, proposals fall
   * through to DEFAULT_AUTO_APPROVE_THRESHOLDS.
   */
  thresholdResolver?: (tenantId: string) => Promise<
    Partial<Record<'supervisor' | 'tech' | 'both', number>> | undefined
  >;
  /**
   * B2 — persistent outcome stamping. When wired, the adapter inserts a
   * voice_sessions row on session start and stamps the typed CallOutcome
   * + ended_reason on session end (before store.delete()). Optional so
   * existing test fixtures continue to work without DI'ing a stub.
   */
  voiceSessionRepo?: VoiceSessionRepository;
  /**
   * When wired, the call outcome is stamped on the voice_recordings row
   * at session end (by callSid). Without this, analytics remain blind.
   */
  voiceRepo?: VoiceRepository;
  /**
   * B1 — Per-tenant voice persona. When present, consulted during
   * `handleInbound` to personalize the greeting. Failures fall back
   * to the static `businessName`-based opener — calls are never
   * blocked by a settings lookup failure.
   */
  voicePersonaResolver?: VoicePersonaResolver;
  /**
   * §10 onboarding — fired after voice_sessions.ended_at is stamped.
   * Drives the 30-minute upgrade nudge (banner + optional email).
   * Failures are swallowed so call termination is never blocked by
   * the nudge check.
   */
  onSessionEnded?: (event: {
    tenantId: string;
    callSid?: string;
    channel: 'voice_inbound' | 'inapp_voice';
  }) => Promise<void>;
  /**
   * §P2-3 — Resolves the vertical-specific repair templates for a tenant.
   * When present, the templates are threaded into the FSM context at
   * session creation so low-confidence reprompts use vertical-aware copy.
   * When absent, the FSM falls back to the generic "say that again" prompt.
   */
  repairTemplatesResolver?: (tenantId: string) => Promise<ReadonlyArray<RepairTemplate>>;
  /**
   * F8 — per-tenant escalation settings repository. When wired, the
   * processor loads channel preferences before each `escalateToHuman`
   * call. Optional so existing test fixtures continue to work.
   */
  settingsRepo?: SettingsRepository;
  whisperCache?: WhisperCache;
  deliveryProvider?: { sendSms(args: { to: string; body: string }): Promise<unknown> };
  /**
   * RV-070 — resolves the backup supervisor's mobile for owner-line
   * recognition (`tenant_settings.backup_supervisor_user_id` →
   * users.mobile_number). Optional: without it, only owner_phone is
   * checked — exactly mirroring the SMS reply handler's identity logic.
   */
  userRepo?: UserRepository;
  /**
   * RV-071 — pending-edit parity guard for voice approvals (same repo
   * method the SMS reply transport and one-tap route use).
   */
  smsEventRepo?: Pick<ProposalSmsEventRepository, 'hasUnappliedEditRequest'>;
  /**
   * RV-071 — one-tap SMS fallback for refused money/irreversible voice
   * approvals (same secret/sender/URL/owner-phone wiring as P12-004
   * unsupervised routing). Threaded through to the voice-turn processor.
   */
  voiceApprovalOneTap?: OneTapFallbackDeps;
}

/**
 * Build the full telephony greeting.
 *
 * `disclosureText` (recording notice) is always appended after the
 * greeting when present — it is a compliance requirement that cannot
 * be opted out.
 *
 * Branch priority:
 *   1. Custom greeting (`persona.greeting` set):
 *        Returns `${persona.greeting} ${disclosureText}` (trimmed).
 *        The tenant owns the entire opening line — NO CTA is appended.
 *        The result is returned as-is so the tenant's chosen wording
 *        is preserved verbatim.
 *   2. Agent name only (`persona.agentName` set, no custom greeting):
 *        `Thank you for calling ${name}. This is ${agentName}. ${disclosure} How can I help you today?`
 *        A CTA is appended if the assembled string does not already end with `?`.
 *   3. Neither:
 *        `Thank you for calling ${name}. ${disclosure} How can I help you today?`
 *        A CTA is appended if the assembled string does not already end with `?`.
 */
export function buildTelephonyGreeting(
  businessName: string,
  disclosureText: string,
  persona?: VoicePersona | null,
  language: Language = 'en'
): string {
  const disclosure = disclosureText.trim();

  // Branch 1 — tenant owns the entire opening line. Return without CTA
  // append. The custom greeting is used verbatim (the tenant authored it
  // in their own language), so we do NOT localize this branch.
  if (persona?.greeting) {
    const greeting = persona.greeting.trim();
    return disclosure ? `${greeting} ${disclosure}`.trim() : greeting;
  }

  // Branch 2 / 3 — assemble a localized default greeting, then ensure it
  // ends with a CTA (the ES CTA already ends with '?').
  const opener = persona?.agentName
    ? t('greeting.opener_named', language, { business: businessName, agent: persona.agentName })
    : t('greeting.opener_default', language, { business: businessName });
  const assembled = disclosure ? `${opener} ${disclosure}`.trim() : opener;
  return assembled.endsWith('?') ? assembled : `${assembled} ${t('greeting.cta', language)}`;
}

function intentToProposalType(intent: string | undefined): ProposalType {
  switch (intent) {
    case 'create_invoice': return 'draft_invoice';
    case 'update_invoice': return 'update_invoice';
    case 'issue_invoice': return 'issue_invoice';
    case 'send_invoice': return 'send_invoice';
    case 'send_estimate': return 'send_estimate';
    case 'record_payment': return 'record_payment';
    case 'draft_estimate': return 'draft_estimate';
    case 'update_estimate': return 'update_estimate';
    case 'create_appointment': return 'create_appointment';
    case 'reschedule_appointment': return 'reschedule_appointment';
    case 'cancel_appointment': return 'cancel_appointment';
    case 'reassign_appointment': return 'reassign_appointment';
    case 'create_customer': return 'create_customer';
    case 'create_job': return 'create_job';
    case 'add_note': return 'add_note';
    case 'emergency_dispatch': return 'emergency_dispatch';
    case 'update_customer': return 'update_customer';
    case 'log_expense': return 'log_expense';
    case 'convert_lead': return 'convert_lead';
    case 'confirm_appointment': return 'confirm_appointment';
    case 'mark_lead_lost': return 'mark_lead_lost';
    case 'add_service_location': return 'add_service_location';
    case 'log_time_entry': return 'log_time_entry';
    case 'notify_delay': return 'notify_delay';
    case 'request_feedback': return 'request_feedback';
    default: return 'voice_clarification';
  }
}

// ─── XML helpers ─────────────────────────────────────────────────────────────

/**
 * P18-001: detect a Twilio `From` value that represents a withheld /
 * blocked / private caller-id. Twilio surfaces these as common literal
 * strings; an empty string signals "we never recorded one". Returns
 * true ONLY for explicitly blocked indicators — a plain missing string
 * returns false so the caller can prompt for a callback rather than
 * assuming the caller chose to withhold.
 */
export function isBlockedCallerId(from: string | undefined): boolean {
  if (!from) return false;
  const v = from.trim().toLowerCase();
  if (v.length === 0) return false;
  return (
    v === 'restricted' ||
    v === 'private' ||
    v === 'blocked' ||
    v === 'unknown' ||
    v === 'anonymous' ||
    v === 'unavailable'
  );
}

/** Escape a string for safe inclusion in TwiML. */
export function xmlEscape(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

// ─── Side-effect → TwiML mapping ─────────────────────────────────────────────

interface BuildTwimlOpts {
  /** Absolute URL (or path) Twilio will POST the next Gather result to. */
  gatherActionUrl: string;
  /**
   * Optional URL that Twilio will POST the finalized recording metadata
   * to. When set, the response begins with a `<Start><Record/></Start>`
   * block — fired only on the initial inbound TwiML so Twilio records
   * the entire call asynchronously. Subsequent <Gather> turns leave it
   * undefined.
   */
  recordingStatusCallback?: string;
  /**
   * P11-002: spoken-output language. Drives both the `<Say voice=...>`
   * Polly voice selection and the `<Gather language=...>` STT hint
   * so Twilio's built-in recognizer picks the right phonetic model.
   */
  language?: 'en' | 'es';
  /**
   * P11-002: per-tenant TTS voice override (settings.ttsVoiceEn/Es).
   * When set, the `<Say voice>` uses it instead of the language-derived
   * default Polly voice. The `<Gather>` STT locale still follows
   * `language`.
   */
  voiceOverride?: string;
}

const GATHER_VOICE_EN = 'Polly.Joanna';
const GATHER_VOICE_ES = 'Polly.Mia-Neural';
const GATHER_LOCALE_EN = 'en-US';
const GATHER_LOCALE_ES = 'es-US';

/**
 * Translate FSM side effects into a TwiML string.
 *
 * Mapping:
 *   tts_play       → <Say voice="Polly.Joanna">…</Say>
 *   end_session    → <Hangup/>
 *   notify_oncall  → no-op here — the adapter's `handleNotifyOncall`
 *                    drives the rotation + emits a `<Dial>` transfer
 *                    TwiML out-of-band (P8-013). buildTwiML stays
 *                    pure so unit tests can still feed in side-effect
 *                    arrays directly.
 *   audit_log      → no-op (the side effect was executed by the caller)
 *   create_proposal→ no-op (executed by the caller)
 *   start_transcription → no-op (P8-012)
 */
export function buildTwiML(
  sideEffects: SideEffect[],
  opts: BuildTwimlOpts,
): string {
  const parts: string[] = [];
  let ended = false;

  // P8-014: when present, prepend a <Start><Record/></Start> block so
  // Twilio records the entire call asynchronously and POSTs metadata to
  // /api/telephony/recording on completion. Only emitted on the initial
  // inbound TwiML — subsequent <Gather> turns must NOT re-emit it (would
  // start a second concurrent recording).
  if (opts.recordingStatusCallback) {
    parts.push(
      `<Start><Record recordingStatusCallback="${xmlEscape(
        opts.recordingStatusCallback,
      )}" recordingStatusCallbackMethod="POST"/></Start>`,
    );
  }

  for (const fx of sideEffects) {
    if (fx.type === 'tts_play') {
      const text = typeof fx.payload.text === 'string' ? fx.payload.text : '';
      // The FSM emits placeholder strings ('greeting', 'intent_confirm', etc.)
      // when it expects a template lookup. Skip those — the caller is
      // responsible for resolving the real text via injected helpers.
      // For now we still <Say> them so a caller hearing the call has *some*
      // audible feedback rather than silence; a real prompt registry is a
      // follow-up.
      const sayText = text.length > 0 ? text : '...';
      const voice =
        opts.voiceOverride ?? (opts.language === 'es' ? GATHER_VOICE_ES : GATHER_VOICE_EN);
      parts.push(`<Say voice="${xmlEscape(voice)}">${xmlEscape(sayText)}</Say>`);
    } else if (fx.type === 'end_session') {
      parts.push('<Hangup/>');
      ended = true;
    } else if (fx.type === 'notify_oncall') {
      // P8-013: the adapter's `handleNotifyOncall` consumes this side
      // effect and produces a `<Dial>` TwiML out-of-band via
      // `pendingTransferTwiml`; buildTwiML itself stays pure.
      logger.debug('notify_oncall side effect (handled out-of-band)', {
        payload: fx.payload,
      });
    }
    // audit_log / create_proposal / start_transcription / emit_quality_event
    // → no TwiML (Gather path has no event bus; telemetry only fires when
    // Media Streams is active).
  }

  if (!ended) {
    // Loop back to <Gather> so the caller can speak the next turn.
    // P11-002: thread the session language to Twilio's built-in STT so
    // Spanish callers don't get transcribed against the English model.
    const gatherLang = opts.language === 'es' ? GATHER_LOCALE_ES : GATHER_LOCALE_EN;
    parts.push(
      `<Gather input="speech" speechTimeout="auto" language="${gatherLang}" action="${xmlEscape(
        opts.gatherActionUrl
      )}" method="POST"/>`
    );
  }

  return `<?xml version="1.0" encoding="UTF-8"?><Response>${parts.join('')}</Response>`;
}

// ─── Adapter ─────────────────────────────────────────────────────────────────

export class TwilioGatherAdapter {
  /**
   * Per-session pending TwiML override. Set by `handleNotifyOncall` when
   * the escalate skill returns a `<Dial>` transfer descriptor; consumed
   * (and cleared) by `finalizeTwiml` so the next webhook response
   * bridges the call to the dispatcher instead of looping back to
   * `<Gather>`. Keyed by sessionId — survives long enough for the
   * current webhook turn only.
   */
  private readonly pendingTransferTwiml = new Map<string, string>();

  /**
   * P18-001: caller-ID phone keyed by sessionId. Recorded at inbound-
   * call time so the create_customer voice flow can stamp the new
   * customer's `primaryPhone` from the caller-id without forcing the
   * caller to spell it back. Lives in-memory on the adapter — same
   * lifetime as the in-memory voice session — and is removed when the
   * session terminates. The map's separate from `VoiceSession` so the
   * session-store interface stays unchanged. A blocked / withheld
   * caller-id stores an empty string so `_isBlocked` can distinguish
   * "missing" (never recorded) from "explicitly blocked".
   */
  private readonly callerIdBySession = new Map<string, string>();

  /**
   * Closure-captured agent loop (P38-FOLLOWUP). Owns `speechTurn`,
   * `finalizeTerminatedSession`, and the side-effect/cost/prompt
   * helpers the gather + media-streams entry points share. The adapter
   * delegates to it so the Layer 2 voice-quality entry test can reach
   * the same code path without instantiating a full adapter.
   */
  private readonly processor: VoiceTurnProcessor;

  constructor(private deps: TwilioAdapterDeps) {
    // Share the adapter's ephemeral maps with the processor so a
    // notify_oncall side effect dispatched inside the processor's
    // `executeSideEffects` writes into the same `pendingTransferTwiml`
    // the adapter's `finalizeTwiml` reads from.
    this.processor = createVoiceTurnProcessor({
      ...this.deps,
      pendingTransferTwiml: this.pendingTransferTwiml,
      callerPhoneResolver: (session) => this.callerIdBySession.get(session.id),
      // Wire the existing fire-and-forget summary path. Preserves the
      // legacy behavior where a terminated turn kicks off the
      // end-of-call summary in the background. The `async` wrapper is
      // intentional: the processor `await`s this callback (so the
      // Layer 2 entry test can await summary spend before the snapshot
      // window closes), but the inner `runSummary` is fire-and-forget
      // here, so the callback resolves immediately and Twilio webhook
      // latency stays bounded by the speechTurn body — the summary
      // (which can take seconds) continues in the background.
      onSessionTerminated: async (session) => {
        void this.processor.runSummary(session).catch(() => {
          /* swallow — summary is best-effort */
        });
      },
    });
  }

  /**
   * RV-070 — owner-line recognition. True when the inbound caller-ID
   * matches `tenant_settings.owner_phone` or the backup supervisor's
   * mobile (normalized E.164 comparison — the SAME identity logic as the
   * SMS reply transport, via `proposals/approver-identity.ts`). Best
   * effort and fail-closed: a settings/user lookup failure returns false
   * so a degraded dependency can never mint an owner session.
   */
  private async resolveOwnerSession(
    tenantId: string,
    from: string | undefined,
  ): Promise<boolean> {
    if (!this.deps.settingsRepo || !from) return false;
    try {
      return await isApproverPhone(
        {
          settingsRepo: this.deps.settingsRepo,
          ...(this.deps.userRepo ? { userRepo: this.deps.userRepo } : {}),
        },
        tenantId,
        from,
      );
    } catch (err) {
      logger.warn('resolveOwnerSession failed — treating caller as non-owner', {
        tenantId,
        error: err instanceof Error ? err.message : String(err),
      });
      return false;
    }
  }

  private async resolveEscalationTriggers(
    tenantId: string,
  ): Promise<CallingAgentContext['escalationTriggers'] | undefined> {
    if (!this.deps.settingsRepo) return undefined;
    try {
      const settings = await this.deps.settingsRepo.findByTenant(tenantId);
      const esc = resolveEscalationSettings(settings);
      return {
        trigger_low_confidence: esc.trigger_low_confidence,
        trigger_explicit_request: esc.trigger_explicit_request,
        trigger_keyword_frustration: esc.trigger_keyword_frustration,
      };
    } catch {
      return undefined;
    }
  }

  /**
   * P11-002 — resolve the spoken language + TTS voice for a new call from
   * the tenant settings (default_language + tts_voice_en/es). Customer-level
   * overrides for voice are a follow-up; the greeting/STT use the tenant
   * default. Falls back to 'en' with no voice override.
   */
  private async resolveTenantLanguage(
    tenantId: string,
  ): Promise<{ language: Language; ttsVoice?: string; supportedLanguages?: Language[] }> {
    if (!this.deps.settingsRepo) return { language: 'en' };
    try {
      const settings = await this.deps.settingsRepo.findByTenant(tenantId);
      // The tenant's explicit default_language is always honored — it IS the
      // tenant's opt-in. The supported_languages stack gates CALLER auto-
      // detection (a Spanish-speaking caller on an English-only tenant), not
      // the tenant's own configured greeting language.
      const language: Language = settings?.defaultLanguage === 'es' ? 'es' : 'en';
      const ttsVoice =
        (language === 'es' ? settings?.ttsVoiceEs : settings?.ttsVoiceEn) ?? undefined;
      // Thread the opt-in stack for the auto-detect gate, always including the
      // pinned language so the gate can never contradict the greeting.
      const baseStack: Language[] = settings?.supportedLanguages ?? ['en'];
      const supportedLanguages = baseStack.includes(language)
        ? baseStack
        : [...baseStack, language];
      return { language, ttsVoice, supportedLanguages };
    } catch {
      return { language: 'en' };
    }
  }

  /**
   * P8-012 — Initial /voice handler when Media Streams is enabled.
   *
   * Creates (or replays) the session, then returns a
   * `<Connect><Stream/></Connect>` TwiML that points Twilio at our WS
   * server. We do NOT run the disclose_recording / identify_caller /
   * `incoming_call` flow here — those will run on the WS adapter side
   * once the stream's `start` event arrives, so the session has a
   * tenantId attached before any FSM dispatch happens. (Today we
   * intentionally keep the WS-side bootstrap minimal: the session is
   * created with tenantId + CallSid, and the FSM lazily greets on the
   * first final transcript.)
   *
   * This avoids racing TTS playback over a Stream frame: the FSM's
   * greeting tts_play would otherwise try to render via the WS audio
   * channel before Twilio finishes the connect.
   */
  async handleInboundForStream(opts: {
    callSid: string;
    from: string;
    tenantId: string;
  }): Promise<string> {
    const existing = this.deps.store.findByCallSid(opts.callSid);
    if (existing && existing.tenantId === opts.tenantId) {
      return this.buildStreamTwiML({ sessionId: existing.id, callSid: opts.callSid });
    }
    const repairTemplates = this.deps.repairTemplatesResolver
      ? await this.deps.repairTemplatesResolver(opts.tenantId).catch(() => [])
      : [];
    const escalationTriggers = await this.resolveEscalationTriggers(opts.tenantId);
    // RV-070 — owner-line recognition happens at session establishment:
    // recognized owner line (caller-ID match; see approver-identity.ts).
    const ownerSession = await this.resolveOwnerSession(opts.tenantId, opts.from);
    const session = this.deps.store.create(opts.tenantId, 'telephony', {
      callSid: opts.callSid,
      ...(repairTemplates.length > 0 ? { repairTemplates } : {}),
      ...(escalationTriggers ? { escalationTriggers } : {}),
      ...(ownerSession ? { ownerSession: true } : {}),
    });
    // initializeStreamSession reads callerIdBySession to drive
    // identifyCaller/lead creation; without this, every media-stream
    // inbound silently falls through to unknown-caller behavior.
    this.callerIdBySession.set(session.id, opts.from ?? '');
    this.persistVoiceSessionRow(session, opts.callSid);
    return this.buildStreamTwiML({ sessionId: session.id, callSid: opts.callSid });
  }

  /**
   * B2 — fire-and-forget insert into voice_sessions. Best-effort: a repo
   * error never blocks call setup.
   */
  private persistVoiceSessionRow(session: VoiceSession, callSid: string | undefined): void {
    if (!this.deps.voiceSessionRepo) return;
    void this.deps.voiceSessionRepo
      .create({
        id: session.id,
        tenantId: session.tenantId,
        channel: 'voice_inbound',
        ...(callSid ? { callSid } : {}),
        state: session.machine.currentState,
      })
      .catch(() => {
        /* swallow — outcome stamping is best-effort */
      });
  }

  /**
   * P8-012 — Run greeting initialization for the Media Streams path.
   *
   * Called by the WS adapter after Deepgram opens (i.e., once the caller
   * is actually connected and can hear audio). Mirrors the disclosure +
   * caller-ID + FSM bootstrap that Gather mode runs inside handleInbound(),
   * but returns side-effect arrays instead of TwiML so the adapter can
   * synthesize them via TTS.
   */
  async initializeStreamSession(opts: {
    callSid: string;
    tenantId: string;
  }): Promise<SideEffect[]> {
    const session = this.deps.store.findByCallSid(opts.callSid);
    if (!session) {
      return [
        { type: 'tts_play', payload: { text: `Thank you for calling ${this.deps.businessName}. How can I help you today?` } },
      ];
    }

    const from = this.callerIdBySession.get(session.id) ?? '';

    // P11-002: resolve + pin the spoken language + TTS voice (tenant default).
    const { language, ttsVoice, supportedLanguages } = await this.resolveTenantLanguage(opts.tenantId);
    session.language = language;
    session.ttsVoice = ttsVoice;
    if (supportedLanguages) session.supportedLanguages = supportedLanguages;

    // 1. Recording disclosure (text only — TTS synthesizes the audio).
    const disclosure = await discloseRecording({
      tenantId: opts.tenantId,
      channel: 'telephony',
      businessName: this.deps.businessName,
      language,
    });

    // 2. Identify caller by phone number.
    let callerKnown: { customerId: string; customerName: string } | null = null;
    let identifyFailed = false;
    if (this.deps.pool && from) {
      try {
        const result = await identifyCaller({
          tenantId: opts.tenantId,
          fromPhone: from,
          pool: this.deps.pool,
        });
        if (result.status === 'matched') {
          callerKnown = { customerId: result.customerId, customerName: result.customerName };
        }
      } catch (err) {
        logger.error('initializeStreamSession: identifyCaller failed', {
          error: err instanceof Error ? err.message : String(err),
          callSid: opts.callSid,
        });
        identifyFailed = true;
      }
    }

    // 3. FSM bootstrap: incoming_call → greeting → identifying.
    const sideEffects: SideEffect[] = [];
    sideEffects.push(
      ...session.machine.dispatch({
        type: 'incoming_call',
        callSid: opts.callSid,
        from,
        to: '',
        tenantId: opts.tenantId,
      }),
    );

    // 4. Replace 'greeting' placeholder with real greeting + disclosure text.
    let persona: VoicePersona | null | undefined;
    if (this.deps.voicePersonaResolver) {
      try {
        persona = await this.deps.voicePersonaResolver(opts.tenantId);
      } catch {
        persona = undefined;
      }
    }
    const greetingText = buildTelephonyGreeting(
      this.deps.businessName,
      disclosure.disclosureText,
      persona,
      language,
    );
    for (const fx of sideEffects) {
      if (fx.type === 'tts_play' && fx.payload.text === 'greeting') {
        fx.payload.text = greetingText;
      }
    }

    // 5. Drive FSM forward: greeted_ok → caller_known / unknown_caller.
    sideEffects.push(...session.machine.dispatch({ type: 'greeted_ok' }));

    if (callerKnown) {
      session.customerId = callerKnown.customerId;
      sideEffects.push(
        ...session.machine.dispatch({ type: 'caller_known', customerId: callerKnown.customerId }),
      );
    } else if (identifyFailed) {
      sideEffects.push(
        ...session.machine.dispatch({ type: 'caller_identification_failed', reason: 'identify_caller_threw' }),
      );
    } else {
      if (this.deps.leadRepo && from) {
        try {
          const result = await findOrCreateLeadByPhone({
            tenantId: opts.tenantId,
            fromPhone: from,
            leadRepo: this.deps.leadRepo,
            ...(this.deps.auditRepo ? { auditRepo: this.deps.auditRepo } : {}),
            systemActorId: this.deps.systemActorId ?? 'system:inbound-call',
          });
          session.leadId = result.leadId;
        } catch (err) {
          logger.error('initializeStreamSession: findOrCreateLeadByPhone failed', {
            callSid: opts.callSid,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
      sideEffects.push(...session.machine.dispatch({ type: 'unknown_caller' }));
    }

    await this.processor.executeSideEffects(session, sideEffects, opts.tenantId);
    return sideEffects;
  }

  /**
   * P8-012 — Build the `<Connect><Stream/></Connect>` TwiML used when
   * `TWILIO_MEDIA_STREAMS_ENABLED=true`. Called from the /voice route
   * after we've created (or replayed) the session. The Media Streams
   * adapter owns audio + transcripts from there; the Gather code path
   * is bypassed entirely on this branch.
   *
   * The resulting URL is wss:// because Twilio rejects ws:// for any
   * public deployment. Falls back to a relative-ish URL keyed off
   * `publicBaseUrl`'s host when set; otherwise emits an explicit
   * placeholder so a missing publicBaseUrl is loud at deploy time.
   */
  buildStreamTwiML(opts: { sessionId: string; callSid: string }): string {
    const baseRaw = this.deps.publicBaseUrl?.replace(/\/+$/, '') ?? '';
    // Translate http(s):// → ws(s):// so Twilio gets a valid ws URL even
    // when the operator only configured PUBLIC_API_URL.
    const wsBase = baseRaw
      ? baseRaw.replace(/^http(s?):\/\//, 'ws$1://')
      : 'wss://media-streams-base-url-not-configured';
    const streamUrl = `${wsBase}${MEDIA_STREAM_PATH}`;
    return (
      `<?xml version="1.0" encoding="UTF-8"?>` +
      `<Response>` +
      `<Connect>` +
      `<Stream url="${xmlEscape(streamUrl)}">` +
      `<Parameter name="sessionId" value="${xmlEscape(opts.sessionId)}"/>` +
      `<Parameter name="callSid" value="${xmlEscape(opts.callSid)}"/>` +
      `</Stream>` +
      `</Connect>` +
      `</Response>`
    );
  }

  /**
   * P8-012 — Drive a single speech turn through the FSM and return the
   * resulting side effects (without rendering TwiML). Used by the
   * Media Streams adapter on a `final` Deepgram transcript.
   *
   * Behaviorally equivalent to `_handleGatherLocked` minus the TwiML
   * build step and minus the automatic per-session lock — the caller
   * is responsible for wrapping in `withSessionLock`.
   *
   * Returns the full side-effect array including any tts_play and
   * end_session emitted by the FSM. The caller decides how to render
   * those (TTS synthesis for the WS path; <Say> for Gather).
   */
  async processCallerUtterance(opts: {
    sessionId: string;
    callSid: string;
    speechResult: string;
    tenantId: string;
  }): Promise<SideEffect[]> {
    const session = this.deps.store.get(opts.sessionId);
    if (!session) {
      logger.warn('processCallerUtterance: unknown session', { sessionId: opts.sessionId });
      return [
        { type: 'tts_play', payload: { text: "I'm sorry, your session has ended. Please call again." } },
        { type: 'end_session', payload: { reason: 'session_not_found' } },
      ];
    }

    // Always append utterance to transcript first so it is captured
    // regardless of the path below (frustration escalation or normal turn).
    this.deps.store.appendTranscript(opts.sessionId, {
      speaker: 'caller',
      text: opts.speechResult,
      ts: Date.now(),
    });

    // B3.2 — keyword frustration check BEFORE intent classification.
    // Route through the processor so notify_oncall (and any escalation
    // side effects added by the FSM) actually fire — the mediastream
    // adapter's emitSideEffects only handles tts_play/quality events.
    const frustration = detectFrustration(opts.speechResult);
    const triggers = session.machine.currentContext.escalationTriggers;
    if (
      frustration.matched &&
      (!triggers || triggers.trigger_keyword_frustration)
    ) {
      const sideEffects = session.machine.dispatch({
        type: 'frustration_detected',
        source: 'keyword',
        detail: frustration.keyword,
      });
      await this.processor.executeSideEffects(session, sideEffects, opts.tenantId);
      return sideEffects;
    }

    return this.processor.speechTurn({
      session,
      speechResult: opts.speechResult,
      callSid: opts.callSid,
      tenantId: opts.tenantId,
    });
  }

  /**
   * Deliver side effects produced by an out-of-band FSM dispatch (e.g. the
   * mediastream adapter's async LLM-sentiment escalation, which dispatches
   * `frustration_detected` outside a normal speech turn). Routes them through
   * the same processor path a normal turn uses so `notify_oncall` and
   * `audit_log` actually fire — the mediastream adapter's `emitSideEffects`
   * only renders `tts_play`.
   */
  async deliverOutOfBandEffects(
    session: VoiceSession,
    effects: SideEffect[],
    tenantId: string,
  ): Promise<void> {
    await this.processor.executeSideEffects(session, effects, tenantId);
  }

  /**
   * Handle the initial `POST /api/telephony/voice` webhook.
   * Creates a session, runs the disclose_recording + identify_caller
   * skills, drives the FSM through `incoming_call`, and returns TwiML.
   */
  async handleInbound(opts: {
    callSid: string;
    from: string;
    to: string;
    tenantId: string;
  }): Promise<string> {
    // CallSid replay protection: Twilio retries the /voice webhook if it
    // doesn't get a 2xx in time. Without this, every retry creates a
    // fresh session AND fires duplicate audit/notify_oncall side effects.
    // We rebuild the same greeting TwiML for the existing session.
    const existing = this.deps.store.findByCallSid(opts.callSid);
    if (existing && existing.tenantId === opts.tenantId) {
      logger.info('handleInbound: replay for existing CallSid — reusing session', {
        callSid: opts.callSid,
        sessionId: existing.id,
      });
      return buildTwiML(
        [{ type: 'tts_play', payload: { text: t('greeting.one_moment', existing.language ?? 'en') } }],
        {
          gatherActionUrl: this.gatherUrl(existing.id),
          ...(existing.language ? { language: existing.language } : {}),
          ...(existing.ttsVoice ? { voiceOverride: existing.ttsVoice } : {}),
        },
      );
    }

    const repairTemplatesForInbound = this.deps.repairTemplatesResolver
      ? await this.deps.repairTemplatesResolver(opts.tenantId).catch(() => [])
      : [];
    const escalationTriggers = await this.resolveEscalationTriggers(opts.tenantId);
    // RV-070 — owner-line recognition happens at session establishment:
    // recognized owner line (caller-ID match; see approver-identity.ts).
    const ownerSession = await this.resolveOwnerSession(opts.tenantId, opts.from);
    const session = this.deps.store.create(opts.tenantId, 'telephony', {
      callSid: opts.callSid,
      ...(repairTemplatesForInbound.length > 0 ? { repairTemplates: repairTemplatesForInbound } : {}),
      ...(escalationTriggers ? { escalationTriggers } : {}),
      ...(ownerSession ? { ownerSession: true } : {}),
    });
    this.persistVoiceSessionRow(session, opts.callSid);

    // P18-001: record the caller-id (or "" when blocked/withheld) so
    // the create_customer voice flow can use it as the new customer's
    // primaryPhone without re-prompting.
    this.callerIdBySession.set(session.id, opts.from ?? '');

    // P11-002: resolve spoken language + TTS voice (tenant default) and pin
    // them on the session so the greeting, disclosure, and every TwiML build
    // speak it in the right language/voice.
    const { language, ttsVoice, supportedLanguages } = await this.resolveTenantLanguage(opts.tenantId);
    session.language = language;
    session.ttsVoice = ttsVoice;
    if (supportedLanguages) session.supportedLanguages = supportedLanguages;

    // 1. Disclose recording (text generation; no TTS — Twilio <Say> handles audio).
    const disclosure = await discloseRecording({
      tenantId: opts.tenantId,
      channel: 'telephony',
      businessName: this.deps.businessName,
      language,
    });

    // 2. Identify caller. Skill requires a Pool; if we don't have one (dev),
    //    skip and treat as unknown_caller below.
    let callerKnown: { customerId: string; customerName: string } | null = null;
    let identifyFailed = false;
    if (this.deps.pool) {
      try {
        const result = await identifyCaller({
          tenantId: opts.tenantId,
          fromPhone: opts.from,
          pool: this.deps.pool,
        });
        if (result.status === 'matched') {
          callerKnown = {
            customerId: result.customerId,
            customerName: result.customerName,
          };
        }
      } catch (err) {
        logger.error('identifyCaller failed', {
          error: err instanceof Error ? err.message : String(err),
          callSid: opts.callSid,
        });
        identifyFailed = true;
      }
    }

    // 3. Dispatch incoming_call → greeting state.
    const sideEffectsAll: SideEffect[] = [];
    sideEffectsAll.push(
      ...session.machine.dispatch({
        type: 'incoming_call',
        callSid: opts.callSid,
        from: opts.from,
        to: opts.to,
        tenantId: opts.tenantId,
      })
    );

    // 4. Replace the placeholder 'greeting' tts_play with the actual greeting
    //    + disclosure copy. B1: resolve per-tenant persona first (best-effort).
    let persona: VoicePersona | null | undefined;
    if (this.deps.voicePersonaResolver) {
      try {
        persona = await this.deps.voicePersonaResolver(opts.tenantId);
      } catch {
        persona = undefined;
      }
    }
    const greetingText = buildTelephonyGreeting(
      this.deps.businessName,
      disclosure.disclosureText,
      persona,
      language,
    );

    const expanded = sideEffectsAll.map((fx) => {
      if (fx.type === 'tts_play' && fx.payload.text === 'greeting') {
        return { ...fx, payload: { ...fx.payload, text: greetingText } };
      }
      return fx;
    });

    // 5. Drive FSM forward: greeted_ok → identifying, then caller_known,
    //    caller_identification_failed, or unknown_caller. We escalate on
    //    identifyFailed (DB error) instead of falling through to anonymous,
    //    which would create proposals against the wrong customer.
    expanded.push(...session.machine.dispatch({ type: 'greeted_ok' }));

    if (callerKnown) {
      session.customerId = callerKnown.customerId;
      expanded.push(
        ...session.machine.dispatch({
          type: 'caller_known',
          customerId: callerKnown.customerId,
        })
      );
    } else if (identifyFailed) {
      expanded.push(
        ...session.machine.dispatch({
          type: 'caller_identification_failed',
          reason: 'identify_caller_threw',
        })
      );
    } else {
      // Unknown caller: best-effort find-or-create a CRM lead so the call
      // lands in the kanban. Failure here must NOT fail the call — we log
      // and fall through to the FSM's unknown_caller path either way.
      if (this.deps.leadRepo) {
        try {
          const result = await findOrCreateLeadByPhone({
            tenantId: opts.tenantId,
            fromPhone: opts.from,
            leadRepo: this.deps.leadRepo,
            ...(this.deps.auditRepo ? { auditRepo: this.deps.auditRepo } : {}),
            systemActorId: this.deps.systemActorId ?? 'system:inbound-call',
          });
          session.leadId = result.leadId;
          logger.info('inbound call lead resolved', {
            callSid: opts.callSid,
            sessionId: session.id,
            leadStatus: result.status,
          });
        } catch (err) {
          logger.error('findOrCreateLeadByPhone failed', {
            callSid: opts.callSid,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
      expanded.push(...session.machine.dispatch({ type: 'unknown_caller' }));
    }

    // 6. Execute non-TwiML side effects (audit_log, create_proposal,
    //    notify_oncall) against the wired repos.
    await this.processor.executeSideEffects(session, expanded, opts.tenantId);

    // 7. Build TwiML — P8-013 may have produced a <Dial> transfer for
    //    the rare case where notify_oncall fires during the inbound
    //    handshake (caller_identification_failed). Honor it here.
    //    Otherwise build standard TwiML; recordingStatusCallback is only
    //    set on the initial inbound response so Twilio doesn't start a
    //    second concurrent recording on each <Gather> turn (P8-014).
    const transferTwiml = this.takePendingTransferTwiml(session.id);
    const twiml =
      transferTwiml ??
      buildTwiML(expanded, {
        gatherActionUrl: this.gatherUrl(session.id),
        ...(session.language ? { language: session.language } : {}),
        ...(session.ttsVoice ? { voiceOverride: session.ttsVoice } : {}),
        ...(this.deps.recordingCallbackPath
          ? { recordingStatusCallback: this.recordingCallbackUrl() }
          : {}),
      });

    // 8. If the FSM drove straight to 'terminated' (escalation chain
    //    that emits end_session), kick off the summary so call_summaries
    //    captures even calls that never reached intent_capture.
    if (session.machine.currentState === 'terminated' && !session.ended) {
      session.ended = true;
      this.processor.finalizeTerminatedSession(session, expanded, 'caller_hangup');
      void this.processor.runSummary(session).catch(() => {
        /* swallow — summary is best-effort */
      });
    }

    return twiml;
  }

  /**
   * Handle a `<Gather>` callback — the caller spoke, Twilio sent us the
   * transcript. Classify intent → drive FSM → emit next TwiML.
   */
  async handleGather(opts: {
    sessionId: string;
    callSid: string;
    speechResult: string;
    confidence: number;
    tenantId: string;
  }): Promise<string> {
    // Per-session lock: Twilio retries (or duplicate webhook deliveries)
    // for the same sessionId could otherwise interleave FSM dispatch +
    // transcript writes. Same primitive as the in-app adapter.
    return this.deps.store.withSessionLock(opts.sessionId, () => this._handleGatherLocked(opts));
  }

  private async _handleGatherLocked(opts: {
    sessionId: string;
    callSid: string;
    speechResult: string;
    confidence: number;
    tenantId: string;
  }): Promise<string> {
    const session = this.deps.store.get(opts.sessionId);
    if (!session) {
      logger.warn('handleGather: unknown session', { sessionId: opts.sessionId });
      return buildTwiML(
        [
          { type: 'tts_play', payload: { text: "I'm sorry, your session has ended. Please call again." } },
          { type: 'end_session', payload: { reason: 'session_not_found' } },
        ],
        { gatherActionUrl: this.gatherUrl(opts.sessionId) },
      );
    }

    // 1. Append caller utterance to transcript first — must happen before
    //    any early-exit path so the utterance is never lost.
    this.deps.store.appendTranscript(opts.sessionId, {
      speaker: 'caller',
      text: opts.speechResult,
      ts: Date.now(),
    });

    // B3.2 — keyword frustration check on the PSTN/Gather path, mirroring
    // the same guard in processCallerUtterance (WS path). Runs after the
    // transcript append so the triggering utterance is always captured.
    const gatherFrustration = detectFrustration(opts.speechResult);
    if (gatherFrustration.matched) {
      const frustrationEffects = session.machine.dispatch({
        type: 'frustration_detected',
        source: 'keyword',
        detail: gatherFrustration.keyword,
      });
      await this.processor.executeSideEffects(session, frustrationEffects, opts.tenantId);
      return this.finalizeTwiml(session, frustrationEffects, opts.sessionId);
    }

    // RV-071 — an in-flight owner approval dialogue (readback awaiting the
    // explicit yes, clarification list, or challenge) consumes this turn.
    // Runs before the empty-speech check: silence while a readback is
    // pending means "no action — keep it for later", not a reprompt.
    const approvalTurn = await this.processor.handlePendingVoiceApproval(
      session,
      opts.speechResult,
      opts.tenantId,
    );
    if (approvalTurn) {
      await this.processor.executeSideEffects(session, approvalTurn, opts.tenantId);
      return this.finalizeTwiml(session, approvalTurn, opts.sessionId);
    }

    const sideEffectsAll: SideEffect[] = [];
    const currentState = session.machine.currentState;

    // Empty SpeechResult (silent caller / Twilio timeout) maps to a
    // confidence_low so the bounded reprompt path kicks in instead of
    // running the classifier on an empty string.
    if (opts.speechResult.trim().length === 0) {
      sideEffectsAll.push(
        ...session.machine.dispatch({
          type: 'confidence_low',
          threshold: TAU_INT,
          score: 0,
        }),
      );
      await this.processor.executeSideEffects(session, sideEffectsAll, opts.tenantId);
      return this.finalizeTwiml(session, sideEffectsAll, opts.sessionId);
    }

    // 2. Branch on FSM state.
    if (currentState === 'intent_confirm') {
      // confirm_intent: caller is responding to a yes/no readback.
      try {
        const ctx = session.machine.currentContext;
        const intentSummary = ctx.currentIntent ?? 'that';
        const confirmation = await confirmIntent({
          intentSummary,
          callerResponse: opts.speechResult,
          tenantId: opts.tenantId,
          gateway: this.deps.gateway,
        });
        // Wire token usage into the cost tracker.
        const capExceeded = this.processor.recordCost(session, confirmation.tokenUsage);
        if (capExceeded) {
          sideEffectsAll.push(...session.machine.dispatch({ type: 'cost_cap_exceeded' }));
        } else if (confirmation.confirmed) {
          sideEffectsAll.push(...session.machine.dispatch({ type: 'confirmed' }));
        } else {
          sideEffectsAll.push(
            ...session.machine.dispatch({
              type: 'correction',
              newTranscript: confirmation.correction ?? opts.speechResult,
            })
          );
        }
      } catch (err) {
        logger.error('confirmIntent failed', {
          error: err instanceof Error ? err.message : String(err),
          sessionId: opts.sessionId,
        });
        // Treat as correction so the caller is re-prompted, not auto-queued.
        sideEffectsAll.push(
          ...session.machine.dispatch({
            type: 'correction',
            newTranscript: opts.speechResult,
          })
        );
      }
    } else if (currentState === 'intent_capture' || currentState === 'closing') {
      // 3. Classify intent. Failure → confidence_low so the bounded
      //    reprompt path triggers instead of bubbling 5xx out to Twilio
      //    (which would hang the caller mid-call).
      let classifierEvent: CallingAgentEvent | null = null;
      let classifiedIntentType: string | undefined;
      const verticalPromptSection = await this.processor.resolveVerticalPromptSection(opts.tenantId);
      const planPromptSection = await this.processor.resolvePlanPromptSection(
        opts.tenantId,
        session.customerId,
      );
      try {
        const classification = await classifyIntent(
          opts.speechResult,
          {
            tenantId: opts.tenantId,
            verticalPromptSection,
            planPromptSection,
            // RV-071 — appended ONLY on verified owner sessions so every
            // other call's prompt stays byte-identical (cassette hashes).
            ...(session.machine.currentContext.ownerSession === true
              ? { ownerSession: true }
              : {}),
          },
          this.deps.gateway,
        );
        // VQ-003: surface the classifier outcome for the harness.
        session.events.emit(
          'voice-event',
          intentClassifiedEvent({
            intentType: classification.intentType,
            confidence: classification.confidence,
            tokenUsage: classification.tokenUsage,
          }),
        );
        const capExceeded = this.processor.recordCost(session, classification.tokenUsage);
        if (capExceeded) {
          classifierEvent = { type: 'cost_cap_exceeded' };
        } else if (classification.confidence >= TAU_INT && classification.intentType !== 'unknown') {
          classifiedIntentType = classification.intentType;
          classifierEvent = {
            type: 'intent_classified',
            intentType: classification.intentType,
            entities: (classification.extractedEntities ?? {}) as Record<string, unknown>,
            confidence: classification.confidence,
          };
        } else {
          classifierEvent = {
            type: 'confidence_low',
            threshold: TAU_INT,
            score: classification.confidence,
          };
        }
      } catch (err) {
        logger.error('classifyIntent failed in handleGather', {
          error: err instanceof Error ? err.message : String(err),
          sessionId: opts.sessionId,
        });
        classifierEvent = { type: 'confidence_low', threshold: TAU_INT, score: 0 };
      }

      // P11-001: lookup intents bypass the proposal-draft path. Route
      // to the corresponding skill, push its `summary` into the
      // tts_play stream, and DO NOT dispatch `intent_classified` —
      // the FSM stays in `intent_capture` so the next <Gather> turn
      // re-enters with "Anything else I can help you with?".
      if (
        classifiedIntentType &&
        isLookupIntent(classifiedIntentType as Parameters<typeof isLookupIntent>[0])
      ) {
        const lookupSummary = await this.runLookupSkill(
          session,
          classifiedIntentType,
          opts.tenantId,
        );
        sideEffectsAll.push({
          type: 'tts_play',
          payload: { text: lookupSummary, source: 'lookup_skill' },
        });
        sideEffectsAll.push({
          type: 'tts_play',
          payload: { text: 'Anything else I can help you with?' },
        });
        await this.processor.executeSideEffects(session, sideEffectsAll, opts.tenantId);
        return this.finalizeTwiml(session, sideEffectsAll, opts.sessionId);
      }

      // RV-071 — owner voice approval. Routed OUTSIDE the FSM (the same
      // pattern as the lookup skills above: state stays in
      // intent_capture/closing; the dialogue rides the session). The
      // processor hard-gates on the RV-070 ownerSession flag — a
      // non-owner "approve" falls into the normal reprompt path.
      if (
        classifierEvent.type === 'intent_classified' &&
        isVoiceApprovalIntent(classifierEvent.intentType)
      ) {
        const approvalFx = await this.processor.handleVoiceApprovalIntent(session, {
          intentType: classifierEvent.intentType,
          entities: classifierEvent.entities,
          utterance: opts.speechResult,
          tenantId: opts.tenantId,
        });
        sideEffectsAll.push(...approvalFx);
        await this.processor.executeSideEffects(session, sideEffectsAll, opts.tenantId);
        return this.finalizeTwiml(session, sideEffectsAll, opts.sessionId);
      }

      // P18-001: `create_customer` runs through a dedicated task handler
      // so the proposal payload uses the contract-validated shape
      // (name + caller-ID phone + optional email) instead of the
      // generic { intent, entities } envelope `handleCreateProposal`
      // would emit. Bypasses the FSM's `entity_resolution` →
      // `intent_confirm` round-trip — identity creation always asks
      // a human, so we go straight from "intent classified" to
      // "proposal queued" + the confirmation TTS (AC-5).
      if (
        classifierEvent.type === 'intent_classified' &&
        classifiedIntentType === 'create_customer'
      ) {
        const handled = await this.handleCreateCustomerVoiceIntent(
          session,
          classifierEvent.entities,
          classifierEvent.confidence,
          opts,
          sideEffectsAll,
        );
        if (handled) {
          await this.processor.executeSideEffects(session, sideEffectsAll, opts.tenantId);
          return this.finalizeTwiml(session, sideEffectsAll, opts.sessionId);
        }
      }

      sideEffectsAll.push(...session.machine.dispatch(classifierEvent));

      // After intent_classified, the FSM is in 'entity_resolution' (unless
      // emergency_dispatch fast-path took us to 'escalating'). For Gather
      // mode we don't run a separate entity-resolver — auto-advance with
      // entity_resolved using whatever entities the classifier extracted
      // so the FSM proceeds to intent_confirm.
      if (
        classifierEvent.type === 'intent_classified' &&
        session.machine.currentState === 'entity_resolution'
      ) {
        // Forward classifier-extracted string entities (customerName,
        // jobReference, etc.) into the FSM context. Without this, the
        // entities pulled from the caller's utterance would be lost
        // before intent_confirm and any downstream proposal builder
        // would see an empty extractedEntities map.
        const refs: Record<string, string> = {};
        for (const [k, v] of Object.entries(classifierEvent.entities)) {
          if (typeof v === 'string') refs[k] = v;
        }
        sideEffectsAll.push(
          ...session.machine.dispatch({ type: 'entity_resolved', refs }),
        );
        this.processor.expandIntentConfirmTemplate(sideEffectsAll, classifierEvent.intentType);
      }
    } else {
      // Other states: log and reprompt with a generic message. Treat as a
      // confidence_low so the FSM's normal retry/escalate logic applies.
      logger.info('handleGather: unhandled state, treating as confidence_low', {
        state: currentState,
        sessionId: opts.sessionId,
      });
      sideEffectsAll.push(
        ...session.machine.dispatch({
          type: 'confidence_low',
          threshold: TAU_INT,
          score: 0,
        })
      );
    }

    await this.processor.executeSideEffects(session, sideEffectsAll, opts.tenantId);
    return this.finalizeTwiml(session, sideEffectsAll, opts.sessionId);
  }

  /**
   * Build TwiML and, when the FSM has reached `terminated`, kick off
   * the end-of-call summary in the background. Centralizes the
   * end-of-handler wrap-up shared by handleGather and handleInbound.
   */
  private async finalizeTwiml(
    session: VoiceSession,
    sideEffects: SideEffect[],
    sessionId: string,
  ): Promise<string> {
    // P8-013: when a notify_oncall side effect produced a <Dial>
    // transfer descriptor, we hand back that TwiML directly instead
    // of looping into another <Gather>. Twilio will POST the dial
    // result back to /dial-result, which advances the rotation.
    const transferTwiml = this.takePendingTransferTwiml(sessionId);
    if (transferTwiml) {
      // Still capture any agent TTS line for the transcript so
      // summarizeSession can see "the agent said: connecting you...".
      appendAgentTts(this.deps.store, sessionId, sideEffects);
      return transferTwiml;
    }

    const twiml = buildTwiML(sideEffects, {
      gatherActionUrl: this.gatherUrl(sessionId),
      ...(session.language ? { language: session.language } : {}),
      ...(session.ttsVoice ? { voiceOverride: session.ttsVoice } : {}),
    });
    // Capture the agent's reply so summarizeSession sees both sides
    // of the conversation, not just the caller turns.
    appendAgentTts(this.deps.store, sessionId, sideEffects);
    if (session.machine.currentState === 'terminated' && !session.ended) {
      session.ended = true;
      this.processor.finalizeTerminatedSession(session, sideEffects, 'caller_hangup');
      void this.processor.runSummary(session).catch(() => {
        /* swallow — summary is best-effort */
      });
    }
    return twiml;
  }

  /** Build the absolute Gather action URL. */
  private gatherUrl(sessionId: string): string {
    const path = `/api/telephony/gather?sid=${encodeURIComponent(sessionId)}`;
    if (this.deps.publicBaseUrl) {
      return `${this.deps.publicBaseUrl.replace(/\/+$/, '')}${path}`;
    }
    return path;
  }

  /**
   * Absolute URL Twilio POSTs the finalized recording metadata to.
   * Caller verified `recordingCallbackPath` is set before calling.
   */
  private recordingCallbackUrl(): string {
    const path = this.deps.recordingCallbackPath ?? '/api/telephony/recording';
    if (this.deps.publicBaseUrl) {
      return `${this.deps.publicBaseUrl.replace(/\/+$/, '')}${path}`;
    }
    return path;
  }

  /**
   * P11-001: dispatch a `lookup_*` intent to the corresponding read-only
   * skill and return its TTS-ready `summary`. Always returns a string —
   * a missing wiring or error degrades to a generic "let me get someone"
   * line so the live call never bubbles a 5xx.
   *
   * Caller must guarantee `intentType` starts with `lookup_` (the gate
   * lives at the call site so the routing branch can stay tight).
   */
  private async runLookupSkill(
    session: VoiceSession,
    intentType: string,
    tenantId: string,
  ): Promise<string> {
    const customerId = session.customerId;
    if (!customerId) {
      // Lookups are customer-scoped. An anonymous caller doesn't have
      // an account to read from; we never want to leak a different
      // tenant's summary. Degrade gracefully.
      return "I can't pull up your account without identifying you first. Let me get a person to help.";
    }

    const sharedInput = {
      tenantId,
      customerId,
      sessionId: session.id,
    };

    // VQ-003: time the skill end-to-end and emit `lookup_executed` on
    // the session bus. Both the success and error branches emit so the
    // harness sees that a lookup attempt occurred even when it fell
    // back to the "let me get someone" string. Errors carry the raw
    // message; successes set `success: true` with no error field.
    const startMs = Date.now();
    try {
      switch (intentType) {
        case 'lookup_appointments': {
          if (!this.deps.jobRepo || !this.deps.appointmentRepo) {
            return this.lookupNotWiredFallback();
          }
          const result = await lookupAppointments(sharedInput, {
            jobRepo: this.deps.jobRepo,
            appointmentRepo: this.deps.appointmentRepo,
            ...(this.deps.lookupEvents ? { lookupEvents: this.deps.lookupEvents } : {}),
          });
          session.events.emit(
            'voice-event',
            lookupExecutedEvent(intentType, Date.now() - startMs, true),
          );
          return result.summary;
        }
        case 'lookup_invoices': {
          if (!this.deps.jobRepo || !this.deps.invoiceRepo) {
            return this.lookupNotWiredFallback();
          }
          const result = await lookupInvoices(sharedInput, {
            jobRepo: this.deps.jobRepo,
            invoiceRepo: this.deps.invoiceRepo,
            ...(this.deps.lookupEvents ? { lookupEvents: this.deps.lookupEvents } : {}),
          });
          session.events.emit(
            'voice-event',
            lookupExecutedEvent(intentType, Date.now() - startMs, true),
          );
          return result.summary;
        }
        case 'lookup_balance': {
          if (!this.deps.jobRepo || !this.deps.invoiceRepo) {
            return this.lookupNotWiredFallback();
          }
          const result = await lookupBalance(sharedInput, {
            jobRepo: this.deps.jobRepo,
            invoiceRepo: this.deps.invoiceRepo,
            ...(this.deps.lookupEvents ? { lookupEvents: this.deps.lookupEvents } : {}),
          });
          session.events.emit(
            'voice-event',
            lookupExecutedEvent(intentType, Date.now() - startMs, true),
          );
          return result.summary;
        }
        case 'lookup_jobs': {
          if (!this.deps.jobRepo) {
            return this.lookupNotWiredFallback();
          }
          const result = await lookupJobs(sharedInput, {
            jobRepo: this.deps.jobRepo,
            ...(this.deps.lookupEvents ? { lookupEvents: this.deps.lookupEvents } : {}),
          });
          session.events.emit(
            'voice-event',
            lookupExecutedEvent(intentType, Date.now() - startMs, true),
          );
          return result.summary;
        }
        case 'lookup_agreements': {
          if (!this.deps.agreementRepo) {
            return this.lookupNotWiredFallback();
          }
          const result = await lookupAgreements(sharedInput, {
            agreementRepo: this.deps.agreementRepo,
            ...(this.deps.lookupEvents ? { lookupEvents: this.deps.lookupEvents } : {}),
          });
          session.events.emit(
            'voice-event',
            lookupExecutedEvent(intentType, Date.now() - startMs, true),
          );
          return result.summary;
        }
        case 'lookup_account_summary': {
          if (
            !this.deps.jobRepo ||
            !this.deps.appointmentRepo ||
            !this.deps.invoiceRepo ||
            !this.deps.agreementRepo
          ) {
            return this.lookupNotWiredFallback();
          }
          const result = await lookupAccountSummary(sharedInput, {
            jobRepo: this.deps.jobRepo,
            appointmentRepo: this.deps.appointmentRepo,
            invoiceRepo: this.deps.invoiceRepo,
            agreementRepo: this.deps.agreementRepo,
            ...(this.deps.lookupEvents ? { lookupEvents: this.deps.lookupEvents } : {}),
          });
          session.events.emit(
            'voice-event',
            lookupExecutedEvent(intentType, Date.now() - startMs, true),
          );
          return result.summary;
        }
        case 'lookup_customer': {
          if (!this.deps.customerRepo) {
            return this.lookupNotWiredFallback();
          }
          // The caller is already identity-resolved (customerId in
          // session) — use that as the fuzzy-lookup target so the
          // skill returns the record matching this caller, not a
          // free-form fuzzy phone search.
          const result = await lookupCustomer(
            {
              tenantId,
              identifier: { type: 'id', value: customerId },
              sessionId: session.id,
            },
            {
              customerRepo: this.deps.customerRepo,
              ...(this.deps.lookupEvents ? { lookupEvents: this.deps.lookupEvents } : {}),
            },
          );
          session.events.emit(
            'voice-event',
            lookupExecutedEvent(intentType, Date.now() - startMs, true),
          );
          return result.summary;
        }
        case 'lookup_estimates': {
          if (!this.deps.jobRepo || !this.deps.estimateRepo) {
            return this.lookupNotWiredFallback();
          }
          const result = await lookupEstimates(sharedInput, {
            jobRepo: this.deps.jobRepo,
            estimateRepo: this.deps.estimateRepo,
            ...(this.deps.lookupEvents ? { lookupEvents: this.deps.lookupEvents } : {}),
          });
          session.events.emit(
            'voice-event',
            lookupExecutedEvent(intentType, Date.now() - startMs, true),
          );
          return result.summary;
        }
        case 'lookup_leads': {
          if (!this.deps.leadRepo) {
            return this.lookupNotWiredFallback();
          }
          const result = await lookupLeads(
            { tenantId, sessionId: session.id },
            {
              leadRepo: this.deps.leadRepo,
              ...(this.deps.lookupEvents ? { lookupEvents: this.deps.lookupEvents } : {}),
            },
          );
          session.events.emit(
            'voice-event',
            lookupExecutedEvent(intentType, Date.now() - startMs, true),
          );
          return result.summary;
        }
        case 'lookup_revenue': {
          if (!this.deps.moneyDashboardRepo) {
            return this.lookupNotWiredFallback();
          }
          const result = await lookupRevenue(
            { tenantId, sessionId: session.id },
            {
              moneyDashboardRepo: this.deps.moneyDashboardRepo,
              ...(this.deps.lookupEvents ? { lookupEvents: this.deps.lookupEvents } : {}),
            },
          );
          session.events.emit(
            'voice-event',
            lookupExecutedEvent(intentType, Date.now() - startMs, true),
          );
          return result.summary;
        }
        case 'lookup_catalog': {
          if (!this.deps.catalogRepo) {
            return this.lookupNotWiredFallback();
          }
          const result = await lookupCatalog(
            { tenantId, sessionId: session.id },
            {
              catalogRepo: this.deps.catalogRepo,
              ...(this.deps.lookupEvents ? { lookupEvents: this.deps.lookupEvents } : {}),
            },
          );
          session.events.emit(
            'voice-event',
            lookupExecutedEvent(intentType, Date.now() - startMs, true),
          );
          return result.summary;
        }
        case 'lookup_availability': {
          if (!this.deps.availabilityFinder) {
            return this.lookupNotWiredFallback();
          }
          const from = new Date();
          const result = await lookupAvailability(
            {
              tenantId,
              searchFrom: from,
              searchTo: new Date(from.getTime() + 14 * 24 * 60 * 60 * 1000),
              durationMs: 2 * 60 * 60 * 1000,
            },
            this.deps.availabilityFinder,
          );
          session.events.emit(
            'voice-event',
            lookupExecutedEvent(intentType, Date.now() - startMs, true),
          );
          return result.status === 'unavailable'
            ? this.lookupNotWiredFallback()
            : result.message;
        }
        default:
          return this.lookupNotWiredFallback();
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.warn('runLookupSkill failed', {
        sessionId: session.id,
        intentType,
        error: message,
      });
      session.events.emit(
        'voice-event',
        lookupExecutedEvent(intentType, Date.now() - startMs, false, message),
      );
      return this.lookupNotWiredFallback();
    }
  }

  private lookupNotWiredFallback(): string {
    return "I'm having trouble pulling that up right now. Let me get a person to help.";
  }

  /**
   * P18-001 — `create_customer` voice flow.
   *
   * Runs the `CreateCustomerVoiceTaskHandler` to build a contract-shaped
   * proposal (name + caller-id phone + optional email) and persists it
   * via the wired proposalRepo. Always asks a human to approve — money
   * / identity creation is never auto-executed (D3, CLAUDE.md).
   *
   * Returns true when the create_customer flow handled this turn end-
   * to-end (the caller emits its TwiML and skips the FSM
   * `intent_classified` → `intent_confirm` round-trip). Returns false
   * when the precondition isn't met (e.g. caller already a customer)
   * so the caller falls back to the standard FSM dispatch.
   */
  private async handleCreateCustomerVoiceIntent(
    session: VoiceSession,
    classifierEntities: Record<string, unknown>,
    classifierConfidence: number,
    opts: { sessionId: string; callSid: string; tenantId: string; speechResult: string },
    sideEffectsAll: SideEffect[],
  ): Promise<boolean> {
    // Caller already matched — confirm identity instead.
    if (session.customerId) {
      sideEffectsAll.push({
        type: 'tts_play',
        payload: {
          text:
            "I've got you in our system already. Let me know what you'd like help with today.",
        },
      });
      return true;
    }

    const callerIdRaw = this.callerIdBySession.get(opts.sessionId);
    const phoneBlocked = isBlockedCallerId(callerIdRaw);
    const callerIdPhone = phoneBlocked ? undefined : callerIdRaw;

    const handler = new CreateCustomerVoiceTaskHandler();
    const outcome = await handler.run({
      tenantId: opts.tenantId,
      message: opts.speechResult,
      conversationId: session.id,
      userId: this.deps.systemActorId ?? 'voice_agent',
      existingEntities: {
        ...classifierEntities,
        callerIdPhone,
        phoneBlocked,
        sessionId: session.id,
        callSid: session.callSid,
        correlationId: session.id,
        classifierConfidence,
        ...(session.leadId ? { existingLeadId: session.leadId } : {}),
      },
    });

    if (outcome.status === 'needs_name') {
      sideEffectsAll.push({
        type: 'tts_play',
        payload: {
          text: "Of course — could I get your name to get you set up?",
        },
      });
      return true;
    }

    if (outcome.status === 'needs_callback') {
      sideEffectsAll.push({
        type: 'tts_play',
        payload: {
          text:
            "I'm sorry, I couldn't see your number. What's the best phone number to reach you on?",
        },
      });
      return true;
    }

    if (!outcome.proposal) {
      return false;
    }

    // Persist the proposal directly so we control the payload shape
    // (instead of going through `handleCreateProposal` which builds
    // the generic { intent, entities } envelope).
    if (!this.deps.proposalRepo) {
      logger.warn('create_customer: proposalRepo not wired; skipping persist', {
        sessionId: session.id,
      });
      sideEffectsAll.push({
        type: 'tts_play',
        payload: { text: CREATE_CUSTOMER_CONFIRMATION_TTS },
      });
      return true;
    }

    try {
      const stored = await this.deps.proposalRepo.create(outcome.proposal);
      session.proposalIds.push(stored.id);
      // Audit row tying the proposal back to the voice session.
      if (this.deps.auditRepo) {
        try {
          const ev = createAuditEvent({
            tenantId: opts.tenantId,
            actorId: this.deps.systemActorId ?? 'voice_agent',
            actorRole: 'system',
            eventType: 'proposal.created',
            entityType: 'proposal',
            entityId: stored.id,
            correlationId: session.id,
            metadata: {
              proposalType: 'create_customer',
              source: 'voice',
              sessionId: session.id,
              callSid: session.callSid,
              classifierConfidence,
            },
          });
          await this.deps.auditRepo.create(ev);
        } catch (err) {
          logger.warn('create_customer: audit persist failed', {
            error: err instanceof Error ? err.message : String(err),
            sessionId: session.id,
          });
        }
      }
      sideEffectsAll.push({
        type: 'tts_play',
        payload: { text: CREATE_CUSTOMER_CONFIRMATION_TTS },
      });
      return true;
    } catch (err) {
      logger.warn('create_customer: persist failed', {
        error: err instanceof Error ? err.message : String(err),
        sessionId: session.id,
      });
      sideEffectsAll.push({
        type: 'tts_play',
        payload: {
          text:
            "I'm having trouble saving that. Let me get a person to help you finish signing up.",
        },
      });
      return true;
    }
  }

  /**
   * Queue the `customer_callback_required` proposal when the rotation
   * cascade is exhausted. Idempotent against the session: subsequent
   * calls (e.g. if the caller redials) will create a new proposal,
   * which is intentional — operators want one row per request.
   *
   * Public so the route layer (`/dial-result`) can call it after
   * walking the rotation cursor off the end.
   */
  async queueCallbackProposal(
    session: VoiceSession,
    tenantId: string,
    reason: string,
    outcome: 'rotation_empty' | 'rotation_exhausted',
  ): Promise<void> {
    if (!this.deps.proposalRepo) {
      logger.warn('queueCallbackProposal: proposalRepo not wired', {
        sessionId: session.id,
        outcome,
      });
      return;
    }
    try {
      const tenantThresholdOverride = await this.processor.resolveThresholdOverride(tenantId);
      const proposal = buildProposal({
        tenantId,
        // No dedicated `customer_callback_required` ProposalType
        // exists; voice_clarification is the closest existing bucket
        // (it's the "needs human follow-up" capture-class proposal).
        // The semantic intent rides in payload.intent so the review
        // UI / future executor can branch on it.
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
        aiRunId: uuidv4(),
        createdBy: this.deps.systemActorId ?? 'calling-agent',
        ...(tenantThresholdOverride ? { tenantThresholdOverride } : {}),
      });
      const stored = await this.deps.proposalRepo.create(proposal);
      session.proposalIds.push(stored.id);

      // Audit for parity with normal escalation paths: operators
      // searching for "callback queued" want a single audit row to
      // jump from.
      if (this.deps.auditRepo) {
        try {
          const auditEvent = createAuditEvent({
            tenantId,
            actorId: this.deps.systemActorId ?? 'calling-agent',
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
          await this.deps.auditRepo.create(auditEvent);
        } catch (err) {
          logger.warn('queueCallbackProposal: audit persist failed', {
            error: err instanceof Error ? err.message : String(err),
            sessionId: session.id,
          });
        }
      }

      // Drop the rotation cursor — the call is done with the dial flow.
      this.deps.callControl?.clearCursor(session.id);
    } catch (err) {
      logger.warn('queueCallbackProposal failed', {
        error: err instanceof Error ? err.message : String(err),
        sessionId: session.id,
      });
    }
  }

  /**
   * Public accessor for the route layer (`/dial-result`) so the
   * dispatcher rotation cascade can walk the same rotation as the
   * initial escalation.
   */
  getDeps(): Readonly<TwilioAdapterDeps> {
    return this.deps;
  }

  /**
   * Pop the pending transfer TwiML for a session, if any. Used by
   * the route layer to short-circuit the normal Gather response when
   * the escalation flow produced a `<Dial>`.
   */
  takePendingTransferTwiml(sessionId: string): string | undefined {
    const twiml = this.pendingTransferTwiml.get(sessionId);
    if (twiml) this.pendingTransferTwiml.delete(sessionId);
    return twiml;
  }

  /**
   * Store a pending <Dial> TwiML string for the given session. Called by
   * `TwilioMediaStreamAdapter` via a deps callback so both the gather
   * adapter (which reads via `takePendingTransferTwiml`) and the media-stream
   * adapter (which writes during `handleEscalateWithContext`) share the same
   * in-memory Map. Without this, the Dial TwiML would be written to
   * `state.pendingTransferTwiml` on the media-stream adapter where nothing
   * ever reads it — the call would hang on hold forever.
   */
  setPendingTransferTwiml(sessionId: string, twiml: string): void {
    this.pendingTransferTwiml.set(sessionId, twiml);
  }

  /**
   * B2 — derive the typed CallOutcome from FSM state, stash it on the
   * session, and kick off the best-effort `voice_sessions` persist.
   *
   * Public so the route layer (`/dial-result`) and the media-streams
   * `finalizeOnClose` hook can stamp the outcome through a single
   * surface. The actual derive+stash+persist body lives in the shared
   * `VoiceTurnProcessor` so the Layer 2 voice-quality harness sees
   * identical behavior.
   */
  finalizeTerminatedSession(
    session: VoiceSession,
    sideEffects: ReadonlyArray<SideEffect>,
    fallbackReason: string,
  ): void {
    // The processor handles derive-outcome + persist-session-ended in a
    // single delegate. The redundant adapter-side body (legacy
    // deriveCallOutcomeFromState + persistSessionEnded private method)
    // was deleted in Codex P1 round 5: `finalizeTerminatedSession`'s
    // early-return-on-terminalOutcome means the processor's path
    // shadows it for every code path, so the adapter copy was dead and
    // was the source of the dropped transcript+customerId bug (the
    // adapter copy included those fields; the processor copy did not).
    this.processor.finalizeTerminatedSession(session, sideEffects, fallbackReason);
    if (session.terminalOutcome) return;
    const endSessionEffect = [...sideEffects].reverse().find((e) => e.type === 'end_session');
    const reason =
      (endSessionEffect && typeof endSessionEffect.payload.reason === 'string'
        ? endSessionEffect.payload.reason
        : undefined) ?? fallbackReason;
    const outcome = deriveCallOutcomeFromState({
      finalState: session.machine.currentState,
      endedReason: reason,
      context: session.machine.currentContext,
      transcript: session.transcript,
      proposalIds: session.proposalIds,
    });
    session.terminalOutcome = outcome;
    session.terminalReason = reason;
    void this.persistSessionEnded(session, reason, outcome);
  }

  /**
   * B2 — async DB-write half of `finalizeTerminatedSession`. Always
   * fire-and-forget; errors are swallowed (outcome stamping is
   * best-effort, never breaks a call flow).
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
        channel: session.channel === 'telephony' ? 'voice_inbound' : 'inapp_voice',
        ...(session.callSid !== undefined ? { callSid: session.callSid } : {}),
        // 15.8/15.9 — persist the in-memory transcript so /api/interactions
        // can surface the full conversation without relying on the
        // process-scoped VoiceSessionStore.
        transcript: session.transcript.length > 0 ? [...session.transcript] : undefined,
        // Stamp the customer FK so the interactions list can join to
        // the customers table and surface the linked customer.
        ...(session.customerId !== undefined ? { customerId: session.customerId } : {}),
      });
    } catch {
      /* swallow — outcome stamping is best-effort */
    }
    if (this.deps.onSessionEnded) {
      try {
        await this.deps.onSessionEnded({
          tenantId: session.tenantId,
          channel: session.channel === 'telephony' ? 'voice_inbound' : 'inapp_voice',
          ...(session.callSid !== undefined ? { callSid: session.callSid } : {}),
        });
      } catch {
        /* swallow — nudge check must never block call end */
      }
    }
  }

  private async runSummary(session: VoiceSession): Promise<void> {
    const durationMs = Date.now() - session.createdAt.getTime();

    // Skip when the caller hung up before speaking — there's nothing to
    // summarize and the LLM call wastes tokens generating filler. The
    // outcome stamp below still runs.
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
            gateway: this.deps.gateway,
            ...(intentDetected ? { intentDetected } : {}),
            ...(this.deps.pool ? { pool: this.deps.pool } : {}),
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
        // After bounded retries, don't bubble — the call has ended and the
        // outcome stamp + audit log carry the operationally important data.
        // Logged at warn so on-call sees a visible signal in metrics.
        logger.warn('summarizeSession failed after retries', {
          error: lastErr instanceof Error ? lastErr.message : String(lastErr),
          sessionId: session.id,
          attempts: SUMMARY_RETRY_DELAYS_MS.length + 1,
        });
      }
    }

    const callSid = session.machine.currentContext.callSid;
    if (this.deps.voiceRepo?.stampOutcomeByCallSid && callSid) {
      try {
        await this.deps.voiceRepo.stampOutcomeByCallSid(
          session.tenantId,
          callSid,
          this.deriveCallOutcome(session),
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
   * Stamp the call outcome on the voice_recordings row. Called from
   * runSummary() (best-effort — usually no-ops because Twilio's recording
   * webhook hasn't fired yet) and again from the recording webhook's
   * onPersisted hook (the reliable path — the row exists by then).
   * Idempotent: stampOutcomeByCallSid is a single UPDATE, so duplicate
   * calls just rewrite the same value.
   */
  async stampCallOutcomeByCallSid(opts: {
    tenantId: string;
    callSid: string;
  }): Promise<void> {
    if (!this.deps.voiceRepo?.stampOutcomeByCallSid) return;
    // Use the ended-inclusive lookup: by the time the recording webhook
    // fires onPersisted, the FSM is typically already terminated and
    // session.ended === true, so findByCallSid would return undefined.
    const session = this.deps.store.findByCallSidIncludingEnded(opts.callSid);
    // When the session is genuinely gone (multi-instance deploy, restart, or
    // idle reap), we cannot derive the outcome — leave the column NULL rather
    // than defaulting to 'completed', which would silently overwrite or mask
    // real failed/escalated outcomes in analytics.
    if (!session) return;
    try {
      await this.deps.voiceRepo.stampOutcomeByCallSid(
        opts.tenantId,
        opts.callSid,
        this.deriveCallOutcome(session),
      );
    } catch (err) {
      logger.warn('stampCallOutcomeByCallSid failed', {
        error: err instanceof Error ? err.message : String(err),
        callSid: opts.callSid,
      });
    }
  }

  private deriveCallOutcome(session: VoiceSession): CallOutcome {
    const ctx = session.machine.currentContext;
    if (ctx.escalationReason) {
      if (ctx.escalationReason.startsWith('system_failure')) return 'failed';
      if (ctx.escalationReason.startsWith('cost_cap_exceeded')) return 'failed';
      if (ctx.escalationReason.startsWith('callback_required')) return 'callback_required';
      // abuse_detected terminates the call immediately with no human handoff
      if (ctx.escalationReason.startsWith('abuse_detected')) return 'failed';
      return 'escalated_to_human';
    }
    if (session.proposalIds.length > 0) return 'completed';
    if (ctx.currentIntent && ctx.currentIntent !== 'unknown') return 'completed';
    // No escalation, no proposal, no classified intent. Distinguish "caller
    // hung up before saying anything" (dropped) from "caller spoke but we
    // couldn't classify" (no_intent) by whether any caller turns landed in
    // the transcript.
    const hadCallerSpeech = session.transcript.some((line) => line.startsWith('caller:'));
    if (!hadCallerSpeech) return 'dropped';
    return 'no_intent';
  }
}
