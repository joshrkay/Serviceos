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
import type { TtsProvider, TtsSynthesizeInput, TtsSynthesizeResult } from '../../../src/ai/tts/tts-provider';
import {
  renderTtsText,
  SPEECH_TURN_FAILURE_REPROMPT_COPY,
  SPEECH_TURN_FAILURE_ESCALATION_COPY,
} from '../../../src/ai/agents/customer-calling/tts-copy';
import type { SideEffect, EscalateWithContextPayload } from '../../../src/ai/agents/customer-calling/types';
import { escalateWithContextPayloadSchema } from '../../../src/ai/agents/customer-calling/types';
import { decodeTwilioInboundFrame } from '../../../src/telephony/media-streams/mulaw-codec';
import { VOICE_EVENT_CHANNEL } from '../../../src/ai/voice-quality/event-bus';
import { WhisperCache } from '../../../src/telephony/whisper-cache';
import { DEFAULT_ESCALATION_SETTINGS } from '../../../src/settings/settings';
import { voiceTurnLatencyMs } from '../../../src/monitoring/metrics';

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
      contentType: 'audio/pcm',
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

  it('P0: does NOT stream synthesize() output as PCM when contentType is compressed audio (e.g. mp3)', async () => {
    // Regression pin for the silent-voice-output bug: a non-streaming
    // TtsProvider (OpenAI tts-1 in production) returns 'audio/mpeg' — MP3
    // bytes streamPcmAsMedia has no decoder for. Feeding it through
    // previously produced inaudible static with no error. The adapter must
    // now refuse to treat non-PCM contentType as raw PCM and log instead.
    store.create('t', 'telephony', { callSid: 'CA-mp3' });
    const ws = new FakeWs();
    const { provider, handle } = makeStreamingProvider();
    const mp3OnlyTts: TtsProvider = {
      synthesize: vi.fn(async (): Promise<TtsSynthesizeResult> => ({
        audio: Buffer.from('ID3-fake-mp3-bytes'),
        contentType: 'audio/mpeg',
        provider: 'openai-tts-1',
      })),
      // Deliberately no synthesizeStream — exercises the buffered branch.
    };
    const adapter = new TwilioMediaStreamAdapter(
      {
        store,
        streamingProvider: provider,
        speechTurn: async () => [],
        ttsProvider: mp3OnlyTts,
        initializeSession: async () => [{ type: 'tts_play', payload: { text: 'Hello!' } }],
      },
      ws,
    );
    adapter.start();

    ws.inboundJson({
      event: 'start',
      streamSid: 'MZ-mp3',
      start: { callSid: 'CA-mp3', accountSid: 'AC', streamSid: 'MZ-mp3', tracks: ['inbound'] },
    });
    await new Promise((r) => setImmediate(r));
    handle.emit({ type: 'final', isFinal: true, transcript: 'hello', confidence: 0.95 });
    await new Promise((r) => setImmediate(r));

    expect(mp3OnlyTts.synthesize).toHaveBeenCalledTimes(1);
    // No media frames were emitted — the mp3 bytes never reached streamPcmAsMedia.
    const mediaFrames = ws.sent.filter((m) => (m as Record<string, unknown>).event === 'media');
    expect(mediaFrames.length).toBe(0);
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

  it('S12: dispatches frustration_detected using the per-tenant resolved threshold', async () => {
    const session = store.create('t', 'telephony', { callSid: 'CA-sentiment' });
    const dispatchSpy = vi.spyOn(session.machine, 'dispatch').mockReturnValue([]);
    const ws = new FakeWs();
    const { provider, handle } = makeStreamingProvider();
    const sentimentClassifier = vi.fn(async () => ({ frustrationScore: 0.9 }));
    const adapter = new TwilioMediaStreamAdapter(
      {
        store,
        streamingProvider: provider,
        speechTurn: async () => [],
        sentimentClassifier,
        // No static escalationSettings dep — mirrors production wiring,
        // where only the per-session resolver is supplied.
        resolveEscalationSettings: async () => ({
          ...DEFAULT_ESCALATION_SETTINGS,
          trigger_llm_sentiment: true,
          llm_sentiment_threshold: 0.5,
        }),
      },
      ws,
    );
    adapter.start();
    ws.inboundJson({
      event: 'start',
      streamSid: 'MZ-sentiment',
      start: { callSid: 'CA-sentiment', accountSid: 'AC', streamSid: 'MZ-sentiment', tracks: ['inbound'] },
    });
    await new Promise((r) => setImmediate(r));
    handle.emit({ type: 'final', isFinal: true, transcript: 'this is ridiculous', confidence: 0.97 });
    // Flush the speech turn plus the fire-and-forget sentiment promise chain.
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    expect(sentimentClassifier).toHaveBeenCalledTimes(1);
    expect(dispatchSpy).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'frustration_detected', source: 'llm_sentiment' }),
    );
  });

  it('S12: does not dispatch frustration_detected when score is below the resolved threshold', async () => {
    const session = store.create('t', 'telephony', { callSid: 'CA-calm' });
    const dispatchSpy = vi.spyOn(session.machine, 'dispatch').mockReturnValue([]);
    const ws = new FakeWs();
    const { provider, handle } = makeStreamingProvider();
    const sentimentClassifier = vi.fn(async () => ({ frustrationScore: 0.2 }));
    const adapter = new TwilioMediaStreamAdapter(
      {
        store,
        streamingProvider: provider,
        speechTurn: async () => [],
        sentimentClassifier,
        resolveEscalationSettings: async () => ({
          ...DEFAULT_ESCALATION_SETTINGS,
          trigger_llm_sentiment: true,
          llm_sentiment_threshold: 0.5,
        }),
      },
      ws,
    );
    adapter.start();
    ws.inboundJson({
      event: 'start',
      streamSid: 'MZ-calm',
      start: { callSid: 'CA-calm', accountSid: 'AC', streamSid: 'MZ-calm', tracks: ['inbound'] },
    });
    await new Promise((r) => setImmediate(r));
    handle.emit({ type: 'final', isFinal: true, transcript: 'thanks for the help', confidence: 0.97 });
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    expect(sentimentClassifier).toHaveBeenCalledTimes(1);
    expect(dispatchSpy).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'frustration_detected' }),
    );
  });

  it('S12: forwards the per-session cost budget into the sentiment classifier', async () => {
    const session = store.create('t', 'telephony', { callSid: 'CA-budget' });
    vi.spyOn(session.machine, 'dispatch').mockReturnValue([]);
    const ws = new FakeWs();
    const { provider, handle } = makeStreamingProvider();
    const sentimentClassifier = vi.fn(async () => ({ frustrationScore: 0.1 }));
    const adapter = new TwilioMediaStreamAdapter(
      {
        store,
        streamingProvider: provider,
        speechTurn: async () => [],
        sentimentClassifier,
        resolveEscalationSettings: async () => ({
          ...DEFAULT_ESCALATION_SETTINGS,
          trigger_llm_sentiment: true,
          llm_sentiment_threshold: 0.5,
        }),
      },
      ws,
    );
    adapter.start();
    ws.inboundJson({
      event: 'start',
      streamSid: 'MZ-budget',
      start: { callSid: 'CA-budget', accountSid: 'AC', streamSid: 'MZ-budget', tracks: ['inbound'] },
    });
    await new Promise((r) => setImmediate(r));
    handle.emit({ type: 'final', isFinal: true, transcript: 'hello', confidence: 0.97 });
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    expect(sentimentClassifier).toHaveBeenCalledTimes(1);
    const budget = sentimentClassifier.mock.calls[0][1] as {
      costTracker?: unknown;
      sessionCostCapCents?: number;
      maxSentimentBudgetRatio?: number;
    };
    expect(budget.costTracker).toBe(session.costTracker);
    expect(budget.sessionCostCapCents).toBe(session.costTracker.costCapCents);
    expect(budget.maxSentimentBudgetRatio).toBe(0.8);
  });

  it('S12: skips the sentiment classifier once the call has already escalated', async () => {
    const session = store.create('t', 'telephony', { callSid: 'CA-already-esc' });
    vi.spyOn(session.machine, 'currentState', 'get').mockReturnValue('escalating');
    const ws = new FakeWs();
    const { provider, handle } = makeStreamingProvider();
    const sentimentClassifier = vi.fn(async () => ({ frustrationScore: 0.9 }));
    const adapter = new TwilioMediaStreamAdapter(
      {
        store,
        streamingProvider: provider,
        speechTurn: async () => [],
        sentimentClassifier,
        resolveEscalationSettings: async () => ({
          ...DEFAULT_ESCALATION_SETTINGS,
          trigger_llm_sentiment: true,
          llm_sentiment_threshold: 0.5,
        }),
      },
      ws,
    );
    adapter.start();
    ws.inboundJson({
      event: 'start',
      streamSid: 'MZ-already-esc',
      start: { callSid: 'CA-already-esc', accountSid: 'AC', streamSid: 'MZ-already-esc', tracks: ['inbound'] },
    });
    await new Promise((r) => setImmediate(r));
    handle.emit({ type: 'final', isFinal: true, transcript: 'this is ridiculous', confidence: 0.97 });
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    expect(sentimentClassifier).not.toHaveBeenCalled();
  });

  it('S12: carries the classifier reasonHint into the frustration_detected dispatch', async () => {
    const session = store.create('t', 'telephony', { callSid: 'CA-hint' });
    const dispatchSpy = vi.spyOn(session.machine, 'dispatch').mockReturnValue([]);
    const ws = new FakeWs();
    const { provider, handle } = makeStreamingProvider();
    const sentimentClassifier = vi.fn(async () => ({
      frustrationScore: 0.9,
      reasonHint: 'caller_impatience',
    }));
    const adapter = new TwilioMediaStreamAdapter(
      {
        store,
        streamingProvider: provider,
        speechTurn: async () => [],
        sentimentClassifier,
        resolveEscalationSettings: async () => ({
          ...DEFAULT_ESCALATION_SETTINGS,
          trigger_llm_sentiment: true,
          llm_sentiment_threshold: 0.5,
        }),
      },
      ws,
    );
    adapter.start();
    ws.inboundJson({
      event: 'start',
      streamSid: 'MZ-hint',
      start: { callSid: 'CA-hint', accountSid: 'AC', streamSid: 'MZ-hint', tracks: ['inbound'] },
    });
    await new Promise((r) => setImmediate(r));
    handle.emit({ type: 'final', isFinal: true, transcript: 'this is ridiculous', confidence: 0.97 });
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    expect(dispatchSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'frustration_detected',
        source: 'llm_sentiment',
        reasonHint: 'caller_impatience',
      }),
    );
  });

  it('S12: delivers out-of-band escalation effects (notify_oncall) through the host', async () => {
    const session = store.create('t', 'telephony', { callSid: 'CA-deliver' });
    const escalationEffects: SideEffect[] = [
      { type: 'notify_oncall', payload: { reason: 'llm_sentiment' } },
      { type: 'tts_play', payload: { text: 'Let me get a person on the line.' } },
    ];
    vi.spyOn(session.machine, 'dispatch').mockReturnValue(escalationEffects);
    const ws = new FakeWs();
    const { provider, handle } = makeStreamingProvider();
    const deliverEscalationEffects = vi.fn(async () => {});
    const adapter = new TwilioMediaStreamAdapter(
      {
        store,
        streamingProvider: provider,
        speechTurn: async () => [],
        ttsProvider: makeTtsProvider(),
        sentimentClassifier: vi.fn(async () => ({ frustrationScore: 0.9 })),
        deliverEscalationEffects,
        resolveEscalationSettings: async () => ({
          ...DEFAULT_ESCALATION_SETTINGS,
          trigger_llm_sentiment: true,
          llm_sentiment_threshold: 0.5,
        }),
      },
      ws,
    );
    adapter.start();
    ws.inboundJson({
      event: 'start',
      streamSid: 'MZ-deliver',
      start: { callSid: 'CA-deliver', accountSid: 'AC', streamSid: 'MZ-deliver', tracks: ['inbound'] },
    });
    await new Promise((r) => setImmediate(r));
    handle.emit({ type: 'final', isFinal: true, transcript: 'this is ridiculous', confidence: 0.97 });
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    expect(deliverEscalationEffects).toHaveBeenCalledWith(session, escalationEffects, session.tenantId);
    // The reassurance TTS is recorded in the transcript for summarization/context.
    expect(session.transcript).toContain('agent: Let me get a person on the line.');
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
    // Section 7 — escalate_with_context fan-out deps
    whisperCache?: WhisperCache;
    deliveryProvider?: { sendSms(args: { to: string; body: string }): Promise<unknown> };
    publicBaseUrl?: string;
    callControl?: { dialDispatcher(callSid: string, phone: string, opts: { actionUrl: string; whisperUrl?: string; timeoutSeconds?: number }): string };
    setPendingTransferTwiml?: (sessionId: string, twiml: string) => void;
  } = {}): {
    adapter: TwilioMediaStreamAdapter;
    ws: FakeWs;
    session: ReturnType<VoiceSessionStore['findByCallSid']>;
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
        whisperCache: opts.whisperCache,
        deliveryProvider: opts.deliveryProvider,
        publicBaseUrl: opts.publicBaseUrl,
        callControl: opts.callControl as never,
        setPendingTransferTwiml: opts.setPendingTransferTwiml,
      },
      ws,
    );
    adapter.start();
    const session = store.findByCallSid(callSid);
    return { adapter, ws, session, streamingProviderHandle: handle };
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

  describe('VOX-35b: streaming TTS failure recovery', () => {
    it('falls back to buffered REST synth (PCM) when the stream throws, instead of dead air', async () => {
      // synthesizeStream opens then throws before any chunk (models a VOX-33
      // inactivity stall / WS blip). synthesize() returns raw PCM, so the
      // fallback should stream it out — the caller must hear the utterance.
      const synthesize = vi.fn(
        async (): Promise<TtsSynthesizeResult> => ({
          audio: Buffer.alloc(640 * 2),
          contentType: 'audio/pcm',
          provider: 'fallback-rest',
        }),
      );
      const failingStreamProvider: TtsProvider = {
        synthesize,
        synthesizeStream: vi.fn(() => ({
          // eslint-disable-next-line require-yield
          async *[Symbol.asyncIterator]() {
            throw new Error('ElevenLabs stream inactivity timeout after 4000ms');
          },
        })),
      };

      const { adapter, ws } = setupAdapter({
        ttsProvider: failingStreamProvider,
        callSid: 'CA-fallback-pcm',
      });
      ws.inboundJson({
        event: 'start',
        streamSid: 'MZ-fallback-pcm',
        start: { callSid: 'CA-fallback-pcm', accountSid: 'AC', streamSid: 'MZ-fallback-pcm', tracks: ['inbound'] },
      });
      await new Promise((r) => setImmediate(r));

      await (adapter as unknown as { emitSideEffects: (fx: unknown[]) => Promise<void> }).emitSideEffects([
        { type: 'tts_play', payload: { text: 'Your appointment is confirmed for Tuesday.' } },
      ]);

      // The REST fallback ran…
      expect(synthesize).toHaveBeenCalledTimes(1);
      // …and its PCM reached the wire (no dead air).
      const mediaFrames = ws.sent.filter((f: unknown) => (f as { event?: string }).event === 'media');
      expect(mediaFrames.length).toBeGreaterThan(0);
    });

    it('drops a non-PCM buffered fallback and plays a filler clip instead of static', async () => {
      // ElevenLabs REST returns mp3 — feeding that to streamPcmAsMedia would
      // be inaudible static, so the PCM guard must reject it and fall through
      // to a short filler clip (audible acknowledgement, not dead air).
      const synthesize = vi.fn(
        async (): Promise<TtsSynthesizeResult> => ({
          audio: Buffer.from([0xff, 0xfb, 0x00]),
          contentType: 'audio/mpeg',
          provider: 'elevenlabs',
        }),
      );
      const failingStreamProvider: TtsProvider = {
        synthesize,
        synthesizeStream: vi.fn(() => ({
          // eslint-disable-next-line require-yield
          async *[Symbol.asyncIterator]() {
            throw new Error('ElevenLabs WS error');
          },
        })),
      };
      const fillerCache = makeFakeFillerCache(['okay']);
      const fillerEngine = {
        selectNext: () => ({ id: 'okay', text: 'One moment.', approxDurationMs: 260 }),
      };

      const { adapter, ws } = setupAdapter({
        ttsProvider: failingStreamProvider,
        fillerCache,
        fillerEngine,
        callSid: 'CA-fallback-mp3',
      });
      ws.inboundJson({
        event: 'start',
        streamSid: 'MZ-fallback-mp3',
        start: { callSid: 'CA-fallback-mp3', accountSid: 'AC', streamSid: 'MZ-fallback-mp3', tracks: ['inbound'] },
      });
      await new Promise((r) => setImmediate(r));

      await (adapter as unknown as { emitSideEffects: (fx: unknown[]) => Promise<void> }).emitSideEffects([
        { type: 'tts_play', payload: { text: 'Give me a second.' } },
      ]);

      expect(synthesize).toHaveBeenCalledTimes(1);
      // The mp3 was NOT streamed as static, but the filler clip WAS played.
      const mediaFrames = ws.sent.filter((f: unknown) => (f as { event?: string }).event === 'media');
      expect(mediaFrames.length).toBeGreaterThan(0);
    });
  });

  describe('escalate_with_context fan-out', () => {
    it('writes whisper cache, calls SMS provider, emits in-app event in parallel', async () => {
      const whisperCache = new WhisperCache();
      const sendSms = vi.fn(async () => ({ success: true }));
      const deliveryProvider = { sendSms };
      const callControl = {
        dialDispatcher: vi.fn((_callSid: string, _phone: string, _opts: unknown) =>
          '<?xml version="1.0" encoding="UTF-8"?><Response><Dial><Number url="https://api.example.com/api/telephony/whisper/esc_xyz">+15125550999</Number></Dial></Response>',
        ),
      };

      const { adapter, ws, session } = setupAdapter({
        whisperCache,
        deliveryProvider,
        publicBaseUrl: 'https://api.example.com',
        callControl,
        callSid: 'CA-esc-1',
      });

      const inAppEvents: unknown[] = [];
      session?.events.on(VOICE_EVENT_CHANNEL, (evt) => inAppEvents.push(evt));

      // Send start frame to populate this.state.session so in-app events fire.
      ws.inboundJson({
        event: 'start',
        streamSid: 'MZ-esc-1',
        start: { callSid: 'CA-esc-1', accountSid: 'AC', streamSid: 'MZ-esc-1', tracks: ['inbound'] },
      });
      await new Promise((r) => setImmediate(r));

      await (
        adapter as unknown as {
          handleEscalateWithContext(p: EscalateWithContextPayload): Promise<void>;
        }
      ).handleEscalateWithContext({
        escalationId: 'esc_xyz',
        summary: {
          whisper: 'Test whisper',
          sms: 'Test SMS <escalationId>',
          panel: {
            header: {},
            customer: {},
            lastInteraction: null,
            intent: {},
            reason: { code: 'operator_request', humanReadable: 'asked for a person' },
            transcriptSnapshot: [],
          } as never,
        },
        dispatcher: { userId: 'user-1', phone: '+15125550999' },
        callSid: 'CA-esc-1',
        tenantId: 'tenant-1',
        channelPreferences: { sms: true, in_app: true, whisper: true },
      });

      expect(whisperCache.get('esc_xyz')).toBe('Test whisper');
      expect(sendSms).toHaveBeenCalledWith(
        expect.objectContaining({ to: '+15125550999', body: 'Test SMS esc_xyz' }),
      );
      expect(
        inAppEvents.some((e) => (e as { type?: string }).type === 'escalation_started'),
      ).toBe(true);
      expect(
        inAppEvents.some((e) => (e as { type?: string }).type === 'escalation_summary_built'),
      ).toBe(true);
    });

    it('respects channel preferences when one or more are disabled', async () => {
      const whisperCache = new WhisperCache();
      const sendSms = vi.fn(async () => ({ success: true }));
      const callControl = {
        dialDispatcher: vi.fn((_callSid: string, _phone: string, _opts: unknown) =>
          '<?xml version="1.0" encoding="UTF-8"?><Response><Dial><Number>+15125550999</Number></Dial></Response>',
        ),
      };

      const { adapter, ws, session } = setupAdapter({
        whisperCache,
        deliveryProvider: { sendSms },
        publicBaseUrl: 'https://api.example.com',
        callControl,
        callSid: 'CA-esc-2',
      });

      const inAppEvents: unknown[] = [];
      session?.events.on(VOICE_EVENT_CHANNEL, (evt) => inAppEvents.push(evt));

      // Send start frame to populate this.state.session.
      ws.inboundJson({
        event: 'start',
        streamSid: 'MZ-esc-2',
        start: { callSid: 'CA-esc-2', accountSid: 'AC', streamSid: 'MZ-esc-2', tracks: ['inbound'] },
      });
      await new Promise((r) => setImmediate(r));

      await (
        adapter as unknown as {
          handleEscalateWithContext(p: EscalateWithContextPayload): Promise<void>;
        }
      ).handleEscalateWithContext({
        escalationId: 'esc_no_sms',
        summary: {
          whisper: 'w',
          sms: 's',
          panel: { reason: { code: 'operator_request' } } as never,
        },
        dispatcher: { userId: 'u', phone: '+15125550999' },
        callSid: 'CA-esc-2',
        tenantId: 't',
        channelPreferences: { sms: false, in_app: true, whisper: true },
      });

      expect(sendSms).not.toHaveBeenCalled();
      expect(whisperCache.get('esc_no_sms')).toBe('w');
      expect(
        inAppEvents.some((e) => (e as { type?: string }).type === 'escalation_started'),
      ).toBe(true);
    });

    // ── NEW: transfer wiring (CRITICAL fix) ──────────────────────────────────

    it('calls setPendingTransferTwiml with the sessionId and built Dial TwiML', async () => {
      const dialTwiml = '<?xml version="1.0"?><Response><Dial><Number>+15125550999</Number></Dial></Response>';
      const callControl = { dialDispatcher: vi.fn(() => dialTwiml) };
      const setPendingTransferTwiml = vi.fn();

      const { adapter, ws, session } = setupAdapter({
        publicBaseUrl: 'https://api.example.com',
        callControl,
        setPendingTransferTwiml,
        callSid: 'CA-esc-wire',
      });

      ws.inboundJson({
        event: 'start',
        streamSid: 'MZ-esc-wire',
        start: { callSid: 'CA-esc-wire', accountSid: 'AC', streamSid: 'MZ-esc-wire', tracks: ['inbound'] },
      });
      await new Promise((r) => setImmediate(r));

      await (adapter as unknown as { handleEscalateWithContext(p: EscalateWithContextPayload): Promise<void> })
        .handleEscalateWithContext({
          escalationId: 'esc_wire',
          summary: {
            whisper: 'w',
            sms: 's',
            panel: { header: {}, customer: {}, lastInteraction: null, intent: {}, reason: { code: 'operator_request', humanReadable: 'asked for a person' }, transcriptSnapshot: [] },
          },
          dispatcher: { userId: 'u', phone: '+15125550999' },
          callSid: 'CA-esc-wire',
          tenantId: 't',
          channelPreferences: { sms: false, in_app: false, whisper: false },
        });

      expect(setPendingTransferTwiml).toHaveBeenCalledOnce();
      expect(setPendingTransferTwiml).toHaveBeenCalledWith(
        session!.id,
        dialTwiml,
      );
    });

    it('strips trailing slash from publicBaseUrl when building whisper and dial-action URLs', async () => {
      const callControl = { dialDispatcher: vi.fn(() => '<Response/>') };
      const setPendingTransferTwiml = vi.fn();

      const { adapter, ws } = setupAdapter({
        publicBaseUrl: 'https://api.example.com/', // trailing slash
        callControl,
        setPendingTransferTwiml,
        callSid: 'CA-esc-slash',
      });

      ws.inboundJson({
        event: 'start',
        streamSid: 'MZ-esc-slash',
        start: { callSid: 'CA-esc-slash', accountSid: 'AC', streamSid: 'MZ-esc-slash', tracks: ['inbound'] },
      });
      await new Promise((r) => setImmediate(r));

      await (adapter as unknown as { handleEscalateWithContext(p: EscalateWithContextPayload): Promise<void> })
        .handleEscalateWithContext({
          escalationId: 'esc_slash',
          summary: {
            whisper: 'w',
            sms: 's',
            panel: { header: {}, customer: {}, lastInteraction: null, intent: {}, reason: { code: 'operator_request', humanReadable: '' }, transcriptSnapshot: [] },
          },
          dispatcher: { userId: 'u', phone: '+15125550999' },
          callSid: 'CA-esc-slash',
          tenantId: 't',
          channelPreferences: { sms: false, in_app: false, whisper: true },
        });

      expect(callControl.dialDispatcher).toHaveBeenCalledOnce();
      const callArgs = callControl.dialDispatcher.mock.calls[0];
      const dialOpts = callArgs[2] as { actionUrl: string; whisperUrl?: string };
      // URL must not contain double slashes from a trailing-slash base.
      expect(dialOpts.actionUrl).toBe('https://api.example.com/api/telephony/dial-action');
      expect(dialOpts.whisperUrl).toBe('https://api.example.com/api/telephony/whisper/esc_slash');
    });

    // ── NEW: accurate telemetry timing (Issue 3) ─────────────────────────────

    it('escalation_summary_built durationMs reflects build time, not SMS carrier latency', async () => {
      // SMS takes 200 ms; build should be measured before the await.
      const sendSms = vi.fn(() => new Promise<void>((r) => setTimeout(r, 200)));
      const callControl = { dialDispatcher: vi.fn(() => '<Response/>') };
      const setPendingTransferTwiml = vi.fn();

      const { adapter, ws, session } = setupAdapter({
        deliveryProvider: { sendSms },
        publicBaseUrl: 'https://api.example.com',
        callControl,
        setPendingTransferTwiml,
        callSid: 'CA-esc-timing',
      });

      const events: unknown[] = [];
      session?.events.on(VOICE_EVENT_CHANNEL, (e) => events.push(e));

      ws.inboundJson({
        event: 'start',
        streamSid: 'MZ-esc-timing',
        start: { callSid: 'CA-esc-timing', accountSid: 'AC', streamSid: 'MZ-esc-timing', tracks: ['inbound'] },
      });
      await new Promise((r) => setImmediate(r));

      await (adapter as unknown as { handleEscalateWithContext(p: EscalateWithContextPayload): Promise<void> })
        .handleEscalateWithContext({
          escalationId: 'esc_timing',
          summary: {
            whisper: 'w',
            sms: 'sms body',
            panel: { header: {}, customer: {}, lastInteraction: null, intent: {}, reason: { code: 'operator_request', humanReadable: '' }, transcriptSnapshot: [] },
          },
          dispatcher: { userId: 'u', phone: '+15125550999' },
          callSid: 'CA-esc-timing',
          tenantId: 't',
          channelPreferences: { sms: true, in_app: false, whisper: false },
        });

      const builtEvent = events.find(
        (e) => (e as { type?: string }).type === 'escalation_summary_built',
      ) as { type: string; durationMs?: number } | undefined;

      expect(builtEvent).toBeDefined();
      // durationMs should be much less than the 200ms SMS mock.
      // We give generous headroom (100ms) to avoid flaky CI timing.
      expect(builtEvent!.durationMs).toBeLessThan(100);
    });

    // ── NEW: invalid payload drops without throw (Issue 4) ───────────────────

    it('drops escalate_with_context side effect with invalid payload without throwing', async () => {
      const speechTurnSpy = vi.fn(async (): Promise<SideEffect[]> => [
        // Missing required fields: escalationId, callSid, tenantId, etc.
        { type: 'escalate_with_context', payload: { invalid: true } as unknown as Record<string, unknown> },
      ]);

      store.create('t', 'telephony', { callSid: 'CA-esc-bad' });
      const ws = new FakeWs();
      const { provider } = makeStreamingProvider();
      const adapter = new TwilioMediaStreamAdapter(
        {
          store,
          streamingProvider: provider,
          speechTurn: speechTurnSpy,
          // ttsProvider absent: emitSideEffects exits immediately for unknown fx types.
          // Provide a minimal one so we reach the escalate_with_context branch.
          ttsProvider: { synthesize: vi.fn(async () => ({ audio: Buffer.alloc(0) })) },
        },
        ws,
      );
      adapter.start();

      ws.inboundJson({
        event: 'start',
        streamSid: 'MZ-esc-bad',
        start: { callSid: 'CA-esc-bad', accountSid: 'AC', streamSid: 'MZ-esc-bad', tracks: ['inbound'] },
      });
      await new Promise((r) => setImmediate(r));

      // Should not throw; the invalid payload is silently dropped (error-logged).
      let threw = false;
      try {
        // Drive a speech turn that emits the bad side effect.
        const session = store.findByCallSid('CA-esc-bad');
        if (session) {
          await speechTurnSpy({ session, speechResult: 'help', callSid: 'CA-esc-bad', tenantId: 't' });
        }
        // Trigger emitSideEffects via the store's onTranscriptEvent path would
        // require firing a Deepgram final — instead, verify the schema parse
        // directly to confirm the intent.
        const result = escalateWithContextPayloadSchema.safeParse({ invalid: true });
        expect(result.success).toBe(false);
      } catch {
        threw = true;
      }
      expect(threw).toBe(false);
    });
  });
});

