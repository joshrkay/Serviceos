/**
 * LCR-03 — one spoken sentence is one caller turn on a live realtime call.
 *
 * Production path (app.ts constructs `new DeepgramStreamingProvider(key)` and
 * hands it, unwrapped, to the media-streams adapter): Deepgram frames →
 * `DeepgramStreamingProvider.openSession` message listener → the adapter's
 * `onEvent` → `onTranscriptEvent` → (final) `speechTurn` under the session
 * lock → `twilioAdapter.processCallerUtterance` → the processor.
 *
 * With `interim_results=true`, Deepgram closes a segment mid-sentence
 * (`is_final:true, speech_final:false`) and only marks the end of the
 * caller's sentence with `speech_final:true` (or, when the endpoint is
 * missed, a separate `UtteranceEnd` frame). Before the fix every `is_final`
 * segment became its own caller turn, so "my furnace stopped" and "at 42 Elm
 * Street" were classified as two turns.
 *
 * Seams: the REAL provider over a local `ws` server (only the remote URL is
 * substituted, the node20-websocket pattern), alone and injected into the
 * adapter with a mocked `speechTurn`. The adapter test's fake provider is not
 * used: it bypasses the provider, so a test through it passes on main.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebSocketServer, type WebSocket as ServerSocket } from 'ws';
import type { AddressInfo } from 'net';

vi.mock('../../../src/analytics/posthog', () => ({ recordVoiceError: vi.fn() }));

import {
  DeepgramStreamingProvider,
  type StreamingTranscriptEvent,
} from '../../../src/voice/transcription-providers';
import {
  TwilioMediaStreamAdapter,
  type WsLike,
} from '../../../src/telephony/media-streams/mediastream-adapter';
import { VoiceSessionStore } from '../../../src/ai/agents/customer-calling/voice-session-store';
import type { SideEffect } from '../../../src/ai/agents/customer-calling/types';

// ─── Deepgram frames (the shapes Deepgram's live API sends) ─────────────────

function results(
  transcript: string,
  flags: { is_final: boolean; speech_final?: boolean; confidence?: number },
): string {
  return JSON.stringify({
    type: 'Results',
    is_final: flags.is_final,
    speech_final: flags.speech_final ?? false,
    channel: { alternatives: [{ transcript, confidence: flags.confidence ?? 0.95 }] },
  });
}

function utteranceEnd(): string {
  return JSON.stringify({ type: 'UtteranceEnd', channel: [0, 1], last_word_end: 2.4 });
}

class FakeTwilioWs implements WsLike {
  sent: Array<Record<string, unknown>> = [];
  closed = false;
  private listeners: Record<string, Array<(...args: unknown[]) => void>> = {};
  send(data: string): void {
    this.sent.push(JSON.parse(data) as Record<string, unknown>);
  }
  close(): void {
    this.closed = true;
    this.fire('close');
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  on(event: string, listener: (...args: any[]) => void): void {
    (this.listeners[event] ??= []).push(listener);
  }
  fire(event: string, ...args: unknown[]): void {
    for (const l of this.listeners[event] ?? []) l(...args);
  }
  inboundJson(obj: unknown): void {
    this.fire('message', JSON.stringify(obj));
  }
}

let server: WebSocketServer;
let baseUrl: string;
let deepgramSide: Promise<ServerSocket>;
const received: string[] = [];

beforeEach(async () => {
  // The deployed image is Node 20 (no global WebSocket): exercise the `ws` path.
  vi.stubGlobal('WebSocket', undefined);
  received.length = 0;
  server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await new Promise<void>((resolve) => server.once('listening', resolve));
  baseUrl = `ws://127.0.0.1:${(server.address() as AddressInfo).port}`;
  deepgramSide = new Promise<ServerSocket>((resolve) => {
    server.once('connection', (socket) => {
      socket.on('message', (data, isBinary) => {
        if (!isBinary) received.push(String(data));
      });
      resolve(socket);
    });
  });
});

afterEach(async () => {
  for (const client of server.clients) client.terminate();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function realProvider(): DeepgramStreamingProvider {
  const provider = new DeepgramStreamingProvider('fixture-key');
  // Substitute only the remote endpoint; everything else is the real provider.
  vi.spyOn(provider as unknown as { buildWsUrl(): string }, 'buildWsUrl').mockReturnValue(
    `${baseUrl}/v1/listen?model=nova-3`,
  );
  return provider;
}

async function openRealSession() {
  const provider = realProvider();
  const events: StreamingTranscriptEvent[] = [];
  const onClose = vi.fn();
  const session = await provider.openSession((e) => events.push(e), vi.fn(), onClose);
  const socket = await deepgramSide;
  return { session, socket, events, onClose };
}

/** A sentinel interim the server sends last: once it arrives, every earlier frame has too. */
async function drain(socket: ServerSocket, events: StreamingTranscriptEvent[]): Promise<void> {
  socket.send(results('zzsentinel', { is_final: false }));
  await vi.waitFor(() => expect(events.some((e) => e.transcript.includes('zzsentinel'))).toBe(true));
}

const finals = (events: StreamingTranscriptEvent[]) => events.filter((e) => e.type === 'final');

