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
import { classifyIntent } from '../ai/orchestration/intent-classifier';
import type { LLMGateway } from '../ai/gateway/gateway';
import { discloseRecording } from '../ai/skills/disclose-recording';
import { identifyCaller } from '../ai/skills/identify-caller';
import { confirmIntent } from '../ai/skills/confirm-intent';
import { summarizeSession } from '../ai/skills/summarize-session';
import { escalateToHuman } from '../ai/skills/escalate-to-human';
import { estimateCostCents } from '../ai/skills/session-cost-tracker';
import { TAU_INT } from '../ai/agents/customer-calling/transitions';
import type { CallingAgentEvent, SideEffect } from '../ai/agents/customer-calling/types';
import type { VoiceSession, VoiceSessionStore } from '../ai/agents/customer-calling/voice-session-store';
import type { ProposalRepository, ProposalType } from '../proposals/proposal';
import { createProposal as buildProposal } from '../proposals/proposal';
import type { AuditRepository } from '../audit/audit';
import { createAuditEvent } from '../audit/audit';
import type { OnCallRepository } from '../oncall/rotation';
import { createLogger } from '../logging/logger';

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

// ─── XML helpers ─────────────────────────────────────────────────────────────

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
}

const GATHER_VOICE = 'Polly.Joanna';

