/**
 * LCR-01 — a failed TTS stream recovers on a live realtime call instead of
 * hanging up or going mute.
 *
 * Production path (app.ts wires the shared ElevenLabs provider, the Twilio
 * REST redirector and the realtime health circuit into the media-streams
 * adapter): an ElevenLabs stream blip or 4 s stall throws out of
 * `synthesizeStream` → `recoverTurnAfterStreamFailure` → `synthesizeBounded`
 * → `ElevenLabsTtsProvider.synthesize`. Before the fix that call always got
 * mp3 back, the media path dropped it, a failed greeting hung up, and a call
 * in progress stayed filler-only.
 *
 * Seams: the adapter driven through its WS frames (Twilio `start`, a Deepgram
 * final), with the real `TwilioGatherAdapter` establishment for the greeting,
 * a TTS double shaped like ElevenLabs (mp3 unless PCM is asked for), and a
 * mocked REST redirector; then the real gather-fallback route for the same
 * session.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import twilio from 'twilio';

vi.mock('../../../src/analytics/posthog', () => ({ recordVoiceError: vi.fn() }));

import {
  TwilioMediaStreamAdapter,
  type WsLike,
} from '../../../src/telephony/media-streams/mediastream-adapter';
import { VoiceSessionStore } from '../../../src/ai/agents/customer-calling/voice-session-store';
import { TwilioGatherAdapter } from '../../../src/telephony/twilio-adapter';
import { createTelephonyRouter } from '../../../src/routes/telephony';
import { t } from '../../../src/ai/i18n/i18n';
import type {
  StreamingSession,
  StreamingTranscriptionProvider,
  StreamingTranscriptCallback,
} from '../../../src/voice/transcription-providers';
import type {
  TtsProvider,
  TtsSynthesizeInput,
  TtsSynthesizeResult,
  TtsStreamChunk,
} from '../../../src/ai/tts/tts-provider';
import type { LLMGateway, LLMResponse } from '../../../src/ai/gateway/gateway';
import type { SideEffect } from '../../../src/ai/agents/customer-calling/types';

class FakeWs implements WsLike {
  sent: Array<Record<string, unknown>> = [];
  closed = false;
  closeCode: number | undefined;
  closeReason: string | undefined;
  private listeners: Record<string, Array<(...args: unknown[]) => void>> = {};
  send(data: string): void {
    this.sent.push(JSON.parse(data) as Record<string, unknown>);
  }
  close(code?: number, reason?: string): void {
    this.closed = true;
    this.closeCode = code;
    this.closeReason = reason;
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

function makeStreamingProvider() {
  let cb: StreamingTranscriptCallback | null = null;
  const session: StreamingSession = { send: vi.fn(), finish: vi.fn(), destroy: vi.fn() };
  const provider: StreamingTranscriptionProvider = {
    openSession: vi.fn((onEvent: StreamingTranscriptCallback) => {
      cb = onEvent;
      return Promise.resolve(session);
    }),
  };
  return { provider, session, emit: (evt: Parameters<StreamingTranscriptCallback>[0]) => cb?.(evt) };
}

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

/** A stream that dies before any audio, like an ElevenLabs WS blip or stall. */
function deadStream(): AsyncIterable<TtsStreamChunk> {
  return {
    // eslint-disable-next-line require-yield
    async *[Symbol.asyncIterator]() {
      throw new Error('ElevenLabs stream inactivity timeout after 4000ms');
    },
  };
}

function liveStream(): AsyncIterable<TtsStreamChunk> {
  return {
    async *[Symbol.asyncIterator]() {
      yield { pcm: Buffer.alloc(640), isFinal: false };
      yield { pcm: Buffer.alloc(0), isFinal: true };
    },
  };
}

/** The ElevenLabs REST contract: mp3 unless the caller asks for PCM. */
function elevenLabsShapedSynth() {
  return vi.fn(async (input: TtsSynthesizeInput): Promise<TtsSynthesizeResult> =>
    input.outputFormat === 'pcm_16000'
      ? { audio: Buffer.alloc(640 * 2), contentType: 'audio/pcm', provider: 'elevenlabs' }
      : { audio: Buffer.from([0xff, 0xfb, 0x90]), contentType: 'audio/mpeg', provider: 'elevenlabs' },
  );
}