describe('LCR-03 — Deepgram provider: one final per caller sentence', () => {
  it('joins is_final segments and emits ONE final when speech_final arrives', async () => {
    const { session, socket, events } = await openRealSession();
    socket.send(results('my furnace stopped', { is_final: true, speech_final: false, confidence: 0.97 }));
    socket.send(results('at 42 Elm Street', { is_final: true, speech_final: true, confidence: 0.88 }));
    await drain(socket, events);

    expect(finals(events)).toEqual([
      {
        type: 'final',
        transcript: 'my furnace stopped at 42 Elm Street',
        // The weakest segment decides, so the low-confidence gate stays conservative.
        confidence: 0.88,
        isFinal: true,
      },
    ]);
    session.destroy();
  });

  it("flushes on Deepgram's empty speech_final endpoint frame", async () => {
    const { session, socket, events } = await openRealSession();
    socket.send(results('the water heater is leaking', { is_final: true, speech_final: false }));
    socket.send(results('', { is_final: true, speech_final: true }));
    await drain(socket, events);

    expect(finals(events).map((e) => e.transcript)).toEqual(['the water heater is leaking']);
    session.destroy();
  });

  it('UtteranceEnd flushes segments that never got a speech_final', async () => {
    const { session, socket, events } = await openRealSession();
    socket.send(results('I need someone', { is_final: true, speech_final: false }));
    socket.send(results('out here tomorrow', { is_final: true, speech_final: false }));
    expect(finals(events)).toEqual([]);
    socket.send(utteranceEnd());
    // An UtteranceEnd after the buffer is already empty is a no-op.
    socket.send(utteranceEnd());
    await drain(socket, events);

    expect(finals(events).map((e) => e.transcript)).toEqual(['I need someone out here tomorrow']);
    session.destroy();
  });

  it('forwards buffered segments as partials carrying the whole sentence so far', async () => {
    const { session, socket, events } = await openRealSession();
    socket.send(results('I smell', { is_final: true, speech_final: false }));
    socket.send(results('gas in the', { is_final: false }));
    socket.send(results('gas in the basement', { is_final: true, speech_final: false }));
    await drain(socket, events);

    const partials = events.filter((e) => e.type === 'partial' && !e.transcript.includes('zzsentinel'));
    expect(partials.map((e) => e.transcript)).toEqual([
      'I smell',
      'I smell gas in the',
      'I smell gas in the basement',
    ]);
    expect(partials.every((e) => e.isFinal === false)).toBe(true);
    // Barge-in and the interim emergency scan run on partials; no turn yet.
    expect(finals(events)).toEqual([]);
    session.destroy();
  });

  it('emits nothing after finish(): a half-heard sentence is never dispatched after teardown', async () => {
    const { session, socket, events, onClose } = await openRealSession();
    socket.send(results('my furnace stopped', { is_final: true, speech_final: false }));
    await vi.waitFor(() => expect(events).toHaveLength(1));

    // Deepgram answers CloseStream with its remaining results, then closes.
    socket.on('message', (data, isBinary) => {
      if (isBinary || JSON.parse(String(data)).type !== 'CloseStream') return;
      socket.send(results('at 42 Elm Street', { is_final: true, speech_final: true }));
      socket.send(utteranceEnd());
      socket.close();
    });
    session.finish();
    await vi.waitFor(() => expect(onClose).toHaveBeenCalled());

    expect(received.map((m) => JSON.parse(m).type)).toContain('CloseStream');
    expect(events).toHaveLength(1);
    expect(finals(events)).toEqual([]);
  });
});

describe('LCR-03 — media-streams adapter with the real Deepgram provider', () => {
  async function startCall() {
    const store = new VoiceSessionStore({ startInterval: false });
    store.create('tenant-lcr03', 'telephony', { callSid: 'CA-lcr03' });
    const speechTurn = vi.fn(async (): Promise<SideEffect[]> => []);
    const ws = new FakeTwilioWs();
    const adapter = new TwilioMediaStreamAdapter(
      { store, streamingProvider: realProvider(), speechTurn },
      ws,
    );
    adapter.start();
    ws.inboundJson({
      event: 'start',
      streamSid: 'MZ-lcr03',
      start: { callSid: 'CA-lcr03', accountSid: 'AC', streamSid: 'MZ-lcr03', tracks: ['inbound'] },
    });
    const socket = await deepgramSide;
    // Let the adapter finish attaching the session before Deepgram talks.
    await new Promise((r) => setTimeout(r, 20));
    return { speechTurn, ws, socket };
  }

  it('a sentence Deepgram finalizes in two segments reaches speechTurn once, whole', async () => {
    const { speechTurn, ws, socket } = await startCall();
    socket.send(results('my furnace stopped', { is_final: true, speech_final: false }));
    socket.send(results('at 42 Elm Street', { is_final: true, speech_final: true }));
    socket.send(utteranceEnd());

    await vi.waitFor(() => expect(speechTurn).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 50));
    expect(speechTurn).toHaveBeenCalledTimes(1);
    expect(speechTurn.mock.calls[0][0]).toMatchObject({
      speechResult: 'my furnace stopped at 42 Elm Street',
      callSid: 'CA-lcr03',
      tenantId: 'tenant-lcr03',
    });
    ws.inboundJson({ event: 'stop' });
  });

  it('a sentence cut off by the caller hanging up is not dispatched as a turn', async () => {
    const { speechTurn, ws, socket } = await startCall();
    socket.on('message', (data, isBinary) => {
      if (isBinary || JSON.parse(String(data)).type !== 'CloseStream') return;
      socket.send(results('at 42 Elm Street', { is_final: true, speech_final: true }));
      socket.close();
    });
    socket.send(results('my furnace stopped', { is_final: true, speech_final: false }));
    await new Promise((r) => setTimeout(r, 30));

    ws.inboundJson({ event: 'stop' });
    await vi.waitFor(() => expect(received.map((m) => JSON.parse(m).type)).toContain('CloseStream'));
    await new Promise((r) => setTimeout(r, 50));
    expect(speechTurn).not.toHaveBeenCalled();
  });
});
