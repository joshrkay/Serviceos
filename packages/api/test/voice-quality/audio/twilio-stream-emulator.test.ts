/**
 * VQ2-006 — Twilio Media Streams emulator tests.
 *
 * The emulator is a Twilio-protocol-speaking WebSocket *client*. To test
 * it without dragging in the production server (signature verification,
 * Deepgram, FSM…), we spin up a thin in-test stub WebSocket server that:
 *
 *   1. Records every JSON message the client sends.
 *   2. Lets the test scriptedly inject inbound `media` frames back at
 *      the client so we can exercise the agent-audio collection path.
 *
 * Timing concerns: the emulator paces caller frames at 20 ms and waits
 * for a `silenceWindowMs` of inbound silence to declare the agent's
 * response complete. Tests use a tiny silence window (50–100 ms) and
 * keep utterances short (1–2 frames worth) to stay fast and stable on
 * shared CI runners.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocket, WebSocketServer } from 'ws';
import { createServer, type Server as HttpServer } from 'http';
import type { AddressInfo } from 'net';

import { TwilioStreamEmulator } from '../../../src/ai/voice-quality/audio/twilio-stream-emulator';
import { AgentEventBus } from '../../../src/ai/voice-quality/event-bus';
import { frameForTwilio, pcm16ToMulaw } from '../../../src/ai/voice-quality/audio/pcm-codec';
import {
  audioFrameEmittedEvent,
  repairTemplateFiredEvent,
  transcriptReceivedEvent,
} from '../../../src/ai/voice-quality/events';

// ─── Stub server ────────────────────────────────────────────────────────────

interface StubServer {
  url: string;
  recorded: Array<Record<string, unknown>>;
  /** Send a base64 μ-law payload back to the connected client as a `media` frame. */
  sendInboundFrame: (payload: string, streamSid?: string) => void;
  /** Send a server `mark` (the adapter's playback checkpoint) to the client. */
  sendMark: (name: string, streamSid?: string) => void;
  /** Wait until the client has connected (resolves once on connection). */
  waitForConnection: () => Promise<void>;
  close: () => Promise<void>;
}

function startStubServer(): Promise<StubServer> {
  return new Promise((resolve, reject) => {
    const recorded: Array<Record<string, unknown>> = [];
    const httpServer: HttpServer = createServer();
    const wss = new WebSocketServer({ server: httpServer });

    let activeWs: WebSocket | null = null;
    let resolveConnection: (() => void) | null = null;
    const connectionPromise = new Promise<void>((r) => {
      resolveConnection = r;
    });

    wss.on('connection', (ws) => {
      activeWs = ws;
      ws.on('message', (data) => {
        try {
          const parsed = JSON.parse(data.toString('utf-8')) as Record<string, unknown>;
          recorded.push(parsed);
        } catch {
          // ignore non-JSON
        }
      });
      if (resolveConnection) {
        resolveConnection();
        resolveConnection = null;
      }
    });

    httpServer.listen(0, '127.0.0.1', () => {
      const addr = httpServer.address() as AddressInfo;
      const url = `ws://127.0.0.1:${addr.port}/twilio-stream`;
      resolve({
        url,
        recorded,
        sendInboundFrame: (payload, streamSid = 'MZ_STUB') => {
          if (!activeWs || activeWs.readyState !== WebSocket.OPEN) return;
          activeWs.send(
            JSON.stringify({
              event: 'media',
              streamSid,
              media: { track: 'outbound', chunk: '1', timestamp: '0', payload },
            }),
          );
        },
        sendMark: (name, streamSid = 'MZ_STUB') => {
          if (!activeWs || activeWs.readyState !== WebSocket.OPEN) return;
          activeWs.send(JSON.stringify({ event: 'mark', streamSid, mark: { name } }));
        },
        waitForConnection: () => connectionPromise,
        close: () =>
          new Promise<void>((r) => {
            try {
              if (activeWs && activeWs.readyState === WebSocket.OPEN) {
                activeWs.close();
              }
            } catch {
              /* swallow */
            }
            wss.close(() => {
              httpServer.close(() => r());
            });
          }),
      });
    });
    httpServer.on('error', reject);
  });
}

