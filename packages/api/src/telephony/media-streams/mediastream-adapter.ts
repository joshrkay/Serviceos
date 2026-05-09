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

import { createLogger } from '../../logging/logger';
import type {
  StreamingSession,
  StreamingTranscriptionProvider,
} from '../../voice/transcription-providers';
import type { TtsProvider } from '../../ai/tts/tts-provider';
import type { VoiceSession, VoiceSessionStore } from '../../ai/agents/customer-calling/voice-session-store';
import type { SideEffect } from '../../ai/agents/customer-calling/types';
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
}

const TWILIO_SURFACE = 'twilio_media_streams';

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
  /**
   * B2 — captures the most recent FSM dispatch's SideEffect[] when an
   * `end_session` effect was emitted. Threaded through `finalizeOnClose`
   * so the host can read the FSM-supplied `payload.reason` for outcome
   * derivation (e.g. 'abuse_detected:*' → escalated_to_human).
   * Empty for non-FSM close paths (idle timer, slow consumer, WS error).
   */
  pendingFinalizeEffects: ReadonlyArray<SideEffect>;
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
      pendingFinalizeEffects: [],
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
      return;
    }
    // Final transcript: dispatch into the FSM under the per-session lock
    // so concurrent webhook deliveries (Twilio retries, parallel
    // /input requests) can't interleave with this turn.
    const session = this.state.session;
    const callSid = this.state.callSid;
    const tenantId = this.state.tenantId;
    if (!session || !callSid || !tenantId) return;

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

    // FSM may have terminated this turn — close the call.
    if (sideEffects.some((fx) => fx.type === 'end_session')) {
      // B2: stash the dispatch's effects so the finalize hook can read
      // the FSM-supplied end_session.payload.reason — handleClose itself
      // only carries a coarse mediastream label suitable for metrics.
      this.state.pendingFinalizeEffects = sideEffects;
      this.handleClose('end_session');
    }
  }

  // ─── Outbound: TTS → μ-law → media frame ───────────────────────────────────

  private async emitSideEffects(sideEffects: SideEffect[]): Promise<void> {
    const ttsProvider = this.deps.ttsProvider;
    if (!ttsProvider) return;
    for (const fx of sideEffects) {
      if (fx.type !== 'tts_play') continue;
      const text = typeof fx.payload.text === 'string' ? fx.payload.text : '';
      if (!text) continue;
      const turnId = ++this.state.outboundTurnId;
      this.state.agentSpeaking = true;
      try {
        const result = await ttsProvider.synthesize({
          text,
          tenantId: this.state.tenantId ?? undefined,
        });
        // If the caller barged in while we were synthesizing, drop this
        // chunk so we don't speak over them.
        if (turnId !== this.state.outboundTurnId || !this.state.agentSpeaking) {
          continue;
        }
        await this.streamPcmAsMedia(result.audio, turnId);
      } catch (err) {
        logger.warn('mediastream: TTS synthesize failed', {
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
   * Send a buffer of PCM16 16 kHz audio out as a stream of Twilio
   * `media` frames. Splits into 20 ms chunks (320 samples @ 16 kHz =
   * 640 bytes) — at the 8 kHz output rate, that's 160 bytes / chunk
   * which is the Twilio canonical frame size.
   *
   * `turnId` lets us abort cleanly if the caller barges in mid-stream.
   * Pacing: when ≥ TWILIO_MAX_UNACKED_MARKS marks are unacked, we yield
   * to give Twilio a chance to ack before pushing more audio.
   */
  private async streamPcmAsMedia(pcm: Buffer, turnId: number): Promise<void> {
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
