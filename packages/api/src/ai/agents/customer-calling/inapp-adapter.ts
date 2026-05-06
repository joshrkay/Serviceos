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

import { v4 as uuidv4 } from 'uuid';
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
   * §3B vertical-aware classifier prompt. Resolves the tenant's active
   * vertical pack and returns a prompt-shaped section (see
   * `formatVerticalForCallerPrompt` in `verticals/context-assembly.ts`).
   * Pluggable so app.ts can wire in its own pack lookup and tests can
   * stub a fixed string. Returns undefined when the tenant has no
   * active pack — the classifier falls back to its base prompt.
   */
  verticalPromptResolver?: (tenantId: string) => Promise<string | undefined>;
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

const GREETING_TEXT_INAPP = 'Hi, this is your assistant. How can I help today?';

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
function classifierToFsmEvent(
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

function intentToProposalType(intent: string | undefined): ProposalType {
  switch (intent) {
    case 'create_invoice': return 'draft_invoice';
    case 'update_invoice': return 'update_invoice';
    case 'issue_invoice': return 'issue_invoice';
    case 'send_invoice': return 'send_invoice';
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
    default: return 'voice_clarification';
  }
}

/**
 * Map FSM escalation reasons to the strict EscalationReason union the
 * escalate-to-human skill accepts.
 */
function toEscalationReason(reason: string | undefined): EscalationReason {
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
    const session = this.deps.store.create(tenantId, 'inapp');
    const convId = conversationId ?? session.id;

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

    session.transcript.push(`agent: ${GREETING_TEXT_INAPP}`);

    let greetingAudio: Buffer | undefined;
    if (this.deps.ttsProvider) {
      try {
        const synth = await this.deps.ttsProvider.synthesize({
          text: GREETING_TEXT_INAPP,
          tenantId,
        });
        greetingAudio = synth.audio;
      } catch {
        // TTS is best-effort: callers always get the greeting text back.
      }
    }

    const result: StartSessionResult = {
      sessionId: session.id,
      state: session.machine.currentState,
      greetingText: GREETING_TEXT_INAPP,
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

    // §3B: load the tenant's vertical prompt section before classifying
    // so per-tenant equipment terminology reaches the LLM. Best-effort:
    // if the resolver fails, we proceed without the vertical block
    // rather than failing the turn.
    let verticalPromptSection: string | undefined;
    if (this.deps.verticalPromptResolver) {
      try {
        verticalPromptSection = await this.deps.verticalPromptResolver(session.tenantId);
      } catch {
        verticalPromptSection = undefined;
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
        { tenantId: session.tenantId, verticalPromptSection },
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
      ttsText = ttsLast.payload.text;
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
      session.events.emit('voice-event', { type: 'ended', reason: typeof last?.payload?.reason === 'string' ? last.payload.reason : 'closed' });
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
    session.events.emit('voice-event', { type: 'ended', reason: 'manual_end' });
    // store.delete() also drops the per-session lock entry.
    this.deps.store.delete(sessionId);
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
      const proposal = buildProposal({
        tenantId: session.tenantId,
        proposalType,
        payload: {
          intent,
          entities,
          sessionId: session.id,
          conversationId: typeof payload.conversationId === 'string' ? payload.conversationId : undefined,
        },
        summary,
        sourceContext: {
          source: 'calling-agent',
          channel: session.channel,
          sessionId: session.id,
        },
        aiRunId: uuidv4(),
        createdBy: typeof payload.customerId === 'string'
          ? payload.customerId
          : this.deps.systemActorId ?? 'calling-agent',
      });
      const stored = await this.deps.proposalRepo.create(proposal);
      session.proposalIds.push(stored.id);
      session.events.emit('voice-event', { type: 'proposal_created', proposalId: stored.id });
      return stored.id;
    } catch {
      // Proposal creation failure should never break the flow — the
      // operator can re-state the request. Errors are logged via the
      // audit_log side-effect that always accompanies create_proposal.
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