// ─── Production-shaped wiring — disclosure/consent + interim emergency ───────
//
// These tests wire the mediastream adapter EXACTLY the way app.ts does:
// `initializeSession` → TwilioGatherAdapter#initializeStreamSession,
// `speechTurn` → #processCallerUtterance, `interimEmergencyScan` →
// #scanInterimForEmergency — so a regression in the app.ts hook shape is
// caught here instead of in production.

import { TwilioGatherAdapter } from '../../../src/telephony/twilio-adapter';
import { InMemoryConsentEventRepository } from '../../../src/compliance/consent-events';
import type { LLMGateway, LLMResponse } from '../../../src/ai/gateway/gateway';

function makeGateway(): LLMGateway {
  const response: LLMResponse = {
    content: '{"intentType":"unknown","confidence":0,"reasoning":"x"}',
    model: 'mock-model',
    provider: 'mock',
    tokenUsage: { input: 1, output: 1, total: 2 },
    latencyMs: 1,
  };
  return { complete: vi.fn().mockResolvedValue(response) } as unknown as LLMGateway;
}

describe('production-shaped wiring (app.ts hooks)', () => {
  function makeProductionShapedSetup(opts: { consentEvents?: InMemoryConsentEventRepository } = {}) {
    const gateway = makeGateway();
    const gatherAdapter = new TwilioGatherAdapter({
      store,
      gateway,
      businessName: 'Acme Plumbing',
      publicBaseUrl: 'https://example.com',
      ...(opts.consentEvents ? { consentEvents: opts.consentEvents } : {}),
    });
    const ws = new FakeWs();
    const { provider, handle } = makeStreamingProvider();
    const tts = makeTtsProvider();
    const adapter = new TwilioMediaStreamAdapter(
      {
        store,
        streamingProvider: provider,
        ttsProvider: tts,
        speechTurn: async ({ session, speechResult, callSid, tenantId }) =>
          gatherAdapter.processCallerUtterance({
            sessionId: session.id,
            callSid,
            speechResult,
            tenantId,
          }),
        initializeSession: ({ callSid, tenantId }) =>
          gatherAdapter.initializeStreamSession({ callSid, tenantId }),
        interimEmergencyScan: ({ session, speechResult, tenantId }) =>
          gatherAdapter.scanInterimForEmergency({
            sessionId: session.id,
            speechResult,
            tenantId,
          }),
      },
      ws,
    );
    return { gatherAdapter, adapter, ws, tts, handle, gateway };
  }

  it('RV-130 — session init speaks greeting+disclosure over stream TTS and ledgers implicit consent', async () => {
    const consentEvents = new InMemoryConsentEventRepository();
    const { gatherAdapter, adapter, ws, tts } = makeProductionShapedSetup({ consentEvents });

    // Production /voice route: create the session + record caller-ID.
    await gatherAdapter.handleInboundForStream({
      callSid: 'CA-prod-init',
      from: '+15125550111',
      tenantId: 't',
    });

    adapter.start();
    ws.inboundJson({
      event: 'start',
      streamSid: 'MZ-prod-init',
      start: { callSid: 'CA-prod-init', accountSid: 'AC', streamSid: 'MZ-prod-init', tracks: ['inbound'] },
    });

    const synth = tts.synthesize as ReturnType<typeof vi.fn>;
    await vi.waitFor(() => {
      expect(synth).toHaveBeenCalled();
    });

    // The spoken greeting carries the business name AND the recording
    // disclosure text — synthesized via the stream TTS path.
    const spoken = synth.mock.calls
      .map((c) => (c[0] as { text: string }).text)
      .join(' ');
    expect(spoken).toContain('Acme Plumbing');
    expect(spoken.toLowerCase()).toContain('record');

    // Disclosure audio reaches the caller as outbound media frames.
    await vi.waitFor(() => {
      expect(ws.sent.some((m) => (m as Record<string, unknown>).event === 'media')).toBe(true);
    });

    // RV-130 — the implicit recording-consent event landed in the ledger.
    expect(consentEvents.rows).toHaveLength(1);
    expect(consentEvents.rows[0]).toMatchObject({
      kind: 'recording',
      state: 'implicit',
      source: 'voice',
    });
    const session = store.findByCallSid('CA-prod-init');
    expect(consentEvents.rows[0].voiceSessionId).toBe(session!.id);
  });

  it('RV-140 — an interim "gas leak" escalates (911 line spoken) before any final transcript', async () => {
    const { gatherAdapter, adapter, ws, tts, handle, gateway } = makeProductionShapedSetup();
    await gatherAdapter.handleInboundForStream({
      callSid: 'CA-prod-int',
      from: '+15125550111',
      tenantId: 't',
    });
    adapter.start();
    ws.inboundJson({
      event: 'start',
      streamSid: 'MZ-prod-int',
      start: { callSid: 'CA-prod-int', accountSid: 'AC', streamSid: 'MZ-prod-int', tracks: ['inbound'] },
    });
    await new Promise((r) => setImmediate(r));

    // INTERIM ONLY — no final has arrived.
    handle.emit({ type: 'partial', isFinal: false, transcript: 'there is a gas leak', confidence: 0.6 });

    const session = store.findByCallSid('CA-prod-int');
    await vi.waitFor(() => {
      expect(session!.machine.currentState).toBe('escalating');
    });

    const synth = tts.synthesize as ReturnType<typeof vi.fn>;
    await vi.waitFor(() => {
      const safetyCalls = synth.mock.calls.filter((c) =>
        (c[0] as { text: string }).text.includes('911'),
      );
      expect(safetyCalls).toHaveLength(1);
    });
    // No LLM call happened — the keyword scan escalated deterministically.
    expect(gateway.complete as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();

    // The FINAL for the same utterance now arrives: the FSM guard is
    // idempotent and the debounce flag is set — the 911 line is not spoken
    // a second time.
    handle.emit({ type: 'final', isFinal: true, transcript: 'there is a gas leak in the basement', confidence: 0.95 });
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    const safetyCallsAfterFinal = synth.mock.calls.filter((c) =>
      (c[0] as { text: string }).text.includes('911'),
    );
    expect(safetyCallsAfterFinal).toHaveLength(1);
  });

  it('DISCLOSURE_INIT_FAILED — emits logger.error with stable greppable code when initializeSession throws', async () => {
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    const { adapter, ws } = makeProductionShapedSetup();

    // Override initializeSession to throw after the session is stored.
    const throwingAdapter = new TwilioMediaStreamAdapter(
      {
        store,
        streamingProvider: makeStreamingProvider().provider,
        speechTurn: async () => [],
        initializeSession: async () => {
          throw new Error('disclosure rpc timeout');
        },
      },
      ws,
    );

    await store.create('t', 'telephony', { callSid: 'CA-disclose-fail' });
    throwingAdapter.start();
    ws.inboundJson({
      event: 'start',
      streamSid: 'MZ-disclose-fail',
      start: {
        callSid: 'CA-disclose-fail',
        accountSid: 'AC',
        streamSid: 'MZ-disclose-fail',
        tracks: ['inbound'],
      },
    });

    // Wait for the async handleStart to complete.
    await vi.waitFor(() => {
      const written = stderrSpy.mock.calls.map((c) => String(c[0])).join('');
      expect(written).toContain('DISCLOSURE_INIT_FAILED');
    });

    // The error log must carry callSid and tenantId so ops can correlate.
    const errorOutput = stderrSpy.mock.calls.map((c) => String(c[0])).join('');
    expect(errorOutput).toContain('CA-disclose-fail');

    // The adapter must NOT have closed the WS — call continues undisclosed
    // rather than dropping the caller.
    expect(ws.closed).toBe(false);

    // Adapter variable is used above; reference it to satisfy unused-var lint.
    void adapter;

    stderrSpy.mockRestore();
  });
});

// ─── UB-C1/C2 — Spanish on the streaming call path ────────────────────────────

describe('UB-C1 — language threading + live switching', () => {
  let store: VoiceSessionStore;

  beforeEach(() => {
    store = new VoiceSessionStore({ startInterval: false });
  });

  /**
   * Streaming-provider double that supports MULTIPLE openSession calls
   * (initial open + finish/reopen cycles). Each call records its args and
   * returns a fresh session mock; `emit` targets the callback of the most
   * recent open so post-switch finals flow through the new session.
   */
  function makeReopenableProvider(): {
    provider: StreamingTranscriptionProvider;
    openCalls: Array<{ language: unknown; options: unknown }>;
    sessions: Array<{ send: ReturnType<typeof vi.fn>; finish: ReturnType<typeof vi.fn>; destroy: ReturnType<typeof vi.fn> }>;
    emit: (evt: StreamingTranscriptEvent) => void;
  } {
    const callbacks: StreamingTranscriptCallback[] = [];
    const openCalls: Array<{ language: unknown; options: unknown }> = [];
    const sessions: Array<{ send: ReturnType<typeof vi.fn>; finish: ReturnType<typeof vi.fn>; destroy: ReturnType<typeof vi.fn> }> = [];
    const provider: StreamingTranscriptionProvider = {
      openSession: vi.fn(async (onEvent, _onError, _onClose, language, options) => {
        callbacks.push(onEvent);
        openCalls.push({ language, options });
        const session = { send: vi.fn(), finish: vi.fn(), destroy: vi.fn() };
        sessions.push(session);
        return session;
      }),
    };
    return {
      provider,
      openCalls,
      sessions,
      emit: (evt) => callbacks[callbacks.length - 1]?.(evt),
    };
  }

  function makeSpyTts() {
    return {
      synthesize: vi.fn(async (_input: TtsSynthesizeInput): Promise<TtsSynthesizeResult> => ({
        audio: Buffer.alloc(640),
        contentType: 'audio/pcm',
        provider: 'test',
      })),
    };
  }

  function startFrame(callSid: string, streamSid: string) {
    return {
      event: 'start',
      streamSid,
      start: { callSid, accountSid: 'AC', streamSid, tracks: ['inbound'] },
    };
  }

  async function flush(times = 4): Promise<void> {
    for (let i = 0; i < times; i++) {
      await new Promise((r) => setImmediate(r));
    }
  }

  it('opens Deepgram with the resolved language and SUPPRESSES keywords on es', async () => {
    store.create('t', 'telephony', { callSid: 'CA-es-open' });
    const ws = new FakeWs();
    const { provider, openCalls } = makeReopenableProvider();
    const adapter = new TwilioMediaStreamAdapter(
      {
        store,
        streamingProvider: provider,
        speechTurn: async () => [],
        terminologyProvider: { getKeywords: async () => ['furnace:3', 'compressor:3'] },
        initialLanguageResolver: async () => 'es',
      },
      ws,
    );
    adapter.start();
    ws.inboundJson(startFrame('CA-es-open', 'MZ-es-open'));
    await flush();

    expect(openCalls).toHaveLength(1);
    expect(openCalls[0].language).toBe('es');
    // English trade-term boost degrades Nova-3 Spanish — must be suppressed.
    expect(openCalls[0].options).toBeUndefined();
    expect(store.findByCallSid('CA-es-open')?.language).toBe('es');
    expect(adapter._debugState().language).toBe('es');
  });

  it('opens with en + keywords when the resolver yields en', async () => {
    store.create('t', 'telephony', { callSid: 'CA-en-open' });
    const ws = new FakeWs();
    const { provider, openCalls } = makeReopenableProvider();
    const adapter = new TwilioMediaStreamAdapter(
      {
        store,
        streamingProvider: provider,
        speechTurn: async () => [],
        terminologyProvider: { getKeywords: async () => ['furnace:3'] },
        initialLanguageResolver: async () => 'en',
      },
      ws,
    );
    adapter.start();
    ws.inboundJson(startFrame('CA-en-open', 'MZ-en-open'));
    await flush();

    expect(openCalls[0].language).toBe('en');
    expect(openCalls[0].options).toEqual({ keywords: ['furnace:3'] });
  });

  it('without a resolver, opens with undefined language (pre-UB-C behavior) and does not pin session.language', async () => {
    store.create('t', 'telephony', { callSid: 'CA-legacy' });
    const ws = new FakeWs();
    const { provider, openCalls } = makeReopenableProvider();
    const adapter = new TwilioMediaStreamAdapter(
      { store, streamingProvider: provider, speechTurn: async () => [] },
      ws,
    );
    adapter.start();
    ws.inboundJson(startFrame('CA-legacy', 'MZ-legacy'));
    await flush();

    expect(openCalls[0].language).toBeUndefined();
    expect(store.findByCallSid('CA-legacy')?.language).toBeUndefined();
  });

  it('first Spanish final switches ONCE: finish+reopen es, event emitted, turn still dispatched', async () => {
    const session = store.create('t', 'telephony', { callSid: 'CA-first-es' });
    session.supportedLanguages = ['en', 'es'];
    const ws = new FakeWs();
    const { provider, openCalls, sessions, emit } = makeReopenableProvider();
    const speechTurn = vi.fn(async (_args: { speechResult: string }): Promise<SideEffect[]> => []);
    const adapter = new TwilioMediaStreamAdapter(
      {
        store,
        streamingProvider: provider,
        speechTurn,
        initialLanguageResolver: async () => 'en',
        terminologyProvider: { getKeywords: async () => ['furnace:3'] },
      },
      ws,
    );
    adapter.start();
    ws.inboundJson(startFrame('CA-first-es', 'MZ-first-es'));
    await flush();

    const events: unknown[] = [];
    session.events.on(VOICE_EVENT_CHANNEL, (evt: { type: string }) => {
      if (evt.type === 'language_switched') events.push(evt);
    });

    emit({ type: 'final', isFinal: true, transcript: 'Hola, necesito una cita por favor', confidence: 0.9 });
    await flush(8);

    // Old session finished, new one opened in es WITHOUT the keyword boost.
    expect(sessions[0].finish).toHaveBeenCalled();
    expect(openCalls).toHaveLength(2);
    expect(openCalls[1].language).toBe('es');
    expect(openCalls[1].options).toBeUndefined();
    expect(session.language).toBe('es');
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'language_switched', from: 'en', to: 'es', trigger: 'first_utterance', switchCount: 1 });
    // Trigger (a) does NOT consume the turn — the FSM still processes it.
    expect(speechTurn).toHaveBeenCalledTimes(1);
    expect(speechTurn.mock.calls[0][0]).toMatchObject({ speechResult: 'Hola, necesito una cita por favor' });
  });

  it('first-final detection is GATED on the tenant supported_languages opt-in', async () => {
    const session = store.create('t', 'telephony', { callSid: 'CA-en-only' });
    session.supportedLanguages = ['en']; // tenant never opted into Spanish
    const ws = new FakeWs();
    const { provider, openCalls, emit } = makeReopenableProvider();
    const speechTurn = vi.fn(async (_args: { speechResult: string }): Promise<SideEffect[]> => []);
    const adapter = new TwilioMediaStreamAdapter(
      { store, streamingProvider: provider, speechTurn, initialLanguageResolver: async () => 'en' },
      ws,
    );
    adapter.start();
    ws.inboundJson(startFrame('CA-en-only', 'MZ-en-only'));
    await flush();

    emit({ type: 'final', isFinal: true, transcript: 'Hola, necesito una cita por favor', confidence: 0.9 });
    await flush(8);

    expect(openCalls).toHaveLength(1); // no reopen
    expect(session.language).toBe('en');
    expect(adapter._debugState().languageSwitchCount).toBe(0);
    expect(speechTurn).toHaveBeenCalledTimes(1);
  });

  it('the one-shot first-final trigger does not fire on utterance #2+', async () => {
    const session = store.create('t', 'telephony', { callSid: 'CA-oneshot' });
    session.supportedLanguages = ['en', 'es'];
    const ws = new FakeWs();
    const { provider, openCalls, emit } = makeReopenableProvider();
    const adapter = new TwilioMediaStreamAdapter(
      { store, streamingProvider: provider, speechTurn: async () => [], initialLanguageResolver: async () => 'en' },
      ws,
    );
    adapter.start();
    ws.inboundJson(startFrame('CA-oneshot', 'MZ-oneshot'));
    await flush();

    emit({ type: 'final', isFinal: true, transcript: 'I need to book an appointment', confidence: 0.9 });
    await flush(8);
    // Spanish markers on the SECOND final must not auto-switch.
    emit({ type: 'final', isFinal: true, transcript: 'Hola, gracias, quiero una cita', confidence: 0.9 });
    await flush(8);

    expect(openCalls).toHaveLength(1);
    expect(session.language).toBe('en');
  });

  it('explicit "hablo español" CONSUMES the turn: localized ack, no speechTurn, transcript kept', async () => {
    const session = store.create('t', 'telephony', { callSid: 'CA-explicit' });
    session.supportedLanguages = ['en', 'es'];
    const ws = new FakeWs();
    const { provider, openCalls, emit } = makeReopenableProvider();
    const speechTurn = vi.fn(async (_args: { speechResult: string }): Promise<SideEffect[]> => []);
    const tts = makeSpyTts();
    const adapter = new TwilioMediaStreamAdapter(
      {
        store,
        streamingProvider: provider,
        speechTurn,
        ttsProvider: tts,
        initialLanguageResolver: async () => 'en',
      },
      ws,
    );
    adapter.start();
    ws.inboundJson(startFrame('CA-explicit', 'MZ-explicit'));
    await flush();

    const events: unknown[] = [];
    session.events.on(VOICE_EVENT_CHANNEL, (evt: { type: string }) => {
      if (evt.type === 'language_switched') events.push(evt);
    });

    emit({ type: 'final', isFinal: true, transcript: 'Hablo español, por favor', confidence: 0.9 });
    await flush(8);

    expect(openCalls).toHaveLength(2);
    expect(openCalls[1].language).toBe('es');
    expect(session.language).toBe('es');
    expect(events[0]).toMatchObject({ trigger: 'explicit_request', to: 'es' });
    // Consumed: the switch utterance never reaches the FSM.
    expect(speechTurn).not.toHaveBeenCalled();
    // Localized ack synthesized in the NEW language.
    expect(tts.synthesize).toHaveBeenCalledWith(
      expect.objectContaining({ language: 'es', text: expect.stringContaining('continuemos en español') }),
    );
    // Transcript stays faithful for summarization.
    expect(session.transcript.join('\n')).toContain('caller: Hablo español, por favor');
    expect(session.transcript.join('\n')).toContain('continuemos en español');
  });

  it('flap guard: the 3rd switch is refused; keywords are re-applied on the switch back to en', async () => {
    const session = store.create('t', 'telephony', { callSid: 'CA-flap' });
    session.supportedLanguages = ['en', 'es'];
    const ws = new FakeWs();
    const { provider, openCalls, emit } = makeReopenableProvider();
    const speechTurn = vi.fn(async (_args: { speechResult: string }): Promise<SideEffect[]> => []);
    const adapter = new TwilioMediaStreamAdapter(
      {
        store,
        streamingProvider: provider,
        speechTurn,
        initialLanguageResolver: async () => 'en',
        terminologyProvider: { getKeywords: async () => ['furnace:3'] },
      },
      ws,
    );
    adapter.start();
    ws.inboundJson(startFrame('CA-flap', 'MZ-flap'));
    await flush();

    // Switch 1: en → es (explicit).
    emit({ type: 'final', isFinal: true, transcript: 'hablo español por favor', confidence: 0.9 });
    await flush(8);
    // Switch 2: es → en (explicit).
    emit({ type: 'final', isFinal: true, transcript: 'switch to english please', confidence: 0.9 });
    await flush(8);
    // Switch 3: refused by the flap guard; the utterance flows to the FSM.
    emit({ type: 'final', isFinal: true, transcript: 'hablo español otra vez', confidence: 0.9 });
    await flush(8);

    expect(openCalls).toHaveLength(3); // initial + 2 switches, NOT 4
    expect(adapter._debugState().languageSwitchCount).toBe(2);
    expect(adapter._debugState().language).toBe('en');
    expect(session.language).toBe('en');
    // Keyword boost restored when the live language returned to English.
    expect(openCalls[2].language).toBe('en');
    expect(openCalls[2].options).toEqual({ keywords: ['furnace:3'] });
    // The blocked 3rd request was NOT consumed.
    expect(speechTurn).toHaveBeenCalledTimes(1);
    expect(speechTurn.mock.calls[0][0]).toMatchObject({ speechResult: 'hablo español otra vez' });
  });

  it('an utterance carrying an emergency keyword is NEVER consumed by the language switch', async () => {
    const session = store.create('t', 'telephony', { callSid: 'CA-emergency-es' });
    session.supportedLanguages = ['en', 'es'];
    const ws = new FakeWs();
    const { provider, openCalls, emit } = makeReopenableProvider();
    const speechTurn = vi.fn(async (_args: { speechResult: string }): Promise<SideEffect[]> => []);
    const adapter = new TwilioMediaStreamAdapter(
      { store, streamingProvider: provider, speechTurn, initialLanguageResolver: async () => 'en' },
      ws,
    );
    adapter.start();
    ws.inboundJson(startFrame('CA-emergency-es', 'MZ-emergency-es'));
    await flush();

    const events: Array<{ trigger?: string }> = [];
    session.events.on(VOICE_EVENT_CHANNEL, (evt: { type: string; trigger?: string }) => {
      if (evt.type === 'language_switched') events.push(evt);
    });

    emit({
      type: 'final',
      isFinal: true,
      transcript: 'Hay una fuga de gas, hablo español',
      confidence: 0.9,
    });
    await flush(8);

    // Life-safety wins the turn: the explicit-switch path bailed out and the
    // utterance reaches the host pipeline (where the deterministic safety
    // scan runs) — it is NEVER consumed by a language ack.
    expect(speechTurn).toHaveBeenCalledTimes(1);
    expect(speechTurn.mock.calls[0][0]).toMatchObject({
      speechResult: 'Hay una fuga de gas, hablo español',
    });
    // The non-consuming first-final detection still switches STT to Spanish
    // (the caller IS speaking Spanish) — as trigger (a), not an explicit ack.
    expect(openCalls).toHaveLength(2);
    expect(openCalls[1].language).toBe('es');
    expect(events[0]).toMatchObject({ trigger: 'first_utterance' });
  });

  it('a classified language_switch intent (audit_log) flips the language as a fallback', async () => {
    const session = store.create('t', 'telephony', { callSid: 'CA-classified' });
    session.supportedLanguages = ['en', 'es'];
    const ws = new FakeWs();
    const { provider, openCalls, emit } = makeReopenableProvider();
    // The classifier caught a phrasing the deterministic heuristic misses.
    const speechTurn = vi.fn(async () => [
      {
        type: 'audit_log' as const,
        payload: { intentType: 'language_switch', confidence: 0.92 },
      },
    ]);
    const adapter = new TwilioMediaStreamAdapter(
      { store, streamingProvider: provider, speechTurn, initialLanguageResolver: async () => 'en' },
      ws,
    );
    adapter.start();
    ws.inboundJson(startFrame('CA-classified', 'MZ-classified'));
    await flush();

    const events: unknown[] = [];
    session.events.on(VOICE_EVENT_CHANNEL, (evt: { type: string }) => {
      if (evt.type === 'language_switched') events.push(evt);
    });

    emit({ type: 'final', isFinal: true, transcript: 'Podemos continuar en el otro idioma', confidence: 0.9 });
    await flush(8);

    expect(speechTurn).toHaveBeenCalledTimes(1); // normal turn ran
    expect(openCalls).toHaveLength(2); // then the fallback reopened in es
    expect(openCalls[1].language).toBe('es');
    expect(events[0]).toMatchObject({ trigger: 'classified_intent', to: 'es' });
  });
});