// ─── Test helpers ───────────────────────────────────────────────────────────

/**
 * 0.04 seconds (40 ms) of silence at 8 kHz PCM16 — produces 2 caller
 * frames of 20 ms each via {@link frameForTwilio}. Short on purpose so
 * the test wall-clock cost is dominated by `silenceWindowMs`, not by
 * caller-frame pacing.
 */
function shortPcmSilence(): Buffer {
  return Buffer.alloc(640); // 320 samples * 2 bytes
}

/** Build an inbound μ-law base64 payload of the canonical 160-byte size. */
function inboundFramePayload(): string {
  // 160 PCM samples → 160 μ-law bytes. Use a non-zero waveform so the
  // decoded pcm length is verifiable downstream.
  const pcm = Buffer.alloc(320);
  for (let i = 0; i < 160; i++) {
    pcm.writeInt16LE(1000, i * 2);
  }
  return pcm16ToMulaw(pcm).toString('base64');
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('VQ2-006 — TwilioStreamEmulator', () => {
  let stub: StubServer;
  let bus: AgentEventBus;
  let emulator: TwilioStreamEmulator;

  beforeEach(async () => {
    stub = await startStubServer();
    bus = new AgentEventBus();
    emulator = new TwilioStreamEmulator({
      serverUrl: stub.url,
      bus,
      // Keep tests fast — 100 ms is plenty since stubs reply within μs.
      silenceWindowMs: 100,
      // Bounds the wait for a (possibly silent) agent's first reply frame.
      firstAudioTimeoutMs: 1_000,
    });
  });

  afterEach(async () => {
    try {
      await emulator.hangup();
    } catch {
      /* swallow — some tests close early */
    }
    await stub.close();
  });

  it('VQ2-006 — start() opens the WS and sends connected + start handshake messages', async () => {
    await emulator.start('CA_TEST_123');
    await stub.waitForConnection();
    // Allow the two synchronous send() calls to flush onto the socket.
    await new Promise((r) => setTimeout(r, 20));

    expect(stub.recorded.length).toBeGreaterThanOrEqual(2);
    const connected = stub.recorded[0]!;
    const start = stub.recorded[1]!;
    expect(connected).toMatchObject({ event: 'connected', protocol: 'Call', version: '1.0.0' });
    expect(start).toMatchObject({
      event: 'start',
      start: {
        callSid: 'CA_TEST_123',
        accountSid: 'AC_TEST',
        tracks: ['inbound'],
        mediaFormat: { encoding: 'audio/x-mulaw', sampleRate: 8000, channels: 1 },
      },
    });
    const typedStart = start as {
      streamSid?: unknown;
      start?: { streamSid?: unknown };
    };
    expect(typeof typedStart.streamSid).toBe('string');
    expect(typedStart.start?.streamSid).toBe(typedStart.streamSid);
  });

  it('VQ2-006 — sendCallerUtterance frames the audio into 20ms chunks (50 frames per second of audio)', async () => {
    await emulator.start('CA_FRAMING');
    await stub.waitForConnection();

    // 1 second of silence at 8 kHz = 16000 bytes of PCM16 = 50 × 20ms frames.
    const oneSecond = Buffer.alloc(16000);
    expect(frameForTwilio(oneSecond)).toHaveLength(50);

    const turnPromise = emulator.sendCallerUtterance(oneSecond);
    // Drain — 1s pacing + 100ms silence window. Worst-case ~1.2s.
    await turnPromise;

    const mediaFrames = stub.recorded.filter((m) => m.event === 'media');
    expect(mediaFrames).toHaveLength(50);
  }, 5_000);

  it('VQ2-006 — sendCallerUtterance sends an `eot-<turnIdx>` mark after the last caller frame', async () => {
    await emulator.start('CA_MARK');
    await stub.waitForConnection();

    await emulator.sendCallerUtterance(shortPcmSilence());

    const marks = stub.recorded.filter((m) => m.event === 'mark');
    expect(marks).toHaveLength(1);
    expect((marks[0] as { mark: { name: string } }).mark.name).toBe('eot-0');

    // Second turn should auto-increment turnIndex.
    await emulator.sendCallerUtterance(shortPcmSilence());
    const allMarks = stub.recorded.filter((m) => m.event === 'mark');
    expect(allMarks).toHaveLength(2);
    expect((allMarks[1] as { mark: { name: string } }).mark.name).toBe('eot-1');
  });

  it('VQ2-006 — sendCallerUtterance emits transcript_received on the bus with monotonic ts', async () => {
    await emulator.start('CA_BUS');
    await stub.waitForConnection();

    const before = bus.events().length;
    await emulator.sendCallerUtterance(shortPcmSilence());
    const after = bus.events();
    expect(after.length).toBe(before + 1);

    const evt = after[after.length - 1]!;
    expect(evt.type).toBe('transcript_received');
    // Narrow to the transcript_received variant so we can read `ts`.
    if (evt.type !== 'transcript_received') throw new Error('unreachable');
    // performance.now() based; should be > 0 and finite.
    expect(typeof evt.ts).toBe('number');
    expect(evt.ts).toBeGreaterThan(0);
    expect(Number.isFinite(evt.ts)).toBe(true);
  });

  it('VQ2-006 — delivers the caller transcript to the streaming STT bridge', async () => {
    const delivered: string[] = [];
    emulator = new TwilioStreamEmulator({
      serverUrl: stub.url,
      bus,
      silenceWindowMs: 100,
      firstAudioTimeoutMs: 1_000,
      deliverFinalTranscript: (transcript) => {
        delivered.push(transcript);
      },
    });
    await emulator.start('CA_TRANSCRIPT_BRIDGE');
    await stub.waitForConnection();

    await emulator.sendCallerUtterance(shortPcmSilence(), 0, 'book me for Friday');

    expect(delivered).toEqual(['book me for Friday']);
    // The adapter owns this event when the bridge is configured; emitting it
    // here as well would double-count TTFA turns.
    expect(bus.events().filter((event) => event.type === 'transcript_received')).toHaveLength(0);
  });

  it('VQ2-006 — rejects a bridged turn without its caller transcript', async () => {
    emulator = new TwilioStreamEmulator({
      serverUrl: stub.url,
      bus,
      silenceWindowMs: 100,
      firstAudioTimeoutMs: 1_000,
      deliverFinalTranscript: () => {},
    });
    await emulator.start('CA_MISSING_TRANSCRIPT');
    await stub.waitForConnection();

    await expect(emulator.sendCallerUtterance(shortPcmSilence())).rejects.toThrow(
      'callerTranscript is required',
    );
  });

  it('VQ2-006 — sendCallerUtterance collects inbound media frames into agentAudio Buffer', async () => {
    await emulator.start('CA_COLLECT');
    await stub.waitForConnection();

    // Inject the agent-audio response immediately on receiving the eot mark.
    const payload = inboundFramePayload();
    const turnPromise = (async () => {
      // Schedule the inbound frame to arrive shortly after the caller turn
      // begins streaming, while we are still inside the silence window.
      setTimeout(() => stub.sendInboundFrame(payload), 30);
      setTimeout(() => stub.sendInboundFrame(payload), 50);
      return emulator.sendCallerUtterance(shortPcmSilence());
    })();

    const result = await turnPromise;
    expect(result.numFrames).toBe(2);
    // Each μ-law frame (160 bytes) decodes into 320 PCM16 bytes; two frames → 640.
    expect(result.agentAudio.length).toBe(640);
    expect(result.totalBytesIn).toBe(640);
  });

  it('VQ2-006 — sendCallerUtterance returns ttfaMs > 0 when at least one inbound frame arrived', async () => {
    await emulator.start('CA_TTFA');
    await stub.waitForConnection();

    const result = await (async () => {
      setTimeout(() => stub.sendInboundFrame(inboundFramePayload()), 60);
      return emulator.sendCallerUtterance(shortPcmSilence());
    })();

    expect(result.ttfaMs).toBeGreaterThan(0);
    expect(result.numFrames).toBe(1);
  });

  it('#1387 — waits for an agent reply slower than the silence window instead of closing the turn empty', async () => {
    // Live agents take seconds (LLM + TTS) to answer. The 1.5 s silence
    // window is an end-of-reply detector; it must not start ticking before
    // the agent has said anything, or every real reply is cut off (TTFA 0,
    // empty agent audio) and leaks into the next turn.
    await emulator.start('CA_SLOW_AGENT');
    await stub.waitForConnection();

    const result = await (async () => {
      setTimeout(() => stub.sendInboundFrame(inboundFramePayload()), 400);
      setTimeout(() => stub.sendInboundFrame(inboundFramePayload()), 420);
      return emulator.sendCallerUtterance(shortPcmSilence());
    })();

    expect(result.numFrames).toBe(2);
    expect(result.agentAudio.length).toBe(640);
    // Frames were scheduled ~400 ms after the call began; caller pacing
    // (2 × 20 ms) precedes transcript delivery, so TTFA lands well above
    // 300 ms.
    expect(result.ttfaMs).toBeGreaterThan(300);
  });

  it('#1331 — on the live bridge, a filler before the answer does not close the turn; the turn ends after the REAL reply', async () => {
    // The production adapter plays a cached filler ~250 ms after the caller
    // finishes when the answer is not ready, then the real reply seconds
    // later. The silence window must measure the end of the REAL reply
    // (marked on the bus by the adapter's audio_frame_emitted), or the
    // turn closes on the filler and the answer leaks into the next turn.
    emulator = new TwilioStreamEmulator({
      serverUrl: stub.url,
      bus,
      silenceWindowMs: 100,
      firstAudioTimeoutMs: 1_000,
      deliverFinalTranscript: () => {
        bus.record(transcriptReceivedEvent({}));
        setTimeout(() => stub.sendInboundFrame(inboundFramePayload()), 30); // filler
        setTimeout(() => {
          bus.record(audioFrameEmittedEvent({ byteCount: 320 }));
          stub.sendInboundFrame(inboundFramePayload());
        }, 400);
        setTimeout(() => stub.sendInboundFrame(inboundFramePayload()), 420);
      },
    });
    await emulator.start('CA_FILLER_THEN_ANSWER');
    await stub.waitForConnection();

    const result = await emulator.sendCallerUtterance(shortPcmSilence(), 0, 'what do I owe');

    expect(result.numFrames).toBe(3);
  });

  it('#1331 — the real reply marked on the bus BEFORE its first frame lands still counts (no race with WS transit)', async () => {
    // The adapter records audio_frame_emitted as it sends; the frame reaches
    // the emulator a transit later. If the silence window is measured from
    // the filler, the turn closes the instant the mark appears — before the
    // reply frame arrives (CI flake on #1537: "expected 1 to be 3"). Model
    // the transit explicitly (40 ms, inside the 100 ms window).
    emulator = new TwilioStreamEmulator({
      serverUrl: stub.url,
      bus,
      silenceWindowMs: 100,
      firstAudioTimeoutMs: 1_000,
      deliverFinalTranscript: () => {
        bus.record(transcriptReceivedEvent({}));
        setTimeout(() => stub.sendInboundFrame(inboundFramePayload()), 30); // filler
        setTimeout(() => bus.record(audioFrameEmittedEvent({ byteCount: 320 })), 400);
        setTimeout(() => stub.sendInboundFrame(inboundFramePayload()), 440); // real reply, in transit
      },
    });
    await emulator.start('CA_MARK_BEFORE_FRAME');
    await stub.waitForConnection();

    const result = await emulator.sendCallerUtterance(shortPcmSilence(), 0, 'what do I owe');

    expect(result.numFrames).toBe(2);
  });

  it('#1331 — after a slow-turn hold line, the turn keeps waiting for the REAL reply instead of closing on the hold', async () => {
    // The adapter speaks an honest hold line when a turn is still thinking at
    // its hold deadline (repair_template_fired trigger 'turn_hold', then the
    // hold's own audio_frame_emitted). The answer is marked by a SECOND
    // audio_frame_emitted when it starts; a quiet gap longer than the silence
    // window between the hold and the answer is still the agent thinking.
    emulator = new TwilioStreamEmulator({
      serverUrl: stub.url,
      bus,
      silenceWindowMs: 100,
      firstAudioTimeoutMs: 2_000,
      deliverFinalTranscript: () => {
        bus.record(transcriptReceivedEvent({}));
        setTimeout(() => {
          bus.record(repairTemplateFiredEvent({ trigger: 'turn_hold', text: 'hold' }));
          bus.record(audioFrameEmittedEvent({ byteCount: 320 }));
          stub.sendInboundFrame(inboundFramePayload()); // hold line
        }, 50);
        setTimeout(() => {
          bus.record(audioFrameEmittedEvent({ byteCount: 320 }));
          stub.sendInboundFrame(inboundFramePayload()); // real reply, 400 ms later
        }, 450);
      },
    });
    await emulator.start('CA_HOLD_THEN_ANSWER');
    await stub.waitForConnection();

    const result = await emulator.sendCallerUtterance(shortPcmSilence(), 0, 'yes');

    expect(result.numFrames).toBe(2);
  });

  it('VQ2-006 — sendCallerUtterance returns ttfaMs = 0 when no inbound frames (handles silent agent)', async () => {
    await emulator.start('CA_SILENT');
    await stub.waitForConnection();

    const result = await emulator.sendCallerUtterance(shortPcmSilence());
    expect(result.ttfaMs).toBe(0);
    expect(result.numFrames).toBe(0);
    expect(result.agentAudio.length).toBe(0);
  });

  it('#1387 — acknowledges each server mark once the audio before it has played, as Twilio does', async () => {
    // The production adapter stops streaming TTS after 3 unacknowledged
    // marks (one per 25 frames). Real Twilio echoes each mark back when
    // playback reaches it; an emulator that never does truncates every
    // agent reply to ~1.5 s of audio.
    await emulator.start('CA_MARK_ACK');
    await stub.waitForConnection();

    const sentAt = Date.now();
    for (let i = 0; i < 5; i++) stub.sendInboundFrame(inboundFramePayload());
    stub.sendMark('turn-1-25');

    const deadline = Date.now() + 1_000;
    let echo: Record<string, unknown> | undefined;
    while (!echo && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 10));
      echo = stub.recorded.find(
        (m) => m.event === 'mark' && (m.mark as { name?: string }).name === 'turn-1-25',
      );
    }
    const ackedAfterMs = Date.now() - sentAt;

    expect(echo).toBeDefined();
    expect((echo as { streamSid?: string }).streamSid).toMatch(/^MZ_TEST_CA_MARK_ACK_/);
    // Five 20 ms frames precede the mark: the ack waits out their playback.
    expect(ackedAfterMs).toBeGreaterThanOrEqual(90);
  });

  it('VQ2-006 — hangup() sends stop event and closes the socket', async () => {
    await emulator.start('CA_HANGUP');
    await stub.waitForConnection();
    await new Promise((r) => setTimeout(r, 20));

    await emulator.hangup();
    // Allow the close to propagate to the stub side.
    await new Promise((r) => setTimeout(r, 50));

    const stops = stub.recorded.filter((m) => m.event === 'stop');
    expect(stops).toHaveLength(1);
    expect((stops[0] as { streamSid?: string }).streamSid).toMatch(/^MZ_TEST_CA_HANGUP_/);
  });
});
