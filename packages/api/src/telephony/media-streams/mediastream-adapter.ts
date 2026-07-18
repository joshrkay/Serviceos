/**
 * Per-WebSocket adapter for a single Twilio Media Streams call.
 *
 * Lifecycle (Twilio Media Streams protocol):
 *   ws.open            → wait for `start` frame
 *   { event: "start" } → resolve sessionId via VoiceSessionStore.findByCallSid
 *                        and open a Deepgram streaming session
 *   { event: "media" } → base64 μ-law 8 kHz inbound → PCM16 16 kHz → Deepgram
 *   Deepgram interim  → if agent TTS is currently playing, treat as
 *                        barge-in: emit Twilio `clear` and stop further
 *                        outbound `media` frames.
 *   Deepgram final    → run a "speech turn" against the FSM under
 *                        `withSessionLock`, emit any tts_play side effects
 *                        as outbound media.
 *   { event: "stop" }  → flush Deepgram + close WS + close session.
 *
 * The adapter is constructed once per WS connection. Tests can
 * exercise the path with a mocked WebSocket-like handle.
 *
 * Backpressure: outbound `media` frames are paced by tracking ack
 * `mark` frames Twilio echoes back. We send a `mark` after each
 * outbound media chunk and only continue once we've received it
 * (or after a small timeout) — this keeps Twilio's buffer from
 * inflating unbounded.
 */

import { z } from 'zod';
import { createLogger } from '../../logging/logger';
import type {
  StreamingSession,
  StreamingTranscriptionProvider,
} from '../../voice/transcription-providers';
import type { TtsProvider } from '../../ai/tts/tts-provider';
import type { VoiceSession, VoiceSessionStore } from '../../ai/agents/customer-calling/voice-session-store';
import { extractPriorTurns } from '../../ai/agents/customer-calling/transcript-turns';
import type { SideEffect } from '../../ai/agents/customer-calling/types';
import { escalateWithContextPayloadSchema } from '../../ai/agents/customer-calling/types';
import {
  decodeTwilioInboundFrame,
  encodeTwilioOutboundFrame,
  pcm16ToMulaw,
} from './mulaw-codec';
import { BoundedSendQueue, type Priority } from '../../ws/bounded-send-queue';
import { wsDisconnectTotal, voiceTurnLatencyMs } from '../../monitoring/metrics';
import { recordVoiceError } from '../../analytics/posthog';
import {
  ConnectionRegistry,
  ConnectionLease,
  globalConnectionRegistry,
} from '../../ws/connection-registry';
import {
  transcriptReceivedEvent,
  audioFrameEmittedEvent,
  repairTemplateFiredEvent,
  fillerFiredEvent,
  fillerCancelledEvent,
  escalationStartedEvent,
  escalationSummaryBuiltEvent,
  languageSwitchedEvent,
  type LanguageSwitchedEvent,
} from '../../ai/voice-quality/events';
import {
  detectLanguageFromTranscript,
  detectLanguageSwitchIntent,
  isLanguageSupported,
} from '../../ai/orchestration/language-detector';
import {
  renderTtsText,
  LANGUAGE_SWITCH_ACK,
  SPEECH_TURN_FAILURE_REPROMPT_COPY,
  SPEECH_TURN_FAILURE_ESCALATION_COPY,
  LOW_STT_CONFIDENCE_REPROMPT_COPY,
  type SessionLanguage,
} from '../../ai/agents/customer-calling/tts-copy';
import { detectEmergency } from '../../ai/agents/customer-calling/emergency-detector';
import { VOICE_EVENT_CHANNEL } from '../../ai/voice-quality/event-bus';
import type { WhisperCache } from '../whisper-cache';
import type { TwilioCallControl } from '../twilio-call-control';
import type { EscalationSettings } from '../../settings/settings';
import type { SentimentInput, SentimentResult, SentimentBudget } from '../../ai/agents/customer-calling/sentiment-classifier';
import type { PanelData } from '../../ai/agents/customer-calling/escalation-summary-builder';
import { createAuditEvent } from '../../audit/audit';

const logger = createLogger({
  service: 'telephony.media-streams',
  environment: process.env.NODE_ENV || 'development',
});

// ─── Types ───────────────────────────────────────────────────────────────────

/**
 * Minimal WS surface this adapter depends on. Real `ws` instances
 * conform; tests pass a vi-mocked object with the same methods.
 */
export interface WsLike {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  on(event: 'message', listener: (data: Buffer | string) => void): void;
  on(event: 'close', listener: () => void): void;
  on(event: 'error', listener: (err: Error) => void): void;
  on(event: string, listener: (...args: unknown[]) => void): void;
  readyState?: number;
}

/**
 * Twilio Media Streams envelope shapes we read.
 *
 * Spec: https://www.twilio.com/docs/voice/twiml/stream
 */
export type TwilioInboundFrame =
  | { event: 'connected'; protocol: string; version: string }
  | {
      event: 'start';
      streamSid: string;
      start: {
        callSid: string;
        accountSid: string;
        streamSid: string;
        tracks: string[];
        customParameters?: Record<string, string | undefined>;
        mediaFormat?: { encoding: string; sampleRate: number; channels: number };
      };
    }
  | {
      event: 'media';
      streamSid: string;
      media: { track: string; chunk: string; timestamp: string; payload: string };
    }
  | { event: 'mark'; streamSid: string; mark: { name: string } }
  | { event: 'stop'; streamSid: string };

/**
 * The "drive a speech turn" callback. Implemented by the host
 * (typically delegating to TwilioGatherAdapter#processCallerUtterance)
 * so this module stays free of FSM/skill knowledge.
 *
 * Returns the side-effect list the FSM produced. The adapter renders
 * `tts_play` via the TTS provider and emits the rest as no-ops on this
 * channel (audit/proposal/notify_oncall persist via the host).
 */
export type SpeechTurnHandler = (args: {
  session: VoiceSession;
  speechResult: string;
  callSid: string;
  tenantId: string;
}) => Promise<SideEffect[]>;

export interface MediaStreamAdapterDeps {
  store: VoiceSessionStore;
  streamingProvider: StreamingTranscriptionProvider;
  ttsProvider?: TtsProvider;
  speechTurn: SpeechTurnHandler;
  /**
   * Called once after Deepgram opens — runs disclosure, caller-ID lookup,
   * and FSM bootstrap (incoming_call → greeted_ok → caller_known/unknown).
   * Returns side effects including the real greeting tts_play text.
   * When omitted the adapter starts silently and waits for the first utterance.
   */
  initializeSession?: (opts: {
    callSid: string;
    tenantId: string;
  }) => Promise<SideEffect[]>;
  /**
   * RV-140 (interim) — emergency-keyword scan over INTERIM transcripts so a
   * caller saying "gas leak" escalates the moment the words are recognized,
   * not seconds later when Deepgram finalizes the utterance. Keywords ONLY —
   * the recording-objection scan stays finals-only (a half-formed interim
   * must never pause a recording). Returns the executed escalation side
   * effects (911 safety line first) or null when nothing matched / the FSM
   * is already escalating. Wired in production to
   * `TwilioGatherAdapter.scanInterimForEmergency`.
   */
  interimEmergencyScan?: (args: {
    session: VoiceSession;
    speechResult: string;
    callSid: string;
    tenantId: string;
  }) => Promise<SideEffect[] | null>;
  /** Audio inactivity teardown (ms). Default 30 minutes. */
  audioIdleTimeoutMs?: number;
  /** T2-F05 — caller-silence reprompt window after an agent turn ends (ms). Default 8 s. */
  silenceRepromptTimeoutMs?: number;
  /**
   * Per-tenant connection registry. Defaults to the process-wide singleton.
   * Override for tests to keep counters isolated between cases.
   */
  connectionRegistry?: ConnectionRegistry;
  /**
   * B2 — invoked from `handleClose` so the host (typically TwilioGatherAdapter)
   * can derive + stash the typed CallOutcome on the session before the
   * WS tears down. The host is expected to fire-and-forget any DB write
   * internally; this hook is sync so we never block close on Postgres.
   *
   * `sideEffects` carries the most recent FSM dispatch's effects when
   * the close was triggered by an `end_session` SideEffect — the host
   * uses these to read the FSM-supplied `payload.reason` (e.g.
   * 'abuse_detected:profanity'), which is more specific than the
   * coarse mediastream close reason and drives the right `CallOutcome`
   * for non-hangup terminations. Empty for non-FSM close paths
   * (idle timeout, WS error, slow consumer).
   *
   * Optional — when omitted, the close path is unchanged.
   */
  finalizeOnClose?: (
    session: VoiceSession,
    reason: string,
    sideEffects: ReadonlyArray<SideEffect>,
  ) => void;
  /**
   * Resolves Deepgram keyword-boost tokens for the tenant. Optional —
   * when omitted, Deepgram opens without keyword boost.
   *
   * UB-C1 — the boost list is suppressed whenever the live STT language
   * is 'es': the tokens are English trade terms and degrade Nova-3's
   * Spanish recognition. It is re-applied on a switch back to 'en'.
   */
  terminologyProvider?: {
    getKeywords(tenantId: string): Promise<ReadonlyArray<string>>;
  };
  /**
   * UB-C1 — resolves the language the call OPENS in, before the Deepgram
   * session is created. Composed in app.ts from the identified caller's
   * `customer.preferredLanguage` + `tenant_settings.default_language` /
   * `supported_languages` via `detectLanguage` (which applies the
   * tenant's opt-in gate internally). Optional — when omitted the call
   * opens with the provider's default language (English), preserving
   * pre-UB-C behavior.
   */
  initialLanguageResolver?: (
    tenantId: string,
    callContext: { callSid: string; sessionId: string },
  ) => Promise<'en' | 'es'>;
  /**
   * Optional filler engine + cache. When both are present, the adapter
   * wraps each `tts_play` turn with a 250ms timer: if the real TTS has
   * not started streaming by then, it plays one filler clip from the
   * cache. Omitting either turns the feature off entirely.
   */
  fillerEngine?: {
    selectNext(ctx?: { skipFillers?: boolean; language?: 'en' | 'es' }): { id: string; text: string; approxDurationMs: number } | undefined;
  };
  fillerCache?: {
    get(id: string): Buffer | undefined;
  };
  /** Override for the 250ms filler threshold (ms). Default 250. */
  fillerDelayMs?: number;
  /**
   * Section 7 — escalate_with_context fan-out deps.
   * When present, handleEscalateWithContext stores whisper TwiML so the
   * /whisper/:escalationId webhook can serve it to the dispatcher's leg.
   */
  whisperCache?: WhisperCache;
  /**
   * Section 7 — delivery provider for dispatcher SMS. Optional so
   * existing test fixtures continue to work without DI'ing a stub.
   */
  deliveryProvider?: { sendSms(args: { to: string; body: string }): Promise<unknown> };
  /**
   * Section 7 — used to build the whisper webhook URL and the dial-action
   * URL injected into the <Dial> TwiML.
   * Falls back to relative paths when absent.
   */
  publicBaseUrl?: string;
  /**
   * Section 7 — Twilio call-control surface used to emit the <Dial>
   * TwiML that bridges the caller to the dispatcher with whisper.
   * When absent, the Dial step is skipped gracefully.
   *
   * Whisper-route mounting note: mount the whisper router inside
   * createTelephonyRouter so it inherits requireTwilioSignature.
   * Full wiring in app.ts is deferred to Section 12.
   */
  callControl?: TwilioCallControl;
  /**
   * Section 7 (CRITICAL) — Callback that writes the <Dial> TwiML into the
   * TwilioGatherAdapter's shared `pendingTransferTwiml` Map so the next
   * gather-callback route invocation returns it to Twilio and bridges the
   * call to the dispatcher. Without this wired, the TwiML is written to
   * `state.pendingTransferTwiml` on the media-stream adapter where nothing
   * ever reads it — the caller stays on hold forever.
   *
   * Wire via: `gatherAdapter.setPendingTransferTwiml.bind(gatherAdapter)`
   */
  setPendingTransferTwiml?: (sessionId: string, twiml: string) => void;
  /**
   * F6c — async LLM sentiment classifier. When present and per-tenant
   * `escalationSettings.trigger_llm_sentiment` is true, the adapter
   * calls this after each `speechTurn` in a fire-and-forget manner.
   * If the returned frustrationScore >= threshold, a `frustration_detected`
   * FSM event is dispatched out-of-band and the resulting side effects executed.
   */
  sentimentClassifier?: (
    input: SentimentInput,
    budget?: SentimentBudget,
  ) => Promise<SentimentResult>;
  /**
   * Delivers side effects from the out-of-band `frustration_detected` dispatch
   * (notify_oncall, audit_log) through the host's voice-turn processor — the
   * adapter's own `emitSideEffects` only renders `tts_play`. When absent, those
   * effects are skipped (test/dev path). Wired in production via
   * `TwilioGatherAdapter.deliverOutOfBandEffects`.
   */
  deliverEscalationEffects?: (
    session: VoiceSession,
    effects: SideEffect[],
    tenantId: string,
  ) => Promise<void>;
  /**
   * Per-tenant escalation settings, resolved once at adapter construction
   * (i.e. per WebSocket connection lifetime). Changes made to the tenant's
   * escalationSettings during an active call are NOT reflected in the
   * current connection — they apply only to subsequent connections.
   * Optional — when absent, LLM sentiment is disabled.
   *
   * @deprecated Use `resolveEscalationSettings` for per-tenant resolution at
   * session start. This static field is kept as a fallback for tests.
   */
  escalationSettings?: EscalationSettings;
  /**
   * F6c (per-tenant) — async resolver for escalation settings. Called once
   * per WS session after the tenantId is known (in handleStart). The resolved
   * settings are stored on RuntimeState and used to gate the LLM sentiment
   * classifier. Preferred over the static `escalationSettings` field.
   * Optional — when absent and `escalationSettings` is also absent, LLM
   * sentiment is disabled.
   */
  resolveEscalationSettings?: (tenantId: string) => Promise<EscalationSettings>;
  /**
   * RV-122 — per-turn vulnerability triage hook. Fired after each
   * `speechTurn` exactly like the sentiment classifier (fire-and-forget,
   * never blocks the audio path). The hook owns its own per-tenant flag
   * gate (`voice_vulnerability_triage`), grading, triage persistence
   * (RV-120) and the patch-owner action (RV-121) — the adapter only
   * supplies the turn context.
   */
  vulnerabilityTriageHook?: (args: {
    session: VoiceSession;
    transcript: string;
    priorTurns: ReadonlyArray<{ role: 'caller' | 'ai'; text: string }>;
    tenantId: string;
  }) => Promise<void>;
  /**
   * WS3/WS16a (voice ingestion resilience) — in-process realtime health
   * circuit, shared with the /voice TwiML branch (which reads `isOpen()`). The
   * adapter votes it AT MOST ONCE per call leg (see
   * {@link RuntimeState.circuitRecorded}) from REAL call outcomes:
   *   - `recordFailure` on a terminal realtime failure — Deepgram open failure,
   *     recording-disclosure bootstrap failure, an unexpected mid-call Deepgram
   *     close (even when the call then degrades to Gather — realtime still
   *     died), a failed language-switch reopen, or an ESTABLISHED session that
   *     closes on a transport_failure-class reason.
   *   - `recordSuccess` only when an ESTABLISHED session closes on a clean /
   *     caller-driven reason (twilio_stop, end_session, audio_idle_timeout) —
   *     the transport survived the whole call.
   * Success is NOT recorded at establishment: doing so reset the consecutive-
   * failure counter and let a clean-establish-then-die-mid-call leg never trip
   * the breaker (the establish-then-die trap). Pre-establishment closes never
   * vote. Optional; when absent the adapter behaves exactly as before.
   */
  realtimeCircuit?: {
    recordFailure(kind: string): void;
    recordSuccess(): void;
  };
  /**
   * WS3 — audit sink for the realtime resilience events
   * (`voice.realtime.session_failed`, `voice.disclosure.init_failed`). Emitted
   * best-effort (never blocks or throws into the WS handler) so a failed
   * realtime session and — critically — an undisclosed recording are countable
   * and alertable rather than a log scrape. Optional; when absent the events
   * are skipped (test/dev path).
   */
  auditRepo?: import('../../audit/audit').AuditRepository;
  /**
   * WS7 — mid-call REST redirect to the Gather-only fallback webhook. When
   * wired, a terminal realtime failure (Deepgram open failure, unexpected
   * mid-call Deepgram close) attempts to steer the LIVE call back to `<Gather>`
   * via Twilio's Calls REST resource instead of hanging up. Returns `true` when
   * Twilio accepted the redirect; on `false`/absent the adapter falls back to
   * today's WS-close behavior. Never throws. `accountSid` is the value Twilio
   * sent in the `start` frame.
   */
  restRedirect?: (args: { callSid: string; accountSid?: string }) => Promise<boolean>;
}