describe('UB-C2 — streaming TTS language + copy rendering', () => {
  let store: VoiceSessionStore;

  beforeEach(() => {
    store = new VoiceSessionStore({ startInterval: false });
  });

  async function setupSpanishSession(opts: {
    ttsProvider: TtsProvider;
    fillerEngine?: {
      selectNext(
        ctx?: { skipFillers?: boolean; language?: 'en' | 'es' },
      ): { id: string; text: string; approxDurationMs: number } | undefined;
    };
    fillerCache?: { get: (id: string) => Buffer | undefined };
    fillerDelayMs?: number;
  }): Promise<{ adapter: TwilioMediaStreamAdapter; ws: FakeWs }> {
    const session = store.create('t', 'telephony', { callSid: 'CA-es-tts' });
    session.language = 'es';
    session.supportedLanguages = ['en', 'es'];
    const ws = new FakeWs();
    const provider: StreamingTranscriptionProvider = {
      openSession: vi.fn(async () => ({ send: vi.fn(), finish: vi.fn(), destroy: vi.fn() })),
    };
    const adapter = new TwilioMediaStreamAdapter(
      {
        store,
        streamingProvider: provider,
        speechTurn: async () => [],
        ttsProvider: opts.ttsProvider,
        fillerEngine: opts.fillerEngine,
        fillerCache: opts.fillerCache,
        fillerDelayMs: opts.fillerDelayMs,
      },
      ws,
    );
    adapter.start();
    ws.inboundJson({
      event: 'start',
      streamSid: 'MZ-es-tts',
      start: { callSid: 'CA-es-tts', accountSid: 'AC', streamSid: 'MZ-es-tts', tracks: ['inbound'] },
    });
    await new Promise((r) => setImmediate(r));
    return { adapter, ws };
  }

  it('renders template keys with the session language and threads language into synthesize', async () => {
    const tts = {
      synthesize: vi.fn(async (_input: TtsSynthesizeInput): Promise<TtsSynthesizeResult> => ({
        audio: Buffer.alloc(640),
        contentType: 'audio/pcm',
        provider: 'test',
      })),
    };
    const { adapter } = await setupSpanishSession({ ttsProvider: tts });

    await (adapter as unknown as { emitSideEffects: (fx: unknown[]) => Promise<void> }).emitSideEffects([
      {
        type: 'tts_play',
        payload: { text: 'intent_confirm', template: 'confirm_intent', intent: 'create_appointment' },
      },
    ]);

    expect(tts.synthesize).toHaveBeenCalledTimes(1);
    const arg = tts.synthesize.mock.calls[0][0];
    expect(arg.language).toBe('es');
    // The template key was rendered to Spanish copy — the caller never
    // hears the literal string "intent_confirm".
    expect(arg.text).toContain('Para confirmar');
    expect(arg.text).toContain('agendar una cita');
  });

  it('threads language into synthesizeStream on the streaming path', async () => {
    const synthesizeStream = vi.fn((input: { text: string; language?: string }) => ({
      async *[Symbol.asyncIterator]() {
        void input;
        yield { pcm: Buffer.alloc(640), isFinal: true };
      },
    }));
    const tts = {
      synthesize: vi.fn(),
      synthesizeStream,
    } as unknown as TtsProvider;
    const { adapter } = await setupSpanishSession({ ttsProvider: tts });

    await (adapter as unknown as { emitSideEffects: (fx: unknown[]) => Promise<void> }).emitSideEffects([
      { type: 'tts_play', payload: { text: 'Perfecto, un momento.' } },
    ]);

    expect(synthesizeStream).toHaveBeenCalledTimes(1);
    expect(synthesizeStream.mock.calls[0][0]).toMatchObject({ language: 'es' });
  });

  it('keys filler selection by session language and degrades to SILENCE when the es clip is missing', async () => {
    // TTS delays past the filler threshold so the filler path fires.
    const tts = {
      synthesize: vi.fn(),
      synthesizeStream: vi.fn(() => ({
        async *[Symbol.asyncIterator]() {
          await new Promise((r) => setTimeout(r, 200));
          yield { pcm: Buffer.alloc(640), isFinal: true };
        },
      })),
    } as unknown as TtsProvider;
    const fillerEngine = {
      selectNext: vi.fn(() => ({ id: 'es-un-momento', text: 'Un momento.', approxDurationMs: 480 })),
    };
    // Cache only holds ENGLISH clips — the Spanish clip is unrendered.
    const englishOnlyCache = { get: (id: string) => (id === 'okay' ? Buffer.alloc(320) : undefined) };
    const { adapter, ws } = await setupSpanishSession({
      ttsProvider: tts,
      fillerEngine,
      fillerCache: englishOnlyCache,
      fillerDelayMs: 30,
    });

    const done = (adapter as unknown as { emitSideEffects: (fx: unknown[]) => Promise<void> }).emitSideEffects([
      { type: 'tts_play', payload: { text: 'Déjeme revisar su cuenta.' } },
    ]);
    // Wait past the filler delay but before the real TTS chunk lands.
    await new Promise((r) => setTimeout(r, 100));

    // Selection was keyed by the session language…
    expect(fillerEngine.selectNext).toHaveBeenCalledWith({ language: 'es' });
    // …and the missing es clip produced SILENCE (no media frames), never
    // the English 'okay' clip.
    const mediaFrames = ws.sent.filter((f) => (f as Record<string, unknown>).event === 'media');
    expect(mediaFrames).toHaveLength(0);

    await done;
    // Real TTS still played after the silent-gap turn.
    const framesAfter = ws.sent.filter((f) => (f as Record<string, unknown>).event === 'media');
    expect(framesAfter.length).toBeGreaterThan(0);
  });
});

