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
import { classifyIntent, isLookupIntent } from '../ai/orchestration/intent-classifier';
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
import type { JobRepository } from '../jobs/job';
import type { AppointmentRepository } from '../appointments/appointment';
import type { InvoiceRepository } from '../invoices/invoice';
import type { AgreementRepository } from '../agreements/agreement';
import type { CustomerRepository } from '../customers/customer';
import type { EstimateRepository } from '../estimates/estimate';
import type { LookupEventService } from '../lookup-events/lookup-event-service';
import type { LLMGateway } from '../ai/gateway/gateway';
import { discloseRecording } from '../ai/skills/disclose-recording';
import { identifyCaller } from '../ai/skills/identify-caller';
import { findOrCreateLeadByPhone } from '../ai/skills/find-or-create-lead';
import { confirmIntent } from '../ai/skills/confirm-intent';
import { summarizeSession } from '../ai/skills/summarize-session';
import { escalateToHuman } from '../ai/skills/escalate-to-human';
import { estimateCostCents } from '../ai/skills/session-cost-tracker';
import {
  intentClassifiedEvent,
  lookupExecutedEvent,
  costIncurredEvent,
  sessionTerminatedEvent,
} from '../ai/voice-quality/events';
import { TAU_INT } from '../ai/agents/customer-calling/transitions';
import type { CallingAgentEvent, SideEffect } from '../ai/agents/customer-calling/types';
import type { VoiceSession, VoiceSessionStore } from '../ai/agents/customer-calling/voice-session-store';
import type { ProposalRepository, ProposalType } from '../proposals/proposal';
import { createProposal as buildProposal } from '../proposals/proposal';
import type { LeadRepository } from '../leads/lead';
import type { AuditRepository } from '../audit/audit';
import { createAuditEvent } from '../audit/audit';
import type { OnCallRepository } from '../oncall/rotation';
import type { TwilioCallControl } from './twilio-call-control';
import { maskPhone } from './twilio-call-control';
import { renderCallbackUnavailablePrompt } from '../../../shared/src/voice-prompts';
import type { DispatcherPhoneResolver } from '../ai/skills/escalate-to-human';
import { createLogger } from '../logging/logger';
import type { TenantCredentialResolver } from '../integrations/credentials';

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
  /** P11-001: when wired, every lookup invocation writes a row. */
  lookupEvents?: LookupEventService;
  /**
   * Phase C: per-tenant integration resolver for runtime auth lookups.
   * Wiring is optional in this adapter phase; consumers can inject and
   * use it for tenant-specific Twilio auth outside this gather loop.
   */
  credentialResolver?: TenantCredentialResolver;
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
      const voice = opts.language === 'es' ? GATHER_VOICE_ES : GATHER_VOICE_EN;
      parts.push(`<Say voice="${voice}">${xmlEscape(sayText)}</Say>`);
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
    // audit_log / create_proposal / start_transcription → no TwiML
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

  constructor(private deps: TwilioAdapterDeps) {}

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
    tenantId: string;
  }): Promise<string> {
    const existing = this.deps.store.findByCallSid(opts.callSid);
    if (existing && existing.tenantId === opts.tenantId) {
      return this.buildStreamTwiML({ sessionId: existing.id, callSid: opts.callSid });
    }
    const session = this.deps.store.create(opts.tenantId, 'telephony', {
      callSid: opts.callSid,
    });
    return this.buildStreamTwiML({ sessionId: session.id, callSid: opts.callSid });
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
    const streamUrl = `${wsBase}/api/telephony/stream`;
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

    // 1. Append caller utterance to transcript.
    this.deps.store.appendTranscript(opts.sessionId, {
      speaker: 'caller',
      text: opts.speechResult,
      ts: Date.now(),
    });

    const sideEffectsAll: SideEffect[] = [];
    const currentState = session.machine.currentState;

    if (opts.speechResult.trim().length === 0) {
      sideEffectsAll.push(
        ...session.machine.dispatch({
          type: 'confidence_low',
          threshold: TAU_INT,
          score: 0,
        }),
      );
      await this.executeSideEffects(session, sideEffectsAll, opts.tenantId);
      return sideEffectsAll;
    }

    if (currentState === 'intent_confirm') {
      try {
        const ctx = session.machine.currentContext;
        const intentSummary = ctx.currentIntent ?? 'that';
        const confirmation = await confirmIntent({
          intentSummary,
          callerResponse: opts.speechResult,
          tenantId: opts.tenantId,
          gateway: this.deps.gateway,
        });
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
            }),
          );
        }
      } catch (err) {
        logger.error('processCallerUtterance: confirmIntent failed', {
          error: err instanceof Error ? err.message : String(err),
          sessionId: opts.sessionId,
        });
        sideEffectsAll.push(
          ...session.machine.dispatch({
            type: 'correction',
            newTranscript: opts.speechResult,
          }),
        );
      }
    } else if (currentState === 'intent_capture' || currentState === 'closing') {
      let classifierEvent: CallingAgentEvent | null = null;
      try {
        const classification = await classifyIntent(
          opts.speechResult,
          { tenantId: opts.tenantId },
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
        logger.error('processCallerUtterance: classifyIntent failed', {
          error: err instanceof Error ? err.message : String(err),
          sessionId: opts.sessionId,
        });
        classifierEvent = { type: 'confidence_low', threshold: TAU_INT, score: 0 };
      }

      sideEffectsAll.push(...session.machine.dispatch(classifierEvent));

      if (
        classifierEvent.type === 'intent_classified' &&
        session.machine.currentState === 'entity_resolution'
      ) {
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
      logger.info('processCallerUtterance: unhandled state, treating as confidence_low', {
        state: currentState,
        sessionId: opts.sessionId,
      });
      sideEffectsAll.push(
        ...session.machine.dispatch({
          type: 'confidence_low',
          threshold: TAU_INT,
          score: 0,
        }),
      );
    }

    await this.executeSideEffects(session, sideEffectsAll, opts.tenantId);

    // Capture the agent's reply in the transcript so summarizeSession sees both sides.
    const ttsLast = [...sideEffectsAll].reverse().find((e) => e.type === 'tts_play');
    if (ttsLast && typeof ttsLast.payload.text === 'string') {
      this.deps.store.appendTranscript(opts.sessionId, {
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

    return sideEffectsAll;
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
        [{ type: 'tts_play', payload: { text: 'One moment, please.' } }],
        { gatherActionUrl: this.gatherUrl(existing.id) },
      );
    }

    const session = this.deps.store.create(opts.tenantId, 'telephony', {
      callSid: opts.callSid,
    });

    // P18-001: record the caller-id (or "" when blocked/withheld) so
    // the create_customer voice flow can use it as the new customer's
    // primaryPhone without re-prompting.
    this.callerIdBySession.set(session.id, opts.from ?? '');

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
    await this.executeSideEffects(session, expanded, opts.tenantId);

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
        ...(this.deps.recordingCallbackPath
          ? { recordingStatusCallback: this.recordingCallbackUrl() }
          : {}),
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
      let classifiedIntentType: string | undefined;
      try {
        const classification = await classifyIntent(
          opts.speechResult,
          { tenantId: opts.tenantId },
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
        const capExceeded = this.recordCost(session, classification.tokenUsage);
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
        await this.executeSideEffects(session, sideEffectsAll, opts.tenantId);
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
          await this.executeSideEffects(session, sideEffectsAll, opts.tenantId);
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
    // P8-013: when a notify_oncall side effect produced a <Dial>
    // transfer descriptor, we hand back that TwiML directly instead
    // of looping into another <Gather>. Twilio will POST the dial
    // result back to /dial-result, which advances the rotation.
    const transferTwiml = this.takePendingTransferTwiml(sessionId);
    if (transferTwiml) {
      // Still capture any agent TTS line for the transcript so
      // summarizeSession can see "the agent said: connecting you...".
      const ttsLast = [...sideEffects].reverse().find((e) => e.type === 'tts_play');
      if (ttsLast && typeof ttsLast.payload.text === 'string') {
        this.deps.store.appendTranscript(sessionId, {
          speaker: 'agent',
          text: ttsLast.payload.text,
          ts: Date.now(),
        });
      }
      return transferTwiml;
    }

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
   *
   * VQ-003: also emits `cost_incurred` on the session bus for the
   * voice-quality harness, plus `session_terminated{cause: 'cap_exceeded'}`
   * when the cap is crossed. Pure book-keeping — no FSM dispatch.
   */
  private recordCost(
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
      const result = await escalateToHuman({
        tenantId,
        sessionId: session.id,
        reason: reason as Parameters<typeof escalateToHuman>[0]['reason'],
        channel: 'telephony',
        onCallRepo: this.deps.onCallRepo,
        auditRepo: this.deps.auditRepo,
        // VQ-003: pass the live session so escalateToHuman can emit
        // `escalation_triggered` for the voice-quality harness.
        session,
        // P8-013: when a callControl + resolver are wired, the skill
        // walks the rotation and returns a transfer descriptor we use
        // to render <Dial> TwiML in place of the next <Gather>.
        ...(this.deps.callControl ? { callControl: this.deps.callControl } : {}),
        ...(this.deps.dispatcherPhoneResolver
          ? { dispatcherPhoneResolver: this.deps.dispatcherPhoneResolver }
          : {}),
        ...(session.callSid ? { callSid: session.callSid } : {}),
        dialActionUrl: this.dialResultUrl(session.id),
      });

      if (result.transfer) {
        // Hand the dial TwiML to finalizeTwiml so the webhook response
        // bridges to the dispatcher. Mask the phone for any log line.
        this.pendingTransferTwiml.set(session.id, result.transfer.fallbackTwiml);
        logger.info('notify_oncall: dialing dispatcher', {
          sessionId: session.id,
          rotationIndex: result.transfer.rotationIndex,
          dispatcherPhone: maskPhone(result.transfer.dispatcherPhone),
        });
      } else if (!result.escalated && this.deps.callControl) {
        // Rotation was empty / exhausted on first attempt and the
        // caller wired callControl (i.e. we *can* dial in principle —
        // the rotation just has no eligible entries). Queue the
        // customer-callback proposal immediately and override the
        // TwiML so the caller hears "we'll call you back" with the
        // business name instead of a `<Gather>` they can't answer.
        await this.queueCallbackProposal(session, tenantId, reason, 'rotation_empty');
        const safeName = xmlEscape(this.deps.businessName);
        this.pendingTransferTwiml.set(
          session.id,
          `<?xml version="1.0" encoding="UTF-8"?>` +
            `<Response>` +
            `<Say voice="Polly.Joanna">${renderCallbackUnavailablePrompt(safeName)}</Say>` +
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
   * Build the absolute /dial-result URL Twilio POSTs once a `<Dial>`
   * verb completes. Mirrors `gatherUrl` but for the dial-result route.
   */
  private dialResultUrl(sessionId: string): string {
    const path = `/api/telephony/dial-result?sid=${encodeURIComponent(sessionId)}`;
    if (this.deps.publicBaseUrl) {
      return `${this.deps.publicBaseUrl.replace(/\/+$/, '')}${path}`;
    }
    return path;
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