const flush = () => new Promise<void>((r) => { setImmediate(r); });
const startFrame = (callSid: string) => ({
  event: 'start' as const,
  streamSid: `MZ-${callSid}`,
  start: { callSid, accountSid: 'AC', streamSid: `MZ-${callSid}`, tracks: ['inbound'] },
});
const mediaFrames = (ws: FakeWs) => ws.sent.filter((f) => f.event === 'media');
const disclosureMark = (ws: FakeWs) =>
  ws.sent
    .map((f) => (f.mark as { name?: string } | undefined)?.name)
    .find((n): n is string => typeof n === 'string' && n.startsWith('silence-arm-'));

let store: VoiceSessionStore;
beforeEach(() => {
  store = new VoiceSessionStore({ startInterval: false });
});

const AUTH_TOKEN = 'lcr01-token';
const PUBLIC_BASE_URL = 'https://api.test';

function gatherFallback(callSid: string) {
  const gatherAdapter = new TwilioGatherAdapter({
    store,
    gateway: makeGateway(),
    businessName: 'Acme Plumbing',
    publicBaseUrl: PUBLIC_BASE_URL,
  });
  const app = express();
  app.use(
    '/api/telephony',
    createTelephonyRouter({
      adapter: gatherAdapter,
      authTokenGetter: () => AUTH_TOKEN,
      publicBaseUrl: PUBLIC_BASE_URL,
      resolveTenantId: () => 't',
      voiceSessionStore: store,
    }),
  );
  const params = { CallSid: callSid, From: '+15125550111', To: '+15125550999' };
  const path = '/api/telephony/voice/gather-fallback';
  const sig = twilio.getExpectedTwilioSignature(AUTH_TOKEN, `${PUBLIC_BASE_URL}${path}`, params);
  return request(app).post(path).set('X-Twilio-Signature', sig).type('form').send(params);
}