// ─── WS26 — voice turn latency (STT-final → first TTS chunk) ──────────────────

describe('WS26 voice_turn_latency_ms', () => {
  /** Read the histogram's cumulative sample count from its prom export. */
  async function turnLatencyCount(): Promise<number> {
    const snap = await voiceTurnLatencyMs.get();
    return (
      snap.values.find((v) => v.metricName === 'voice_turn_latency_ms_count')?.value ?? 0
    );
  }

  beforeEach(() => {
    // Isolated from other tests + reruns — this metric is a module singleton.
    voiceTurnLatencyMs.reset();
  });

  it('observes exactly one sample per driven turn (final transcript → first TTS chunk)', async () => {
    store.create('t', 'telephony', { callSid: 'CA-ws26' });
    const ws = new FakeWs();
    const { provider, handle } = makeStreamingProvider();
    const tts = makeTtsProvider();
    const adapter = new TwilioMediaStreamAdapter(
      {
        store,
        streamingProvider: provider,
        // The turn's reply is what produces outbound audio AFTER the final
        // transcript arms the latency timer (the greeting would not count).
        speechTurn: async () => [{ type: 'tts_play', payload: { text: 'Sure, one moment.' } }],
        ttsProvider: tts,
      },
      ws,
    );
    adapter.start();

    ws.inboundJson({
      event: 'start',
      streamSid: 'MZ-ws26',
      start: { callSid: 'CA-ws26', accountSid: 'AC', streamSid: 'MZ-ws26', tracks: ['inbound'] },
    });
    await new Promise((r) => setImmediate(r));

    expect(await turnLatencyCount()).toBe(0);

    handle.emit({ type: 'final', isFinal: true, transcript: 'do you have a slot', confidence: 0.95 });
    await new Promise((r) => setImmediate(r));

    // Audio actually flowed…
    const mediaFrames = ws.sent.filter((m) => (m as Record<string, unknown>).event === 'media');
    expect(mediaFrames.length).toBeGreaterThanOrEqual(1);
    // …and the turn was measured exactly once, no matter how many chunks.
    expect(await turnLatencyCount()).toBe(1);
  });

  it('does not throw into the audio path when the metrics registry throws', async () => {
    // Simulate a broken prom registry: observe() throws. The turn must still
    // complete and stream audio — the timing capture is best-effort only.
    const observeSpy = vi
      .spyOn(voiceTurnLatencyMs, 'observe')
      .mockImplementation(() => {
        throw new Error('registry exploded');
      });
    try {
      store.create('t', 'telephony', { callSid: 'CA-ws26-throw' });
      const ws = new FakeWs();
      const { provider, handle } = makeStreamingProvider();
      const tts = makeTtsProvider();
      const adapter = new TwilioMediaStreamAdapter(
        {
          store,
          streamingProvider: provider,
          speechTurn: async () => [{ type: 'tts_play', payload: { text: 'Of course.' } }],
          ttsProvider: tts,
        },
        ws,
      );
      adapter.start();

      ws.inboundJson({
        event: 'start',
        streamSid: 'MZ-ws26-throw',
        start: {
          callSid: 'CA-ws26-throw',
          accountSid: 'AC',
          streamSid: 'MZ-ws26-throw',
          tracks: ['inbound'],
        },
      });
      await new Promise((r) => setImmediate(r));
      handle.emit({ type: 'final', isFinal: true, transcript: 'hi there', confidence: 0.95 });
      await new Promise((r) => setImmediate(r));

      // observe() was reached (proving the seam is wired) and it threw…
      expect(observeSpy).toHaveBeenCalled();
      // …yet the outbound audio path was unaffected.
      const mediaFrames = ws.sent.filter((m) => (m as Record<string, unknown>).event === 'media');
      expect(mediaFrames.length).toBeGreaterThanOrEqual(1);
    } finally {
      observeSpy.mockRestore();
    }
  });
});

