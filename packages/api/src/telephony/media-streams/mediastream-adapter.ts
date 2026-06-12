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
import type { SideEffect } from '../../ai/agents/customer-calling/types';
import { escalateWithContextPayloadSchema } from '../../ai/agents/customer-calling/types';
import {
  decodeTwilioInboundFrame,
  encodeTwilioOutboundFrame,
  pcm16ToMulaw,
} from './mulaw-codec';
import { BoundedSendQueue, type Priority } from '../../ws/bounded-send-queue';
import { wsDisconnectTotal } from '../../monitoring/metrics';
import {
  ConnectionRegistry,
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
} from '../../ai/voice-quality/events';
import { VOICE_EVENT_CHANNEL } from '../../ai/voice-quality/event-bus';
import type { WhisperCache } from '../whisper-cache';
import type { TwilioCallControl } from '../twilio-call-control';
import type { EscalationSettings } from '../../settings/settings';
import type { SentimentInput, SentimentResult, SentimentBudget } from '../../ai/agents/customer-calling/sentiment-classifier';
import type { PanelData } from '../../ai/agents/customer-calling/escalation-summary-builder';

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
   */
  terminologyProvider?: {
    getKeywords(tenantId: string): Promise<ReadonlyArray<string>>;
  };
  /**
   * Optional filler engine + cache. When both are present, the adapter
   * wraps each `tts_play` turn with a 250ms timer: if the real TTS has
   * not started streaming by then, it plays one filler clip from the
   * cache. Omitting either turns the feature off entirely.
   */
  fillerEngine?: {
    selectNext(ctx?: { skipFillers?: boolean }): { id: string; text: string; approxDurationMs: number } | undefined;
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
}

const TWILIO_SURFACE = 'twilio_media_streams';

// Skip the LLM sentiment call once the session has consumed this fraction of
// its cost cap, so frustration classification can't blow a tenant's budget.
const SENTIMENT_MAX_BUDGET_RATIO = 0.8;

interface RuntimeState {
  ws: WsLike;
  streamSid: string | null;
  callSid: string | null;
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
  /** Outbound queue (bounded, priority-aware). */
  queue: BoundedSendQueue;
  draining: boolean;
  /** Outstanding marks awaiting Twilio `mark` ack (for backpressure). */
  unackedMarks: number;
  /** Slow-consumer grace timer; when set, we close after this fires. */
  slowConsumerTimer: NodeJS.Timeout | null;
  /** True after we've released our slot in the connection registry. */
  registryReleased: boolean;
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
    reason === 'queue_overflow_terminal'
  ) {
    return 'transport_failure';
  }
  return 'caller_hangup';
}

// ─── Adapter ─────────────────────────────────────────────────────────────────

/**
 * Default audio-inactivity teardown: 30 minutes. Aligns with the
 * VoiceSessionStore's idle TTL so a long-lived WS that stops receiving
 * `media` frames doesn't leak past the FSM session.
 */
