/**
 * U1 (voice parity) — reply-gap measurement on the media-streams path.
 *
 * U1b: the caller-turn timing handed to `recordTurn` (`lastWordAt` anchored to
 * the first sample forwarded to the CURRENT Deepgram session, `sttFinalAt`,
 * `endpointDelayMs`, `transport`).
 * U1c: the `first_real:<turnId>` mark bracketing the first real reply frame and
 * what its ack (or the lack of one) stamps through `markReplyAudio` and the
 * `voice_reply_*` metrics.
 *
 * Wall time is faked so every instant is exact; the adapter, the real
 * VoiceSessionStore and the metrics are real, the repository and Deepgram are
 * fakes.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  TwilioMediaStreamAdapter,
  type WsLike,
} from '../../../src/telephony/media-streams/mediastream-adapter';
import { VoiceSessionStore } from '../../../src/ai/agents/customer-calling/voice-session-store';
import type {
  StreamingSession,
  StreamingTranscriptEvent,
  StreamingTranscriptionProvider,
} from '../../../src/voice/transcription-providers';
import type { TtsProvider } from '../../../src/ai/tts/tts-provider';
import type { SideEffect } from '../../../src/ai/agents/customer-calling/types';
import { voiceReplyGapMs, voiceReplyUnackedTotal } from '../../../src/monitoring/metrics';

// ─── Fakes ─────────────────────────────────────────────────────────────────

class FakeWs implements WsLike {
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

  on(event: string, listener: (...args: unknown[]) => void): void {
    (this.listeners[event] ??= []).push(listener);
  }

  private fire(event: string, ...args: unknown[]): void {
    for (const l of this.listeners[event] ?? []) l(...args);
  }

  inboundJson(obj: unknown): void {
    this.fire('message', JSON.stringify(obj));
  }

  markNames(prefix: string): string[] {
    return this.sent
      .filter((f) => f.event === 'mark')
      .map((f) => (f.mark as { name: string }).name)
      .filter((n) => n.startsWith(prefix));
  }
}

interface DeepgramOpen {
  emit: (evt: Partial<StreamingTranscriptEvent>) => void;
  session: StreamingSession & { send: ReturnType<typeof vi.fn> };
}

/** A streaming provider that remembers every `openSession` (one per Deepgram generation). */
function makeProvider(): { provider: StreamingTranscriptionProvider; opens: DeepgramOpen[] } {
  const opens: DeepgramOpen[] = [];
  const provider: StreamingTranscriptionProvider = {
    openSession: vi.fn((onEvent) => {
      const session = { send: vi.fn(), finish: vi.fn(), destroy: vi.fn() };
      opens.push({
        session,
        emit: (evt) =>
          onEvent({
            type: 'final',
            isFinal: true,
            transcript: 'my AC is broken',
            confidence: 0.95,
            ...evt,
          } as StreamingTranscriptEvent),
      });
      return Promise.resolve(session as unknown as StreamingSession);
    }),
  };
  return { provider, opens };
}

const pcmTts: TtsProvider = {
  synthesize: vi.fn(async () => ({ audio: Buffer.alloc(640), contentType: 'audio/pcm', provider: 'test' })),
};

const flush = async (): Promise<void> => {
  for (let i = 0; i < 4; i++) {
    await new Promise<void>((r) => {
      setImmediate(r);
    });
  }
};

const CALL_SID = 'CA-latency';
const STREAM_SID = 'MZ-latency';
const startFrame = {
  event: 'start',
  streamSid: STREAM_SID,
  start: { callSid: CALL_SID, accountSid: 'AC', streamSid: STREAM_SID, tracks: ['inbound'] },
};
const mediaFrame = { event: 'media', media: { payload: 'AAAA' } };

interface Harness {
  adapter: TwilioMediaStreamAdapter;
  ws: FakeWs;
  store: VoiceSessionStore;
  opens: DeepgramOpen[];
  recordTurn: ReturnType<typeof vi.fn>;
  markReplyAudio: ReturnType<typeof vi.fn>;
  speechGate?: { release: () => void };
}

