/**
 * P8-012 — TwilioMediaStreamAdapter unit tests.
 *
 * Drives the adapter with a hand-rolled WS-like double + a fake
 * Deepgram streaming provider, then asserts:
 *
 * 1. Twilio `start` → audio → Deepgram final → speechTurn dispatch →
 *    outbound `media` → `stop` lifecycle hits each expected hook.
 * 2. Barge-in (interim transcript during agent TTS) emits Twilio
 *    `clear` and aborts further outbound media.
 * 3. Tenant isolation — a CallSid that doesn't resolve to a session in
 *    the store closes the WS instead of attaching.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  TwilioMediaStreamAdapter,
  type WsLike,
} from '../../../src/telephony/media-streams/mediastream-adapter';
import { VoiceSessionStore } from '../../../src/ai/agents/customer-calling/voice-session-store';
import type {
  StreamingSession,
  StreamingTranscriptionProvider,
  StreamingTranscriptCallback,
} from '../../../src/voice/transcription-providers';
import type { TtsProvider, TtsSynthesizeResult } from '../../../src/ai/tts/tts-provider';
import type { SideEffect } from '../../../src/ai/agents/customer-calling/types';

// ─── Fakes ───────────────────────────────────────────────────────────────────

/**
 * Hand-rolled WS double. Captures every outbound message JSON envelope
 * and exposes a manual fire() for inbound frames. Behaves like the
 * subset of the `ws` API the adapter touches.
 */
class FakeWs implements WsLike {
  readonly sent: Array<Record<string, unknown>> = [];
  closed = false;
  readonly closeCode: number[] = [];
  private listeners: Record<string, Array<(...args: unknown[]) => void>> = {};

  send(data: string): void {
    if (this.closed) return;
    try {
      this.sent.push(JSON.parse(data));
    } catch {
      this.sent.push({ raw: data });
    }
  }

  close(code?: number, _reason?: string): void {
    this.closed = true;
    if (code) this.closeCode.push(code);
    this.fire('close');
  }

  on(event: string, listener: (...args: unknown[]) => void): void {
    (this.listeners[event] ??= []).push(listener);
  }

  fire(event: string, ...args: unknown[]): void {
    for (const listener of this.listeners[event] ?? []) listener(...args);
  }

  // Convenience for tests: send a JSON inbound "message" frame.
  inboundJson(envelope: Record<string, unknown>): void {
    this.fire('message', Buffer.from(JSON.stringify(envelope)));
  }
}

interface FakeStreamingHandle {
  send: ReturnType<typeof vi.fn>;
  finish: ReturnType<typeof vi.fn>;
  destroy: ReturnType<typeof vi.fn>;
  emit: StreamingTranscriptCallback;
}

function makeStreamingProvider(): { provider: StreamingTranscriptionProvider; handle: FakeStreamingHandle } {
  const handle: FakeStreamingHandle = {
    send: vi.fn(),
    finish: vi.fn(),
    destroy: vi.fn(),
    emit: () => {
      throw new Error('streamingProvider not opened yet');
    },
  };
  const provider: StreamingTranscriptionProvider = {
    async openSession(onEvent): Promise<StreamingSession> {
      handle.emit = onEvent;
      return {
        send: handle.send,
        finish: handle.finish,
        destroy: handle.destroy,
      };
    },
  };
  return { provider, handle };
}

