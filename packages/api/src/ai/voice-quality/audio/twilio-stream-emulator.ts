/**
 * VQ2-006 — Twilio Media Streams emulator.
 *
 * A WebSocket *client* that speaks the Twilio Media Streams protocol so
 * the Voice Quality v1 Layer 2 harness can drive the same
 * `mediastream-adapter`/`twilio-mediastream-server` code path production
 * runs against, without any Twilio dependency. Used per turn by the
 * AudioModeDriver (VQ2-008).
 *
 * Lifecycle for a single emulated call:
 *   1. `start(callSid)` opens the WS, sends:
 *        - `{ event: 'connected', protocol: 'Call', version: '1.0.0' }`
 *        - `{ event: 'start', streamSid, start: { callSid, accountSid: 'AC_TEST',
 *             tracks: ['inbound'], mediaFormat: { encoding: 'audio/x-mulaw',
 *             sampleRate: 8000, channels: 1 } } }`
 *   2. `sendCallerUtterance(audio)` per turn:
 *        a. Frames the caller PCM into 20 ms μ-law base64 chunks via
 *           {@link frameForTwilio} and emits them paced at 20 ms wall-clock
 *           intervals so the adapter sees realistic delivery timing.
 *        b. Emits a `mark` named `eot-<turnIndex>` to flag end-of-turn.
 *        c. Records a synthetic `transcript_received` on the AgentEventBus
 *           — the production adapter would emit this when its STT returned;
 *           the emulator simulates that signal as soon as the caller's audio
 *           is fully delivered. Pairs with `audio_frame_emitted` (VQ2-004
 *           wiring) to compute TTFA.
 *        d. Waits (up to `firstAudioTimeoutMs`, default 10 s) for the
 *           agent's first reply frame, then collects inbound `media` frames
 *           (the agent's TTS) until `silenceWindowMs` of inbound silence
 *           elapses after the latest frame (default 1500 ms), then decodes
 *           them via {@link decodeAgentOutbound}.
 *   3. `hangup()` sends a `stop` and closes the socket cleanly.
 *
 * Test-mode only. The emulator's WS upgrade hits the production server
 * which signs requests; VQ2-007 introduces an `authTestMode` bypass so
 * the harness can connect. For unit tests, point at any stub WS server.
 */
import WebSocket from 'ws';
import { performance } from 'node:perf_hooks';

import {
  decodeAgentOutbound,
  frameForTwilio,
  type OutboundFrame,
} from './pcm-codec';
import type { AgentEventBus } from '../event-bus';
import { transcriptReceivedEvent } from '../events';

/** 20 ms — Twilio's canonical media-frame cadence. */
const FRAME_PACING_MS = 20;
/** Default silence window — 1.5 s matches the plan's tolerance for end-of-agent-turn. */
const DEFAULT_SILENCE_WINDOW_MS = 1500;
/**
 * Default bound on how long the emulator waits for the agent's FIRST reply
 * frame after the caller's transcript is delivered. A live agent turn is an
 * LLM call plus TTS synthesis — seconds, not milliseconds — so this must be
 * far larger than the silence window (#1387).
 */
const DEFAULT_FIRST_AUDIO_TIMEOUT_MS = 10_000;
/** Polling cadence inside the silence-window wait loop. */
const SILENCE_POLL_MS = 50;

export interface TwilioStreamEmulatorDeps {
  /** WS URL the production server listens on, e.g. `ws://localhost:<port>/api/telephony/stream`. */
  serverUrl: string;
  /** Bus the emulator writes synthetic `transcript_received` events to. */
  bus: AgentEventBus;
  /**
   * Layer-2 STT bridge. The production adapter advances a turn only after
   * its streaming provider emits a final transcript; recording a timing
   * event on the quality bus is not sufficient. The live harness supplies
   * this callback to deliver the known scripted transcript through that
   * provider callback after the caller audio has been streamed.
   */
  deliverFinalTranscript?: (transcript: string) => void | Promise<void>;
  /**
   * How long after the last received agent frame the emulator waits
   * before declaring the agent's response complete. Defaults to 1500 ms
   * per the plan; tests pass a much shorter value (e.g. 100 ms) for
   * speed.
   */
  silenceWindowMs?: number;
  /**
   * How long to wait for the agent's first reply frame before declaring the
   * agent silent for this turn. The silence window only starts once the
   * reply has begun (#1387). Defaults to 10 s; tests pass a short value.
   */
  firstAudioTimeoutMs?: number;
}