function setup(
  opts: {
    initializeSession?: () => Promise<SideEffect[]>;
    ttsProvider?: TtsProvider;
    /** Hold speechTurn open until `speechGate.release()` (the caller line is appended first). */
    holdSpeechTurn?: boolean;
    fillerDelayMs?: number;
    withFiller?: boolean;
  } = {},
): Harness {
  const recordTurn = vi.fn(async (input: unknown) => input as never);
  const markReplyAudio = vi.fn(async () => 1);
  const store = new VoiceSessionStore({
    startInterval: false,
    callTranscriptTurnRepo: { recordTurn, markReplyAudio },
  });
  store.create('tenant-1', 'telephony', { callSid: CALL_SID });
  const ws = new FakeWs();
  const { provider, opens } = makeProvider();
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const adapter = new TwilioMediaStreamAdapter(
    {
      store,
      streamingProvider: provider,
      ttsProvider: opts.ttsProvider ?? pcmTts,
      ...(opts.initializeSession ? { initializeSession: opts.initializeSession } : {}),
      speechTurn: async ({ session, speechResult }) => {
        // The real speechTurn appends the caller line before delegating.
        store.appendTranscript(session.id, { speaker: 'caller', text: speechResult });
        if (opts.holdSpeechTurn) await gate;
        return [{ type: 'tts_play', payload: { text: 'Sure, one moment.' } }];
      },
      ...(opts.withFiller
        ? {
            fillerCache: { get: () => Buffer.alloc(320), has: () => true, size: () => 1 },
            fillerEngine: { selectNext: () => ({ id: 'okay', text: 'Okay.', approxDurationMs: 260 }) },
            fillerDelayMs: opts.fillerDelayMs ?? 50,
          }
        : {}),
    },
    ws,
  );
  adapter.start();
  return { adapter, ws, store, opens, recordTurn, markReplyAudio, speechGate: { release } };
}

const callerTurn = (h: Harness): Record<string, unknown> =>
  h.recordTurn.mock.calls.map(([i]) => i as Record<string, unknown>).find((i) => i.speaker === 'caller')!;

async function histogramCount(anchor: string): Promise<number> {
  const snap = await voiceReplyGapMs.get();
  return snap.values.find((v) => v.metricName === 'voice_reply_gap_ms_count' && v.labels.anchor === anchor)?.value ?? 0;
}

async function unackedCount(reason: string): Promise<number> {
  const snap = await voiceReplyUnackedTotal.get();
  return snap.values.find((v) => v.labels.reason === reason)?.value ?? 0;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
  voiceReplyGapMs.reset();
  voiceReplyUnackedTotal.reset();
});

afterEach(() => {
  vi.useRealTimers();
});

// ─── U1b — caller-turn timing ───────────────────────────────────────────────