function makeTtsProvider(audio: Buffer = Buffer.alloc(640)): TtsProvider {
  return {
    async synthesize(): Promise<TtsSynthesizeResult> {
      return { audio, contentType: 'audio/pcm', provider: 'fake' };
    },
  };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('P8-012 TwilioMediaStreamAdapter', () => {
  let store: VoiceSessionStore;

  beforeEach(() => {
    store = new VoiceSessionStore({ startInterval: false });
  });

  it('Twilio start with unknown CallSid closes the WS (tenant isolation)', async () => {
    const ws = new FakeWs();
    const { provider } = makeStreamingProvider();
    const adapter = new TwilioMediaStreamAdapter(
      {
        store,
        streamingProvider: provider,
        speechTurn: async () => [],
      },
      ws,
    );
    adapter.start();

    // No session in the store for this CallSid.
    ws.inboundJson({
      event: 'start',
      streamSid: 'MZ-unknown',
      start: { callSid: 'CA-unknown', accountSid: 'AC1', streamSid: 'MZ-unknown', tracks: ['inbound'] },
    });
    // Allow the async openSession path to settle.
    await new Promise((r) => setImmediate(r));
    expect(ws.closed).toBe(true);
    expect(ws.closeCode).toContain(1008);
  });

  it('Tenant A CallSid stream cannot resolve to Tenant B session', async () => {
    // Tenant A creates a session with one CallSid.
    const sessionA = store.create('tenant-A', 'telephony', { callSid: 'CA-A' });
    // Tenant B has its own session, different CallSid.
    store.create('tenant-B', 'telephony', { callSid: 'CA-B' });

    const ws = new FakeWs();
    const { provider } = makeStreamingProvider();
    const speechTurn = vi.fn().mockResolvedValue([] as SideEffect[]);
    const adapter = new TwilioMediaStreamAdapter(
      { store, streamingProvider: provider, speechTurn },
      ws,
    );
    adapter.start();

    ws.inboundJson({
      event: 'start',
      streamSid: 'MZ-A',
      start: { callSid: 'CA-A', accountSid: 'AC1', streamSid: 'MZ-A', tracks: ['inbound'] },
    });
    await new Promise((r) => setImmediate(r));

    // The adapter resolved to tenant A's session — verify by sending a
    // final transcript and inspecting the speechTurn call.
    const { handle } = (() => {
      // Reach into the adapter — easier: rerun with a captured handle.
      return { handle: null as never };
    })();
    void handle;

    // Re-build with a fresh handle so we can fire a transcript event.
    const wsA = new FakeWs();
    const { provider: providerA, handle: handleA } = makeStreamingProvider();
    const speechTurnA = vi.fn().mockResolvedValue([] as SideEffect[]);
    const adapterA = new TwilioMediaStreamAdapter(
      { store, streamingProvider: providerA, speechTurn: speechTurnA },
      wsA,
    );
    adapterA.start();
    wsA.inboundJson({
      event: 'start',
      streamSid: 'MZ-A',
      start: { callSid: 'CA-A', accountSid: 'AC1', streamSid: 'MZ-A', tracks: ['inbound'] },
    });
    await new Promise((r) => setImmediate(r));

    handleA.emit({ type: 'final', isFinal: true, transcript: 'hello', confidence: 0.95 });
    await new Promise((r) => setImmediate(r));

    expect(speechTurnA).toHaveBeenCalledTimes(1);
    const callArg = speechTurnA.mock.calls[0][0] as { session: { id: string; tenantId: string }; callSid: string; tenantId: string };
    expect(callArg.session.id).toBe(sessionA.id);
    expect(callArg.tenantId).toBe('tenant-A');
    // Critically not tenant-B.
    expect(callArg.tenantId).not.toBe('tenant-B');
  });

  it('start → media → final transcript drives speechTurn and emits outbound media', async () => {
    const session = store.create('tenant-X', 'telephony', { callSid: 'CA-2' });
    const ws = new FakeWs();
    const { provider, handle } = makeStreamingProvider();
    const speechTurn = vi.fn().mockResolvedValue([
      { type: 'tts_play', payload: { text: 'Hi there' } },
    ] as SideEffect[]);
    // 2 ms × 16 kHz × 2 bytes = 64 bytes; small fake TTS payload
    // exercises the framing loop without producing many frames.
    const ttsAudio = Buffer.alloc(640);
    const adapter = new TwilioMediaStreamAdapter(
      { store, streamingProvider: provider, ttsProvider: makeTtsProvider(ttsAudio), speechTurn },
      ws,
    );
    adapter.start();

    ws.inboundJson({
      event: 'start',
      streamSid: 'MZ-2',
      start: { callSid: 'CA-2', accountSid: 'AC', streamSid: 'MZ-2', tracks: ['inbound'] },
    });
    await new Promise((r) => setImmediate(r));

    // A media frame after start: payload is base64-encoded μ-law bytes.
    const muBytes = Buffer.from([0xff, 0x80, 0x7f, 0x00]);
    ws.inboundJson({
      event: 'media',
      streamSid: 'MZ-2',
      media: { track: 'inbound', chunk: '1', timestamp: '20', payload: muBytes.toString('base64') },
    });
    await new Promise((r) => setImmediate(r));
    expect(handle.send).toHaveBeenCalled(); // forwarded to Deepgram

    // Fire a final transcript → speechTurn → outbound media frames.
    handle.emit({ type: 'final', isFinal: true, transcript: 'order me a pizza', confidence: 0.97 });
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    expect(speechTurn).toHaveBeenCalledTimes(1);
    const speechArg = speechTurn.mock.calls[0][0] as { session: { id: string }; callSid: string; tenantId: string; speechResult: string };
    expect(speechArg.session.id).toBe(session.id);
    expect(speechArg.callSid).toBe('CA-2');
    expect(speechArg.tenantId).toBe('tenant-X');
    expect(speechArg.speechResult).toBe('order me a pizza');

    // Outbound `media` frames should have been pushed.
    const mediaOut = ws.sent.filter((m) => m.event === 'media');
    expect(mediaOut.length).toBeGreaterThan(0);
    expect(mediaOut[0].streamSid).toBe('MZ-2');
    // A trailing `mark` is emitted after the turn so Twilio can ack.
    const marks = ws.sent.filter((m) => m.event === 'mark');
    expect(marks.length).toBe(1);

    // Stop frame closes the adapter cleanly.
    ws.inboundJson({ event: 'stop', streamSid: 'MZ-2' });
    await new Promise((r) => setImmediate(r));
    expect(ws.closed).toBe(true);
    expect(handle.destroy).toHaveBeenCalled();
  });

  it('barge-in: interim transcript during agent TTS emits clear and stops outbound', async () => {
    store.create('t', 'telephony', { callSid: 'CA-3' });
    const ws = new FakeWs();
    const { provider, handle } = makeStreamingProvider();

    // TTS provider that sleeps to give us a window to fire an interim
    // transcript in the middle of the synth — that's the barge-in
    // window the adapter must guard against.
    let resolveSynth!: (audio: Buffer) => void;
    const synthPromise = new Promise<Buffer>((r) => { resolveSynth = r; });
    const slowTts: TtsProvider = {
      async synthesize() {
        const audio = await synthPromise;
        return { audio, contentType: 'audio/pcm', provider: 'slow-fake' };
      },
    };
    const speechTurn = vi.fn().mockResolvedValue([
      { type: 'tts_play', payload: { text: 'Long agent reply' } },
    ] as SideEffect[]);
    const adapter = new TwilioMediaStreamAdapter(
      { store, streamingProvider: provider, ttsProvider: slowTts, speechTurn },
      ws,
    );
    adapter.start();

    ws.inboundJson({
      event: 'start',
      streamSid: 'MZ-3',
      start: { callSid: 'CA-3', accountSid: 'AC', streamSid: 'MZ-3', tracks: ['inbound'] },
    });
    await new Promise((r) => setImmediate(r));

    // Final transcript triggers TTS synth (which is parked on synthPromise).
    handle.emit({ type: 'final', isFinal: true, transcript: 'hi', confidence: 0.95 });
    // Let speechTurn resolve so emitSideEffects starts awaiting tts.
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    expect(adapter._debugState().agentSpeaking).toBe(true);

    // Caller barges in.
    handle.emit({ type: 'partial', isFinal: false, transcript: 'wait', confidence: 0.7 });
    await new Promise((r) => setImmediate(r));

    // The adapter should have sent a `clear` to Twilio.
    const clears = ws.sent.filter((m) => m.event === 'clear');
    expect(clears.length).toBe(1);
    expect(clears[0].streamSid).toBe('MZ-3');
    expect(adapter._debugState().agentSpeaking).toBe(false);

    // Now resolve the synth — the late-arriving audio must NOT be
    // streamed (the outbound turn was aborted).
    resolveSynth(Buffer.alloc(2000));
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    const outboundMediaAfterBargeIn = ws.sent.filter((m) => m.event === 'media');
    expect(outboundMediaAfterBargeIn.length).toBe(0);
  });

  it('end_session side effect from speechTurn closes the WS', async () => {
    store.create('t', 'telephony', { callSid: 'CA-4' });
    const ws = new FakeWs();
    const { provider, handle } = makeStreamingProvider();
    const speechTurn = vi.fn().mockResolvedValue([
      { type: 'end_session', payload: { reason: 'normal_close' } },
    ] as SideEffect[]);
    const adapter = new TwilioMediaStreamAdapter(
      { store, streamingProvider: provider, speechTurn },
      ws,
    );
    adapter.start();
    ws.inboundJson({
      event: 'start',
      streamSid: 'MZ-4',
      start: { callSid: 'CA-4', accountSid: 'AC', streamSid: 'MZ-4', tracks: ['inbound'] },
    });
    await new Promise((r) => setImmediate(r));
    handle.emit({ type: 'final', isFinal: true, transcript: 'goodbye', confidence: 0.99 });
    await new Promise((r) => setImmediate(r));
    expect(ws.closed).toBe(true);
  });

  it('malformed inbound JSON is silently dropped', async () => {
    store.create('t', 'telephony', { callSid: 'CA-5' });
    const ws = new FakeWs();
    const { provider } = makeStreamingProvider();
    const adapter = new TwilioMediaStreamAdapter(
      { store, streamingProvider: provider, speechTurn: async () => [] },
      ws,
    );
    adapter.start();
    // Not JSON.
    ws.fire('message', Buffer.from('this is not json'));
    expect(ws.closed).toBe(false);
  });
});