describe('LCR-01 — the greeting turn (recording notice)', () => {
  function greetingSetup(tts: TtsProvider, restRedirect = vi.fn().mockResolvedValue(true)) {
    const gatherAdapter = new TwilioGatherAdapter({
      store,
      gateway: makeGateway(),
      businessName: 'Acme Plumbing',
      publicBaseUrl: PUBLIC_BASE_URL,
    });
    const ws = new FakeWs();
    const stt = makeStreamingProvider();
    const circuit = { recordFailure: vi.fn(), recordSuccess: vi.fn() };
    const adapter = new TwilioMediaStreamAdapter(
      {
        store,
        streamingProvider: stt.provider,
        ttsProvider: tts,
        restRedirect,
        realtimeCircuit: circuit,
        speechTurn: async () => [],
        initializeSession: ({ callSid, tenantId }) =>
          gatherAdapter.initializeStreamSession({ callSid, tenantId }),
      },
      ws,
    );
    return { gatherAdapter, adapter, ws, stt, circuit, restRedirect };
  }

  it('a stream blip on the greeting is recovered with buffered PCM: the notice plays and listening opens', async () => {
    const synthesize = elevenLabsShapedSynth();
    const tts: TtsProvider = { synthesize, synthesizeStream: vi.fn(() => deadStream()) };
    const { gatherAdapter, adapter, ws, stt, restRedirect } = greetingSetup(tts);
    await gatherAdapter.handleInboundForStream({ callSid: 'CA-greet-pcm', from: '+15125550111', tenantId: 't' });
    adapter.start();
    ws.inboundJson(startFrame('CA-greet-pcm'));

    await vi.waitFor(() => expect(disclosureMark(ws)).toBeDefined());
    expect(synthesize).toHaveBeenCalledWith(expect.objectContaining({ outputFormat: 'pcm_16000' }));
    expect(mediaFrames(ws).length).toBeGreaterThan(0);
    expect(ws.closed).toBe(false);
    expect(restRedirect).not.toHaveBeenCalled();

    // Twilio acks the notice's end-of-utterance mark → caller audio reaches STT.
    ws.inboundJson({ event: 'mark', streamSid: 'MZ-CA-greet-pcm', mark: { name: disclosureMark(ws) } });
    await flush();
    ws.inboundJson({ event: 'media', media: { payload: 'AAAA' } });
    await flush();
    expect(stt.session.send).toHaveBeenCalledTimes(1);
    ws.close();
  });

  it('TTS fully down on the greeting → the call moves to Gather undisclosed, and Gather reads the notice first', async () => {
    const tts: TtsProvider = {
      synthesize: vi.fn(async () => {
        throw new Error('ElevenLabs 503');
      }),
      synthesizeStream: vi.fn(() => deadStream()),
    };
    const { gatherAdapter, adapter, ws, stt, circuit, restRedirect } = greetingSetup(tts);
    await gatherAdapter.handleInboundForStream({ callSid: 'CA-greet-dead', from: '+15125550111', tenantId: 't' });
    adapter.start();
    ws.inboundJson(startFrame('CA-greet-dead'));

    await vi.waitFor(() => expect(ws.closed).toBe(true));
    expect(restRedirect).toHaveBeenCalledTimes(1);
    expect(restRedirect).toHaveBeenCalledWith({ callSid: 'CA-greet-dead', accountSid: 'AC' });
    expect(ws.closeCode).toBe(1000);
    expect(ws.closeReason).toBe('degraded_to_gather');
    expect(circuit.recordFailure).toHaveBeenCalledWith('disclosure_init_failed');
    // Nothing was captured on the stream leg.
    ws.fire('message', JSON.stringify({ event: 'media', media: { payload: 'AAAA' } }));
    expect(stt.session.send).not.toHaveBeenCalled();
    const session = store.findByCallSid('CA-greet-dead')!;
    expect(session.recordingDisclosed).toBe(false);

    // Twilio re-requests TwiML for the same call: the notice is spoken in its
    // own <Say> before <Gather> starts listening.
    const res = await gatherFallback('CA-greet-dead');
    expect(res.status).toBe(200);
    const notice = t('disclose.two_party', 'en');
    const noticeAt = res.text.indexOf(`<Say>${notice}</Say>`);
    expect(noticeAt).toBeGreaterThanOrEqual(0);
    expect(noticeAt).toBeLessThan(res.text.indexOf('<Gather'));
    expect(res.text).not.toContain('<Stream');
  });

  it('establishment itself throws → the same move to Gather, never a capture on the stream', async () => {
    const ws = new FakeWs();
    const stt = makeStreamingProvider();
    const restRedirect = vi.fn().mockResolvedValue(true);
    store.create('t', 'telephony', { callSid: 'CA-init-threw' });
    const adapter = new TwilioMediaStreamAdapter(
      {
        store,
        streamingProvider: stt.provider,
        ttsProvider: { synthesize: elevenLabsShapedSynth(), synthesizeStream: vi.fn(() => liveStream()) },
        restRedirect,
        speechTurn: async () => [],
        initializeSession: async () => {
          throw new Error('disclosure rpc timeout');
        },
      },
      ws,
    );
    adapter.start();
    ws.inboundJson(startFrame('CA-init-threw'));

    await vi.waitFor(() => expect(ws.closed).toBe(true));
    expect(restRedirect).toHaveBeenCalledTimes(1);
    expect(ws.closeReason).toBe('degraded_to_gather');
    expect(store.findByCallSid('CA-init-threw')!.recordingDisclosed).toBe(false);
    expect(stt.session.send).not.toHaveBeenCalled();
  });

  it('TTS fully down and the redirect refused → the undisclosed leg still ends (no capture)', async () => {
    const tts: TtsProvider = {
      synthesize: vi.fn(async () => {
        throw new Error('ElevenLabs 503');
      }),
      synthesizeStream: vi.fn(() => deadStream()),
    };
    const { gatherAdapter, adapter, ws, stt, restRedirect } = greetingSetup(tts, vi.fn().mockResolvedValue(false));
    await gatherAdapter.handleInboundForStream({ callSid: 'CA-greet-refused', from: '+15125550111', tenantId: 't' });
    adapter.start();
    ws.inboundJson(startFrame('CA-greet-refused'));

    await vi.waitFor(() => expect(ws.closed).toBe(true));
    expect(restRedirect).toHaveBeenCalledTimes(1);
    expect(ws.closeCode).toBe(1011);
    expect(ws.closeReason).toBe('disclosure_init_failed');
    expect(stt.session.send).not.toHaveBeenCalled();
  });
});