/**
 * Translate FSM side effects into a TwiML string.
 *
 * Mapping:
 *   tts_play       → <Say voice="Polly.Joanna">…</Say>
 *   end_session    → <Hangup/>
 *   notify_oncall  → no-op (P8-013 will turn this into <Dial>)
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
      parts.push(`<Say voice="${GATHER_VOICE}">${xmlEscape(sayText)}</Say>`);
    } else if (fx.type === 'end_session') {
      parts.push('<Hangup/>');
      ended = true;
    } else if (fx.type === 'notify_oncall') {
      // P8-013 turns this into <Dial>. For now we just log so we can see
      // when the agent fired escalation and the call kept going.
      logger.warn('notify_oncall side effect — no <Dial> yet (P8-013)', {
        payload: fx.payload,
      });
    }
    // audit_log / create_proposal / start_transcription → no TwiML
  }

  if (!ended) {
    // Loop back to <Gather> so the caller can speak the next turn.
    parts.push(
      `<Gather input="speech" speechTimeout="auto" action="${xmlEscape(
        opts.gatherActionUrl
      )}" method="POST"/>`
    );
  }

  return `<?xml version="1.0" encoding="UTF-8"?><Response>${parts.join('')}</Response>`;
}

// ─── Adapter ─────────────────────────────────────────────────────────────────

export class TwilioGatherAdapter {
  constructor(private deps: TwilioAdapterDeps) {}

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
        [{ type: 'tts_play', payload: { text: 'One moment, please.' } }],
        { gatherActionUrl: this.gatherUrl(existing.id) },
      );
    }

    const session = this.deps.store.create(opts.tenantId, 'telephony', {
      callSid: opts.callSid,
    });

    // 1. Disclose recording (text generation; no TTS — Twilio <Say> handles audio).
    const disclosure = await discloseRecording({
      tenantId: opts.tenantId,
      channel: 'telephony',
      businessName: this.deps.businessName,
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
    //    + disclosure copy. We do this by post-processing the side-effect list.
    const greetingText =
      `Thank you for calling ${this.deps.businessName}. ` +
      disclosure.disclosureText +
      ' How can I help you today?';

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
      expanded.push(...session.machine.dispatch({ type: 'unknown_caller' }));
    }

    // 6. Execute non-TwiML side effects (audit_log, create_proposal,
    //    notify_oncall) against the wired repos.
    await this.executeSideEffects(session, expanded, opts.tenantId);

    // 7. Build TwiML.
    const twiml = buildTwiML(expanded, {
      gatherActionUrl: this.gatherUrl(session.id),
    });

    // 8. If the FSM drove straight to 'terminated' (escalation chain
    //    that emits end_session), kick off the summary so call_summaries
    //    captures even calls that never reached intent_capture.
    if (session.machine.currentState === 'terminated' && !session.ended) {
      session.ended = true;
      void this.runSummary(session).catch(() => {
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

    // 1. Append caller utterance to transcript.
    this.deps.store.appendTranscript(opts.sessionId, {
      speaker: 'caller',
      text: opts.speechResult,
      ts: Date.now(),
    });

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
      await this.executeSideEffects(session, sideEffectsAll, opts.tenantId);
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
        const capExceeded = this.recordCost(session, confirmation.tokenUsage);
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
      try {
        const classification = await classifyIntent(
          opts.speechResult,
          { tenantId: opts.tenantId },
          this.deps.gateway,
        );
        const capExceeded = this.recordCost(session, classification.tokenUsage);
        if (capExceeded) {
          classifierEvent = { type: 'cost_cap_exceeded' };
        } else if (classification.confidence >= TAU_INT && classification.intentType !== 'unknown') {
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
        this.expandIntentConfirmTemplate(sideEffectsAll, classifierEvent.intentType);
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

    await this.executeSideEffects(session, sideEffectsAll, opts.tenantId);
    return this.finalizeTwiml(session, sideEffectsAll, opts.sessionId);
  }

  /**
   * Build TwiML and, when the FSM has reached `terminated`, kick off
   * the end-of-call summary in the background. Centralizes the
   * end-of-handler wrap-up shared by handleGather and handleInbound.
   */
  private finalizeTwiml(
    session: VoiceSession,
    sideEffects: SideEffect[],
    sessionId: string,
  ): string {
    const twiml = buildTwiML(sideEffects, { gatherActionUrl: this.gatherUrl(sessionId) });
    const ttsLast = [...sideEffects].reverse().find((e) => e.type === 'tts_play');
    if (ttsLast && typeof ttsLast.payload.text === 'string') {
      // Capture the agent's reply so summarizeSession sees both sides
      // of the conversation, not just the caller turns.
      this.deps.store.appendTranscript(sessionId, {
        speaker: 'agent',
        text: ttsLast.payload.text,
        ts: Date.now(),
      });
    }
    if (session.machine.currentState === 'terminated' && !session.ended) {
      session.ended = true;
      void this.runSummary(session).catch(() => {
        /* swallow — summary is best-effort */
      });
    }
    return twiml;
  }

  /**
   * Push token usage from an LLM skill into the per-session cost tracker.
   * Returns true when a hard cap was crossed (caller should escalate).
   */
  private recordCost(
    session: VoiceSession,
    usage: { input: number; output: number } | undefined,
  ): boolean {
    if (!usage) return false;
    const events = session.costTracker.recordUsage({
      inputTokens: usage.input,
      outputTokens: usage.output,
      costCents: estimateCostCents(usage.input, usage.output),
    });
    return events.some((e) => e.type === 'cost_cap_exceeded');
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
   * Replace any tts_play side effect whose text equals 'intent_confirm' with
   * a concrete readback so the caller hears something coherent.
   */
  private expandIntentConfirmTemplate(
    sideEffects: SideEffect[],
    intentType: string
  ): void {
    for (const fx of sideEffects) {
      if (
        fx.type === 'tts_play' &&
        (fx.payload.text === 'intent_confirm' || fx.payload.template === 'confirm_intent')
      ) {
        fx.payload.text = `Just to confirm — ${intentType.replace(/_/g, ' ')}. Is that right?`;
      }
    }
  }

  /**
   * Execute the non-TwiML side effects against the wired repos. Each
   * branch swallows its own errors so a single repo blip never breaks
   * the in-flight TwiML response (Twilio would retry, doubling work).
   */
  private async executeSideEffects(
    session: VoiceSession,
    sideEffects: SideEffect[],
    tenantId: string,
  ): Promise<void> {
    if (sideEffects.length > 0) {
      // Touch lastActivityAt from the side-effect path so a long Gather
      // / TTS turn doesn't let the idle reaper steal the session.
      this.deps.store.touch(session.id);
    }
    // for-of over an array sees items pushed during iteration. We rely
    // on that so handleCreateProposal's proposal_queued / system_failure
    // dispatches (and the audit_log + tts_play they emit) flow back into
    // sideEffects and end up in the TwiML response.
    for (const fx of sideEffects) {
      if (fx.type === 'audit_log') {
        await this.handleAuditLog(session, fx, tenantId);
      } else if (fx.type === 'create_proposal') {
        await this.handleCreateProposal(session, fx, tenantId, sideEffects);
      } else if (fx.type === 'notify_oncall') {
        await this.handleNotifyOncall(session, fx, tenantId);
      }
    }
  }

  private async handleAuditLog(
    session: VoiceSession,
    fx: SideEffect,
    tenantId: string,
  ): Promise<void> {
    if (!this.deps.auditRepo) {
      logger.debug('audit_log (no auditRepo wired)', { tenantId, payload: fx.payload });
      return;
    }
    const eventType = typeof fx.payload.eventType === 'string' ? fx.payload.eventType : 'agent.calling.unknown';
    try {
      const ev = createAuditEvent({
        tenantId,
        actorId: this.deps.systemActorId ?? 'calling-agent',
        actorRole: 'system',
        eventType,
        entityType: 'voice_session',
        entityId: session.id,
        correlationId: session.id,
        metadata: fx.payload,
      });
      await this.deps.auditRepo.create(ev);
    } catch (err) {
      logger.warn('audit_log persist failed', {
        error: err instanceof Error ? err.message : String(err),
        sessionId: session.id,
      });
    }
  }

  private async handleCreateProposal(
    session: VoiceSession,
    fx: SideEffect,
    tenantId: string,
    sideEffectsSink: SideEffect[],
  ): Promise<void> {
    if (!this.deps.proposalRepo) {
      logger.info('create_proposal (no proposalRepo wired)', { tenantId, payload: fx.payload });
      return;
    }
    const intent = typeof fx.payload.intent === 'string' ? fx.payload.intent : undefined;
    const entities =
      typeof fx.payload.entities === 'object' && fx.payload.entities !== null
        ? (fx.payload.entities as Record<string, unknown>)
        : {};
    try {
      const proposal = buildProposal({
        tenantId,
        proposalType: intentToProposalType(intent),
        payload: {
          intent,
          entities,
          sessionId: session.id,
          callSid: session.callSid,
        },
        summary: intent ? `Voice intent: ${intent}` : 'Voice clarification needed',
        sourceContext: {
          source: 'calling-agent',
          channel: 'telephony',
          sessionId: session.id,
        },
        aiRunId: uuidv4(),
        createdBy: typeof fx.payload.customerId === 'string'
          ? fx.payload.customerId
          : this.deps.systemActorId ?? 'calling-agent',
      });
      const stored = await this.deps.proposalRepo.create(proposal);
      session.proposalIds.push(stored.id);
      // Advance the FSM: proposal_queued moves us into 'closing' and emits
      // a final tts_play ("Great, I've got that taken care of..."). Push
      // those follow-up effects back into the side-effect array so they
      // reach buildTwiML — without this the caller never hears the close.
      const followUps = session.machine.dispatch({
        type: 'proposal_queued',
        proposalId: stored.id,
      });
      sideEffectsSink.push(...followUps);
    } catch (err) {
      logger.warn('create_proposal persist failed', {
        error: err instanceof Error ? err.message : String(err),
        sessionId: session.id,
      });
      // Persistence failure strands the FSM in proposal_draft. Dispatch
      // a global system_failure so we land in 'escalating' with a real
      // tts_play + notify_oncall instead of looping the caller through
      // an unhandled-state reprompt.
      const recovery = session.machine.dispatch({
        type: 'system_failure',
        reason: 'proposal_persist_failed',
      });
      sideEffectsSink.push(...recovery);
    }
  }

  private async handleNotifyOncall(
    session: VoiceSession,
    fx: SideEffect,
    tenantId: string,
  ): Promise<void> {
    if (!this.deps.onCallRepo || !this.deps.auditRepo) {
      logger.warn('notify_oncall (oncall/audit repos not wired)', {
        tenantId,
        payload: fx.payload,
      });
      return;
    }
    const reason = typeof fx.payload.reason === 'string' ? fx.payload.reason : 'low_confidence';
    try {
      await escalateToHuman({
        tenantId,
        sessionId: session.id,
        reason: reason as Parameters<typeof escalateToHuman>[0]['reason'],
        channel: 'telephony',
        onCallRepo: this.deps.onCallRepo,
        auditRepo: this.deps.auditRepo,
      });
    } catch (err) {
      logger.warn('escalateToHuman failed', {
        error: err instanceof Error ? err.message : String(err),
        sessionId: session.id,
      });
    }
  }

  /**
   * Persist an end-of-call summary to call_summaries. Best-effort —
   * failures are logged but never bubble out (the call already ended).
   */
  private async runSummary(session: VoiceSession): Promise<void> {
    const durationMs = Date.now() - session.createdAt.getTime();
    try {
      const intentDetected = session.machine.currentContext.currentIntent;
      // recordingId intentionally omitted: voice_recordings rows are
      // created by the P8-014 recording webhook. Until that lands,
      // summaries persist with NULL call_id.
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
    } catch (err) {
      logger.warn('summarizeSession failed', {
        error: err instanceof Error ? err.message : String(err),
        sessionId: session.id,
      });
    }
  }
}