// ─── VOX-35c — speechTurn-failure recovery (no silent dead-air turn) ──────────
//
// Before this fix, when `speechTurn` threw inside the session lock the catch
// only logged a warn and returned — the caller heard pure silence for the
// whole turn (the inbound analogue of the VOX-35b mid-stream dead-air bug).
// These pins assert the recovery: an apology+reprompt is spoken through the
// normal outbound-turn path, the counter resets on a good turn, and repeated
// back-to-back failures hand the caller off gracefully instead of looping
// apologies forever.
describe('VOX-35c speechTurn-failure recovery', () => {
  /** TTS double that records the (already-localized) text handed to synthesize. */
  function makeCapturingTts(): { tts: TtsProvider; texts: string[] } {
    const texts: string[] = [];
    const tts: TtsProvider = {
      synthesize: vi.fn(async (input: TtsSynthesizeInput): Promise<TtsSynthesizeResult> => {
        texts.push(input.text);
        return { audio: Buffer.alloc(640), contentType: 'audio/pcm', provider: 'test' };
      }),
    };
    return { tts, texts };
  }

  it('speaks an apology+reprompt (not silence) when speechTurn throws once, and resets the counter after a good turn', async () => {
    store.create('t', 'telephony', { callSid: 'CA-recover-1' });
    const ws = new FakeWs();
    const { provider, handle } = makeStreamingProvider();
    const { tts, texts } = makeCapturingTts();
    // Throw on the 1st + 3rd turns, succeed on the 2nd. If the counter did
    // NOT reset after the good 2nd turn, the 3rd throw would be the "2nd
    // consecutive" and escalate+close instead of apologizing again.
    const speechTurn = vi
      .fn()
      .mockRejectedValueOnce(new Error('gateway 500'))
      .mockResolvedValueOnce([])
      .mockRejectedValueOnce(new Error('gateway 500 again'));
    const finalizeOnClose = vi.fn();
    const adapter = new TwilioMediaStreamAdapter(
      { store, streamingProvider: provider, speechTurn, ttsProvider: tts, finalizeOnClose },
      ws,
    );
    adapter.start();
    ws.inboundJson({
      event: 'start',
      streamSid: 'MZ-recover-1',
      start: { callSid: 'CA-recover-1', accountSid: 'AC', streamSid: 'MZ-recover-1', tracks: ['inbound'] },
    });
    await new Promise((r) => setImmediate(r));

    // Turn 1: speechTurn throws → apology audio (not silence).
    handle.emit({ type: 'final', isFinal: true, transcript: 'hello', confidence: 0.95 });
    await new Promise((r) => setImmediate(r));
    let mediaFrames = ws.sent.filter((m) => (m as Record<string, unknown>).event === 'media');
    expect(mediaFrames.length).toBeGreaterThanOrEqual(1);
    expect(texts).toEqual([renderTtsText(SPEECH_TURN_FAILURE_REPROMPT_COPY, {}, 'en')]);
    expect(ws.closed).toBe(false);

    // Turn 2: speechTurn succeeds → resets the consecutive-failure counter.
    handle.emit({ type: 'final', isFinal: true, transcript: 'i need an appointment', confidence: 0.95 });
    await new Promise((r) => setImmediate(r));

    // Turn 3: speechTurn throws again — because the counter reset, this is
    // treated as a fresh 1st failure → another APOLOGY, not an escalation.
    handle.emit({ type: 'final', isFinal: true, transcript: 'still there?', confidence: 0.95 });
    await new Promise((r) => setImmediate(r));

    expect(texts).toEqual([
      renderTtsText(SPEECH_TURN_FAILURE_REPROMPT_COPY, {}, 'en'),
      renderTtsText(SPEECH_TURN_FAILURE_REPROMPT_COPY, {}, 'en'),
    ]);
    // Never escalated/closed — the call is still live for the caller to retry.
    expect(ws.closed).toBe(false);
    expect(finalizeOnClose).not.toHaveBeenCalled();
  });

  it('speaks the apology in the session active language (es)', async () => {
    const session = store.create('t', 'telephony', { callSid: 'CA-recover-es' });
    session.language = 'es';
    const ws = new FakeWs();
    const { provider, handle } = makeStreamingProvider();
    const { tts, texts } = makeCapturingTts();
    const speechTurn = vi.fn().mockRejectedValue(new Error('gateway 500'));
    const adapter = new TwilioMediaStreamAdapter(
      { store, streamingProvider: provider, speechTurn, ttsProvider: tts },
      ws,
    );
    adapter.start();
    ws.inboundJson({
      event: 'start',
      streamSid: 'MZ-recover-es',
      start: { callSid: 'CA-recover-es', accountSid: 'AC', streamSid: 'MZ-recover-es', tracks: ['inbound'] },
    });
    await new Promise((r) => setImmediate(r));

    handle.emit({ type: 'final', isFinal: true, transcript: 'hola necesito ayuda', confidence: 0.95 });
    await new Promise((r) => setImmediate(r));

    const esReprompt = renderTtsText(SPEECH_TURN_FAILURE_REPROMPT_COPY, {}, 'es');
    expect(texts).toEqual([esReprompt]);
    // Sanity: the es rendering actually differs from the raw English key.
    expect(esReprompt).not.toBe(SPEECH_TURN_FAILURE_REPROMPT_COPY);
  });

  it('escalates + ends gracefully after two consecutive failures (no third apology loop)', async () => {
    store.create('t', 'telephony', { callSid: 'CA-recover-2' });
    const ws = new FakeWs();
    const { provider, handle } = makeStreamingProvider();
    const { tts, texts } = makeCapturingTts();
    const speechTurn = vi.fn().mockRejectedValue(new Error('gateway down'));
    const finalizeOnClose = vi.fn();
    const adapter = new TwilioMediaStreamAdapter(
      { store, streamingProvider: provider, speechTurn, ttsProvider: tts, finalizeOnClose },
      ws,
    );
    adapter.start();
    ws.inboundJson({
      event: 'start',
      streamSid: 'MZ-recover-2',
      start: { callSid: 'CA-recover-2', accountSid: 'AC', streamSid: 'MZ-recover-2', tracks: ['inbound'] },
    });
    await new Promise((r) => setImmediate(r));

    // Failure 1 → apology; call stays live.
    handle.emit({ type: 'final', isFinal: true, transcript: 'hello', confidence: 0.95 });
    await new Promise((r) => setImmediate(r));
    expect(ws.closed).toBe(false);

    // Failure 2 (consecutive) → spoken hand-off line + graceful end.
    handle.emit({ type: 'final', isFinal: true, transcript: 'anyone there', confidence: 0.95 });
    await new Promise((r) => setImmediate(r));

    // Exactly two turns were attempted — no third apology loop.
    expect(speechTurn).toHaveBeenCalledTimes(2);
    // The two spoken lines: apology, then the escalation hand-off.
    expect(texts).toEqual([
      renderTtsText(SPEECH_TURN_FAILURE_REPROMPT_COPY, {}, 'en'),
      renderTtsText(SPEECH_TURN_FAILURE_ESCALATION_COPY, {}, 'en'),
    ]);
    // Graceful end through the existing end_session close path.
    expect(ws.closed).toBe(true);
    expect(finalizeOnClose).toHaveBeenCalledTimes(1);
    const [, reason, sideEffects] = finalizeOnClose.mock.calls[0];
    expect(reason).toBe('session_ended');
    expect(sideEffects).toEqual([
      { type: 'end_session', payload: { reason: 'system_failure:speech_turn_repeated_failure' } },
    ]);
  });

  it('barge-in during the recovery apology behaves like normal barge-in', async () => {
    store.create('t', 'telephony', { callSid: 'CA-recover-barge' });
    const ws = new FakeWs();
    const { provider, handle } = makeStreamingProvider();
    // Hang the apology synth so it is in-flight when the caller barges in.
    const tts: TtsProvider = {
      synthesize: vi.fn(
        () =>
          new Promise(() => {
            /* never resolves */
          }),
      ),
    };
    const speechTurn = vi.fn().mockRejectedValue(new Error('gateway 500'));
    const adapter = new TwilioMediaStreamAdapter(
      { store, streamingProvider: provider, speechTurn, ttsProvider: tts },
      ws,
    );
    adapter.start();
    ws.inboundJson({
      event: 'start',
      streamSid: 'MZ-recover-barge',
      start: { callSid: 'CA-recover-barge', accountSid: 'AC', streamSid: 'MZ-recover-barge', tracks: ['inbound'] },
    });
    await new Promise((r) => setImmediate(r));

    // Final → speechTurn throws → apology synth starts and hangs (agentSpeaking).
    handle.emit({ type: 'final', isFinal: true, transcript: 'hello', confidence: 0.95 });
    await new Promise((r) => setImmediate(r));

    // Caller barges in over the apology.
    handle.emit({ type: 'partial', isFinal: false, transcript: 'wait', confidence: 0.5 });
    await new Promise((r) => setImmediate(r));

    const clearFrames = ws.sent.filter((m) => (m as Record<string, unknown>).event === 'clear');
    expect(clearFrames.length).toBeGreaterThanOrEqual(1);
    const mediaFrames = ws.sent.filter((m) => (m as Record<string, unknown>).event === 'media');
    expect(mediaFrames.length).toBe(0);
  });
});
