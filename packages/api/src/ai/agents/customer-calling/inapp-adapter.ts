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
import type { AuditRepository } from '../../../audit/audit';
import { createAuditEvent } from '../../../audit/audit';
import type { OnCallRepository } from '../../../oncall/rotation';
import { classifyIntent, CLASSIFIER_CONFIDENCE_THRESHOLD } from '../../orchestration/intent-classifier';
import { escalateToHuman } from '../../skills/escalate-to-human';
import type { EscalationReason } from '../../skills/escalate-to-human';
import { summarizeSession } from '../../skills/summarize-session';
import { estimateCostCents } from '../../skills/session-cost-tracker';
import {
  intentClassifiedEvent,
  costIncurredEvent,
  sessionTerminatedEvent,
} from '../../voice-quality/events';
import { TAU_INT } from './transitions';
import type { CallingAgentEvent, SideEffect } from './types';
import type { VoiceSession, VoiceSessionStore } from './voice-session-store';
import type { VoiceSessionRepository } from '../../../voice/voice-session';
import type { CallOutcome } from '../../../voice/voice-service';
import { deriveCallOutcome } from './outcome-mapper';
import { resolveSchedulingEntities } from './entity-resolution';
import { detectLanguage, renderTtsText } from './tts-copy';
import type { Language } from '../../i18n/i18n';
import { isLanguageSupported } from '../../orchestration/language-detector';
import type { VoicePersona, VoicePersonaResolver } from '../../../settings/voice-persona-resolver';
import type { RepairTemplate } from '../../../verticals/registry';
import type { DroppedCallScheduler } from '../../../sms/recovery/scheduler';

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
   */
  pool?: Pool;
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

export function buildInappGreeting(persona?: VoicePersona | null): string {
  if (persona?.greeting) return persona.greeting;
  if (persona?.agentName) return `Hi, I'm ${persona.agentName}. How can I help today?`;
  return DEFAULT_GREETING_INAPP;
}

/**
 * Map a classifier intent + entities into the FSM event shape.
 *
 * Two thresholds in play here on purpose:
 *  - CLASSIFIER_CONFIDENCE_THRESHOLD (0.6) — below this the classifier
 *    has already coerced intentType to 'unknown'; the threshold value
 *    is reported back to the FSM only for audit/log purposes.
 *  - TAU_INT (0.75) — the FSM's "act on this intent" gate, applied
 *    in transitionIntentCapture. Confidence in the [0.6, 0.75) band
 *    will be classified but reprompted by the FSM. Both adapters
 *    rely on this same FSM gate, so behavior is now consistent.
 */
export function classifierToFsmEvent(
  intentType: string,
  confidence: number,
  entities: Record<string, unknown> | undefined
): CallingAgentEvent {
  if (intentType === 'unknown') {
    return { type: 'confidence_low', threshold: CLASSIFIER_CONFIDENCE_THRESHOLD, score: confidence };
  }
  return {
    type: 'intent_classified',
    intentType,
    entities: entities ?? {},
    confidence,
  };
}

function summaryFor(intent: string | undefined, entities: Record<string, unknown> | undefined): string {
  const name = entities && typeof entities.customerName === 'string' ? entities.customerName : undefined;
  const ref = entities && typeof entities.jobReference === 'string' ? entities.jobReference : undefined;
  if (intent === 'create_invoice') return `Draft invoice${name ? ` for ${name}` : ''}`;
  if (intent === 'draft_estimate') return `Draft estimate${name ? ` for ${name}` : ''}`;
  if (intent === 'create_appointment') return `Schedule appointment${name ? ` for ${name}` : ''}`;
  if (intent === 'emergency_dispatch') return 'Emergency dispatch — escalate to on-call';
  if (intent) return `Voice intent: ${intent}${ref ? ` (${ref})` : ''}`;
  return 'Voice clarification needed';
}

