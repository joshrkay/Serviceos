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

import type { Pool } from 'pg';
import { classifyIntent } from '../ai/orchestration/intent-classifier';
import type { LLMGateway } from '../ai/gateway/gateway';
import { discloseRecording } from '../ai/skills/disclose-recording';
import { identifyCaller } from '../ai/skills/identify-caller';
import { confirmIntent } from '../ai/skills/confirm-intent';
import type { SideEffect } from '../ai/agents/customer-calling/types';
import type { VoiceSessionStore } from '../ai/agents/customer-calling/voice-session-store';
import { createLogger } from '../logging/logger';

const logger = createLogger({
  service: 'telephony.twilio-adapter',
  environment: process.env.NODE_ENV || 'development',
});

// ─── Deps ────────────────────────────────────────────────────────────────────

export interface TwilioAdapterDeps {
  store: VoiceSessionStore;
  gateway: LLMGateway;
  /** Postgres pool — passed to identifyCaller. Optional in dev. */
  pool?: Pool;
  /** Business name used in recording disclosure copy. */
  businessName: string;
  /**
   * Public base URL used when building the absolute `<Gather action="...">`
   * URL Twilio will POST to. Twilio requires an absolute URL when the
   * webhook is hit from a public IP. Falls back to a relative path.
   */
  publicBaseUrl?: string;
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

/** Confidence threshold below which we dispatch `confidence_low`, not `intent_classified`. */
const TAU_INT = 0.75;

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
    const session = await this.deps.store.create(opts.tenantId, 'telephony', {
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

    // 5. Drive FSM forward: greeted_ok → identifying, then caller_known or unknown_caller.
    expanded.push(...session.machine.dispatch({ type: 'greeted_ok' }));

    if (callerKnown) {
      expanded.push(
        ...session.machine.dispatch({
          type: 'caller_known',
          customerId: callerKnown.customerId,
        })
      );
    } else {
      expanded.push(...session.machine.dispatch({ type: 'unknown_caller' }));
    }

    // 6. Execute non-TwiML side effects (audit_log, etc.) — currently no-op
    //    for inline execution; logs are surfaced by the FSM tests. P8-014
    //    persists audit events to the audit table via the audit repo.
    this.executeSideEffects(expanded, opts.tenantId);

    // 7. Build TwiML.
    return buildTwiML(expanded, {
      gatherActionUrl: this.gatherUrl(session.id),
    });
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
    const session = await this.deps.store.get(opts.sessionId);
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
    await this.deps.store.appendTranscript(opts.sessionId, {
      speaker: 'caller',
      text: opts.speechResult,
      ts: Date.now(),
    });

    const sideEffectsAll: SideEffect[] = [];
    const currentState = session.machine.currentState;

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
        if (confirmation.confirmed) {
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
      // 3. Classify intent.
      const classification = await classifyIntent(
        opts.speechResult,
        { tenantId: opts.tenantId },
        this.deps.gateway
      );

      if (classification.confidence >= TAU_INT && classification.intentType !== 'unknown') {
        sideEffectsAll.push(
          ...session.machine.dispatch({
            type: 'intent_classified',
            intentType: classification.intentType,
            entities: (classification.extractedEntities ?? {}) as Record<string, unknown>,
            confidence: classification.confidence,
          })
        );

        // After intent_classified, the FSM is in 'entity_resolution' (unless
        // emergency_dispatch fast-path took us to 'escalating'). For Gather
        // mode we don't run a separate entity-resolver — auto-advance with
        // entity_resolved using whatever entities the classifier extracted
        // so the FSM proceeds to intent_confirm. A real entity-resolution
        // skill is P8-005's territory; this is the minimum to get the loop
        // closed end-to-end.
        if (session.machine.currentState === 'entity_resolution') {
          sideEffectsAll.push(
            ...session.machine.dispatch({
              type: 'entity_resolved',
              refs: {},
            })
          );

          // The FSM's intent_confirm tts_play uses a template marker —
          // replace with a concrete readback so callers actually hear it.
          this.expandIntentConfirmTemplate(sideEffectsAll, classification.intentType);
        }
      } else {
        sideEffectsAll.push(
          ...session.machine.dispatch({
            type: 'confidence_low',
            threshold: TAU_INT,
            score: classification.confidence,
          })
        );
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

    this.executeSideEffects(sideEffectsAll, opts.tenantId);

    return buildTwiML(sideEffectsAll, {
      gatherActionUrl: this.gatherUrl(opts.sessionId),
    });
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
   * Execute (or stub) the non-TwiML side effects. Audit and proposal
   * persistence is wired in P8-014 / P8-015; for now we log so manual
   * tests can verify the FSM ran the right steps.
   */
  private executeSideEffects(sideEffects: SideEffect[], tenantId: string): void {
    for (const fx of sideEffects) {
      if (fx.type === 'audit_log') {
        logger.debug('audit_log', { tenantId, payload: fx.payload });
      } else if (fx.type === 'create_proposal') {
        logger.info('create_proposal (stub — P8-015 will persist)', {
          tenantId,
          payload: fx.payload,
        });
      }
    }
  }
}