export interface TurnResult {
  /** Decoded PCM16 LE 8 kHz of all agent audio frames received this turn. */
  agentAudio: Buffer;
  /**
   * Time-to-first-audio in milliseconds: first inbound frame timestamp
   * minus the synthetic `transcript_received` timestamp. `0` when no
   * inbound frame arrived (silent agent).
   */
  ttfaMs: number;
  /** Number of inbound `media` frames received this turn. */
  numFrames: number;
  /** Total bytes of decoded PCM16 audio received from the agent. */
  totalBytesIn: number;
}

export class TwilioStreamEmulator {
  private ws: WebSocket | null = null;
  private callSid: string | null = null;
  private streamSid: string | null = null;
  /**
   * Per-turn buffer of received outbound frames. Reset at the start of
   * each `sendCallerUtterance` call so each turn's TTFA / agentAudio
   * calculation is isolated.
   */
  private receivedFrames: OutboundFrame[] = [];
  /** Auto-incrementing turn index for `eot-<n>` mark names. */
  private turnIndex = 0;
  /**
   * Simulated playback clock (performance.now() ms): when the agent audio
   * received so far finishes "playing" at 20 ms per frame. Server marks are
   * acknowledged at this time, as Twilio does (#1387).
   */
  private playbackEndsAt = 0;
  /** Scheduled mark acknowledgements, cancelled on hangup. */
  private readonly pendingMarkAcks = new Set<ReturnType<typeof setTimeout>>();

  constructor(private readonly deps: TwilioStreamEmulatorDeps) {}

  /**
   * Open the WebSocket and send the canonical Twilio handshake messages.
   * Resolves once both `connected` and `start` have been written to the
   * socket. Rejects on WS error before open.
   */
  async start(callSid: string): Promise<void> {
    this.callSid = callSid;
    this.streamSid = `MZ_TEST_${callSid}_${Date.now().toString(36)}`;

    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.deps.serverUrl);
      this.ws = ws;

      const onOpen = (): void => {
        try {
          ws.send(
            JSON.stringify({ event: 'connected', protocol: 'Call', version: '1.0.0' }),
          );
          ws.send(
            JSON.stringify({
              event: 'start',
              streamSid: this.streamSid,
              start: {
                callSid,
                // Twilio repeats the stream identifier inside `start`.
                // The production adapter validates this canonical location
                // before binding a call, so the emulator must do the same.
                streamSid: this.streamSid,
                accountSid: 'AC_TEST',
                tracks: ['inbound'],
                mediaFormat: {
                  encoding: 'audio/x-mulaw',
                  sampleRate: 8000,
                  channels: 1,
                },
              },
            }),
          );
          // Replace the error handler with a no-op-friendly one once we're open;
          // the open-error rejecter only matters for the initial connect race.
          ws.removeListener('error', onError);
          ws.on('error', () => {
            /* swallow — subsequent errors are surfaced via the WS close path */
          });
          resolve();
        } catch (err) {
          reject(err instanceof Error ? err : new Error(String(err)));
        }
      };

      const onError = (err: Error): void => {
        reject(err);
      };