export const DEFAULT_AUDIO_IDLE_TIMEOUT_MS = 30 * 60 * 1000;

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
      tenantId: null,
      session: null,
      deepgram: null,
      agentSpeaking: false,
      outboundTurnId: 0,
      ttsController: null,
      closed: false,
      lastMediaAt: Date.now(),
      audioIdleTimer: null,
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
      wsCloseInitiated: false,
      pendingFinalizeEffects: [],
      awaitingFirstAudioFrame: false,
      fillerActive: false,
      pendingTransferTwiml: null,
      resolvedEscalationSettings: null,
      interimEmergencyFired: false,
    };
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
    if (!registry.tryAcquire(TWILIO_SURFACE, session.tenantId)) {
      this.logSecurityEvent('tenant_connection_cap_exceeded', {
        callSid,
        tenantId: session.tenantId,
      });
      this.closeWs(1013, 'tenant_connection_cap');
      return;
    }
    this.state.registryReleased = false;

    this.state.streamSid = frame.start.streamSid;
    this.state.callSid = callSid;
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

    try {
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
          // Deepgram closed independently — we can still drain Twilio
          // until it sends `stop`. No-op.
        },
        undefined, // language defaults
        keywords.length > 0 ? { keywords } : undefined
      );
    } catch (err) {
      logger.error('mediastream: failed to open Deepgram session', {
        error: err instanceof Error ? err.message : String(err),
        callSid,
      });
      this.closeWs(1011, 'deepgram_open_failed');
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
      } catch (err) {
        logger.warn('mediastream: initializeSession failed — continuing without greeting', {
          error: err instanceof Error ? err.message : String(err),
          callSid,
        });
        // DISCLOSURE_INIT_FAILED — the call continues but the caller was never
        // given the recording-consent disclosure and the session is unledgered.
        // This is a compliance gap that must be countable/alertable.
        // TODO(follow-up): emit a voice.disclosure_init_failed audit/quality event
        // once a session-scoped event type is added to VoiceSessionEvent so ops
        // dashboards can count & alert on this failure mode without a log scrape.
        logger.error('DISCLOSURE_INIT_FAILED', {
          callSid,
          tenantId: session.tenantId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
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

    // VQ2-004: TTFA-start. Stamp the moment the STT provider returned a
    // final transcript on the session bus and arm the per-turn
    // first-frame guard so the next outbound chunk emits
    // `audio_frame_emitted`. Emitted BEFORE speechTurn to capture the
    // full agent-thinking window.
    this.state.awaitingFirstAudioFrame = true;
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
      return;
    }

    await this.emitSideEffects(sideEffects);

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
   * Extract the last `n` caller + AI turns from the session transcript
   * in the format `{ role, text }` the sentiment classifier expects.
   * The session transcript stores strings like `"caller: text"` and
   * `"agent: text"`.
   */
  private extractPriorTurns(
    session: VoiceSession,
    n: number,
  ): ReadonlyArray<{ role: 'caller' | 'ai'; text: string }> {
    const snapshot = [...session.transcript].slice(-n);
    return snapshot
      .map((line) => {
        const colonIdx = line.indexOf(': ');
        if (colonIdx === -1) return null;
        const speaker = line.slice(0, colonIdx);
        const text = line.slice(colonIdx + 2);
        const role: 'caller' | 'ai' = speaker === 'caller' ? 'caller' : 'ai';
        return { role, text };
      })
      .filter((t): t is { role: 'caller' | 'ai'; text: string } => t !== null);
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
      const text = typeof fx.payload.text === 'string' ? fx.payload.text : '';
      if (!text) continue;
      let turnId = ++this.state.outboundTurnId;
      this.state.agentSpeaking = true;
      try {
        // runTurnWithFiller returns the final turnId — it may have been
        // bumped if a filler was preempted by the real TTS arrival.
        turnId = await this.runTurnWithFiller(ttsProvider, text, turnId);
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
          const filler = engine.selectNext();
          if (!filler) return;
          const pcm = cache.get(filler.id);
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
        const stream = ttsProvider.synthesizeStream({
          text,
          tenantId: this.state.tenantId ?? undefined,
          signal: controller.signal,
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
      } else {
        const result = await ttsProvider.synthesize({
          text,
          tenantId: this.state.tenantId ?? undefined,
        });
        realStarted = true;
        if (fillerTimer) clearTimeout(fillerTimer);
        // Same cancellation logic for buffered (non-streaming) TTS.
        cancelActiveFiller();
        if (turnId === this.state.outboundTurnId && this.state.agentSpeaking) {
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

  // ─── Close / cleanup ───────────────────────────────────────────────────────

  private handleClose(reason: string): void {
    if (this.state.closed) return;
    this.state.closed = true;
    // B2: stash the outcome BEFORE we tear down. The host's
    // `finalizeOnClose` is sync (sets session.terminalOutcome and
    // kicks off the DB write in the background), so close stays
    // non-blocking. `pendingFinalizeEffects` carries the FSM
    // dispatch's effects (with `end_session.payload.reason`) when the
    // close was triggered by an FSM end_session — empty otherwise, in
    // which case the host falls back to the mapped close reason.
    if (this.deps.finalizeOnClose && this.state.session) {
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
    if (!this.state.registryReleased && this.state.tenantId) {
      const registry = this.deps.connectionRegistry ?? globalConnectionRegistry;
      registry.release(TWILIO_SURFACE, this.state.tenantId);
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
  }> {
    return {
      streamSid: this.state.streamSid,
      agentSpeaking: this.state.agentSpeaking,
      outboundTurnId: this.state.outboundTurnId,
      closed: this.state.closed,
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
