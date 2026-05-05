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
  /** Audio inactivity teardown (ms). Default 30 minutes. */
  audioIdleTimeoutMs?: number;
}

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
        // We could pace outbound here; for now we just log the ack.
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
      if (!text || text === 'greeting' || text === 'intent_confirm') continue;
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
   */
  private async streamPcmAsMedia(pcm: Buffer, turnId: number): Promise<void> {
    if (!this.state.streamSid) return;
    const FRAME_BYTES_16K = 640; // 20 ms @ 16 kHz, 16-bit mono
    let offset = 0;
    let frameCount = 0;
    while (offset < pcm.length) {
      if (turnId !== this.state.outboundTurnId || !this.state.agentSpeaking || this.state.closed) {
        return;
      }
      const chunk = pcm.subarray(offset, Math.min(offset + FRAME_BYTES_16K, pcm.length));
      offset += FRAME_BYTES_16K;
      const payload = encodeTwilioOutboundFrame(chunk, 16000);
      this.send({
        event: 'media',
        streamSid: this.state.streamSid,
        media: { payload },
      });
      frameCount++;
    }
    // Mark frame so Twilio can ack the end of this turn — useful for
    // observability and future backpressure pacing.
    if (frameCount > 0 && turnId === this.state.outboundTurnId) {
      this.send({
        event: 'mark',
        streamSid: this.state.streamSid,
        mark: { name: `turn-${turnId}` },
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
    this.send({ event: 'clear', streamSid: this.state.streamSid });
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
    if (this.state.audioIdleTimer) {
      clearTimeout(this.state.audioIdleTimer);
      this.state.audioIdleTimer = null;
    }
    try {
      this.state.deepgram?.destroy();
    } catch {
      /* swallow */
    }
    this.state.deepgram = null;
    this.closeWs(1000, reason);
  }

  private closeWs(code: number, reason: string): void {
    try {
      this.state.ws.close(code, reason);
    } catch {
      /* swallow */
    }
  }

  private send(envelope: Record<string, unknown>): void {
    try {
      this.state.ws.send(JSON.stringify(envelope));
    } catch (err) {
      logger.warn('mediastream: ws.send failed', {
        error: err instanceof Error ? err.message : String(err),
      });
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