const TWILIO_SURFACE = 'twilio_media_streams';
/** Connection-cap lease TTL for telephony — no registry heartbeat, so it must
 *  exceed any call's duration; it only serves as the crashed-replica backstop. */
const TELEPHONY_LEASE_TTL_MS = 2 * 60 * 60 * 1000;

// Skip the LLM sentiment call once the session has consumed this fraction of
// its cost cap, so frustration classification can't blow a tenant's budget.
const SENTIMENT_MAX_BUDGET_RATIO = 0.8;

/**
 * UB-C1 — flap guard: maximum Deepgram finish+reopen cycles per call.
 * Two covers the legitimate shapes (wrong opening language → correct one,
 * plus one explicit switch back); anything more is flapping on the
 * revenue path and is refused.
 */
const MAX_LANGUAGE_SWITCHES_PER_CALL = 2;

/**
 * VOX-35c — after this many CONSECUTIVE `speechTurn` failures the adapter
 * stops apologizing and hands the caller off gracefully (spoken escalation
 * line + clean end) instead of looping "my apologies, let me try again"
 * forever. A single successful turn resets the counter. Two mirrors the
 * language-switch flap budget: one transient blip earns a retry, a second
 * back-to-back failure is a real outage and the caller should not stay
 * trapped talking to a broken agent.
 */
const MAX_CONSECUTIVE_SPEECH_TURN_FAILURES = 2;

/**
 * A3 — minimum Deepgram acoustic `confidence` (0..1, on FINAL transcripts
 * only) the adapter requires before treating a transcript as heard correctly
 * and dispatching it into the FSM. Below this, the turn is NOT dispatched —
 * the caller is asked to repeat instead (see {@link LOW_STT_CONFIDENCE_REPROMPT_COPY}).
 * A misheard turn acted on as if correct is worse than one extra reprompt
 * (e.g. "cancel" dispatched from a misheard "confirm").
 *
 * 0.5 is a conservative default: Deepgram Nova-3's acoustic confidence for
 * ordinary, clearly-heard speech is typically well above 0.7-0.8, while a
 * genuinely garbled/crosstalk/very-noisy-line utterance tends to fall well
 * below 0.5. A conservative (low) floor means we mostly catch the clearly-bad
 * tail rather than second-guessing ordinary accented or slightly-quiet audio.
 * Env-overridable per deployment (e.g. a noisier vertical may want it lower).
 * Invalid/out-of-range overrides fall back to the default rather than
 * disabling or over-triggering the gate.
 */
// Exported (not just module-local) so the Gather/PSTN fallback adapter
// (twilio-adapter.ts `_handleGatherLocked`) gates Twilio's `Confidence` field
// against the SAME threshold and cap as the media-streams/Deepgram path —
// one env var, one number, for both surfaces.
export const MIN_STT_CONFIDENCE = ((): number => {
  const raw = process.env.VOICE_MIN_STT_CONFIDENCE;
  if (raw === undefined) return 0.5;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 1 ? parsed : 0.5;
})();

/**
 * A3 — after this many CONSECUTIVE low-acoustic-confidence finals the
 * adapter stops reprompting and hands the caller off gracefully, mirroring
 * {@link MAX_CONSECUTIVE_SPEECH_TURN_FAILURES}: a caller on a persistently
 * noisy/unintelligible line should not be trapped in a "could you repeat
 * that" loop forever. Exported for the same cross-surface reason as
 * {@link MIN_STT_CONFIDENCE}.
 */
export const MAX_CONSECUTIVE_LOW_CONFIDENCE_TURNS = 2;

interface RuntimeState {
  ws: WsLike;
  streamSid: string | null;
  callSid: string | null;
  /** WS7 — Twilio AccountSid from the `start` frame, for the mid-call REST redirect. */
  accountSid: string | null;
  tenantId: string | null;
  session: VoiceSession | null;
  deepgram: StreamingSession | null;
  /**
   * True while we are actively streaming an agent TTS response. A
   * partial transcript that arrives while this is true is treated as
   * caller barge-in: we send `clear` to Twilio and abort the in-flight
   * outbound stream.
   */
  agentSpeaking: boolean;
  /**
   * Bumped before each outbound TTS turn so an in-flight async TTS
   * synthesis whose output arrives after a barge-in is dropped instead
   * of overlapping the next caller turn.
   */
  outboundTurnId: number;
  /** Active TTS turn's AbortController so barge-in can immediately cancel a pending WS read. */
  ttsController: AbortController | null;
  closed: boolean;
  /** Last time we received an inbound `media` frame. */
  lastMediaAt: number;
  audioIdleTimer: NodeJS.Timeout | null;
  /**
   * T2-F05 — per-turn caller-silence reprompt timer. Armed when the final
   * end-of-turn mark of an agent (non-filler) TTS turn is enqueued; cleared
   * by any transcript event, barge-in, and close. See
   * {@link TwilioMediaStreamAdapter.armSilenceRepromptTimer}.
   */
  silenceRepromptTimer: NodeJS.Timeout | null;
  /** Outbound queue (bounded, priority-aware). */
  queue: BoundedSendQueue;
  draining: boolean;
  /** Outstanding marks awaiting Twilio `mark` ack (for backpressure). */
  unackedMarks: number;
  /** Slow-consumer grace timer; when set, we close after this fires. */
  slowConsumerTimer: NodeJS.Timeout | null;
  /** True after we've released our slot in the connection registry. */
  registryReleased: boolean;
  /** Connection-cap lease (U3b); released on teardown, refreshed by no loop. */
  connectionLease: ConnectionLease | null;
  /** Guards against calling ws.close() more than once. */
  wsCloseInitiated: boolean;
  /**
   * B2 — captures the most recent FSM dispatch's SideEffect[] when an
   * `end_session` effect was emitted. Threaded through `finalizeOnClose`
   * so the host can read the FSM-supplied `payload.reason` for outcome
   * derivation (e.g. 'abuse_detected:*' → escalated_to_human).
   * Empty for non-FSM close paths (idle timer, slow consumer, WS error).
   */
  pendingFinalizeEffects: ReadonlyArray<SideEffect>;
  /**
   * VQ2-004 — per-turn first-frame guard. Set to `true` when a final
   * transcript arrives (`transcript_received` was just emitted). Reset
   * to `false` after the first outbound media chunk of the turn is
   * enqueued, so subsequent frames in the same turn don't re-emit
   * `audio_frame_emitted`. Stored on the adapter (not the session)
   * because the lifecycle is strictly bound to this WS connection.
   */
  awaitingFirstAudioFrame: boolean;
  /**
   * WS26 — epoch-ms stamped when a FINAL transcript arms the turn (paired with
   * `awaitingFirstAudioFrame`). Read once when the first non-filler outbound
   * chunk is enqueued to observe `voice_turn_latency_ms`, then cleared. `null`
   * between turns. Overwritten each turn, so a barge-in that killed the prior
   * turn before any audio never leaks a stale start into the next measurement.
   */
  turnLatencyStartMs: number | null;
  /**
   * True while a filler clip is actively streaming. Cleared when real
   * TTS preempts it or when barge-in kills it. Used to gate
   * TTFA emission and to coordinate filler/real-TTS cancellation.
   */
  fillerActive: boolean;
  /**
   * @deprecated DO NOT USE — use `deps.setPendingTransferTwiml` to write
   * into the TwilioGatherAdapter's shared pendingTransferTwiml Map. This
   * field is never read by any route handler; it exists only as a fallback
   * log target when `deps.setPendingTransferTwiml` is not wired.
   */
  pendingTransferTwiml: string | null;
  /**
   * F6c (per-tenant) — escalation settings resolved at session start
   * (after tenantId is known in handleStart). Null when resolution
   * failed or `deps.resolveEscalationSettings` is absent. Falls back
   * to `deps.escalationSettings` when null.
   */
  resolvedEscalationSettings: EscalationSettings | null;
  /**
   * RV-140 (interim) — debounce for the interim emergency scan. Set once an
   * interim-detected emergency actually escalated, so the stream of
   * progressively longer interims for the SAME utterance ("gas", "gas leak",
   * "gas leak in the…") doesn't re-enter the scan on every frame. The FSM's
   * own `emergency_detected` guard is the correctness backstop (already
   * escalating → empty effects, so the final that follows an interim-fired
   * emergency can't double-page) — this flag just skips redundant lock
   * round-trips on subsequent interims.
   */
  interimEmergencyFired: boolean;
  /**
   * UB-C1 — the language the LIVE Deepgram session is listening in.
   * Distinct from `session.language` (the spoken/TTS language, which the
   * host may also set from tenant defaults): this field tracks what the
   * STT socket was actually opened with, so the switch triggers compare
   * against reality. `switchLanguage` keeps both in sync.
   */
  language: 'en' | 'es';
  /**
   * UB-C1 — keyword-boost tokens resolved at `start`. Kept so a
   * language switch back to 'en' can re-apply them ('es' suppresses
   * them — English trade terms degrade Nova-3 on Spanish).
   */
  sttKeywords: ReadonlyArray<string>;
  /** UB-C1 — flap guard. Hard cap on Deepgram reopen cycles per call. */
  languageSwitchCount: number;
  /**
   * WS7 — monotonic Deepgram session generation. Bumped on every
   * `openSession` call AND before discarding the old session in
   * `switchLanguage`, so a stale session's `onClose` (fired by the
   * deliberate finish/reopen cycle) can be told apart from the LIVE
   * session closing unexpectedly. The degrade-to-Gather hook bails when
   * its captured generation is no longer current — a healthy
   * language-switched call must never be REST-redirected.
   */
  deepgramGeneration: number;
  /**
   * WS7 — set once a mid-call REST redirect to Gather was ACCEPTED by
   * Twilio. `handleClose` then skips `finalizeOnClose`: the session is
   * still live (the caller continues on the Gather leg), so stamping a
   * terminal CallOutcome here would mark it ended mid-call, block the
   * Gather leg's own finalization (terminalOutcome early-return), and
   * schedule dropped-call recovery SMS to a caller who is still on the
   * phone. The Gather path owns finalization from this point.
   */
  degradedToGather: boolean;
  /**
   * UB-C1 — set once the first FINAL transcript has been through the
   * one-shot language-detection trigger, so utterance #2+ can only
   * switch via the explicit-request path.
   */
  firstFinalLanguageChecked: boolean;
  /**
   * WS16a — realtime-circuit latch. One WebSocket == one realtime call leg,
   * so the leg votes the circuit at most ONCE (`recordFailure` OR
   * `recordSuccess`). The FIRST, most-precise signal wins: a mid-call
   * `deepgram_unexpected_close` recorded at its onClose site suppresses the
   * blunt `ws_closed` that follows it through `handleClose`, and a disclosure
   * failure suppresses the clean terminal `twilio_stop` (letting a clean end
   * erase an establishment failure would resurrect the establish-then-die
   * trap). Init false in the constructor.
   */
  circuitRecorded: boolean;
  /**
   * VOX-35c — number of CONSECUTIVE `speechTurn` failures on this leg. Bumped
   * each time the dispatch throws inside the session lock; reset to 0 after
   * any successful turn. When it reaches
   * {@link MAX_CONSECUTIVE_SPEECH_TURN_FAILURES} the adapter escalates/hands
   * off instead of speaking another apology, so a persistently broken turn
   * pipeline can't trap the caller in an apology loop. Init 0.
   */
  consecutiveSpeechTurnFailures: number;
  /**
   * A3 — number of CONSECUTIVE FINAL transcripts on this leg whose Deepgram
   * acoustic `confidence` fell below {@link MIN_STT_CONFIDENCE}. Bumped each
   * time a final is reprompted instead of dispatched; reset to 0 by any
   * dispatched (high-enough-confidence, or confidence-absent) turn. When it
   * reaches {@link MAX_CONSECUTIVE_LOW_CONFIDENCE_TURNS} the adapter hands
   * off gracefully instead of reprompting again. Init 0.
   */
  consecutiveLowConfidenceTurns: number;
}