      ws.on('open', onOpen);
      ws.on('error', onError);
      ws.on('message', (raw: Buffer | string) => {
        this.onMessage(typeof raw === 'string' ? raw : raw.toString('utf-8'));
      });
    });
  }

  /**
   * Receive handler. Captures inbound `media` frames (the agent's TTS)
   * along with their wall-clock arrival timestamp via `performance.now()`
   * for honest TTFA accounting.
   *
   * Server `mark`s are acknowledged the way Twilio does: echoed back once
   * the audio queued before them has finished playing (20 ms per frame on
   * a simulated playback clock). The production adapter pauses outbound
   * TTS after 3 unacknowledged marks, so without this every agent reply
   * stalled after ~1.5 s of audio (#1387). Layer 2 scripts never barge
   * in, so `clear` / `stop` are observed but not acted on.
   */
  private onMessage(raw: string): void {
    let msg: { event?: string; media?: { payload?: string }; mark?: { name?: string } };
    try {
      msg = JSON.parse(raw) as typeof msg;
    } catch {
      // The production server only sends JSON; ignore non-JSON debug frames.
      return;
    }
    if (msg.event === 'media' && typeof msg.media?.payload === 'string') {
      const now = performance.now();
      this.receivedFrames.push({
        payload: msg.media.payload,
        ts: now,
      });
      this.playbackEndsAt = Math.max(this.playbackEndsAt, now) + FRAME_PACING_MS;
    } else if (msg.event === 'mark' && typeof msg.mark?.name === 'string') {
      const name = msg.mark.name;
      const delayMs = Math.max(0, this.playbackEndsAt - performance.now());
      const timer = setTimeout(() => {
        this.pendingMarkAcks.delete(timer);
        this.ackMark(name);
      }, delayMs);
      this.pendingMarkAcks.add(timer);
    }
  }

  private ackMark(name: string): void {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    try {
      ws.send(JSON.stringify({ event: 'mark', streamSid: this.streamSid, mark: { name } }));
    } catch {
      /* socket closing — the ack no longer matters */
    }
  }

  /**
   * Stream caller PCM into the server, signal end-of-turn via `mark`,
   * synthesize the `transcript_received` event on the bus, and collect
   * agent audio until the silence window elapses without a new frame.
   *
   * @param audio  PCM16 LE mono 8 kHz buffer to deliver as the caller's turn.
   * @param turnIndexOverride  Optional explicit turn index; otherwise
   *                           the emulator's internal counter is used
   *                           and incremented.
   */
  async sendCallerUtterance(
    audio: Buffer,
    turnIndexOverride?: number,
    callerTranscript?: string,
  ): Promise<TurnResult> {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      throw new Error('TwilioStreamEmulator: WS not open; call start() first');
    }
    const idx = turnIndexOverride ?? this.turnIndex++;

    // Reset per-turn state so we don't leak frames from a previous turn.
    this.receivedFrames = [];

    // Frame and pace at 20 ms wall-clock intervals.
    const frames = frameForTwilio(audio);
    for (const payload of frames) {
      ws.send(
        JSON.stringify({
          event: 'media',
          streamSid: this.streamSid,
          media: { payload, track: 'inbound' },
        }),
      );
      await new Promise((r) => setTimeout(r, FRAME_PACING_MS));
    }

    // End-of-turn mark — Twilio uses arbitrary mark names; we encode
    // the turn index so the server's mark-ack path is observable in
    // tests that care about pacing.
    ws.send(
      JSON.stringify({
        event: 'mark',
        streamSid: this.streamSid,
        mark: { name: `eot-${idx}` },
      }),
    );

    // In the live harness, deliver the known transcript through the
    // streaming-provider callback. That makes the production adapter emit
    // `transcript_received` and invoke speechTurn exactly as it does after a
    // real Deepgram final. Standalone emulator tests have no adapter, so they
    // retain the synthetic bus event as a timing fallback.
    const transcriptReceivedTs = performance.now();
    // Wall-clock twin of the above: bus events carry Date.now() stamps.
    const transcriptDeliveredAtMs = Date.now();
    if (this.deps.deliverFinalTranscript) {
      if (callerTranscript === undefined) {
        throw new Error(
          'TwilioStreamEmulator: callerTranscript is required when deliverFinalTranscript is configured',
        );
      }
      await this.deps.deliverFinalTranscript(callerTranscript);
    } else {
      this.deps.bus.record(transcriptReceivedEvent({ ts: transcriptReceivedTs }));
    }

    // Phase 1: wait (bounded) for the agent's first reply frame. The reply
    // is an LLM call + TTS synthesis, so it routinely starts more than a
    // silence window after the transcript. Starting the silence clock at
    // transcript delivery (the pre-#1387 behaviour) closed every live turn
    // before the agent spoke: agentAudio came back empty, TTFA read 0, and
    // the late reply leaked into the next turn's buffer.
    const silenceWindowMs = this.deps.silenceWindowMs ?? DEFAULT_SILENCE_WINDOW_MS;
    const firstAudioTimeoutMs =
      this.deps.firstAudioTimeoutMs ?? DEFAULT_FIRST_AUDIO_TIMEOUT_MS;
    const firstReplyFrame = (): OutboundFrame | undefined =>
      this.receivedFrames.find((f) => f.ts >= transcriptReceivedTs);
    while (
      !firstReplyFrame() &&
      performance.now() - transcriptReceivedTs < firstAudioTimeoutMs
    ) {
      await new Promise((r) => setTimeout(r, SILENCE_POLL_MS));
    }

    // Phase 2: once the reply has begun, collect frames until
    // `silenceWindowMs` elapses without a new arrival (end of agent turn).
    //
    // #1331 — on the live bridge the first frames may be the production
    // filler (played ~250 ms after the caller finishes when the answer is not
    // ready); the real reply follows seconds later. Until the adapter marks
    // the REAL reply on the bus (`audio_frame_emitted`), a quiet gap is the
    // agent thinking, not the end of its turn — keep waiting, bounded by the
    // same first-audio timeout.
    const awaitingRealReply = (): boolean =>
      this.deps.deliverFinalTranscript !== undefined &&
      !this.deps.bus
        .events()
        .some((e) => e.type === 'audio_frame_emitted' && e.ts >= transcriptDeliveredAtMs) &&
      performance.now() - transcriptReceivedTs < firstAudioTimeoutMs;
    const firstReply = firstReplyFrame();
    if (firstReply) {
      let lastFrameTs = this.receivedFrames[this.receivedFrames.length - 1]!.ts;
      while (performance.now() - lastFrameTs < silenceWindowMs || awaitingRealReply()) {
        await new Promise((r) => setTimeout(r, SILENCE_POLL_MS));
        const newest = this.receivedFrames[this.receivedFrames.length - 1];
        if (newest && newest.ts > lastFrameTs) {
          lastFrameTs = newest.ts;
        }
      }
    }

    const { pcm16 } = decodeAgentOutbound(this.receivedFrames);
    const ttfaMs = firstReply ? firstReply.ts - transcriptReceivedTs : 0;
    return {
      agentAudio: pcm16,
      ttfaMs,
      numFrames: this.receivedFrames.length,
      totalBytesIn: pcm16.length,
    };
  }

  /**
   * Send a `stop` and close the WS. Idempotent — subsequent calls after
   * the socket has already closed are no-ops.
   */
  async hangup(): Promise<void> {
    for (const timer of this.pendingMarkAcks) clearTimeout(timer);
    this.pendingMarkAcks.clear();
    const ws = this.ws;
    if (ws && ws.readyState === WebSocket.OPEN) {
      try {
        ws.send(JSON.stringify({ event: 'stop', streamSid: this.streamSid }));
      } catch {
        /* swallow — best-effort stop signal */
      }
      // Brief delay so the stop frame flushes before the close handshake.
      await new Promise((r) => setTimeout(r, 50));
      try {
        ws.close();
      } catch {
        /* swallow */
      }
    }
    this.ws = null;
  }
}