describe('U1b caller-turn timing into recordTurn', () => {
  it('anchors Deepgram offsets at the first FORWARDED sample, not the start frame', async () => {
    vi.setSystemTime(1_000_000);
    const h = setup();
    h.ws.inboundJson(startFrame);
    await flush();

    vi.setSystemTime(1_000_500);
    h.ws.inboundJson(mediaFrame);
    // A later frame in the same Deepgram session must not move the anchor.
    vi.setSystemTime(1_001_000);
    h.ws.inboundJson(mediaFrame);
    await flush();

    vi.setSystemTime(1_002_000);
    h.opens[0].emit({ lastWordEndMs: 800 });
    await flush();

    expect(callerTurn(h)).toMatchObject({
      transport: 'realtime',
      sttFinalAt: new Date(1_002_000),
      lastWordAt: new Date(1_000_500 + 800),
      endpointDelayMs: 1_002_000 - (1_000_500 + 800),
    });
    // Not start-frame + offset.
    expect((callerTurn(h).lastWordAt as Date).getTime()).not.toBe(1_000_000 + 800);
  });

  it('frames dropped before captureEnabled (disclosure still playing) do not move the anchor', async () => {
    let resolveDisclosure!: (fx: SideEffect[]) => void;
    const disclosure = new Promise<SideEffect[]>((resolve) => {
      resolveDisclosure = resolve;
    });
    vi.setSystemTime(2_000_000);
    const h = setup({ initializeSession: () => disclosure });
    h.ws.inboundJson(startFrame);
    await flush();

    // Dropped: the disclosure has not played.
    vi.setSystemTime(2_001_000);
    h.ws.inboundJson(mediaFrame);
    await flush();
    expect(h.opens[0].session.send).not.toHaveBeenCalled();

    resolveDisclosure([{ type: 'tts_play', payload: { text: 'This call may be recorded.' } }]);
    await flush();
    vi.setSystemTime(2_003_000);
    const [armMark] = h.ws.markNames('silence-arm-');
    h.ws.inboundJson({ event: 'mark', streamSid: STREAM_SID, mark: { name: armMark } });
    await flush();

    vi.setSystemTime(2_003_500);
    h.ws.inboundJson(mediaFrame);
    await flush();
    expect(h.opens[0].session.send).toHaveBeenCalledTimes(1);

    vi.setSystemTime(2_004_500);
    h.opens[0].emit({ lastWordEndMs: 400 });
    await flush();

    expect((callerTurn(h).lastWordAt as Date).getTime()).toBe(2_003_500 + 400);
  });

  it('a language switch re-anchors: a post-switch final is measured from its own last word', async () => {
    vi.setSystemTime(3_000_000);
    const h = setup();
    h.ws.inboundJson(startFrame);
    await flush();
    h.store.findByCallSid(CALL_SID)!.supportedLanguages = ['en', 'es'];

    h.ws.inboundJson(mediaFrame); // anchors generation 1 at 3_000_000
    await flush();

    vi.setSystemTime(3_060_000); // a minute into the call
    await expect(h.adapter.switchLanguage('es', 'explicit_request')).resolves.toBe(true);
    expect(h.opens).toHaveLength(2);

    vi.setSystemTime(3_061_000);
    h.ws.inboundJson(mediaFrame); // first sample forwarded to generation 2
    await flush();
    expect(h.opens[1].session.send).toHaveBeenCalledTimes(1);

    vi.setSystemTime(3_062_000);
    h.opens[1].emit({ transcript: 'necesito ayuda con mi aire', lastWordEndMs: 300 });
    await flush();

    const turn = callerTurn(h);
    expect((turn.lastWordAt as Date).getTime()).toBe(3_061_000 + 300);
    // Near the new anchor, nowhere near the start of the call.
    expect((turn.lastWordAt as Date).getTime() - 3_000_000).toBeGreaterThan(60_000);
    expect(turn.endpointDelayMs).toBe(3_062_000 - (3_061_000 + 300));
  });

  it('a late final from a finished generation carries no last word (its clock is gone)', async () => {
    vi.setSystemTime(4_000_000);
    const h = setup();
    h.ws.inboundJson(startFrame);
    await flush();
    h.store.findByCallSid(CALL_SID)!.supportedLanguages = ['en', 'es'];
    h.ws.inboundJson(mediaFrame);
    await flush();
    await h.adapter.switchLanguage('es', 'explicit_request');
    vi.setSystemTime(4_001_000);
    h.ws.inboundJson(mediaFrame); // generation 2 anchored
    await flush();

    vi.setSystemTime(4_002_000);
    h.opens[0].emit({ lastWordEndMs: 500 }); // generation 1, finished
    await flush();

    const turn = callerTurn(h);
    expect(turn.sttFinalAt).toEqual(new Date(4_002_000));
    expect(turn).not.toHaveProperty('lastWordAt');
    expect(turn).not.toHaveProperty('endpointDelayMs');
  });

  it('a final without lastWordEndMs records sttFinalAt and transport but no lastWordAt', async () => {
    vi.setSystemTime(5_000_000);
    const h = setup();
    h.ws.inboundJson(startFrame);
    await flush();
    h.ws.inboundJson(mediaFrame);
    vi.setSystemTime(5_001_000);
    h.opens[0].emit({});
    await flush();

    const turn = callerTurn(h);
    expect(turn).toMatchObject({ transport: 'realtime', sttFinalAt: new Date(5_001_000) });
    expect(turn).not.toHaveProperty('lastWordAt');
    expect(turn).not.toHaveProperty('endpointDelayMs');
  });
});

// ─── U1c — first real acked audio ───────────────────────────────────────────

/** Start the call, anchor Deepgram at `anchorMs`, and finalise one caller turn at `finalMs`. */
async function driveTurn(
  h: Harness,
  t: { anchorMs: number; finalMs: number; lastWordEndMs?: number },
): Promise<void> {
  vi.setSystemTime(t.anchorMs - 500);
  h.ws.inboundJson(startFrame);
  await flush();
  vi.setSystemTime(t.anchorMs);
  h.ws.inboundJson(mediaFrame);
  await flush();
  vi.setSystemTime(t.finalMs);
  h.opens[0].emit(t.lastWordEndMs === undefined ? {} : { lastWordEndMs: t.lastWordEndMs });
  await flush();
}