const TWILIO_QUEUE_MAX_MSGS = 200;
const TWILIO_QUEUE_MAX_BYTES = 4 * 1024 * 1024;
const TWILIO_QUEUE_HIGH_WATERMARK = 0.7;
/** Pause TTS pull when this many marks are unacked. */
const TWILIO_MAX_UNACKED_MARKS = 3;
/** Slow-consumer grace window before disconnect. */
const TWILIO_SLOW_CONSUMER_GRACE_MS = 8_000;
/** Slow-consumer EWMA send latency threshold. */
const TWILIO_SLOW_CONSUMER_EWMA_THRESHOLD_MS = 250;

/**
 * P0 voice-output fix — MIME types that `streamPcmAsMedia` can safely
 * consume. That method treats its input as raw, unencoded PCM16 samples
 * (it does the PCM16 → mu-law encoding itself via `encodeTwilioOutboundFrame`)
 * — it has no decoder for compressed formats. A `TtsProvider.synthesize()`
 * result is only safe to hand to it when `contentType` is one of these; any
 * compressed format (e.g. OpenAI/ElevenLabs' default 'audio/mpeg') would be
 * streamed out as static with no error otherwise.
 */
const RAW_PCM_CONTENT_TYPES = new Set(['audio/pcm', 'audio/l16', 'audio/x-raw', 'audio/raw']);

function isRawPcmContentType(contentType: string): boolean {
  const base = contentType.split(';')[0]?.trim().toLowerCase() ?? '';
  return RAW_PCM_CONTENT_TYPES.has(base);
}

/**
 * B2 — map handleClose's `reason` into a CallOutcome-compatible
 * endedReason recognised by `deriveCallOutcome`. Transport-layer
 * failures (WS errors, slow-consumer disconnects, outbound-queue
 * overflow) are stamped as `failed` rather than being flattened into
 * caller-driven outcomes — otherwise an infra regression looks like
 * normal call abandonment in the dashboards.
 *
 * `twilio_stop` is the protocol-correct end-of-call signal from
 * Twilio; treat as caller-hangup. `ws_closed` only reaches the mapper
 * when the WS closed BEFORE a `stop` frame arrived (a `stop` would
 * have set state.closed and short-circuited this path), which is also
 * a transport failure.
 */
function mapCloseReasonToFinalize(reason: string): string {
  if (reason === 'audio_idle_timeout') return 'idle_timeout';
  if (reason === 'end_session') return 'session_ended';
  if (reason === 'twilio_stop') return 'caller_hangup';
  if (
    reason === 'ws_error' ||
    reason === 'ws_closed' ||
    reason === 'slow_consumer' ||
    reason === 'queue_overflow_terminal' ||
    // WS16a — a failed Deepgram reopen (language switch) with no recovery
    // leaves the live call with no STT: a transport failure, not the
    // caller_hangup default it previously fell through to. Both the CallOutcome
    // (`failed`) and the realtime-circuit vote depend on this classification.
    reason === 'deepgram_reopen_failed'
  ) {
    return 'transport_failure';
  }
  return 'caller_hangup';
}

/**
 * WS26 — best-effort observation of voice turn latency (STT-final → first TTS
 * chunk) into the `voice_turn_latency_ms` histogram. Wrapped so a metrics-layer
 * failure (a throwing prom registry) can NEVER propagate into the outbound audio
 * loop — the same posture as the adapter's other best-effort emitters. A `null`
 * start (no armed turn) or a negative delta (clock skew) is silently ignored.
 */
function observeTurnLatency(startMs: number | null): void {
  if (startMs === null) return;
  try {
    const deltaMs = Date.now() - startMs;
    if (deltaMs >= 0) voiceTurnLatencyMs.observe(deltaMs);
  } catch {
    /* metrics must never throw into the audio pipeline */
  }
}

// ─── Adapter ─────────────────────────────────────────────────────────────────

/**
 * Default audio-inactivity teardown: 30 minutes. Aligns with the
 * VoiceSessionStore's idle TTL so a long-lived WS that stops receiving
 * `media` frames doesn't leak past the FSM session.
 */
export const DEFAULT_AUDIO_IDLE_TIMEOUT_MS = 30 * 60 * 1000;

/**
 * T2-F05 — how long after the agent finishes speaking a totally silent caller
 * waits before the reprompt fires. Default 8 s: long enough for a caller
 * checking a calendar or conferring with a spouse, short enough that the line
 * never feels dead. Dep-injectable via `deps.silenceRepromptTimeoutMs`.
 */
export const DEFAULT_SILENCE_REPROMPT_MS = 8_000;

export class TwilioMediaStreamAdapter {
  private readonly state: RuntimeState;

  constructor(
    private readonly deps: MediaStreamAdapterDeps,
    ws: WsLike,
  ) {
    this.state = {
      ws,
      streamSid: null,
      callSid: null,
      accountSid: null,
      tenantId: null,
      session: null,
      deepgram: null,
      agentSpeaking: false,
      outboundTurnId: 0,
      ttsController: null,
      closed: false,
      lastMediaAt: Date.now(),
      audioIdleTimer: null,
      silenceRepromptTimer: null,
      queue: new BoundedSendQueue({
        surface: 'twilio_media_streams',
        maxMsgs: TWILIO_QUEUE_MAX_MSGS,
        maxBytes: TWILIO_QUEUE_MAX_BYTES,
        highWatermark: TWILIO_QUEUE_HIGH_WATERMARK,
      }),
      draining: false,
      unackedMarks: 0,
      slowConsumerTimer: null,
      registryReleased: true,
      connectionLease: null,
      wsCloseInitiated: false,
      pendingFinalizeEffects: [],
      awaitingFirstAudioFrame: false,
      turnLatencyStartMs: null,
      fillerActive: false,
      pendingTransferTwiml: null,
      resolvedEscalationSettings: null,
      interimEmergencyFired: false,
      language: 'en',
      sttKeywords: [],
      languageSwitchCount: 0,
      deepgramGeneration: 0,
      degradedToGather: false,
      firstFinalLanguageChecked: false,
      circuitRecorded: false,
      consecutiveSpeechTurnFailures: 0,
      consecutiveLowConfidenceTurns: 0,
    };
  }

  /**
   * WS16a — feed the realtime health circuit AT MOST ONCE per call leg. The
   * first signal latches; every later signal for the same WS is suppressed so
   * a single dying call (deepgram close → accepted degrade → ws close) casts
   * exactly one vote, and the earliest (most precise) reason wins. No-ops when
   * no circuit is wired (test/dev). See {@link RuntimeState.circuitRecorded}.
   */
  private recordCircuitOutcomeOnce(kind: 'success' | 'failure', reason: string): void {
    if (this.state.circuitRecorded || !this.deps.realtimeCircuit) return;
    this.state.circuitRecorded = true;
    if (kind === 'failure') {
      this.deps.realtimeCircuit.recordFailure(reason);
    } else {
      this.deps.realtimeCircuit.recordSuccess();
    }
  }

  /** Wire WS event listeners. Idempotent — call once per connection. */
  start(): void {
    const { ws } = this.state;
    ws.on('message', (data: Buffer | string) => {
      void this.handleMessage(data);
    });
    ws.on('close', () => this.handleClose('ws_closed'));
    ws.on('error', (err: Error) => {
      logger.warn('mediastream ws error', { error: err.message });
      this.handleClose('ws_error');
    });
    this.armIdleTimer();
  }

  // ─── Inbound message dispatch ──────────────────────────────────────────────

  private async handleMessage(data: Buffer | string): Promise<void> {
    let frame: TwilioInboundFrame;
    try {
      const text = typeof data === 'string' ? data : data.toString('utf8');
      frame = JSON.parse(text) as TwilioInboundFrame;
    } catch {
      // Twilio always sends JSON. Malformed → drop the frame.
      return;
    }
    switch (frame.event) {
      case 'connected':
        // Just an info frame; nothing to do.
        return;
      case 'start':
        await this.handleStart(frame);
        return;
      case 'media':
        await this.handleMedia(frame);
        return;
      case 'mark':
        if (this.state.unackedMarks > 0) this.state.unackedMarks--;
        // Mark-ack is the cue to drain any backpressured outbound work.
        void this.flushQueue();
        return;
      case 'stop':
        await this.handleStop();
        return;
      default:
        return;
    }
  }

  private async handleStart(frame: Extract<TwilioInboundFrame, { event: 'start' }>): Promise<void> {
    if (!isValidStartFrame(frame)) {
      this.logSecurityEvent('invalid_start_payload', {
        streamSid: frame.streamSid,
        hasStart: typeof frame.start === 'object' && frame.start !== null,
      });
      this.closeWs(1008, 'invalid_start_payload');
      return;
    }

    const callSid = frame.start.callSid;
    const session = this.deps.store.findByCallSid(callSid);
    if (!session) {
      this.logSecurityEvent('tenant_resolution_failed', {
        reason: 'unknown_callsid',
        callSid,
      });
      this.closeWs(1008, 'unknown_callsid');
      return;
    }

    const claimedTenant = frame.start.customParameters?.tenantId;
    if (claimedTenant && claimedTenant !== session.tenantId) {
      this.logSecurityEvent('tenant_mismatch', {
        callSid,
        claimedTenant,
        resolvedTenant: session.tenantId,
      });
      this.closeWs(1008, 'tenant_mismatch');
      return;
    }

    // Per-tenant connection cap.
    const registry = this.deps.connectionRegistry ?? globalConnectionRegistry;
    // Telephony has no registry heartbeat loop, so use a long lease TTL that
    // covers any call; the slot is released on teardown and the TTL is only the
    // crashed-replica backstop. (Gateway connections refresh on their heartbeat.)
    const lease = await registry.acquire(
      TWILIO_SURFACE,
      session.tenantId,
      'standard',
      TELEPHONY_LEASE_TTL_MS,
    );
    if (!lease) {
      this.logSecurityEvent('tenant_connection_cap_exceeded', {
        callSid,
        tenantId: session.tenantId,
      });
      this.closeWs(1013, 'tenant_connection_cap');
      return;
    }
    this.state.connectionLease = lease;
    this.state.registryReleased = false;

    this.state.streamSid = frame.start.streamSid;
    this.state.callSid = callSid;
    this.state.accountSid = frame.start.accountSid ?? null;
    this.state.session = session;
    this.state.tenantId = session.tenantId;

    // F6c (per-tenant) — resolve escalation settings now that tenantId is known.
    // Stored on RuntimeState so the sentiment gating check reads a live value
    // rather than the static dep (which was always undefined in production).
    if (this.deps.resolveEscalationSettings) {
      try {
        this.state.resolvedEscalationSettings = await this.deps.resolveEscalationSettings(session.tenantId);
      } catch (err) {
        logger.warn('mediastream: failed to resolve escalation settings, using defaults', {
          tenantId: session.tenantId,
          error: err instanceof Error ? err.message : String(err),
        });
        this.state.resolvedEscalationSettings = null;
      }
    }

    const keywords = this.deps.terminologyProvider
      ? await this.deps.terminologyProvider.getKeywords(session.tenantId).catch(() => [])
      : [];
    this.state.sttKeywords = keywords;

    // UB-C1 — resolve the language the call opens in (customer
    // preferredLanguage + tenant supported_languages, composed in app.ts).
    // Failure-soft: a resolver error opens the call in English rather than
    // blocking audio. Only pin session.language when a resolver is wired so
    // the host's own tenant-default resolution keeps pre-UB-C behavior in
    // test/dev fixtures that don't inject one.
    let initialLanguage: 'en' | 'es' | undefined;
    if (this.deps.initialLanguageResolver) {
      try {
        initialLanguage = await this.deps.initialLanguageResolver(session.tenantId, {
          callSid,
          sessionId: session.id,
        });
      } catch (err) {
        logger.warn('mediastream: initialLanguageResolver failed — opening in English', {
          tenantId: session.tenantId,
          error: err instanceof Error ? err.message : String(err),
        });
        initialLanguage = 'en';
      }
      this.state.language = initialLanguage;
      // Pin the spoken language too — initializeStreamSession honors a
      // pre-pinned session.language (greeting/disclosure/TTS all follow it).
      session.language = initialLanguage;
    }

    try {
      const dgGeneration = ++this.state.deepgramGeneration;
      this.state.deepgram = await this.deps.streamingProvider.openSession(
        (event) => {
          this.onTranscriptEvent(event).catch((err) => {
            logger.warn('mediastream transcript handler threw', {
              error: err instanceof Error ? err.message : String(err),
            });
          });
        },
        (err) => {
          logger.warn('mediastream deepgram error', { error: err.message });
        },
        () => {
          // WS7 — Deepgram closed independently mid-call. Attempt to steer the
          // live call back to Gather so the caller isn't talking into dead
          // transcription. Generation-guarded: a deliberate finish/reopen
          // cycle (switchLanguage) closes THIS session on purpose — only the
          // current generation's close is an unexpected failure. On redirect
          // failure / absent dep (or during normal teardown, which
          // attemptDegradeToGather guards against) this keeps today's
          // behavior: drain Twilio until it sends `stop`.
          if (dgGeneration !== this.state.deepgramGeneration) return;
          // WS16a — a deliberate teardown (twilio `stop`, idle timeout, WS
          // close) calls deepgram.finish(), whose real provider fires THIS
          // hook on the follow-on ws close. That is not a transport failure,
          // so bail before voting once the leg is already tearing down; the
          // clean-close success is recorded by handleClose instead.
          if (this.state.closed || this.state.wsCloseInitiated) return;
          // An unexpected mid-call close on the LIVE generation IS a realtime
          // transport failure. Vote BEFORE the degrade attempt — a successful
          // degrade-to-Gather still means realtime died mid-call, so it counts
          // as a failure of the realtime transport (the latch then suppresses
          // the blunt `ws_closed` that the degrade's closeWs produces).
          this.recordCircuitOutcomeOnce('failure', 'deepgram_unexpected_close');
          void this.attemptDegradeToGather('deepgram_unexpected_close');
        },
        initialLanguage, // undefined → provider default (English)
        // UB-C1 — suppress the English trade-term boost on Spanish opens.
        this.deepgramKeywordOptions(initialLanguage ?? 'en')
      );
    } catch (err) {
      logger.error('mediastream: failed to open Deepgram session', {
        error: err instanceof Error ? err.message : String(err),
        callSid,
      });
      // WS3/WS7 — terminal pre-conversation failure. Trip the realtime health
      // circuit and emit an alertable audit event before ending the leg, so
      // repeated Deepgram outages steer subsequent calls to Gather. WS7: also
      // attempt a REST redirect of THIS live call to the Gather webhook; on
      // success the caller continues on Gather (close 1000) instead of being
      // hung up. When no redirector is wired or the redirect fails, closeWs(1011)
      // ends the leg exactly as before and Twilio ends the call.
      this.recordCircuitOutcomeOnce('failure', 'deepgram_open_failed');
      await this.emitRealtimeResilienceAudit('voice.realtime.session_failed', {
        callSid,
        tenantId: session.tenantId,
        reason: 'deepgram_open_failed',
      });
      if (!(await this.attemptDegradeToGather('deepgram_open_failed'))) {
        this.closeWs(1011, 'deepgram_open_failed');
      }
      return;
    }

    // Play greeting: run disclosure + caller-ID + FSM bootstrap, then
    // synthesize and stream the greeting audio before listening for speech.
    // Wrapped in withSessionLock so a final transcript that races the
    // bootstrap (caller speaks before greeting completes) cannot dispatch
    // FSM events on top of an in-flight `incoming_call` / `greeted_ok`.
    if (this.deps.initializeSession) {
      try {
        const initEffects = await this.deps.store.withSessionLock(session.id, () =>
          this.deps.initializeSession!({
            callSid,
            tenantId: session.tenantId,
          }),
        );
        await this.emitSideEffects(initEffects);
        // WS16a — establishment success is deliberately NOT recorded here. The
        // old recordSuccess() at this site reset the circuit's consecutive-
        // failure counter, so a call that established cleanly then died mid-call
        // (Deepgram dropped, transport failure) never counted — the
        // "establish-then-die" trap that let the breaker never trip under the
        // most common realtime outage mode. Success is now voted once at close
        // time (handleClose) and only on a clean/caller-driven end reason; a
        // transport-failure close votes failure instead.
      } catch (err) {
        logger.warn('mediastream: initializeSession failed — continuing without greeting', {
          error: err instanceof Error ? err.message : String(err),
          callSid,
        });
        // DISCLOSURE_INIT_FAILED — the call continues but the caller was never
        // given the recording-consent disclosure and the session is unledgered.
        // WS3 — undisclosed recording is a compliance stop signal: emit an
        // alertable audit event and trip the realtime health circuit so
        // repeated disclosure failures steer subsequent calls to Gather. We do
        // NOT hang up a live customer — the call continues (Twilio is already
        // recording per the <Start><Stream> TwiML), the disclosure gap is now
        // countable rather than a log scrape.
        logger.error('DISCLOSURE_INIT_FAILED', {
          callSid,
          tenantId: session.tenantId,
          error: err instanceof Error ? err.message : String(err),
        });
        this.recordCircuitOutcomeOnce('failure', 'disclosure_init_failed');
        await this.emitRealtimeResilienceAudit('voice.disclosure.init_failed', {
          callSid,
          tenantId: session.tenantId,
          reason: 'disclosure_init_failed',
        });
      }
    }
    // WS16a — the no-`initializeSession` branch no longer records success here
    // either: like the wired path, a clean session votes success only at close
    // time. Recording success at establishment is the establish-then-die trap.
  }

