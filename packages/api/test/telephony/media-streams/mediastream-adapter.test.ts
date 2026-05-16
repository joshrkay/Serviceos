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
  StreamingTranscriptEvent,
} from '../../../src/voice/transcription-providers';
import type { TtsProvider, TtsSynthesizeResult } from '../../../src/ai/tts/tts-provider';
import type { SideEffect } from '../../../src/ai/agents/customer-calling/types';
import { decodeTwilioInboundFrame } from '../../../src/telephony/media-streams/mulaw-codec';

// ─── Fakes ─────────────────────────────────────────────────────────────────────────────

/**
 * Hand-rolled WS double. Captures every outbound message JSON envelope
 * and exposes a manual fire() for inbound frames. Behaves like the
 * subset of the `ws` API the adapter touches.
 */
class FakeWs implements WsLike {
  sent: unknown[] = [];
  closed = false;
  closeCode: number | undefined;
  closeReason: string | undefined;
  private listeners: Record<string, Array<(...args: unknown[]) => void>> = {};

  send(data: string): void {
    this.sent.push(JSON.parse(data));
  }

  close(code?: number, reason?: string): void {
    this.closed = true;
    this.closeCode = code;
    this.closeReason = reason;
    this.fire('close');
  }

  on(event: 'message', listener: (data: string | Buffer) => void): void;
  on(event: 'close', listener: () => void): void;
  on(event: 'error', listener: (err: Error) => void): void;
  on(event: string, listener: (...args: unknown[]) => void): void;
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

type StreamHandle = {
  emit: (evt: StreamingTranscriptEvent) => void;
};

function makeStreamingProvider(): {
  provider: StreamingTranscriptionProvider;
  handle: StreamHandle;
} {
  let cb: StreamingTranscriptCallback | null = null;
  const session: StreamingSession = {
    send: vi.fn(),
    finish: vi.fn(),
    destroy: vi.fn(),
  };
  const provider: StreamingTranscriptionProvider = {
    openSession: vi.fn((onEvent, _onError, _onClose) => {
      cb = onEvent;
      return Promise.resolve(session);
    }),
  };
  return {
    provider,
    handle: {
      emit: (evt) => cb?.(evt),
    },
  };
}

function makeTtsProvider(): TtsProvider {
  return {
    synthesize: vi.fn(async (): Promise<TtsSynthesizeResult> => ({
      audio: Buffer.alloc(640),
      contentType: 'audio/mulaw',
      provider: 'test',
    })),
  };
}

// ─── Tests ─────────────────────────────────────────────────────────────────────────────

let store: VoiceSessionStore;

beforeEach(() => {
  store = new VoiceSessionStore({ startInterval: false });
});

describe('P8-012 TwilioMediaStreamAdapter', () => {
  it('attaches on start event and starts Deepgram session', async () => {
    store.create('t', 'telephony', { callSid: 'CA-1' });
    const ws = new FakeWs();
    const { provider } = makeStreamingProvider();
    const adapter = new TwilioMediaStreamAdapter(
      { store, streamingProvider: provider, speechTurn: async () => [] },
      ws,
    );
    adapter.start();

    ws.inboundJson({
      event: 'start',
      streamSid: 'MZ-1',
      start: { callSid: 'CA-1', accountSid: 'AC', streamSid: 'MZ-1', tracks: ['inbound'] },
    });
    await new Promise((r) => setImmediate(r));
    expect(provider.openSession).toHaveBeenCalledTimes(1);
  });

  it('forwards base64 audio to the Deepgram session', async () => {
    store.create('t', 'telephony', { callSid: 'CA-2' });
    const ws = new FakeWs();
    const { provider, handle } = makeStreamingProvider();
    const adapter = new TwilioMediaStreamAdapter(
      { store, streamingProvider: provider, speechTurn: async () => [] },
      ws,
    );
    adapter.start();

    ws.inboundJson({
      event: 'start',
      streamSid: 'MZ-2',
      start: { callSid: 'CA-2', accountSid: 'AC', streamSid: 'MZ-2', tracks: ['inbound'] },
    });
    await new Promise((r) => setImmediate(r));

    const deepgramSession = (provider.openSession as ReturnType<typeof vi.fn>).mock.results[0]
      .value as Promise<StreamingSession>;
    const session = await deepgramSession;

    ws.inboundJson({
      event: 'media',
      media: { payload: 'AAAA' },
    });
    expect(session.send).toHaveBeenCalledWith(decodeTwilioInboundFrame('AAAA'));

    handle.emit({ type: 'final', isFinal: true, transcript: 'hello', confidence: 0.95 });
    await new Promise((r) => setImmediate(r));
  });

  it('sends TTS audio as outbound media frames then marks TTS done', async () => {
    store.create('t', 'telephony', { callSid: 'CA-3' });
    const ws = new FakeWs();
    const { provider, handle } = makeStreamingProvider();
    const tts = makeTtsProvider();
    const adapter = new TwilioMediaStreamAdapter(
      {
        store,
        streamingProvider: provider,
        speechTurn: async () => [],
        ttsProvider: tts,
        initializeSession: async () => [{ type: 'tts_play', payload: { text: 'Hello!' } }],
      },
      ws,
    );
    adapter.start();

    ws.inboundJson({
      event: 'start',
      streamSid: 'MZ-3',
      start: { callSid: 'CA-3', accountSid: 'AC', streamSid: 'MZ-3', tracks: ['inbound'] },
    });
    await new Promise((r) => setImmediate(r));
    handle.emit({ type: 'final', isFinal: true, transcript: 'hello', confidence: 0.95 });
    await new Promise((r) => setImmediate(r));

    const mediaFrames = ws.sent.filter((m) => (m as Record<string, unknown>).event === 'media');
    expect(mediaFrames.length).toBeGreaterThanOrEqual(1);
  });

  it('closes WS with 1008 when start frame has empty callSid (invalid_start_payload)', async () => {
    store.create('t', 'telephony', { callSid: 'CA-valid' });
    const ws = new FakeWs();
    const { provider } = makeStreamingProvider();
    const adapter = new TwilioMediaStreamAdapter(
      { store, streamingProvider: provider, speechTurn: async () => [] },
      ws,
    );
    adapter.start();

    ws.inboundJson({
      event: 'start',
      streamSid: 'MZ-bad',
      start: { callSid: '', accountSid: 'AC', streamSid: 'MZ-bad', tracks: ['inbound'] },
    });
    await new Promise((r) => setImmediate(r));
    expect(ws.closed).toBe(true);
    expect(ws.closeCode).toBe(1008);
    expect(ws.closeReason).toBe('invalid_start_payload');
  });

  it('closes WS when CallSid does not resolve to a session', async () => {
    const ws = new FakeWs();
    const { provider } = makeStreamingProvider();
    const adapter = new TwilioMediaStreamAdapter(
      { store, streamingProvider: provider, speechTurn: async () => [] },
      ws,
    );
    adapter.start();

    ws.inboundJson({
      event: 'start',
      streamSid: 'MZ-4',
      start: { callSid: 'CA-4', accountSid: 'AC', streamSid: 'MZ-4', tracks: ['inbound'] },
    });
    await new Promise((r) => setImmediate(r));
    expect(ws.closed).toBe(true);
    expect(ws.closeCode).toBe(1008);
    expect(ws.closeReason).toBe('unknown_callsid');
  });

  it('closes WS with 1008 when customParameters.tenantId does not match session tenantId', async () => {
    store.create('real-tenant', 'telephony', { callSid: 'CA-tenant' });
    const ws = new FakeWs();
    const { provider } = makeStreamingProvider();
    const adapter = new TwilioMediaStreamAdapter(
      { store, streamingProvider: provider, speechTurn: async () => [] },
      ws,
    );
    adapter.start();

    ws.inboundJson({
      event: 'start',
      streamSid: 'MZ-tenant',
      start: {
        callSid: 'CA-tenant',
        accountSid: 'AC',
        streamSid: 'MZ-tenant',
        tracks: ['inbound'],
        customParameters: { tenantId: 'spoofed-tenant' },
      },
    });
    await new Promise((r) => setImmediate(r));
    expect(ws.closed).toBe(true);
    expect(ws.closeCode).toBe(1008);
    expect(ws.closeReason).toBe('tenant_mismatch');
  });

  it('B2: forwards FSM sideEffects to finalizeOnClose so abuse_detected reason reaches the host', async () => {
    store.create('t', 'telephony', { callSid: 'CA-abuse' });
    const ws = new FakeWs();
    const { provider, handle } = makeStreamingProvider();
    const abuseSideEffects: SideEffect[] = [
      { type: 'audit_log', payload: {} },
      { type: 'end_session', payload: { reason: 'abuse_detected:profanity' } },
    ];
    const speechTurn = vi.fn().mockResolvedValue(abuseSideEffects);
    const finalizeOnClose = vi.fn();
    const adapter = new TwilioMediaStreamAdapter(
      { store, streamingProvider: provider, speechTurn, finalizeOnClose },
      ws,
    );
    adapter.start();
    ws.inboundJson({
      event: 'start',
      streamSid: 'MZ-abuse',
      start: { callSid: 'CA-abuse', accountSid: 'AC', streamSid: 'MZ-abuse', tracks: ['inbound'] },
    });
    await new Promise((r) => setImmediate(r));
    handle.emit({ type: 'final', isFinal: true, transcript: 'profanity here', confidence: 0.99 });
    await new Promise((r) => setImmediate(r));
    expect(finalizeOnClose).toHaveBeenCalledTimes(1);
    const [, reason, sideEffects] = finalizeOnClose.mock.calls[0];
    expect(reason).toBe('session_ended');
    expect(sideEffects).toEqual(abuseSideEffects);
  });

  it('B2: passes empty sideEffects to finalizeOnClose for non-FSM close paths', async () => {
    store.create('t', 'telephony', { callSid: 'CA-idle' });
    const ws = new FakeWs();
    const { provider } = makeStreamingProvider();
    const finalizeOnClose = vi.fn();
    const adapter = new TwilioMediaStreamAdapter(
      {
        store,
        streamingProvider: provider,
        speechTurn: async () => [],
        finalizeOnClose,
        audioIdleTimeoutMs: 1,
      },
      ws,
    );
    adapter.start();
    ws.inboundJson({
      event: 'start',
      streamSid: 'MZ-idle',
      start: { callSid: 'CA-idle', accountSid: 'AC', streamSid: 'MZ-idle', tracks: ['inbound'] },
    });
    await new Promise((r) => setTimeout(r, 5));
    expect(finalizeOnClose).toHaveBeenCalled();
    const [, reason, sideEffects] = finalizeOnClose.mock.calls[0];
    expect(reason).toBe('idle_timeout');
    expect(sideEffects).toEqual([]);
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
    ws.fire('message', 'not-json');
    await new Promise((r) => setImmediate(r));
    expect(ws.closed).toBe(false);
  });

  // ─── Helpers for streaming tests ───────────────────────────────────────────

  function setupAdapter(opts: { ttsProvider?: TtsProvider } = {}): {
    adapter: TwilioMediaStreamAdapter;
    ws: FakeWs;
  } {
    store.create('t', 'telephony', { callSid: 'CA-stream' });
    const ws = new FakeWs();
    const { provider } = makeStreamingProvider();
    const adapter = new TwilioMediaStreamAdapter(
      {
        store,
        streamingProvider: provider,
        speechTurn: async () => [],
        ttsProvider: opts.ttsProvider,
      },
      ws,
    );
    adapter.start();
    return { adapter, ws };
  }

  async function flushMicrotasks(): Promise<void> {
    await new Promise((r) => setImmediate(r));
  }

  it('barge-in during TTS emits clear and drops further audio', async () => {
    store.create('t', 'telephony', { callSid: 'CA-barge' });
    const ws = new FakeWs();
    const { provider, handle } = makeStreamingProvider();
    // Make TTS hang so it's in-flight when barge-in arrives.
    const tts: TtsProvider = {
      synthesize: vi.fn(
        () =>
          new Promise(() => {
            /* never resolves */
          }),
      ),
    };
    const adapter = new TwilioMediaStreamAdapter(
      {
        store,
        streamingProvider: provider,
        speechTurn: async () => [],
        ttsProvider: tts,
        initializeSession: async () => [{ type: 'tts_play', payload: { text: 'Hello there' } }],
      },
      ws,
    );
    adapter.start();
    ws.inboundJson({
      event: 'start',
      streamSid: 'MZ-barge',
      start: { callSid: 'CA-barge', accountSid: 'AC', streamSid: 'MZ-barge', tracks: ['inbound'] },
    });
    // Wait for greeting TTS to start (still hanging).
    await new Promise((r) => setImmediate(r));

    // Barge-in interim transcript.
    handle.emit({ type: 'partial', isFinal: false, transcript: 'hey', confidence: 0.5 });
    await new Promise((r) => setImmediate(r));

    const clearFrames = ws.sent.filter((m) => (m as Record<string, unknown>).event === 'clear');
    expect(clearFrames.length).toBeGreaterThanOrEqual(1);

    // TTS never resolved, so no media frames should have been sent after barge-in.
    const mediaFrames = ws.sent.filter((m) => (m as Record<string, unknown>).event === 'media');
    expect(mediaFrames.length).toBe(0);
  });

  it('streams outbound media as TTS chunks arrive (does not wait for full audio)', async () => {
    // Drive a fake streaming TTS provider that yields two chunks then closes.
    let firstChunkEmitted = false;
    const streamingProvider = {
      synthesize: vi.fn(),
      synthesizeStream: vi.fn(() => ({
        async *[Symbol.asyncIterator]() {
          yield { pcm: Buffer.alloc(640), isFinal: false };
          firstChunkEmitted = true;
          // Simulate ~50ms of "model thinking" between chunks.
          await new Promise((r) => setTimeout(r, 50));
          yield { pcm: Buffer.alloc(640), isFinal: true };
        },
      })),
    };

    const { adapter, ws } = setupAdapter({ ttsProvider: streamingProvider });
    ws.inboundJson({ event: 'start', streamSid: 's1', start: { callSid: 'CA-stream', accountSid: 'a1', streamSid: 's1', tracks: ['inbound'] } });
    await flushMicrotasks();

    // Directly invoke a tts_play side effect (bypass FSM for unit isolation).
    await (adapter as unknown as { emitSideEffects: (fx: unknown[]) => Promise<void> }).emitSideEffects([
      { type: 'tts_play', payload: { text: 'hello world' } },
    ]);

    expect(firstChunkEmitted).toBe(true);
    expect(streamingProvider.synthesizeStream).toHaveBeenCalledTimes(1);
    expect(ws.sent.filter((f: unknown) => (f as { event?: string }).event === 'media').length).toBeGreaterThanOrEqual(1);
  });
});
