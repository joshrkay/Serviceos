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
import { VOICE_EVENT_CHANNEL } from '../../../src/ai/voice-quality/event-bus';

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

  function makeFakeFillerCache(ids: string[]): {
    get: (id: string) => Buffer | undefined;
    has: (id: string) => boolean;
    size: () => number;
  } {
    const m = new Map<string, Buffer>();
    for (const id of ids) m.set(id, Buffer.alloc(320));
    return {
      get: (id) => m.get(id),
      has: (id) => m.has(id),
      size: () => m.size,
    };
  }

  function setupAdapter(opts: {
    ttsProvider?: TtsProvider;
    streamingProvider?: StreamingTranscriptionProvider;
    terminologyProvider?: { getKeywords(tenantId: string): Promise<ReadonlyArray<string>> };
    fillerCache?: { get: (id: string) => Buffer | undefined; has?: (id: string) => boolean; size?: () => number };
    fillerEngine?: { selectNext(ctx?: { skipFillers?: boolean }): { id: string; text: string; approxDurationMs: number } | undefined };
    fillerDelayMs?: number;
    callSid?: string;
  } = {}): {
    adapter: TwilioMediaStreamAdapter;
    ws: FakeWs;
    streamingProviderHandle?: ReturnType<typeof makeStreamingProvider>['handle'];
  } {
    const callSid = opts.callSid ?? 'CA-stream';
    store.create('t', 'telephony', { callSid });
    const ws = new FakeWs();
    const { provider: defaultProvider, handle } = makeStreamingProvider();
    const adapter = new TwilioMediaStreamAdapter(
      {
        store,
        streamingProvider: opts.streamingProvider ?? defaultProvider,
        speechTurn: async () => [],
        ttsProvider: opts.ttsProvider,
        terminologyProvider: opts.terminologyProvider,
        fillerCache: opts.fillerCache,
        fillerEngine: opts.fillerEngine,
        fillerDelayMs: opts.fillerDelayMs,
      },
      ws,
    );
    adapter.start();
    return { adapter, ws, streamingProviderHandle: handle };
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

  it('passes vertical keywords to Deepgram openSession when terminologyProvider yields them', async () => {
    const openSessionSpy = vi.fn(async () => ({
      send: vi.fn(),
      finish: vi.fn(),
      destroy: vi.fn(),
    }));
    const streamingProvider = { openSession: openSessionSpy };
    const terminologyProvider = {
      getKeywords: vi.fn(async () => ['furnace:3', 'compressor:3']),
    };
    const { ws } = setupAdapter({
      streamingProvider,
      terminologyProvider,
    });
    ws.inboundJson({
      event: 'start',
      streamSid: 's1',
      start: {
        callSid: 'CA-stream',
        accountSid: 'a1',
        streamSid: 's1',
        tracks: ['inbound'],
      },
    });
    await flushMicrotasks();

    expect(terminologyProvider.getKeywords).toHaveBeenCalledWith(expect.any(String));
    expect(openSessionSpy).toHaveBeenCalled();
    const callArgs = openSessionSpy.mock.calls[0];
    // 5th argument should be { keywords: [...] }
    expect(callArgs[4]).toEqual({ keywords: ['furnace:3', 'compressor:3'] });
  });

  it('does not pass keywords to openSession when terminologyProvider returns empty', async () => {
    const openSessionSpy = vi.fn(async () => ({
      send: vi.fn(),
      finish: vi.fn(),
      destroy: vi.fn(),
    }));
    const streamingProvider = { openSession: openSessionSpy };
    const terminologyProvider = { getKeywords: vi.fn(async () => []) };
    const { ws } = setupAdapter({ streamingProvider, terminologyProvider });
    ws.inboundJson({
      event: 'start',
      streamSid: 's1',
      start: {
        callSid: 'CA-stream',
        accountSid: 'a1',
        streamSid: 's1',
        tracks: ['inbound'],
      },
    });
    await flushMicrotasks();

    expect(openSessionSpy).toHaveBeenCalled();
    // 5th arg should be undefined when keywords list is empty
    expect(openSessionSpy.mock.calls[0][4]).toBeUndefined();
  });

  // ─── Filler engine race tests ───────────────────────────────────────────────

  describe('mediastream-adapter filler engine', () => {
    it('plays a filler when TTS does not start within 250ms', async () => {
      // The TTS stream deliberately delays 400ms before yielding its first
      // chunk. The filler timer fires at 250ms (default) and should have
      // sent at least one media frame before the real TTS arrives.
      let ttsStarted = false;
      const slowStreamingProvider = {
        synthesize: vi.fn(),
        synthesizeStream: vi.fn(() => ({
          async *[Symbol.asyncIterator]() {
            await new Promise((r) => setTimeout(r, 400));
            ttsStarted = true;
            yield { pcm: Buffer.alloc(640), isFinal: true };
          },
        })),
      };
      const fillerCache = makeFakeFillerCache(['okay', 'got-it']);
      const fillerEngine = {
        selectNext: () => ({ id: 'okay', text: 'Okay.', approxDurationMs: 260 }),
      };
      const { adapter, ws } = setupAdapter({
        ttsProvider: slowStreamingProvider,
        fillerCache,
        fillerEngine,
        fillerDelayMs: 50, // use short delay to keep the test fast
        callSid: 'CA-filler-slow',
      });

      // Send start frame so streamSid is set.
      ws.inboundJson({
        event: 'start',
        streamSid: 'MZ-filler-slow',
        start: { callSid: 'CA-filler-slow', accountSid: 'AC', streamSid: 'MZ-filler-slow', tracks: ['inbound'] },
      });
      await new Promise((r) => setImmediate(r));

      // Drive a tts_play effect directly.
      const promise = (adapter as unknown as { emitSideEffects: (fx: unknown[]) => Promise<void> }).emitSideEffects([
        { type: 'tts_play', payload: { text: 'Long response...' } },
      ]);

      // Wait long enough for filler timer (50ms) but shorter than TTS delay (400ms).
      await new Promise((r) => setTimeout(r, 120));

      // Filler media frames should have been sent.
      const mediaFrames = ws.sent.filter((f) => (f as Record<string, unknown>).event === 'media');
      expect(mediaFrames.length).toBeGreaterThan(0);

      // Now let the whole thing complete.
      await promise;
      expect(ttsStarted).toBe(true);
    });

    it('does NOT play a filler when TTS starts within 250ms', async () => {
      const fastStreamingProvider = {
        synthesize: vi.fn(),
        synthesizeStream: vi.fn(() => ({
          async *[Symbol.asyncIterator]() {
            yield { pcm: Buffer.alloc(640), isFinal: false };
            yield { pcm: Buffer.alloc(640), isFinal: true };
          },
        })),
      };
      const fillerCache = makeFakeFillerCache(['okay']);
      let fillerFetched = false;
      const wrappedCache = {
        ...fillerCache,
        get: (id: string) => { fillerFetched = true; return fillerCache.get(id); },
        has: (id: string) => fillerCache.has(id),
        size: () => fillerCache.size(),
      };
      const fillerEngine = {
        selectNext: () => ({ id: 'okay', text: 'Okay.', approxDurationMs: 260 }),
      };
      const { adapter, ws } = setupAdapter({
        ttsProvider: fastStreamingProvider,
        fillerCache: wrappedCache,
        fillerEngine,
        fillerDelayMs: 200, // filler delay is 200ms but TTS yields immediately
        callSid: 'CA-filler-fast',
      });

      ws.inboundJson({
        event: 'start',
        streamSid: 'MZ-filler-fast',
        start: { callSid: 'CA-filler-fast', accountSid: 'AC', streamSid: 'MZ-filler-fast', tracks: ['inbound'] },
      });
      await new Promise((r) => setImmediate(r));

      await (adapter as unknown as { emitSideEffects: (fx: unknown[]) => Promise<void> }).emitSideEffects([
        { type: 'tts_play', payload: { text: 'Quick response' } },
      ]);

      // Give any pending timer callbacks a chance to fire (they shouldn't).
      await new Promise((r) => setTimeout(r, 10));

      // The filler cache.get should never have been called — real TTS was fast.
      expect(fillerFetched).toBe(false);
    });

    it('cancels the filler cleanly when the real response arrives mid-filler', async () => {
      // Filler with multiple chunks of audio (~640 bytes each) to simulate
      // a real filler clip mid-playback when the real TTS arrives.
      const fillerPcm = Buffer.alloc(640 * 5); // 5 frames worth
      const fillerCache = {
        get: (id: string) => (id === 'okay' || id === 'mm-hmm' ? fillerPcm : undefined),
        has: () => true,
        size: () => 8,
      };
      const fillerEngine = {
        selectNext: () => ({ id: 'okay', text: 'Okay.', approxDurationMs: 260 }),
      };

      // Real TTS provider: yields nothing for 100ms (filler fires at delayMs=50),
      // then yields a real chunk. Filler should be canceled mid-flight.
      const realTtsProvider = {
        synthesize: vi.fn(),
        synthesizeStream: vi.fn(() => ({
          async *[Symbol.asyncIterator]() {
            await new Promise((r) => setTimeout(r, 100));
            yield { pcm: Buffer.alloc(640), isFinal: false };
            yield { pcm: Buffer.alloc(640), isFinal: true };
          },
        })),
      };

      const fillerCancelled: string[] = [];
      const callSid = 'CA-filler-cancel';
      const { adapter, ws } = setupAdapter({
        ttsProvider: realTtsProvider,
        fillerEngine,
        fillerCache,
        fillerDelayMs: 50,
        callSid,
      });

      ws.inboundJson({
        event: 'start',
        streamSid: 's-cancel',
        start: { callSid, accountSid: 'a1', streamSid: 's-cancel', tracks: ['inbound'] },
      });
      await flushMicrotasks();

      // Subscribe to filler_cancelled events on this session.
      const session = store.findByCallSid(callSid);
      if (session) {
        session.events.on(VOICE_EVENT_CHANNEL, (evt: { type: string; fillerText?: string }) => {
          if (evt.type === 'filler_cancelled') fillerCancelled.push(evt.fillerText ?? '');
        });
      }

      const promise = (adapter as unknown as { emitSideEffects: (fx: unknown[]) => Promise<void> }).emitSideEffects([
        { type: 'tts_play', payload: { text: 'real response' } },
      ]);
      await promise;

      // After the turn completes: filler should have started and then been cancelled.
      expect(fillerCancelled.length).toBeGreaterThanOrEqual(1);
    });
  });

  it('streams outbound media as TTS chunks arrive (does not wait for full audio)', async () => {
    // Drive a fake streaming TTS provider that yields two chunks then closes.
    // The second chunk is delayed 50ms to allow us to assert mid-stream delivery
    // before it arrives.
    let secondChunkYielded = false;
    const streamingProvider = {
      synthesize: vi.fn(),
      synthesizeStream: vi.fn(() => ({
        async *[Symbol.asyncIterator]() {
          yield { pcm: Buffer.alloc(640), isFinal: false };
          await new Promise((r) => setTimeout(r, 50));
          secondChunkYielded = true;
          yield { pcm: Buffer.alloc(640), isFinal: true };
        },
      })),
    };

    const { adapter, ws } = setupAdapter({ ttsProvider: streamingProvider });
    ws.inboundJson({ event: 'start', streamSid: 's1', start: { callSid: 'CA-stream', accountSid: 'a1', streamSid: 's1', tracks: ['inbound'] } });
    await flushMicrotasks();

    // Start emitSideEffects WITHOUT awaiting so the stream runs concurrently.
    const promise = (adapter as unknown as { emitSideEffects: (fx: unknown[]) => Promise<void> }).emitSideEffects([
      { type: 'tts_play', payload: { text: 'hello world' } },
    ]);

    // Yield a couple microtask turns so the first chunk gets emitted, but
    // not long enough for the 50ms setTimeout in the generator to fire.
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    // First chunk should already be on the wire — proves mid-stream delivery, not buffering.
    expect(ws.sent.filter((f: unknown) => (f as { event?: string }).event === 'media').length).toBeGreaterThanOrEqual(1);
    // Second chunk should NOT have yielded yet — proves we're not buffering until the end.
    expect(secondChunkYielded).toBe(false);

    // Now let it complete.
    await promise;
    // After full await, both chunks have flowed.
    expect(secondChunkYielded).toBe(true);
    expect(streamingProvider.synthesizeStream).toHaveBeenCalledTimes(1);
  });
});