  /**
   * WS3 — best-effort audit emit for the realtime resilience events. Never
   * throws into the WS handler and never blocks the audio path on a failed
   * Postgres write; a persistence error is logged and swallowed. No-ops when
   * no `auditRepo` is wired (test/dev). The event is tenant-scoped and
   * correlated by callSid so ops can count & alert on realtime session
   * failures and undisclosed recordings.
   */
  private async emitRealtimeResilienceAudit(
    eventType:
      | 'voice.realtime.session_failed'
      | 'voice.disclosure.init_failed'
      | 'voice.realtime.degraded_to_gather',
    args: { callSid: string; tenantId: string; reason: string },
  ): Promise<void> {
    if (!this.deps.auditRepo) return;
    try {
      await this.deps.auditRepo.create(
        createAuditEvent({
          tenantId: args.tenantId,
          actorId: 'system:media-streams',
          actorRole: 'system',
          eventType,
          entityType: 'voice_session',
          entityId: args.callSid,
          correlationId: args.callSid,
          metadata: {
            callSid: args.callSid,
            reason: args.reason,
            surface: TWILIO_SURFACE,
          },
        }),
      );
    } catch (err) {
      logger.warn('mediastream: realtime resilience audit persist failed', {
        eventType,
        callSid: args.callSid,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * WS7 — attempt to steer the LIVE call back to Gather via the Twilio REST
   * redirect (`deps.restRedirect`). On success emit the
   * `voice.realtime.degraded_to_gather` audit and close the WS with 1000 —
   * Twilio then re-requests TwiML from the Gather-fallback webhook and the
   * caller continues on Gather instead of hearing dead air. Returns `true` when
   * the redirect was accepted; on `false`/absent dep the caller keeps its
   * existing terminal behavior. Never throws.
   */
  private async attemptDegradeToGather(reason: string): Promise<boolean> {
    const { restRedirect } = this.deps;
    const callSid = this.state.callSid;
    if (!restRedirect || !callSid || this.state.wsCloseInitiated || this.state.closed) {
      return false;
    }
    let redirected = false;
    try {
      redirected = await restRedirect({
        callSid,
        ...(this.state.accountSid ? { accountSid: this.state.accountSid } : {}),
      });
    } catch {
      redirected = false;
    }
    if (!redirected) return false;
    if (this.state.session) {
      await this.emitRealtimeResilienceAudit('voice.realtime.degraded_to_gather', {
        callSid,
        tenantId: this.state.session.tenantId,
        reason,
      });
    }
    // The session stays LIVE — the caller continues on the Gather leg, which
    // owns finalization from here. handleClose reads this flag and skips
    // finalizeOnClose (a terminal outcome stamped now would be mid-call).
    this.state.degradedToGather = true;
    this.closeWs(1000, 'degraded_to_gather');
    // OBS — fire-and-forget after the degrade has actually happened; never
    // alters the redirect/close behavior above.
    recordVoiceError({
      errorKind: 'degraded_to_gather',
      channel: 'media_streams',
      callSid,
      tenantId: this.state.tenantId,
    });
    return true;
  }

  private async handleMedia(frame: Extract<TwilioInboundFrame, { event: 'media' }>): Promise<void> {
    if (!this.state.deepgram) return;
    this.state.lastMediaAt = Date.now();
    this.armIdleTimer();
    try {
      const pcm16 = decodeTwilioInboundFrame(frame.media.payload);
      this.state.deepgram.send(pcm16);
    } catch (err) {
      logger.warn('mediastream: failed to decode/forward inbound frame', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private async handleStop(): Promise<void> {
    try {
      this.state.deepgram?.finish();
    } catch {
      /* swallow */
    }
    this.handleClose('twilio_stop');
  }

  // ─── Transcript event handler ──────────────────────────────────────────────

  private async onTranscriptEvent(event: {
    type: 'partial' | 'final';
    transcript: string;
    confidence: number;
    isFinal: boolean;
  }): Promise<void> {
    // T2-F05 — any caller audio (interim or final) means not-silent.
    this.clearSilenceRepromptTimer();
    // Barge-in: any interim transcript while we're playing TTS aborts
    // the current agent utterance. Empty interim transcripts are
    // already filtered by DeepgramStreamingProvider.
    if (!event.isFinal) {
      if (this.state.agentSpeaking) {
        this.bargeIn();
      }
      // RV-140 (interim) — emergency keywords escalate on interims; the
      // 911 line should not wait for Deepgram to finalize the utterance.
      await this.maybeRunInterimEmergencyScan(event.transcript);
      return;
    }
    // Final transcript: dispatch into the FSM under the per-session lock
    // so concurrent webhook deliveries (Twilio retries, parallel
    // /input requests) can't interleave with this turn.
    const session = this.state.session;
    const callSid = this.state.callSid;
    const tenantId = this.state.tenantId;
    if (!session || !callSid || !tenantId) return;

    // UB-C1 trigger (b) — explicit language request ("hablo español" /
    // "switch to english"). Deterministic pre-scan; when it performs a
    // switch it CONSUMES the turn with a localized acknowledgment (the
    // recording-objection pattern) — "hablo español" is not a booking
    // utterance. Emergency keywords always win the turn: an utterance
    // that contains both is never consumed here.
    if (await this.maybeHandleExplicitLanguageSwitch(event.transcript)) {
      return;
    }

    // UB-C1 trigger (a) — one-shot first-final detection. If the caller's
    // first utterance disagrees with the language Deepgram opened in
    // (gated by the tenant's supported_languages opt-in), switch BEFORE
    // dispatching the turn so the agent's reply renders in the caller's
    // language. Does NOT consume the turn.
    await this.maybeRunFirstFinalLanguageDetection(event.transcript);

    // A3 — low acoustic STT confidence gate. Runs AFTER the life-safety
    // (interim emergency scan, above) and explicit-language-switch checks —
    // neither must ever be suppressed by a shaky confidence score — but
    // BEFORE the turn is dispatched into the FSM. A FINAL Deepgram
    // transcript whose acoustic `confidence` is below MIN_STT_CONFIDENCE is
    // likely mis-heard; dispatching it risks acting on the WRONG intent
    // (e.g. "cancel" dispatched from a misheard "confirm"), so it is
    // reprompted instead. `confidence` is non-optional on
    // StreamingTranscriptEvent and DeepgramStreamingProvider always supplies
    // a number (defaulting to 1 when Deepgram omits it — see
    // transcription-providers.ts), but the check is still defensive: a
    // missing/non-finite value is treated as HIGH so it can never block a
    // turn on absent data (requirement: never block on absent confidence).
    if (
      typeof event.confidence === 'number' &&
      Number.isFinite(event.confidence) &&
      event.confidence < MIN_STT_CONFIDENCE
    ) {
      await this.recoverFromLowSttConfidence(session);
      return;
    }
    // A dispatched (high-confidence, or confidence-absent) final resets the
    // low-confidence streak — mirrors consecutiveSpeechTurnFailures being
    // cleared after a successful turn below.
    this.state.consecutiveLowConfidenceTurns = 0;

    // VQ2-004: TTFA-start. Stamp the moment the STT provider returned a
    // final transcript on the session bus and arm the per-turn
    // first-frame guard so the next outbound chunk emits
    // `audio_frame_emitted`. Emitted BEFORE speechTurn to capture the
    // full agent-thinking window.
    this.state.awaitingFirstAudioFrame = true;
    // WS26 — stamp the turn-latency start (STT-final). Plain assignment; a
    // metrics failure can only happen at observe() time, which is wrapped.
    this.state.turnLatencyStartMs = Date.now();
    session.events.emit(VOICE_EVENT_CHANNEL, transcriptReceivedEvent());

    let sideEffects: SideEffect[] = [];
    try {
      sideEffects = await this.deps.store.withSessionLock(session.id, () =>
        this.deps.speechTurn({
          session,
          speechResult: event.transcript,
          callSid,
          tenantId,
        }),
      );
    } catch (err) {
      logger.warn('mediastream: speechTurn failed', {
        error: err instanceof Error ? err.message : String(err),
        sessionId: session.id,
      });
      // VOX-35c — the turn threw inside the session lock. The old code just
      // returned, so the caller heard pure silence for this turn (the
      // inbound analogue of the VOX-35b mid-stream dead-air bug). Speak a
      // language-aware apology + reprompt through the normal outbound-turn
      // path instead, and after repeated back-to-back failures hand the
      // caller off gracefully rather than looping apologies forever.
      await this.recoverFromSpeechTurnFailure(session);
      return;
    }

    // speechTurn succeeded — clear the consecutive-failure counter so a
    // later isolated blip still gets its own apology+reprompt (not an
    // immediate escalation off a stale count).
    this.state.consecutiveSpeechTurnFailures = 0;

    await this.emitSideEffects(sideEffects);

    // UB-C1 trigger (b), classifier fallback — the LLM classifier caught a
    // `language_switch` intent the deterministic pre-scan missed (e.g.
    // "¿Puedo continuar en español?"). Classified intents flow back to the
    // adapter via the turn's audit_log side effect (same channel the
    // sentiment hook reads). The target is the utterance's requested
    // language when the heuristic can extract it, else the other language
    // of the en/es pair. Gated + flap-guarded inside switchLanguage; the
    // FSM's own effects for this turn were already rendered above.
    const classifiedIntent = (
      sideEffects.find((fx) => fx.type === 'audit_log')?.payload as
        | { intentType?: string }
        | undefined
    )?.intentType;
    if (classifiedIntent === 'language_switch') {
      const target =
        detectLanguageSwitchIntent(event.transcript) ??
        (this.state.language === 'es' ? 'en' : 'es');
      if (isLanguageSupported(target, session.supportedLanguages ?? null)) {
        await this.switchLanguage(target, 'classified_intent');
      }
    }

    // B3.3 — async LLM sentiment classifier. Gated by per-tenant settings.
    // Fire-and-forget so it never blocks the audio response path.
    // Skip when the current turn already emits end_session — the WS will be
    // torn down below, and dispatching into a closing session produces noise.
    const alreadyEnding = sideEffects.some((fx) => fx.type === 'end_session');
    // Use per-session resolved settings (preferred) falling back to the static dep.
    const activeEscalationSettings = this.state.resolvedEscalationSettings ?? this.deps.escalationSettings;
    // Once the call has already escalated (or ended), further sentiment checks
    // are wasted LLM spend — the FSM no-ops the dispatch anyway. Skip them.
    const callState = session.machine.currentState;
    if (
      !alreadyEnding &&
      callState !== 'escalating' &&
      callState !== 'terminated' &&
      this.deps.sentimentClassifier &&
      activeEscalationSettings?.trigger_llm_sentiment
    ) {
      void this.runSentimentCheckAndMaybeEscalate(
        session,
        event.transcript,
        sideEffects,
        activeEscalationSettings,
      ).catch(
        (err) =>
          logger.warn('sentiment check failed', {
            error: err instanceof Error ? err.message : String(err),
          }),
      );
    }

    // RV-122 — per-turn vulnerability triage, fire-and-forget behind the
    // tenant flag (gated inside the hook). Same skip conditions as the
    // sentiment classifier: an ending/escalated call is wasted LLM spend.
    if (
      !alreadyEnding &&
      callState !== 'escalating' &&
      callState !== 'terminated' &&
      this.deps.vulnerabilityTriageHook
    ) {
      void this.deps
        .vulnerabilityTriageHook({
          session,
          transcript: event.transcript,
          priorTurns: this.extractPriorTurns(session, 4),
          tenantId,
        })
        .catch((err) =>
          logger.warn('vulnerability triage hook failed', {
            error: err instanceof Error ? err.message : String(err),
            sessionId: session.id,
          }),
        );
    }

    // FSM may have terminated this turn — close the call.
    if (sideEffects.some((fx) => fx.type === 'end_session')) {
      // B2: stash the dispatch's effects so the finalize hook can read
      // the FSM-supplied end_session.payload.reason — handleClose itself
      // only carries a coarse mediastream label suitable for metrics.
      this.state.pendingFinalizeEffects = sideEffects;
      this.handleClose('end_session');
    }
  }

  /**
   * RV-140 (interim) — run the host's emergency-keyword scan on an interim
   * transcript. Serialized under the per-session lock (same as speechTurn)
   * so an escalating interim can't interleave with an in-flight final turn.
   * On a match, the executed effects (911 line first) are rendered through
   * the normal TTS path and `interimEmergencyFired` debounces every later
   * interim/final for this connection — the FSM's idempotent
   * `emergency_detected` guard already prevents a double-page, the flag
   * just avoids redundant dispatches.
   */
  private async maybeRunInterimEmergencyScan(transcript: string): Promise<void> {
    if (this.state.interimEmergencyFired) return;
    const session = this.state.session;
    const callSid = this.state.callSid;
    const tenantId = this.state.tenantId;
    if (!this.deps.interimEmergencyScan || !session || !callSid || !tenantId) return;
    if (!transcript.trim()) return;

    let effects: SideEffect[] | null = null;
    try {
      effects = await this.deps.store.withSessionLock(session.id, () =>
        this.deps.interimEmergencyScan!({
          session,
          speechResult: transcript,
          callSid,
          tenantId,
        }),
      );
    } catch (err) {
      logger.warn('mediastream: interim emergency scan failed', {
        error: err instanceof Error ? err.message : String(err),
        sessionId: session.id,
      });
      return;
    }
    if (!effects) return;

    this.state.interimEmergencyFired = true;
    await this.emitSideEffects(effects);
  }

  /**
   * VOX-35c — recover a caller turn whose `speechTurn` dispatch threw inside
   * the session lock. Before this the catch simply `return`ed and the caller
   * heard dead air for the whole turn.
   *
   * Failure 1 (and any isolated blip): speak a language-aware apology +
   * reprompt through the SAME outbound-turn path as any agent line
   * (`emitSideEffects` → `runTurnWithFiller`). That reuse is deliberate — it
   * bumps `outboundTurnId`, consumes the dangling `awaitingFirstAudioFrame`/
   * TTFA markers armed before the failed dispatch, and makes barge-in during
   * the apology behave exactly like barge-in during any other agent speech.
   *
   * Failure {@link MAX_CONSECUTIVE_SPEECH_TURN_FAILURES} (back-to-back): the
   * turn pipeline is really down, so stop apologizing — speak the FSM's own
   * system-failure hand-off line and end the call gracefully via the existing
   * `end_session` close path (which finalizes the leg as a `failed` outcome
   * and arms the durable dropped-call recovery follow-up) rather than trapping
   * the caller in an apology loop.
   *
   * The counter is bumped here and reset to 0 by any successful turn.
   */
  private async recoverFromSpeechTurnFailure(session: VoiceSession): Promise<void> {
    this.state.consecutiveSpeechTurnFailures += 1;

    if (
      this.state.consecutiveSpeechTurnFailures >= MAX_CONSECUTIVE_SPEECH_TURN_FAILURES
    ) {
      await this.speakAndEndAfterRepeatedSpeechTurnFailures(session);
      // OBS — fired after the hand-off is spoken/the call is torn down;
      // never alters the recovery behavior above.
      recordVoiceError({
        errorKind: 'speech_turn_repeated_failure',
        channel: 'media_streams',
        callSid: this.state.callSid,
        tenantId: this.state.tenantId,
      });
      return;
    }

    await this.speakRecoveryLine(session, SPEECH_TURN_FAILURE_REPROMPT_COPY);
    // OBS — fired after the apology/reprompt is spoken; never alters the
    // recovery behavior above.
    recordVoiceError({
      errorKind: 'speech_turn_failed',
      channel: 'media_streams',
      callSid: this.state.callSid,
      tenantId: this.state.tenantId,
    });
  }

  /**
   * VOX-35c — repeated-failure branch: speak the localized hand-off line then
   * tear the call down through the normal `end_session` path. The synthetic
   * `end_session` effect is stashed so `finalizeOnClose` reads its
   * `payload.reason` (system_failure:* → `failed` outcome) exactly as it would
   * for an FSM-emitted end_session.
   *
   * A3 reuses this exact hand-off (speak the escalation line, stash a
   * synthetic `end_session`, close) for repeated low-STT-confidence turns —
   * same graceful-hand-off shape, different root cause — so it takes an
   * optional `endSessionReason` to keep `voice_sessions.terminal_reason`
   * accurate for each caller rather than mislabeling a noisy-line hand-off
   * as a pipeline failure. `deriveCallOutcome` doesn't special-case either
   * string beyond the shared `system_failure:` prefix check (which neither
   * of these calls exercises — finalState here is never `escalating`), so
   * both fall through to the same `failed` outcome; the string only affects
   * the persisted reason.
   */
  private async speakAndEndAfterRepeatedSpeechTurnFailures(
    session: VoiceSession,
    endSessionReason: string = 'system_failure:speech_turn_repeated_failure',
  ): Promise<void> {
    await this.speakRecoveryLine(session, SPEECH_TURN_FAILURE_ESCALATION_COPY);
    if (this.state.closed) return;
    this.state.pendingFinalizeEffects = [
      {
        type: 'end_session',
        payload: { reason: endSessionReason },
      },
    ];
    this.handleClose('end_session');
  }

  /**
   * A3 — recover a FINAL transcript whose Deepgram acoustic `confidence`
   * came back below {@link MIN_STT_CONFIDENCE}. Unlike
   * {@link recoverFromSpeechTurnFailure} (the turn PIPELINE threw), here the
   * pipeline is healthy but the STT engine itself flagged the audio as
   * likely mis-heard — dispatching it risks acting on the WRONG intent
   * (e.g. "cancel" dispatched from a misheard "confirm").
   *
   * Streak 1 (and any isolated blip): speak a distinct, language-aware
   * "didn't catch that" reprompt ({@link LOW_STT_CONFIDENCE_REPROMPT_COPY})
   * through the SAME outbound-turn path VOX-35c uses
   * ({@link speakRecoveryLine}) — barge-in/TTFA/transcript bookkeeping
   * behave identically to any other agent line.
   *
   * Streak {@link MAX_CONSECUTIVE_LOW_CONFIDENCE_TURNS} (back-to-back): the
   * line itself is the problem (noisy/crosstalk/bad connection), not a
   * one-off blip — stop reprompting and hand off through the SAME
   * escalation/`end_session` path VOX-35c uses for a persistently broken
   * turn pipeline ({@link speakAndEndAfterRepeatedSpeechTurnFailures}),
   * rather than trapping the caller in a "could you repeat that" loop.
   *
   * The streak is bumped here and reset to 0 by any dispatched
   * (high-confidence, or confidence-absent) final.
   */
  private async recoverFromLowSttConfidence(session: VoiceSession): Promise<void> {
    this.state.consecutiveLowConfidenceTurns += 1;

    if (
      this.state.consecutiveLowConfidenceTurns >= MAX_CONSECUTIVE_LOW_CONFIDENCE_TURNS
    ) {
      await this.speakAndEndAfterRepeatedSpeechTurnFailures(
        session,
        'low_stt_confidence_max_retries',
      );
      // OBS — fired after the hand-off is spoken/the call is torn down;
      // never alters the recovery behavior above.
      recordVoiceError({
        errorKind: 'low_stt_confidence_repeated',
        channel: 'media_streams',
        callSid: this.state.callSid,
        tenantId: this.state.tenantId,
      });
      return;
    }

    await this.speakRecoveryLine(session, LOW_STT_CONFIDENCE_REPROMPT_COPY);
    // OBS — fired after the reprompt is spoken; never alters the recovery
    // behavior above.
    recordVoiceError({
      errorKind: 'low_stt_confidence',
      channel: 'media_streams',
      callSid: this.state.callSid,
      tenantId: this.state.tenantId,
    });
  }

  /**
   * VOX-35c — render one recovery line through the normal outbound-turn path
   * and keep the transcript faithful by appending the spoken (localized) copy
   * as an agent line. `rawText` is an English catalog key that
   * `renderTtsText` localizes to the session's active language (en/es).
   */
  private async speakRecoveryLine(session: VoiceSession, rawText: string): Promise<void> {
    if (this.state.closed) return;
    await this.emitSideEffects([{ type: 'tts_play', payload: { text: rawText } }]);
    this.deps.store.appendTranscript(session.id, {
      speaker: 'agent',
      text: renderTtsText(rawText, {}, this.currentSpokenLanguage()),
      ts: Date.now(),
    });
  }

  // ─── UB-C1 — live language switching ───────────────────────────────────────

  /**
   * Keyword-boost options for a Deepgram open/reopen in `lang`.
   *
   * A2 — previously this returned `undefined` on Spanish sessions (the
   * boost list was assumed to be English-only trade terminology that would
   * degrade Nova-3's Spanish recognition), which silently dropped boosting
   * for every es caller. The terms themselves (catalog items, proper nouns,
   * codeswitched trade jargon like "PEX" or model numbers) are frequently
   * spoken as-is by Spanish speakers too, so suppressing them cost more
   * than it protected. Boosting is now sent for both languages; the
   * 50-term cap (`VerticalTerminologyProvider.MAX_KEYWORDS`) still bounds
   * the list upstream.
   */
  private deepgramKeywordOptions(
    _lang: 'en' | 'es',
  ): { keywords: ReadonlyArray<string> } | undefined {
    return this.state.sttKeywords.length > 0
      ? { keywords: this.state.sttKeywords }
      : undefined;
  }

  /**
   * The language the agent SPEAKS in. Prefers `session.language` (which
   * the host may pin from tenant defaults even when no
   * initialLanguageResolver is wired) over the adapter's STT language.
   */
  private currentSpokenLanguage(): SessionLanguage {
    const sessionLang = this.state.session?.language;
    if (sessionLang === 'en' || sessionLang === 'es') return sessionLang;
    return this.state.language;
  }

  /**
   * UB-C1 trigger (b) — deterministic explicit-switch scan on a final
   * transcript. Returns true when the turn was CONSUMED (a switch actually
   * happened and the localized ack was spoken); false lets the caller's
   * words flow into the normal turn pipeline. Never consumes when:
   *   - the utterance carries an emergency keyword (life-safety wins),
   *   - the requested language is already active,
   *   - the tenant hasn't opted into the target language,
   *   - the flap guard has been exhausted (switchLanguage refuses).
   */
  private async maybeHandleExplicitLanguageSwitch(transcript: string): Promise<boolean> {
    const session = this.state.session;
    if (!session) return false;
    const target = detectLanguageSwitchIntent(transcript);
    if (!target) return false;
    if (target === this.state.language) {
      // STT already listens in `target`; the SPOKEN language can still
      // disagree when the host pinned a different tenant default (no
      // resolver wired). Align TTS without burning a reopen/flap-budget
      // slot — and don't consume the turn.
      if (
        (session.language === 'en' || session.language === 'es') &&
        session.language !== target
      ) {
        session.language = target;
      }
      return false;
    }
    // detectLanguageSwitchIntent is an ungated heuristic — the tenant
    // opt-in gate is applied here (only detectLanguage gates internally).
    if (!isLanguageSupported(target, session.supportedLanguages ?? null)) return false;
    // Life-safety first: "hay una fuga de gas, en español por favor" must
    // run the emergency pipeline, not be consumed by a language ack.
    if (detectEmergency(transcript).matched) return false;

    const switched = await this.switchLanguage(target, 'explicit_request');
    if (!switched) return false;

    // The consumed turn bypasses processCallerUtterance (which normally
    // appends the caller line) — keep the transcript faithful ourselves.
    this.deps.store.appendTranscript(session.id, {
      speaker: 'caller',
      text: transcript,
      ts: Date.now(),
    });
    const ack = LANGUAGE_SWITCH_ACK[target];
    await this.emitSideEffects([{ type: 'tts_play', payload: { text: ack } }]);
    this.deps.store.appendTranscript(session.id, {
      speaker: 'agent',
      text: ack,
      ts: Date.now(),
    });
    return true;
  }

  /**
   * UB-C1 trigger (a) — one-shot detection on the FIRST final transcript.
   * When the caller's opening words disagree with the language Deepgram
   * opened in (and the tenant opted into the detected language), switch
   * once before the turn is dispatched. `detectLanguageFromTranscript` is
   * an ungated heuristic — the supported-languages gate is applied here.
   */
  private async maybeRunFirstFinalLanguageDetection(transcript: string): Promise<void> {
    if (this.state.firstFinalLanguageChecked) return;
    this.state.firstFinalLanguageChecked = true;
    const session = this.state.session;
    if (!session) return;
    const detected = detectLanguageFromTranscript(transcript);
    if (!detected || detected === this.state.language) return;
    if (!isLanguageSupported(detected, session.supportedLanguages ?? null)) return;
    await this.switchLanguage(detected, 'first_utterance');
  }

  /**
   * UB-C1 — finish + reopen the live Deepgram session in `target`.
   *
   * Serialized under the SAME per-session lock the speech-turn dispatch
   * uses (`store.withSessionLock`) so a reopen can never interleave with
   * an in-flight FSM turn. NOTE the lock is a non-reentrant promise chain
   * — this method must never be called from inside another lock body.
   *
   * Flap guard: hard cap of {@link MAX_LANGUAGE_SWITCHES_PER_CALL}
   * reopen cycles per call; the 3rd request is refused (audio keeps
   * flowing in the current language).
   *
   * Media frames that arrive during the reopen window are dropped
   * (state.deepgram is null) — the gap is one WS round-trip.
   *
   * Returns true when the switch happened.
   */
  async switchLanguage(
    target: 'en' | 'es',
    trigger: LanguageSwitchedEvent['trigger'],
  ): Promise<boolean> {
    const session = this.state.session;
    if (!session || this.state.closed) return false;
    return this.deps.store.withSessionLock(session.id, async () => {
      // Re-validate under the lock — a queued concurrent switch may have
      // already flipped the language or spent the flap budget.
      if (this.state.closed) return false;
      if (target === this.state.language) return false;
      if (this.state.languageSwitchCount >= MAX_LANGUAGE_SWITCHES_PER_CALL) {
        logger.info('mediastream: language switch refused — flap guard', {
          callSid: this.state.callSid,
          target,
          switchCount: this.state.languageSwitchCount,
        });
        return false;
      }

      const from = this.state.language;
      const old = this.state.deepgram;
      // Null out first so handleMedia drops frames instead of feeding a
      // finishing socket. Bump the generation BEFORE finishing so the old
      // session's onClose (fired by this deliberate teardown) is stale and
      // never mistaken for an unexpected mid-call failure (WS7).
      this.state.deepgram = null;
      this.state.deepgramGeneration++;
      try {
        old?.finish();
      } catch {
        /* swallow — the old session is being discarded either way */
      }

      const openWith = async (lang: 'en' | 'es') => {
        const dgGeneration = ++this.state.deepgramGeneration;
        return this.deps.streamingProvider.openSession(
          (event) => {
            this.onTranscriptEvent(event).catch((err) => {
              logger.warn('mediastream transcript handler threw', {
                error: err instanceof Error ? err.message : String(err),
              });
            });
          },
          (err) => {
            logger.warn('mediastream deepgram error', { error: err.message });
          },
          () => {
            // WS7 — same unexpected-close degrade as the initial open, so a
            // language-switched call keeps mid-call failure coverage.
            // Generation-guarded like the initial open's hook.
            if (dgGeneration !== this.state.deepgramGeneration) return;
            // WS16a — same latch + teardown guard + vote-before-degrade as the
            // initial open's hook (see there): don't vote on a deliberate
            // teardown; an unexpected live-generation close is a failure.
            if (this.state.closed || this.state.wsCloseInitiated) return;
            this.recordCircuitOutcomeOnce('failure', 'deepgram_unexpected_close');
            void this.attemptDegradeToGather('deepgram_unexpected_close');
          },
          lang,
          this.deepgramKeywordOptions(lang),
        );
      };

      try {
        this.state.deepgram = await openWith(target);
      } catch (err) {
        logger.error('mediastream: Deepgram reopen failed on language switch', {
          callSid: this.state.callSid,
          target,
          error: err instanceof Error ? err.message : String(err),
        });
        // Recovery: try to restore STT in the previous language. A call
        // with no STT at all is dead air — tear down if that fails too.
        try {
          this.state.deepgram = await openWith(from);
          return false;
        } catch {
          // WS16a — both the target reopen and the same-language recovery
          // failed: the live call now has no STT at all. That is a realtime
          // transport failure — vote it here (the most precise reason) so the
          // latch suppresses the blunt `ws_closed`/transport_failure that the
          // handleClose below produces. mapCloseReasonToFinalize now classifies
          // `deepgram_reopen_failed` as transport_failure so the CallOutcome is
          // stamped `failed`, not the caller_hangup default.
          this.recordCircuitOutcomeOnce('failure', 'deepgram_reopen_failed');
          this.handleClose('deepgram_reopen_failed');
          return false;
        }
      }

      this.state.language = target;
      session.language = target;
      this.state.languageSwitchCount++;
      session.events.emit(
        VOICE_EVENT_CHANNEL,
        languageSwitchedEvent({
          from,
          to: target,
          trigger,
          switchCount: this.state.languageSwitchCount,
        }),
      );
      logger.info('mediastream: language switched', {
        callSid: this.state.callSid,
        from,
        to: target,
        trigger,
        switchCount: this.state.languageSwitchCount,
      });
      return true;
    });
  }

  /**
   * B3.3 — Run the async LLM sentiment classifier and, if the score
   * meets or exceeds the per-tenant threshold, dispatch
   * `frustration_detected` out-of-band into the FSM and execute the
   * resulting side effects. The FSM's idempotency guard handles
   * double-fires correctly (keyword detector may have already fired).
   */
  private async runSentimentCheckAndMaybeEscalate(
    session: VoiceSession,
    transcript: string,
    priorTurnEffects: SideEffect[],
    escalationSettings: EscalationSettings,
  ): Promise<void> {
    const priorTurns = this.extractPriorTurns(session, 4);
    const intent =
      (priorTurnEffects.find((fx) => fx.type === 'audit_log')?.payload as { intentType?: string } | undefined)
        ?.intentType ?? 'unknown';

    const result = await this.deps.sentimentClassifier!(
      {
        transcript,
        priorTurns,
        intent,
        tenantId: session.tenantId,
      },
      {
        costTracker: session.costTracker,
        sessionCostCapCents: session.costTracker.costCapCents,
        maxSentimentBudgetRatio: SENTIMENT_MAX_BUDGET_RATIO,
      },
    );

    const threshold = escalationSettings.llm_sentiment_threshold;
    if (result.frustrationScore >= threshold) {
      // Serialize dispatch+emit against any concurrent turn handler.
      // The LLM call above may take 200–2000 ms; without the lock the FSM
      // could advance (e.g. to `confirming`) between the LLM returning and
      // our dispatch. withSessionLock queues us behind the current turn so
      // the FSM idempotency guard at transitions.ts:212 is the only arbiter
      // of whether frustration_detected is still actionable.
      const newEffects = await this.deps.store.withSessionLock(session.id, () =>
        Promise.resolve(
          session.machine.dispatch({
            type: 'frustration_detected',
            source: 'llm_sentiment',
            detail: result.frustrationScore.toFixed(2),
            ...(result.reasonHint ? { reasonHint: result.reasonHint } : {}),
          }),
        ),
      );
      // Deliver notify_oncall + audit through the host processor (the adapter's
      // emitSideEffects only renders tts_play), then render the reassurance TTS.
      await this.deps.deliverEscalationEffects?.(session, newEffects, session.tenantId);
      await this.emitSideEffects(newEffects);
      // Record the agent's reassurance line so summarizeSession + later turns
      // see it — mirrors the speechTurn path (create-voice-turn-processor.ts).
      const spokenTts = [...newEffects].reverse().find((fx) => fx.type === 'tts_play');
      if (spokenTts && typeof spokenTts.payload.text === 'string') {
        this.deps.store.appendTranscript(session.id, {
          speaker: 'agent',
          text: spokenTts.payload.text,
          ts: Date.now(),
        });
      }
    }
  }

  /**
   * Extract the last `n` caller + AI turns from the session transcript in the
   * `{ role, text }` format the sentiment + vulnerability hooks expect.
   * Delegates to the shared projection so the Gather path stays in lockstep.
   */
  private extractPriorTurns(
    session: VoiceSession,
    n: number,
  ): ReadonlyArray<{ role: 'caller' | 'ai'; text: string }> {
    return extractPriorTurns(session.transcript, n);
  }

  // ─── Outbound: TTS → μ-law → media frame ───────────────────────────────────

  private async emitSideEffects(sideEffects: SideEffect[]): Promise<void> {
    const ttsProvider = this.deps.ttsProvider;
    if (!ttsProvider) return;
    for (const fx of sideEffects) {
      if (fx.type === 'emit_quality_event' && this.state.session) {
        const eventType = String((fx.payload as { eventType?: string }).eventType ?? '');
        if (eventType === 'repair_template_fired') {
          this.state.session.events.emit(VOICE_EVENT_CHANNEL, repairTemplateFiredEvent({
            trigger: String((fx.payload as { trigger?: string }).trigger ?? ''),
            text: String((fx.payload as { text?: string }).text ?? ''),
          }));
        }
        continue;
      }
      if (fx.type === 'escalate_with_context') {
        const parsed = escalateWithContextPayloadSchema.safeParse(fx.payload);
        if (!parsed.success) {
          logger.error('escalate_with_context: invalid payload, dropping', {
            issues: parsed.error.issues,
          });
          continue;
        }
        this.handleEscalateWithContext(parsed.data).catch((err) => {
          logger.error('escalate_with_context handler threw', {
            error: err instanceof Error ? err.message : String(err),
            escalationId: parsed.data.escalationId,
          });
        });
        continue;
      }
      if (fx.type !== 'tts_play') continue;
      const rawText = typeof fx.payload.text === 'string' ? fx.payload.text : '';
      if (!rawText) continue;
      // UB-C2 — render template keys + the fixed-sentence es catalog with
      // the session language before synthesis (parity with the in-app
      // adapter, which routes every spoken line through renderTtsText).
      //
      // Greeting exception: initializeStreamSession SUBSTITUTES the
      // 'greeting' placeholder with the real greeting + the RECORDING
      // DISCLOSURE legal copy (already localized). Re-rendering via the
      // surviving `template` hint would replace that with the generic
      // template line and silently drop the disclosure — so the hint is
      // stripped once the text is no longer the placeholder. The
      // 'confirm_intent' hint stays: its payload carries `intent`, making
      // the re-render lossless (and it's what localizes the confirm).
      const lang = this.currentSpokenLanguage();
      const templateHint = (fx.payload as { template?: unknown }).template;
      const isSubstitutedGreeting =
        (templateHint === 'greeting' || templateHint === 'greeting_with_disclosure') &&
        rawText !== 'greeting';
      const renderPayload = isSubstitutedGreeting
        ? { ...(fx.payload as Record<string, unknown>), template: undefined }
        : (fx.payload as Record<string, unknown>);
      const text = renderTtsText(rawText, renderPayload, lang);
      let turnId = ++this.state.outboundTurnId;
      this.state.agentSpeaking = true;
      try {
        // runTurnWithFiller returns the final turnId — it may have been
        // bumped if a filler was preempted by the real TTS arrival.
        turnId = await this.runTurnWithFiller(ttsProvider, text, turnId, lang);
      } catch (err) {
        logger.warn('mediastream: TTS turn failed', {
          error: err instanceof Error ? err.message : String(err),
        });
      } finally {
        if (turnId === this.state.outboundTurnId) {
          this.state.agentSpeaking = false;
        }
      }
    }
  }

  /**
   * Section 7 — Fan out the escalate_with_context side effect to three
   * parallel channels: whisper TwiML cache, dispatcher SMS, and in-app
   * SSE event. Builds and stashes the <Dial> TwiML with whisperUrl so
   * the next gather-webhook response bridges the call to the dispatcher.
   *
   * All channels are independently opt-in via channelPreferences and
   * fail gracefully — a failed SMS send is logged and swallowed, never
   * blocking the Dial TwiML or in-app notification.
   *
   * Whisper-route mounting: mount inside createTelephonyRouter so it
   * inherits requireTwilioSignature. Full wiring deferred to Section 12.
   */
  private async handleEscalateWithContext(
    payload: z.infer<typeof escalateWithContextPayloadSchema>,
  ): Promise<void> {
    const startMs = Date.now();
    const { escalationId, summary, dispatcher, callSid, channelPreferences } = payload;

    // 1) Store whisper text in cache for Twilio's webhook fetch (no-op if disabled).
    if (channelPreferences.whisper && this.deps.whisperCache) {
      this.deps.whisperCache.set(escalationId, summary.whisper);
    }

    // 2) Send dispatcher SMS in parallel (no-op if disabled).
    let smsPromise: Promise<unknown> = Promise.resolve();
    if (channelPreferences.sms && this.deps.deliveryProvider) {
      const smsBody = summary.sms.replace('<escalationId>', escalationId);
      smsPromise = this.deps.deliveryProvider
        .sendSms({ to: dispatcher.phone, body: smsBody })
        .catch((err) => {
          logger.warn('escalate_with_context: SMS dispatch failed', {
            escalationId,
            error: err instanceof Error ? err.message : String(err),
          });
        });
    }

    // 3) Emit in-app SSE event (no-op if disabled or no active session).
    if (channelPreferences.in_app && this.state.session) {
      this.state.session.events.emit(
        VOICE_EVENT_CHANNEL,
        escalationStartedEvent({
          escalationId,
          reason: summary.panel.reason.code,
          dispatcherUserId: dispatcher.userId,
          tenantId: payload.tenantId,
          // summary.panel is structurally compatible with PanelData at runtime;
          // the Zod schema uses z.string() for reason.code vs the TS union type.
          panel: summary.panel as unknown as PanelData,
        }),
      );
    }

    // 4) Build <Dial> with whisper URL and hand off to the gather adapter's
    // pendingTransferTwiml Map via deps.setPendingTransferTwiml. This is the
    // CRITICAL fix: without this callback, the TwiML would be written to the
    // media-stream adapter's state where no route handler ever reads it, and
    // the caller would stay on hold forever while the dispatcher gets an SMS
    // but no incoming call.
    if (this.deps.callControl) {
      // Issue 6: strip trailing slash from publicBaseUrl before building URLs.
      const baseUrl = this.deps.publicBaseUrl?.replace(/\/$/, '');
      const whisperUrl =
        channelPreferences.whisper && baseUrl
          ? `${baseUrl}/api/telephony/whisper/${escalationId}`
          : undefined;
      const dialActionUrl = baseUrl
        ? `${baseUrl}/api/telephony/dial-action`
        : '/api/telephony/dial-action';
      const dialTwiml = this.deps.callControl.dialDispatcher(
        callSid,
        dispatcher.phone,
        {
          actionUrl: dialActionUrl,
          whisperUrl,
          timeoutSeconds: 20,
        },
      );

      if (this.deps.setPendingTransferTwiml && this.state.session) {
        // Route the TwiML through the gather adapter's shared Map so the
        // next gather-callback route response bridges the call.
        this.deps.setPendingTransferTwiml(this.state.session.id, dialTwiml);
      } else {
        // Legacy fallback — kept for parity but unread by any route handler.
        // Log a warning so operators know the transfer will NOT happen.
        this.state.pendingTransferTwiml = dialTwiml;
        logger.warn(
          'escalate_with_context: setPendingTransferTwiml not wired — call will not transfer',
          { escalationId, callSid },
        );
      }
    } else {
      logger.warn(
        'escalate_with_context: callControl not wired — Dial TwiML not built, call will not transfer',
        { escalationId, callSid },
      );
    }

    // 5) Telemetry — capture durationMs BEFORE awaiting SMS so the metric
    // reflects summary-build/dispatch time, not carrier round-trip latency.
    const builtMs = Date.now();
    if (this.state.session) {
      this.state.session.events.emit(
        VOICE_EVENT_CHANNEL,
        escalationSummaryBuiltEvent({
          escalationId,
          durationMs: builtMs - startMs,
        }),
      );
    }

    // Block on SMS only to surface failures via logger.warn (already in .catch).
    await smsPromise;
  }

  /**
   * Run a single TTS turn, optionally preceded by a filler clip if the
   * real TTS has not started streaming within `fillerDelayMs` (default 250ms).
   *
   * The filler is fired in a best-effort setTimeout. If real audio starts
   * before the timer fires, it is cancelled. If it fires while real audio is
   * already in-flight (e.g. buffered provider), the timer is a no-op because
   * `realStarted` will be true. The existing barge-in machinery (bargeIn())
   * cancels both filler and real audio together when the caller speaks.
   */
  private async runTurnWithFiller(
    ttsProvider: TtsProvider,
    text: string,
    turnIdIn: number,
    /**
     * UB-C2 — session language for this turn. Threads into the synth call
     * (es → eleven_multilingual_v2 in the provider) and keys filler
     * selection so a Spanish call never hears an English filler. When the
     * selected clip is missing from the cache the turn simply gets no
     * filler (silence) — never a clip from the other language.
     */
    lang: SessionLanguage = 'en',
  ): Promise<number> {
    const delayMs = this.deps.fillerDelayMs ?? 250;
    const engine = this.deps.fillerEngine;
    const cache = this.deps.fillerCache;

    // Mutable local copy so we can rebind after filler-cancellation bump.
    let turnId = turnIdIn;
    let realStarted = false;
    const controller = new AbortController();
    this.state.ttsController = controller;

    // Helper: cancel an in-flight filler by bumping the turn id so its
    // streamPcmAsMedia loop exits on the next iteration, then rebind our
    // local turnId so subsequent real-TTS writes land under the new turn.
    const cancelActiveFiller = () => {
      if (this.state.fillerActive) {
        this.state.outboundTurnId++;
        turnId = this.state.outboundTurnId;
        this.state.fillerActive = false;
        if (this.state.session) {
          this.state.session.events.emit(
            VOICE_EVENT_CHANNEL,
            fillerCancelledEvent({ fillerText: '' }),
          );
        }
      }
    };

    // Schedule a filler if both engine and cache are wired.
    const fillerTimer = engine && cache
      ? setTimeout(() => {
          if (realStarted || turnId !== this.state.outboundTurnId || !this.state.agentSpeaking) {
            return;
          }
          const filler = engine.selectNext({ language: lang });
          if (!filler) return;
          const pcm = cache.get(filler.id);
          // Missing clip (e.g. Spanish clips not yet rendered at deploy
          // time) → SILENCE for this turn. Never substitute a clip from
          // the other language.
          if (!pcm) return;
          // Mark filler as active BEFORE starting the stream so that the
          // real-TTS first-chunk handler can see the flag synchronously.
          this.state.fillerActive = true;
          // Best-effort emission — do not await; cancellation is handled
          // by cancelActiveFiller() when real audio arrives.
          void this.streamPcmAsMedia(pcm, turnId, /* isFiller */ true).catch(() => undefined);
          if (this.state.session) {
            this.state.session.events.emit(
              VOICE_EVENT_CHANNEL,
              fillerFiredEvent({ fillerText: filler.text }),
            );
          }
        }, delayMs)
      : null;
    if (fillerTimer && typeof fillerTimer.unref === 'function') fillerTimer.unref();

    try {
      if (typeof ttsProvider.synthesizeStream === 'function') {
        try {
          const stream = ttsProvider.synthesizeStream({
            text,
            tenantId: this.state.tenantId ?? undefined,
            signal: controller.signal,
            language: lang,
          });
          let first = true;
          for await (const chunk of stream) {
            if (turnId !== this.state.outboundTurnId || !this.state.agentSpeaking) {
              controller.abort();
              break;
            }
            if (first && chunk.pcm.length > 0) {
              realStarted = true;
              if (fillerTimer) clearTimeout(fillerTimer);
              // If a filler clip is mid-stream, terminate it cleanly by
              // bumping outboundTurnId (exits its streamPcmAsMedia loop)
              // and rebinding our local turnId to the new value.
              cancelActiveFiller();
              first = false;
            }
            if (chunk.pcm.length > 0) {
              await this.streamPcmAsMedia(chunk.pcm, turnId);
            }
            if (chunk.isFinal) break;
          }
        } catch (streamErr) {
          // VOX-35b — a WS blip or a VOX-33 inactivity stall surfaces here
          // as a thrown rejection. The old caller only logged.warn, so the
          // utterance was cut off mid-sentence → dead air. Recover once via
          // the buffered REST synth (or a short filler) instead of silently
          // ending the turn. A clean barge-in does NOT reach this path: it
          // aborts the controller, which closes the WS and ends the stream
          // normally (done, not error).
          logger.warn('mediastream: TTS stream failed mid-turn, attempting recovery', {
            error: streamErr instanceof Error ? streamErr.message : String(streamErr),
            realStarted,
            callSid: this.state.callSid,
          });
          // Only recover if this turn still owns the floor (no barge-in, no
          // newer turn superseded it).
          if (turnId === this.state.outboundTurnId && this.state.agentSpeaking) {
            if (fillerTimer) clearTimeout(fillerTimer);
            cancelActiveFiller();
            await this.recoverTurnAfterStreamFailure(ttsProvider, text, lang, turnId);
            // OBS — fired after the recovery attempt (buffered synth /
            // filler / dead-air-avoided) has already run; never alters it.
            recordVoiceError({
              errorKind: 'tts_stream_recovered',
              channel: 'media_streams',
              callSid: this.state.callSid,
              tenantId: this.state.tenantId,
            });
          }
        }
      } else {
        const result = await ttsProvider.synthesize({
          text,
          tenantId: this.state.tenantId ?? undefined,
          language: lang,
        });
        realStarted = true;
        if (fillerTimer) clearTimeout(fillerTimer);
        // Same cancellation logic for buffered (non-streaming) TTS.
        cancelActiveFiller();
        // P0 defense-in-depth: streamPcmAsMedia() assumes raw PCM16 @ 16kHz
        // (it mu-law-encodes the bytes itself) and does NOT decode
        // compressed formats. synthesize() results are only PCM-safe when
        // contentType says so — feeding compressed audio (e.g. OpenAI's
        // default 'audio/mpeg') into it produces inaudible static with no
        // error surfaced to the caller. The app.ts boot guard should
        // prevent a non-streaming, non-PCM provider from ever being wired
        // when Media Streams is enabled; this check is the belt-and-
        // suspenders so a future provider swap can't silently regress.
        if (!isRawPcmContentType(result.contentType)) {
          logger.error(
            'mediastream: synthesize() returned non-PCM audio, dropping instead of streaming as static',
            { contentType: result.contentType, provider: result.provider, tenantId: this.state.tenantId ?? undefined },
          );
        } else if (turnId === this.state.outboundTurnId && this.state.agentSpeaking) {
          await this.streamPcmAsMedia(result.audio, turnId);
        }
      }
    } finally {
      if (fillerTimer) clearTimeout(fillerTimer);
      if (this.state.ttsController === controller) {
        this.state.ttsController = null;
      }
    }
    // Return the (possibly rebounded) turnId so emitSideEffects can
    // compare it against outboundTurnId for the agentSpeaking reset.
    return turnId;
  }

  /**
   * VOX-35b — recover a voice turn whose streaming TTS failed mid-flight
   * (WS error, or a VOX-33 inactivity stall). Preference order, all bounded:
   *
   *  1. Buffered REST `synthesize()` — but ONLY stream it when the result is
   *     raw PCM (same guard the non-streaming branch uses). ElevenLabs REST
   *     returns mp3, which streamPcmAsMedia would emit as inaudible static —
   *     worse than silence — so a non-PCM result is dropped, not played.
   *  2. A short filler/apology clip from the cache, so the caller hears an
   *     acknowledgement rather than dead air while the turn ends cleanly.
   *
   * If neither is available we still return normally: the throw is now
   * caught, so `agentSpeaking` resets in the caller's finally and the call
   * proceeds to listen again — never the 30-minute idle hang.
   *
   * All writes are re-guarded on turn ownership because `synthesize()` can
   * take time and the caller may barge in during the fallback.
   */
  private async recoverTurnAfterStreamFailure(
    ttsProvider: TtsProvider,
    text: string,
    lang: SessionLanguage,
    turnId: number,
  ): Promise<void> {
    let result: Awaited<ReturnType<TtsProvider['synthesize']>> | null = null;
    try {
      result = await ttsProvider.synthesize({
        text,
        tenantId: this.state.tenantId ?? undefined,
        language: lang,
      });
    } catch (err) {
      logger.warn('mediastream: buffered TTS fallback also failed', {
        error: err instanceof Error ? err.message : String(err),
        callSid: this.state.callSid,
      });
    }

    if (
      result &&
      isRawPcmContentType(result.contentType) &&
      turnId === this.state.outboundTurnId &&
      this.state.agentSpeaking
    ) {
      await this.streamPcmAsMedia(result.audio, turnId);
      return;
    }
    if (result && !isRawPcmContentType(result.contentType)) {
      logger.warn(
        'mediastream: buffered TTS fallback returned non-PCM audio, cannot stream — trying filler',
        { contentType: result.contentType, provider: result.provider, callSid: this.state.callSid },
      );
    }

    // Last resort: a short filler clip so the caller hears something.
    const engine = this.deps.fillerEngine;
    const cache = this.deps.fillerCache;
    if (
      engine &&
      cache &&
      turnId === this.state.outboundTurnId &&
      this.state.agentSpeaking
    ) {
      const filler = engine.selectNext({ language: lang });
      const pcm = filler ? cache.get(filler.id) : undefined;
      if (pcm) {
        await this.streamPcmAsMedia(pcm, turnId, /* isFiller */ true);
        return;
      }
    }

    logger.warn('mediastream: TTS turn ended without audio after stream failure', {
      callSid: this.state.callSid,
    });
  }

  /**
   * Send a buffer of PCM16 16 kHz audio out as a stream of Twilio
   * `media` frames. Splits into 20 ms chunks (320 samples @ 16 kHz =
   * 640 bytes) — at the 8 kHz output rate, that's 160 bytes / chunk
   * which is the Twilio canonical frame size.
   *
   * `turnId` lets us abort cleanly if the caller barges in mid-stream.
   * Pacing: when ≥ TWILIO_MAX_UNACKED_MARKS marks are unacked, we yield
   * to give Twilio a chance to ack before pushing more audio.
   */
  private async streamPcmAsMedia(pcm: Buffer, turnId: number, isFiller = false): Promise<void> {
    if (!this.state.streamSid) return;
    const FRAME_BYTES_16K = 640; // 20 ms @ 16 kHz, 16-bit mono
    const MARK_EVERY_N_FRAMES = 25; // ~500ms at 20ms/frame
    let offset = 0;
    let frameCount = 0;
    while (offset < pcm.length) {
      if (turnId !== this.state.outboundTurnId || !this.state.agentSpeaking || this.state.closed) {
        return;
      }

      // Backpressure: pause when too many marks are outstanding.
      if (this.state.unackedMarks >= TWILIO_MAX_UNACKED_MARKS) {
        await this.waitForMarkAck();
        continue;
      }

      const chunk = pcm.subarray(offset, Math.min(offset + FRAME_BYTES_16K, pcm.length));
      offset += FRAME_BYTES_16K;
      const payload = encodeTwilioOutboundFrame(chunk, 16000);
      this.enqueueOutbound('control', {
        event: 'media',
        streamSid: this.state.streamSid,
        media: { payload },
      });
      // VQ2-004: TTFA-stop. Emit `audio_frame_emitted` ONCE per turn,
      // on the first chunk that lands on the queue. The flag is armed
      // by `onTranscriptEvent` and disarmed here so subsequent chunks
      // in the same turn (and barge-in `clear` events) don't re-emit.
      // Skip when this chunk is a filler — filler audio fills the LLM
      // thinking gap and would otherwise poison the TTFA metric.
      if (!isFiller && this.state.awaitingFirstAudioFrame && this.state.session) {
        this.state.awaitingFirstAudioFrame = false;
        // WS26 — observe voice turn latency at the first real (non-filler)
        // outbound chunk. Best-effort + exception-proof (observeTurnLatency
        // swallows any metrics error); done BEFORE the event emit so a
        // metrics failure can't disturb the existing TTFA telemetry either.
        observeTurnLatency(this.state.turnLatencyStartMs);
        this.state.turnLatencyStartMs = null;
        this.state.session.events.emit(
          VOICE_EVENT_CHANNEL,
          audioFrameEmittedEvent({ byteCount: chunk.length }),
        );
      }
      frameCount++;

      // Insert a periodic mark so Twilio can ack and we can pace.
      if (frameCount % MARK_EVERY_N_FRAMES === 0) {
        this.state.unackedMarks++;
        this.enqueueOutbound('control', {
          event: 'mark',
          streamSid: this.state.streamSid,
          mark: { name: `turn-${turnId}-${frameCount}` },
        });
      }
    }
    // Mark frame so Twilio can ack the end of this turn.
    if (frameCount > 0 && turnId === this.state.outboundTurnId) {
      this.state.unackedMarks++;
      this.enqueueOutbound('control', {
        event: 'mark',
        streamSid: this.state.streamSid,
        mark: { name: `turn-${turnId}` },
      });
      if (!isFiller) this.armSilenceRepromptTimer(turnId);
    }
  }

  private async waitForMarkAck(maxWaitMs = 200): Promise<void> {
    const start = Date.now();
    while (
      this.state.unackedMarks >= TWILIO_MAX_UNACKED_MARKS &&
      Date.now() - start < maxWaitMs &&
      !this.state.closed
    ) {
      await new Promise((r) => {
        const t = setTimeout(r, 20);
        if (typeof t.unref === 'function') t.unref();
      });
    }
  }

  // ─── Barge-in ──────────────────────────────────────────────────────────────

  /**
   * Cancel any in-flight outbound TTS by:
   *   1. Bumping outboundTurnId so streaming loops abort.
   *   2. Setting agentSpeaking = false so any in-flight TTS synth is dropped.
   *   3. Sending Twilio `clear` to flush its outbound buffer.
   *
   * Called when an interim transcript arrives during agent TTS.
   */
  private bargeIn(): void {
    this.clearSilenceRepromptTimer();
    this.state.ttsController?.abort();
    // If a filler clip was mid-stream when barge-in fires, emit the
    // cancellation event and clear the flag before bumping the turn.
    if (this.state.fillerActive) {
      this.state.fillerActive = false;
      if (this.state.session) {
        this.state.session.events.emit(
          VOICE_EVENT_CHANNEL,
          fillerCancelledEvent({ fillerText: '' }),
        );
      }
    }
    if (!this.state.streamSid) return;
    this.state.outboundTurnId++;
    this.state.agentSpeaking = false;
    // Drop any queued media; leave control/terminal in place.
    this.state.queue.clear();
    this.state.unackedMarks = 0;
    this.enqueueOutbound('terminal', {
      event: 'clear',
      streamSid: this.state.streamSid,
    });
  }

  // ─── Idle teardown ─────────────────────────────────────────────────────────

  private armIdleTimer(): void {
    if (this.state.audioIdleTimer) clearTimeout(this.state.audioIdleTimer);
    const ms = this.deps.audioIdleTimeoutMs ?? DEFAULT_AUDIO_IDLE_TIMEOUT_MS;
    this.state.audioIdleTimer = setTimeout(() => {
      logger.info('mediastream: audio idle timeout — tearing down', {
        callSid: this.state.callSid,
      });
      this.handleClose('audio_idle_timeout');
    }, ms);
    if (typeof this.state.audioIdleTimer.unref === 'function') {
      this.state.audioIdleTimer.unref();
    }
  }

  /**
   * T2-F05 — per-turn caller-silence reprompt. The 30-minute audioIdleTimer
   * can NEVER catch a silent caller: Twilio Media Streams delivers `media`
   * frames continuously (comfort-noise/silent mu-law) for the whole call, so
   * `lastMediaAt` keeps refreshing and that timer only fires when the
   * transport itself stalls. This timer instead measures caller-turn silence:
   * armed when an agent (non-filler) TTS turn enqueues its final
   * `turn-${turnId}` mark (NOT the periodic pacing marks), cleared by any
   * transcript event (interim or final), by barge-in, and by close. Expiry
   * funnels into `recoverFromLowSttConfidence` deliberately: silence shares
   * the `consecutiveLowConfidenceTurns` streak, reprompt copy, and
   * MAX_CONSECUTIVE_LOW_CONFIDENCE_TURNS escalation with mumbled turns, so a
   * caller cannot alternate silence and mumbling to stay on the line
   * indefinitely and the ladder stays single-sourced. Re-arming after the
   * reprompt is natural — the reprompt renders through the same
   * `streamPcmAsMedia` path and enqueues its own end-of-turn mark. The
   * captured `turnId` + agentSpeaking guards make a stale expiry (a newer
   * outbound turn started without a transcript, e.g. an async sentiment
   * escalation) a no-op.
   */
  private armSilenceRepromptTimer(turnId: number): void {
    if (this.state.closed) return;
    this.clearSilenceRepromptTimer();
    const ms = this.deps.silenceRepromptTimeoutMs ?? DEFAULT_SILENCE_REPROMPT_MS;
    this.state.silenceRepromptTimer = setTimeout(() => {
      this.state.silenceRepromptTimer = null;
      const session = this.state.session;
      if (
        this.state.closed ||
        !session ||
        turnId !== this.state.outboundTurnId ||
        this.state.agentSpeaking
      ) {
        return;
      }
      void this.recoverFromLowSttConfidence(session).catch((err) => {
        logger.warn('mediastream: silence reprompt failed', {
          error: err instanceof Error ? err.message : String(err),
          callSid: this.state.callSid,
        });
      });
    }, ms);
    if (typeof this.state.silenceRepromptTimer.unref === 'function') {
      this.state.silenceRepromptTimer.unref();
    }
  }

  private clearSilenceRepromptTimer(): void {
    if (this.state.silenceRepromptTimer) {
      clearTimeout(this.state.silenceRepromptTimer);
      this.state.silenceRepromptTimer = null;
    }
  }

  // ─── Close / cleanup ───────────────────────────────────────────────────────

  private handleClose(reason: string): void {
    if (this.state.closed) return;
    this.state.closed = true;
    // WS16a — vote the realtime health circuit from the TERMINAL close outcome,
    // but ONLY for an ESTABLISHED session: state.session assigned AND at least
    // one Deepgram open attempted (deepgramGeneration > 0). Pre-establishment
    // security closes (invalid start, unknown CallSid, tenant mismatch,
    // connection cap) all close before state.session is set — they are
    // caller/config noise, not transport health, and must not vote. A
    // transport_failure-class reason votes failure; a clean/caller-driven end
    // (twilio_stop, end_session, audio_idle_timeout) votes success — the
    // transport survived the whole call. The once-per-leg latch means an
    // earlier, more precise signal (deepgram_unexpected_close,
    // disclosure_init_failed, deepgram_reopen_failed) already recorded and this
    // blunt terminal signal is suppressed.
    if (this.state.session && this.state.deepgramGeneration > 0) {
      if (mapCloseReasonToFinalize(reason) === 'transport_failure') {
        this.recordCircuitOutcomeOnce('failure', reason);
      } else {
        this.recordCircuitOutcomeOnce('success', reason);
      }
    }
    // B2: stash the outcome BEFORE we tear down. The host's
    // `finalizeOnClose` is sync (sets session.terminalOutcome and
    // kicks off the DB write in the background), so close stays
    // non-blocking. `pendingFinalizeEffects` carries the FSM
    // dispatch's effects (with `end_session.payload.reason`) when the
    // close was triggered by an FSM end_session — empty otherwise, in
    // which case the host falls back to the mapped close reason.
    // WS7 — skipped after a successful degrade-to-Gather: the call is NOT
    // over (Twilio is re-requesting TwiML from /voice/gather-fallback), so a
    // terminal stamp here would misrecord a live call as transport_failure,
    // block the Gather leg's real finalization (terminalOutcome early-return)
    // and schedule dropped-call recovery SMS to a caller still on the phone.
    if (!this.state.degradedToGather && this.deps.finalizeOnClose && this.state.session) {
      try {
        this.deps.finalizeOnClose(
          this.state.session,
          mapCloseReasonToFinalize(reason),
          this.state.pendingFinalizeEffects,
        );
      } catch {
        /* swallow — outcome stamping is best-effort */
      }
    }
    if (this.state.audioIdleTimer) {
      clearTimeout(this.state.audioIdleTimer);
      this.state.audioIdleTimer = null;
    }
    this.clearSilenceRepromptTimer();
    if (this.state.slowConsumerTimer) {
      clearTimeout(this.state.slowConsumerTimer);
      this.state.slowConsumerTimer = null;
    }
    try {
      this.state.deepgram?.destroy();
    } catch {
      /* swallow */
    }
    this.state.deepgram = null;
    if (!this.state.registryReleased && this.state.connectionLease) {
      // Fire-and-forget: teardown can't await; idempotent + TTL backstop.
      void this.state.connectionLease.release().catch(() => {});
      this.state.connectionLease = null;
      this.state.registryReleased = true;
    }
    wsDisconnectTotal.inc({ surface: TWILIO_SURFACE, reason });
    this.closeWs(1000, reason);
  }

  private closeWs(code: number, reason: string): void {
    // Guard prevents ws.close() being called twice (which overwrites the
    // close code). Does NOT set state.closed so handleClose can still run
    // its cleanup (registry release, timers) when the 'close' event fires.
    if (this.state.wsCloseInitiated) return;
    this.state.wsCloseInitiated = true;
    try {
      this.state.ws.close(code, reason);
    } catch {
      /* swallow */
    }
  }

  private enqueueOutbound(priority: Priority, envelope: Record<string, unknown>): void {
    const data = JSON.stringify(envelope);
    const accepted = this.state.queue.enqueue({ priority, data });
    if (!accepted && priority === 'terminal') {
      // Terminal message lost is a programmer error; close immediately.
      logger.warn('mediastream: terminal frame dropped, closing', {
        callSid: this.state.callSid,
      });
      this.handleClose('queue_overflow_terminal');
      return;
    }
    void this.flushQueue();
  }

  private async flushQueue(): Promise<void> {
    if (this.state.draining || this.state.closed) return;
    this.state.draining = true;
    try {
      await this.state.queue.drain((frame) => {
        this.state.ws.send(frame.data);
      });
    } catch (err) {
      logger.warn('mediastream: queue drain error', {
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      this.state.draining = false;
    }
    this.checkSlowConsumer();
  }

  private checkSlowConsumer(): void {
    const stats = this.state.queue.stats();
    const isSlow =
      stats.consecutiveOverWatermarkMs > TWILIO_SLOW_CONSUMER_GRACE_MS / 2 ||
      stats.ewmaSendLatencyMs > TWILIO_SLOW_CONSUMER_EWMA_THRESHOLD_MS;

    if (isSlow && !this.state.slowConsumerTimer && !this.state.closed) {
      this.state.slowConsumerTimer = setTimeout(() => {
        this.state.slowConsumerTimer = null;
        const now = this.state.queue.stats();
        if (
          now.consecutiveOverWatermarkMs > TWILIO_SLOW_CONSUMER_GRACE_MS ||
          now.ewmaSendLatencyMs > TWILIO_SLOW_CONSUMER_EWMA_THRESHOLD_MS
        ) {
          // wsDisconnectTotal is incremented inside handleClose() to
          // avoid double-counting; just log and tear down.
          logger.warn('mediastream: slow consumer detected, disconnecting', {
            callSid: this.state.callSid,
            ewmaSendLatencyMs: now.ewmaSendLatencyMs,
            occupancyPct: now.occupancyPct,
          });
          this.handleClose('slow_consumer');
        }
      }, TWILIO_SLOW_CONSUMER_GRACE_MS);
      if (typeof this.state.slowConsumerTimer.unref === 'function') {
        this.state.slowConsumerTimer.unref();
      }
    } else if (!isSlow && this.state.slowConsumerTimer) {
      clearTimeout(this.state.slowConsumerTimer);
      this.state.slowConsumerTimer = null;
    }
  }

  private logSecurityEvent(action: string, details: Record<string, unknown>): void {
    logger.warn('mediastream security event', {
      action,
      ...details,
      security: true,
      component: 'twilio_media_stream_adapter',
    });
  }

  // ─── Test hooks (intentionally minimal) ────────────────────────────────────

  /**
   * Test-only: read a copy of the runtime state so assertions can
   * verify barge-in flags / outbound counters without forcing every
   * field to be public.
   */
  _debugState(): Readonly<{
    streamSid: string | null;
    agentSpeaking: boolean;
    outboundTurnId: number;
    closed: boolean;
    language: 'en' | 'es';
    languageSwitchCount: number;
  }> {
    return {
      streamSid: this.state.streamSid,
      agentSpeaking: this.state.agentSpeaking,
      outboundTurnId: this.state.outboundTurnId,
      closed: this.state.closed,
      language: this.state.language,
      languageSwitchCount: this.state.languageSwitchCount,
    };
  }
}

function isValidStartFrame(frame: Extract<TwilioInboundFrame, { event: 'start' }>): boolean {
  const start = frame.start;
  if (!start || typeof start !== 'object') return false;
  if (typeof start.callSid !== 'string' || start.callSid.trim().length === 0) return false;
  if (typeof start.streamSid !== 'string' || start.streamSid.trim().length === 0) return false;
  return true;
}

/**
 * Re-export the codec so callers can stub or override it in tests
 * without depending on the codec module path.
 */
export { pcm16ToMulaw };