describe('LCR-01 — a turn later in the call', () => {
  function midCallSetup(opts: { synthesize: TtsProvider['synthesize'] }) {
    const tts: TtsProvider = {
      synthesize: opts.synthesize,
      // Every reply's stream dies (the vendor's streaming endpoint is down).
      synthesizeStream: vi.fn(() => deadStream()),
    };
    const ws = new FakeWs();
    const stt = makeStreamingProvider();
    const circuit = { recordFailure: vi.fn(), recordSuccess: vi.fn() };
    const restRedirect = vi.fn().mockResolvedValue(true);
    const session = store.create('t', 'telephony', { callSid: 'CA-mid' });
    // The recording notice already played earlier in this call.
    session.recordingDisclosed = true;
    const adapter = new TwilioMediaStreamAdapter(
      {
        store,
        streamingProvider: stt.provider,
        ttsProvider: tts,
        restRedirect,
        realtimeCircuit: circuit,
        speechTurn: async (): Promise<SideEffect[]> => [
          { type: 'tts_play', payload: { text: 'You are booked for Tuesday at nine.' } },
        ],
      },
      ws,
    );
    adapter.start();
    ws.inboundJson(startFrame('CA-mid'));
    return { ws, stt, circuit, restRedirect, session };
  }

  it('stream and buffered recovery both fail → the call continues on Gather instead of going mute', async () => {
    const synthesize = vi.fn(async () => {
      throw new Error('ElevenLabs 503');
    });
    const { ws, stt, circuit, restRedirect, session } = midCallSetup({ synthesize });
    await flush();
    stt.emit({ type: 'final', isFinal: true, transcript: 'can I book for Tuesday', confidence: 0.95 });

    await vi.waitFor(() => expect(ws.closed).toBe(true));
    expect(synthesize).toHaveBeenCalledWith(expect.objectContaining({ outputFormat: 'pcm_16000' }));
    expect(restRedirect).toHaveBeenCalledWith({ callSid: 'CA-mid', accountSid: 'AC' });
    expect(ws.closeCode).toBe(1000);
    expect(ws.closeReason).toBe('degraded_to_gather');
    expect(circuit.recordFailure).toHaveBeenCalledWith('tts_unavailable');
    // The notice already played: Gather must not read it again, and the call
    // is still live for the Gather leg to continue.
    expect(session.recordingDisclosed).toBe(true);
    expect(session.ended).not.toBe(true);
  });

  it('stream fails but buffered PCM recovery plays → the turn is heard and the call stays on the stream', async () => {
    const synthesize = elevenLabsShapedSynth();
    const { ws, stt, circuit, restRedirect } = midCallSetup({ synthesize });
    await flush();
    stt.emit({ type: 'final', isFinal: true, transcript: 'can I book for Tuesday', confidence: 0.95 });

    await vi.waitFor(() => expect(mediaFrames(ws).length).toBeGreaterThan(0));
    await flush();
    expect(synthesize).toHaveBeenCalledWith(expect.objectContaining({ outputFormat: 'pcm_16000' }));
    expect(restRedirect).not.toHaveBeenCalled();
    expect(circuit.recordFailure).not.toHaveBeenCalled();
    expect(ws.closed).toBe(false);
    ws.close();
  });

  it('a finished conversation is not reopened on Gather when its last line cannot be spoken', async () => {
    const synthesize = vi.fn(async () => {
      throw new Error('ElevenLabs 503');
    });
    const { ws, stt, restRedirect, session } = midCallSetup({ synthesize });
    await flush();
    session.ended = true;
    stt.emit({ type: 'final', isFinal: true, transcript: 'thanks, bye', confidence: 0.95 });
    await vi.waitFor(() => expect(synthesize).toHaveBeenCalled());
    await flush();
    await flush();
    expect(restRedirect).not.toHaveBeenCalled();
    ws.close();
  });
});

// A stream that works for the greeting keeps working: guard against the fix
// redirecting a healthy call.
describe('LCR-01 — healthy streams are untouched', () => {
  it('a turn whose stream plays never calls the buffered synth or the redirector', async () => {
    const synthesize = elevenLabsShapedSynth();
    const tts: TtsProvider = { synthesize, synthesizeStream: vi.fn(() => liveStream()) };
    const ws = new FakeWs();
    const stt = makeStreamingProvider();
    const restRedirect = vi.fn().mockResolvedValue(true);
    store.create('t', 'telephony', { callSid: 'CA-ok' });
    const adapter = new TwilioMediaStreamAdapter(
      {
        store,
        streamingProvider: stt.provider,
        ttsProvider: tts,
        restRedirect,
        speechTurn: async () => [{ type: 'tts_play', payload: { text: 'Sure, Tuesday works.' } }],
      },
      ws,
    );
    adapter.start();
    ws.inboundJson(startFrame('CA-ok'));
    await flush();
    stt.emit({ type: 'final', isFinal: true, transcript: 'Tuesday please', confidence: 0.95 });
    await vi.waitFor(() => expect(mediaFrames(ws).length).toBeGreaterThan(0));
    await flush();
    expect(synthesize).not.toHaveBeenCalled();
    expect(restRedirect).not.toHaveBeenCalled();
    ws.close();
  });
});