const stampsOf = (h: Harness): Array<Record<string, unknown>> =>
  h.markReplyAudio.mock.calls.map(([i]) => i as Record<string, unknown>);

describe('U1c first real acked audio', () => {
  it('stamps the enqueue, then the ack with the gap measured from the last word', async () => {
    const h = setup();
    await driveTurn(h, { anchorMs: 10_000_000, finalMs: 10_002_000, lastWordEndMs: 800 });

    const [markName] = h.ws.markNames('first_real:');
    expect(markName).toBeDefined();
    // The mark sits right behind the first real media frame.
    const frames = h.ws.sent.filter((f) => f.event === 'media' || f.event === 'mark');
    const mediaIdx = frames.findIndex((f) => f.event === 'media');
    expect((frames[mediaIdx + 1].mark as { name: string }).name).toBe(markName);
    // Before the ack: enqueue stamp only, no gap yet.
    expect(stampsOf(h)).toHaveLength(1);
    expect(stampsOf(h)[0]).toMatchObject({
      tenantId: 'tenant-1',
      callSid: CALL_SID,
      turnIndex: callerTurn(h).turnIndex,
      firstAudioEnqueuedAt: new Date(10_002_000),
    });
    expect(stampsOf(h)[0]).not.toHaveProperty('firstAudioAt');

    vi.setSystemTime(10_002_900);
    h.ws.inboundJson({ event: 'mark', streamSid: STREAM_SID, mark: { name: markName } });
    await flush();

    const lastWordMs = 10_000_000 + 800;
    expect(stampsOf(h)).toHaveLength(2);
    expect(stampsOf(h)[1]).toMatchObject({
      turnIndex: callerTurn(h).turnIndex,
      firstAudioAt: new Date(10_002_900),
      replyGapMs: 10_002_900 - lastWordMs,
      // A fillerless turn: the real frame is also the first audible sound.
      firstAudibleAt: new Date(10_002_900),
    });
    expect(await histogramCount('last_word')).toBe(1);
    expect(await histogramCount('stt_final')).toBe(0);
    // The first_real mark is outside the backpressure count in both directions.
    expect((h.adapter as unknown as { state: { unackedMarks: number } }).state.unackedMarks).toBe(1);

    // A repeated ack is not a second stamp.
    h.ws.inboundJson({ event: 'mark', streamSid: STREAM_SID, mark: { name: markName } });
    await flush();
    expect(stampsOf(h)).toHaveLength(2);
    expect(await histogramCount('last_word')).toBe(1);
  });

  it('falls back to the STT-final anchor without a last word, in its own population and not in reply_gap_ms', async () => {
    const h = setup();
    await driveTurn(h, { anchorMs: 11_000_000, finalMs: 11_002_000 });

    const [markName] = h.ws.markNames('first_real:');
    vi.setSystemTime(11_002_700);
    h.ws.inboundJson({ event: 'mark', streamSid: STREAM_SID, mark: { name: markName } });
    await flush();

    expect(await histogramCount('stt_final')).toBe(1);
    expect(await histogramCount('last_word')).toBe(0);
    const ack = stampsOf(h)[1];
    expect(ack).toMatchObject({ firstAudioAt: new Date(11_002_700) });
    expect(ack).not.toHaveProperty('replyGapMs');
    const snap = await voiceReplyGapMs.get();
    expect(snap.values.find((v) => v.metricName === 'voice_reply_gap_ms_sum' && v.labels.anchor === 'stt_final')?.value).toBe(700);
  });

  it('no ack within 5 s → ack_timeout: counted and stamped, gap left null, a late ack stamps nothing', async () => {
    const h = setup();
    await driveTurn(h, { anchorMs: 12_000_000, finalMs: 12_002_000, lastWordEndMs: 500 });
    const [markName] = h.ws.markNames('first_real:');

    await vi.advanceTimersByTimeAsync(4_999);
    expect(await unackedCount('ack_timeout')).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    await flush();

    expect(await unackedCount('ack_timeout')).toBe(1);
    expect(stampsOf(h)).toHaveLength(2);
    expect(stampsOf(h)[1]).toEqual(
      expect.objectContaining({ turnIndex: callerTurn(h).turnIndex, replyUnackedReason: 'ack_timeout' }),
    );
    expect(stampsOf(h)[1]).not.toHaveProperty('firstAudioAt');
    expect(stampsOf(h)[1]).not.toHaveProperty('replyGapMs');

    h.ws.inboundJson({ event: 'mark', streamSid: STREAM_SID, mark: { name: markName } });
    await flush();
    expect(stampsOf(h)).toHaveLength(2);
    expect(await histogramCount('last_word')).toBe(0);
  });

  it('barge-in (clear) before the ack → clear_echo, and the echoed ack is not timed', async () => {
    // A TTS stream that keeps the agent speaking after its first chunk.
    let release!: () => void;
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const streamingTts: TtsProvider = {
      synthesize: vi.fn(),
      synthesizeStream: vi.fn(() => ({
        async *[Symbol.asyncIterator]() {
          yield { pcm: Buffer.alloc(640), isFinal: false };
          await hold;
          yield { pcm: Buffer.alloc(640), isFinal: true };
        },
      })),
    };
    const h = setup({ ttsProvider: streamingTts });
    await driveTurn(h, { anchorMs: 13_000_000, finalMs: 13_002_000, lastWordEndMs: 500 });
    const [markName] = h.ws.markNames('first_real:');
    expect(markName).toBeDefined();

    h.opens[0].emit({ type: 'partial', isFinal: false, transcript: 'wait', confidence: 0.5 });
    await flush();
    expect(h.ws.sent.some((f) => f.event === 'clear')).toBe(true);
    expect(await unackedCount('clear_echo')).toBe(1);
    expect(stampsOf(h).at(-1)).toMatchObject({ replyUnackedReason: 'clear_echo' });

    // Twilio echoes the flushed mark as an ack: it must not become a gap.
    vi.setSystemTime(13_002_400);
    h.ws.inboundJson({ event: 'mark', streamSid: STREAM_SID, mark: { name: markName } });
    await flush();
    expect(await histogramCount('last_word')).toBe(0);
    expect(stampsOf(h).filter((s) => 'firstAudioAt' in s)).toHaveLength(0);
    release();
    await flush();
  });

  it('stream closing before the ack → stream_closed', async () => {
    const h = setup();
    await driveTurn(h, { anchorMs: 14_000_000, finalMs: 14_002_000, lastWordEndMs: 500 });

    h.ws.inboundJson({ event: 'stop', streamSid: STREAM_SID });
    await flush();

    expect(await unackedCount('stream_closed')).toBe(1);
    expect(stampsOf(h).at(-1)).toMatchObject({ replyUnackedReason: 'stream_closed' });
    // The ack timer was released with the leg: nothing fires later.
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await unackedCount('ack_timeout')).toBe(0);
  });

  it('a filler heard first stamps first_audible_at alone; the real ack keeps the filler stamp', async () => {
    const h = setup({ holdSpeechTurn: true, withFiller: true, fillerDelayMs: 50 });
    await driveTurn(h, { anchorMs: 15_000_000, finalMs: 15_002_000, lastWordEndMs: 600 });

    // speechTurn is still thinking: the early filler fires and is the first audible sound.
    vi.setSystemTime(15_002_100);
    await vi.advanceTimersByTimeAsync(100);
    await flush();
    expect(stampsOf(h)).toHaveLength(1);
    expect(stampsOf(h)[0]).toMatchObject({ firstAudibleAt: expect.any(Date) });
    expect(stampsOf(h)[0]).not.toHaveProperty('firstAudioAt');
    expect(stampsOf(h)[0]).not.toHaveProperty('firstAudioEnqueuedAt');
    expect(h.ws.markNames('first_real:')).toHaveLength(0);

    vi.setSystemTime(15_003_000);
    h.speechGate!.release();
    await flush();
    const [markName] = h.ws.markNames('first_real:');
    expect(markName).toBeDefined();
    vi.setSystemTime(15_003_400);
    h.ws.inboundJson({ event: 'mark', streamSid: STREAM_SID, mark: { name: markName } });
    await flush();

    const ack = stampsOf(h).at(-1)!;
    expect(ack).toMatchObject({ firstAudioAt: new Date(15_003_400), replyGapMs: 15_003_400 - 15_000_600 });
    // The earlier filler stamp stands: the ack does not offer a later audible time.
    expect(ack).not.toHaveProperty('firstAudibleAt');
    expect(await histogramCount('last_word')).toBe(1);
  });
});
