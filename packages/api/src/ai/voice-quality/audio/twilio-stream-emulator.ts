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
 *        d. Collects inbound `media` frames (the agent's TTS) until
 *           `silenceWindowMs` of inbound silence elapses (default 1500 ms),
 *           then decodes them via {@link decodeAgentOutbound}.
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
/** Polling cadence inside the silence-window wait loop. */
const SILENCE_POLL_MS = 50;

export interface TwilioStreamEmulatorDeps {
  /** WS URL the production server listens on, e.g. `ws://localhost:<port>/api/telephony/stream`. */
  serverUrl: string;
  /** Bus the emulator writes synthetic `transcript_received` events to. */
  bus: AgentEventBus;
  /**
   * How long after the last received agent frame the emulator waits
   * before declaring the agent's response complete. Defaults to 1500 ms
   * per the plan; tests pass a much shorter value (e.g. 100 ms) for
   * speed.
   */
  silenceWindowMs?: number;
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
   * for honest TTFA accounting. Other events (`mark`, `clear`, `stop`)
   * are observed but not acted on — the emulator is a passive collector
   * of agent audio.
   */
  private onMessage(raw: string): void {
    let msg: { event?: string; media?: { payload?: string } };
    try {
      msg = JSON.parse(raw) as { event?: string; media?: { payload?: string } };
    } catch {
      // The production server only sends JSON; ignore non-JSON debug frames.
      return;
    }
    if (msg.event === 'media' && typeof msg.media?.payload === 'string') {
      this.receivedFrames.push({
        payload: msg.media.payload,
        ts: performance.now(),
      });
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

    // Synthetic `transcript_received` — pairs with `audio_frame_emitted`
    // (which the production adapter emits via VQ2-004 wiring) to compute
    // TTFA. Stamped via performance.now() to match the receive timestamps
    // we record in `onMessage`.
    const transcriptReceivedTs = performance.now();
    this.deps.bus.record(transcriptReceivedEvent({ ts: transcriptReceivedTs }));

    // Collect agent frames until `silenceWindowMs` elapses without a new
    // arrival. We start the clock from `transcriptReceivedTs` so a fully
    // silent agent still terminates after the silence window — `lastFrameTs`
    // is bumped each time a new frame lands.
    const silenceWindowMs = this.deps.silenceWindowMs ?? DEFAULT_SILENCE_WINDOW_MS;
    let lastFrameTs = transcriptReceivedTs;
    while (performance.now() - lastFrameTs < silenceWindowMs) {
      await new Promise((r) => setTimeout(r, SILENCE_POLL_MS));
      const newest = this.receivedFrames[this.receivedFrames.length - 1];
      if (newest && newest.ts > lastFrameTs) {
        lastFrameTs = newest.ts;
      }
    }

    const { pcm16, firstFrameTs } = decodeAgentOutbound(this.receivedFrames);
    const ttfaMs =
      firstFrameTs !== null ? Math.max(0, firstFrameTs - transcriptReceivedTs) : 0;
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