export function intentToProposalType(intent: string | undefined): ProposalType {
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

export class InAppVoiceAdapter {
  constructor(private readonly deps: InAppAdapterDeps) {}

  /**
   * Open a new in-app session. Drives the FSM through the
   * idle → greeting → identifying transitions and synthesizes the
   * greeting audio if a TTS provider is wired.
   *
   * Recording disclosure is intentionally skipped for the inapp channel
   * (consent is captured at account creation; see disclose_recording).
   */
  async startSession(tenantId: string, userId: string, conversationId?: string): Promise<StartSessionResult> {
    const repairTemplates = this.deps.repairTemplatesResolver
      ? await this.deps.repairTemplatesResolver(tenantId).catch(() => [])
      : [];
    const session = this.deps.store.create(tenantId, 'inapp', {
      ...(repairTemplates.length > 0 ? { repairTemplates } : {}),
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

    const callerKnownEffects = session.machine.dispatch({
      type: 'caller_known',
      customerId: userId,
    });
    await this.executeSideEffects(session, callerKnownEffects);

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
    let fsmEvent: CallingAgentEvent;
    let classifierUsage: { input: number; output: number } | undefined;
    try {
      const classification = await classifyIntent(
        text,
        {
          tenantId: session.tenantId,
          verticalPromptSection,
          planPromptSection,
        },
        this.deps.gateway
      );
      classifierUsage = classification.tokenUsage
        ? { input: classification.tokenUsage.input, output: classification.tokenUsage.output }
        : undefined;
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
      fsmEvent = classifierToFsmEvent(
        classification.intentType,
        classification.confidence,
        classification.extractedEntities as Record<string, unknown> | undefined
      );
    } catch {
      fsmEvent = { type: 'confidence_low', threshold: CLASSIFIER_CONFIDENCE_THRESHOLD, score: 0 };
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

    const allSideEffects: SideEffect[] = [];

    // Dispatch the classifier-derived event.
    const effects1 = session.machine.dispatch(fsmEvent);
    allSideEffects.push(...effects1);
    const aggregate1 = await this.executeSideEffects(session, effects1);

    // For high-confidence intents we expect the FSM to land in
    // entity_resolution; auto-resolve to keep the flow progressing
    // without a separate entity-resolution skill (P8 wave 8B simplified
    // path). For phase-1 inapp the entities supplied by the classifier
    // are treated as resolved.
    const stateAfterClassify: string = session.machine.currentState;
    if (
      stateAfterClassify === 'entity_resolution' &&
      fsmEvent.type === 'intent_classified'
    ) {
      const refs: Record<string, string> = {};
      for (const [k, v] of Object.entries(fsmEvent.entities)) {
        if (typeof v === 'string') refs[k] = v;
      }
      // QA-2026-06-05 (SCH-02/03): REAL resolution before entity_resolved —
      // turn customer/job/appointment references and natural-language times
      // into concrete ids/timestamps so the execution contract is satisfied.
      // Best-effort: failures leave refs as-is and the proposal surfaces for
      // operator review.
      if (this.deps.pool) {
        try {
          const concrete = await resolveSchedulingEntities(
            this.deps.pool,
            session.tenantId,
            fsmEvent.intentType,
            fsmEvent.entities,
          );
          Object.assign(refs, concrete);
        } catch {
          // Resolution must never break the call flow.
        }
      }
      const effects2 = session.machine.dispatch({ type: 'entity_resolved', refs });
      allSideEffects.push(...effects2);
      const aggregate2 = await this.executeSideEffects(session, effects2);

      // FSM is now in intent_confirm; auto-confirm in phase-1 (we drive
      // confirmation later when readback is wired into the UI).
      const effects3 = session.machine.dispatch({ type: 'confirmed' });
      allSideEffects.push(...effects3);
      const aggregate3 = await this.executeSideEffects(session, effects3);

      // proposal_draft is the state immediately after `confirmed`. If a
      // proposal was created in aggregate3, push proposal_queued so the
      // FSM proceeds to closing.
      const lastProposalId = aggregate3.lastProposalId
        ?? aggregate2.lastProposalId
        ?? aggregate1.lastProposalId;
      const stateAfterConfirm: string = session.machine.currentState;
      if (stateAfterConfirm === 'proposal_draft' && lastProposalId) {
        const effects4 = session.machine.dispatch({
          type: 'proposal_queued',
          proposalId: lastProposalId,
        });
        allSideEffects.push(...effects4);
        await this.executeSideEffects(session, effects4);
      }
    }

    const last = allSideEffects[allSideEffects.length - 1];
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
    void scheduler
      .schedule({
        tenantId: session.tenantId,
        voiceSessionId: session.id,
        callerE164,
        outcome,
        channel: session.channel,
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
    const summary = summaryFor(intent, entities);

    try {
      // PR B — load tenant threshold override so the Settings UI value
      // actually flows into the proposal's auto-approve decision.
      // Best-effort: a resolver that throws or returns undefined falls
      // through to DEFAULT_AUTO_APPROVE_THRESHOLDS — never blocks
      // proposal creation on a settings-lookup hiccup.
      let tenantThresholdOverride;
      if (this.deps.thresholdResolver) {
        try {
          tenantThresholdOverride = await this.deps.thresholdResolver(session.tenantId);
        } catch {
          tenantThresholdOverride = undefined;
        }
      }
      // QA-2026-06-05: execution handlers read the FLAT task contract
      // (create_customer wants payload.name; create_appointment wants
      // payload.jobId/scheduledStart/... — see proposals/execution/*), but
      // this adapter only nested the raw classifier entities, so EVERY
      // voice execution failed its handler validation (live:
      // 'Payload must include a non-empty name' / 'a valid jobId').
      // Promote primitive entity values to the payload top level — the
      // classifier's entity keys ARE the task-contract field names — while
      // keeping `entities` intact for audit/rendering. Reserved envelope
      // keys are never clobbered, and create_customer's displayName→name
      // alias mirrors the assistant route's translation.
      const RESERVED = new Set(['intent', 'entities', 'sessionId', 'conversationId', 'callSid', 'customerId', 'confidence']);
      const flat: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(entities)) {
        if (RESERVED.has(k)) continue;
        if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') flat[k] = v;
      }
      if (typeof entities.displayName === 'string' && flat.name === undefined) flat.name = entities.displayName;
      const proposal = buildProposal({
        tenantId: session.tenantId,
        proposalType,
        payload: {
          ...flat,
          intent,
          entities,
          sessionId: session.id,
          conversationId: typeof payload.conversationId === 'string' ? payload.conversationId : undefined,
        },
        summary,
        // QA-2026-06-04: mirror the AI task handlers (create-appointment-task
        // et al.) — calling-agent proposals are capture-class from the
        // autonomous tier with a real classifier confidence. Without these,
        // initialProposalStatus always returned 'draft', which the approval
        // guard correctly refuses to approve — voice proposals were stuck.
        ...(typeof payload.confidence === 'number' ? { confidenceScore: payload.confidence } : {}),
        sourceTrustTier: 'autonomous',
        sourceContext: {
          source: 'calling-agent',
          channel: session.channel,
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
      });
    } catch {
      // Summary is best-effort — the call still ended successfully.
    }
  }
}
