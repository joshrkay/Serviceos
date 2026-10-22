/**
 * S3-3 (plan U4) — useRivetVoice, the playback half: Rivet's lines in the
 * tenant's voice from the server, prefetched a turn at a time, with
 * speechSynthesis and then silence as the fallbacks.
 *
 * Real hook, real apiFetch: the network is stubbed at `fetch` (the HTTP
 * boundary) and answers the way POST /api/voice/tts, POST /api/voice/tts/batch
 * and GET /api/voice/tts/clip/:hash answer. jsdom implements no media playback,
 * so `play`/`pause` are stubbed on HTMLMediaElement and the test drives the
 * element's own `playing` / `ended` / `error` events; speechSynthesis is faked
 * the way useConversationVoice.test.ts fakes it.
 *
 * S3-5 — the listening half (`openMic`, `useRivetTurnListener`): the microphone,
 * MediaRecorder and Deepgram's socket are faked at the browser/vendor boundary
 * the way useDeepgramDictation.test.ts fakes them; POST /api/voice/stream-token
 * is answered at fetch like the other routes.
 */
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const track = vi.hoisted(() => ({ trackFunnel: vi.fn(), track: vi.fn() }));
vi.mock('../lib/analytics', () => track);

import { useRivetTurnListener, useRivetVoice, type RivetVoice } from './useRivetVoice';
import type { UtteranceScreen } from '../lib/onboarding-utterance';

const FUNNEL = { tenantId: 'tenant-1', userId: 'user-1' };

// ── The server ────────────────────────────────────────────────
interface Sent {
  method: string;
  path: string;
  body?: { items?: string[]; text?: string };
}
let sent: Sent[];
/** How the next TTS answers go: an HTTP status, or 'network' for a fetch that never reaches the server. */
let faults: Array<number | 'network'>;
/** Clips the server holds by hash (what GET /tts/clip/:hash can serve). */
let serverCache: Map<string, string>;
/** How POST /api/voice/stream-token answers: 200 with a fresh token each time, or an error status. */
let tokenStatus: number;
let tokensMinted: number;

const b64 = (text: string) => btoa(`clip:${text}`);
const hashFor = (text: string) => text.split('').reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7).toString(16).padStart(64, '0');
const srcFor = (text: string) => `data:audio/mpeg;base64,${b64(text)}`;

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

const ERRORS: Record<number, unknown> = {
  429: { error: 'RATE_LIMITED', message: 'Too many spoken answers in a row. The answer is still on screen.' },
  501: { error: 'NOT_CONFIGURED', message: 'Speech synthesis is not configured' },
  502: { error: 'TTS_FAILED', message: "Couldn't speak that answer right now — it's still on screen." },
};

function clip(text: string) {
  serverCache.set(hashFor(text), text);
  return { text, clipHash: hashFor(text), audio: b64(text), contentType: 'audio/mpeg', cached: false };
}

function stubServer() {
  sent = [];
  faults = [];
  serverCache = new Map();
  tokenStatus = 200;
  tokensMinted = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      const method = init?.method ?? 'GET';
      const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as Sent['body']) : undefined;
      sent.push({ method, path, body });
      if (path.startsWith('/api/voice/tts/clip/') && method === 'GET') {
        const text = serverCache.get(path.slice(path.lastIndexOf('/') + 1));
        if (!text) return json(404, { error: 'NOT_CACHED', message: 'That clip is not cached here' });
        return new Response(new TextEncoder().encode(`clip:${text}`), { status: 200, headers: { 'Content-Type': 'audio/mpeg' } });
      }
      if (path.startsWith('/api/voice/stream-token') && method === 'POST') {
        if (tokenStatus !== 200) return json(tokenStatus, { error: 'NOT_CONFIGURED', message: 'Live transcription is not configured' });
        tokensMinted += 1;
        return json(200, { token: `dg-${tokensMinted}`, expiresIn: 30, model: 'nova-3' });
      }
      const fault = faults.shift();
      if (fault === 'network') throw new TypeError('Failed to fetch');
      if (fault) return json(fault, ERRORS[fault]);
      if (path === '/api/voice/tts/batch' && method === 'POST') return json(200, { clips: body!.items!.map(clip) });
      if (path === '/api/voice/tts' && method === 'POST') {
        const { text: _t, ...one } = clip(body!.text!);
        return json(200, one);
      }
      throw new Error(`unexpected request ${method} ${path}`);
    }),
  );
}

const ttsRequests = () => sent.filter((r) => r.method === 'POST');
const batches = () => sent.filter((r) => r.path === '/api/voice/tts/batch');

// ── The audio element ────────────────────────────────────────
let played: string[];
let playOutcome: 'ok' | 'autoplay' | 'error';
const play = vi.fn(function (this: HTMLMediaElement) {
  played.push(this.src);
  if (playOutcome === 'autoplay') return Promise.reject(new DOMException('blocked', 'NotAllowedError'));
  queueMicrotask(() => this.dispatchEvent(new Event(playOutcome === 'error' ? 'error' : 'playing')));
  return Promise.resolve();
});
/** The element the hook last played. */
const element = () => play.mock.contexts.at(-1) as HTMLMediaElement | undefined;

/** The clip on the element finishes. */
async function finish() {
  await act(async () => {
    element()?.dispatchEvent(new Event('ended'));
  });
}

// ── speechSynthesis ──────────────────────────────────────────
class FakeUtterance {
  static instances: FakeUtterance[] = [];
  text: string;
  rate = 1;
  pitch = 1;
  lang = '';
  voice: unknown = null;
  onstart: (() => void) | null = null;
  onend: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(text: string) {
    this.text = text;
    FakeUtterance.instances.push(this);
  }
}
const synthSpeak = vi.fn((u: FakeUtterance) => u.onstart?.());
const spoken = () => FakeUtterance.instances.map((u) => u.text);

function withSpeechSynthesis() {
  vi.stubGlobal('speechSynthesis', { cancel: vi.fn(), speak: synthSpeak, getVoices: () => [] });
  vi.stubGlobal('SpeechSynthesisUtterance', FakeUtterance as unknown as typeof SpeechSynthesisUtterance);
}

const fallbacks = () => track.trackFunnel.mock.calls.filter(([e]) => e === 'v3_tts_fallback').map(([, , extra]) => extra);
const firstHeard = () => track.trackFunnel.mock.calls.filter(([e]) => e === 'v3_first_heard').map(([, , extra]) => extra);

const QUESTION = 'How should I answer your phone?';
const LINE_A = 'Walsh Plumbing, how can I help?';
const LINE_B = "Thanks for calling Walsh Plumbing. What's going on today?";
const GREETING = [QUESTION, LINE_A, LINE_B];
const PRICE = ['What do you charge to come out?', "It's $89 for the visit.", "It's $129 for the visit."];

function mount() {
  return renderHook(() => useRivetVoice({ funnel: FUNNEL }));
}

/** Let the pending fetches, microtasks and renders settle. */
async function settle() {
  await act(async () => {
    for (let i = 0; i < 10; i += 1) await Promise.resolve();
  });
}

async function speak(voice: () => RivetVoice, text: string, turn: string, withLines?: string[]) {
  await act(async () => {
    void voice().speak(text, { turn, with: withLines });
  });
  await settle();
}

beforeEach(() => {
  stubServer();
  played = [];
  playOutcome = 'ok';
  FakeUtterance.instances = [];
  synthSpeak.mockClear();
  play.mockClear();
  track.trackFunnel.mockClear();
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(play as unknown as () => Promise<void>);
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
  try {
    sessionStorage.clear();
  } catch {
    /* no storage: nothing to clear */
  }
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('useRivetVoice — playback', () => {
  it('the "Make it mine" gesture plays the kept-warm element inside the handler, before anything is awaited', () => {
    const { result } = mount();
    act(() => {
      result.current.unlock('make_it_mine');
      // Synchronous: iOS only lets an element play later if it played inside the tap.
      expect(play).toHaveBeenCalledTimes(1);
    });
    expect(played[0]).toMatch(/^data:audio\/wav;base64,/);
    expect(ttsRequests()).toEqual([]);
  });

  it('a turn of three lines is one batch request, and the question plays in the server voice', async () => {
    const { result } = mount();
    await speak(() => result.current, QUESTION, 'greeting', GREETING);
    expect(batches()).toHaveLength(1);
    expect(batches()[0].body).toEqual({ items: GREETING });
    expect(ttsRequests()).toHaveLength(1);
    expect(played).toEqual([srcFor(QUESTION)]);
    expect(result.current.speaking).toBe(true);
    await finish();
    expect(result.current.speaking).toBe(false);
  });

  it('an option tapped on that turn plays from the batch already received, with no new request', async () => {
    const { result } = mount();
    await speak(() => result.current, QUESTION, 'greeting', GREETING);
    await speak(() => result.current, LINE_B, 'greeting', GREETING);
    await speak(() => result.current, LINE_B, 'greeting', GREETING);
    expect(ttsRequests()).toHaveLength(1);
    expect(played).toEqual([srcFor(QUESTION), srcFor(LINE_B), srcFor(LINE_B)]);
  });

  it('prefetches the next turn after the current turn has arrived, so it is fetched while the current line plays', async () => {
    const { result } = mount();
    await act(async () => {
      void result.current.speak(QUESTION, { turn: 'greeting', with: GREETING });
      result.current.prefetch(PRICE);
      // The next turn waits for the current one: never two turns' requests in flight at once.
      expect(batches().map((r) => r.body?.items)).not.toContainEqual(PRICE);
    });
    await settle();
    expect(batches().map((r) => r.body?.items)).toEqual([GREETING, PRICE]);
    // Playing the next turn's question needs nothing more from the server.
    await speak(() => result.current, PRICE[0], 'trip_fee_and_rate', PRICE);
    expect(batches()).toHaveLength(2);
    expect(played.at(-1)).toBe(srcFor(PRICE[0]));
  });

  it('asks for only the lines it does not already hold, and nothing at all for a turn it holds', async () => {
    const { result } = mount();
    await speak(() => result.current, QUESTION, 'greeting', GREETING);
    await act(async () => result.current.prefetch(GREETING));
    await act(async () => result.current.prefetch([LINE_A, PRICE[0]]));
    await settle();
    expect(batches().map((r) => r.body?.items)).toEqual([GREETING, [PRICE[0]]]);
  });

  it('a line outside the seven turns is one single-clip request', async () => {
    const { result } = mount();
    await speak(() => result.current, 'Walsh Plumbing is already set up.', 'ready');
    expect(ttsRequests()).toEqual([{ method: 'POST', path: '/api/voice/tts', body: { text: 'Walsh Plumbing is already set up.' } }]);
    expect(played).toEqual([srcFor('Walsh Plumbing is already set up.')]);
  });

  it('a clip received before a reload is read back by its hash for free, and only a miss there is charged', async () => {
    const first = mount();
    await speak(() => first.result.current, 'Walsh Plumbing is already set up.', 'ready');
    first.unmount();
    sent = [];

    const again = mount();
    await speak(() => again.result.current, 'Walsh Plumbing is already set up.', 'ready');
    expect(sent.map((r) => `${r.method} ${r.path}`)).toEqual([`GET /api/voice/tts/clip/${hashFor('Walsh Plumbing is already set up.')}`]);
    expect(played.at(-1)).toBe(srcFor('Walsh Plumbing is already set up.'));
    again.unmount();

    // Another replica's cache (or an evicted clip): the free read misses, and the charged POST answers.
    serverCache.clear();
    sent = [];
    const third = mount();
    await speak(() => third.result.current, 'Walsh Plumbing is already set up.', 'ready');
    expect(sent.map((r) => `${r.method} ${r.path}`)).toEqual([
      `GET /api/voice/tts/clip/${hashFor('Walsh Plumbing is already set up.')}`,
      'POST /api/voice/tts',
    ]);
  });

  it('counts a full seven-turn pass: at most three clips a turn, twenty-one in all', async () => {
    const turns = Array.from({ length: 7 }, (_, i) => [`Question ${i}?`, `Line ${i} a.`, `Line ${i} b.`]);
    const { result } = mount();
    for (let i = 0; i < turns.length; i += 1) {
      await act(async () => {
        void result.current.speak(turns[i][0], { turn: `turn-${i}`, with: turns[i] });
        if (turns[i + 1]) result.current.prefetch(turns[i + 1]);
      });
      await settle();
      // The owner taps both cards before moving on.
      await speak(() => result.current, turns[i][1], `turn-${i}`, turns[i]);
      await speak(() => result.current, turns[i][2], `turn-${i}`, turns[i]);
    }
    const perRequest = ttsRequests().map((r) => r.body?.items?.length ?? 1);
    expect(perRequest.every((n) => n <= 3)).toBe(true);
    expect(perRequest.reduce((a, b) => a + b, 0)).toBe(21);
  });
});

describe('useRivetVoice — fallbacks', () => {
  it.each([
    [429, 'rate_limited'],
    [502, 'tts_failed'],
    [501, 'not_configured'],
    ['network', 'network'],
  ] as const)('a %s from the server speaks that turn with speechSynthesis and records why, once', async (fault, reason) => {
    withSpeechSynthesis();
    faults = [fault];
    const { result } = mount();
    await speak(() => result.current, QUESTION, 'greeting', GREETING);
    expect(spoken()).toEqual([QUESTION]);
    expect(played).toEqual([]);
    expect(fallbacks()).toEqual([{ reason, mode: 'speech_synthesis', turn: 'greeting' }]);

    // The rest of the turn stays on speechSynthesis: no second charged request, no second event.
    await speak(() => result.current, LINE_A, 'greeting', GREETING);
    expect(spoken()).toEqual([QUESTION, LINE_A]);
    expect(ttsRequests()).toHaveLength(1);
    expect(fallbacks()).toHaveLength(1);
  });

  it('a prefetch the server refused degrades that turn when it opens, without asking again', async () => {
    withSpeechSynthesis();
    const { result } = mount();
    await speak(() => result.current, QUESTION, 'greeting', GREETING);
    faults = [429];
    await act(async () => result.current.prefetch(PRICE));
    await settle();
    await speak(() => result.current, PRICE[0], 'trip_fee_and_rate', PRICE);
    expect(batches()).toHaveLength(2);
    expect(spoken()).toEqual([PRICE[0]]);
    expect(fallbacks()).toEqual([{ reason: 'rate_limited', mode: 'speech_synthesis', turn: 'trip_fee_and_rate' }]);
  });

  it('autoplay refused: play() rejects, and the line is spoken by speechSynthesis', async () => {
    withSpeechSynthesis();
    playOutcome = 'autoplay';
    const { result } = mount();
    await speak(() => result.current, QUESTION, 'greeting', GREETING);
    expect(spoken()).toEqual([QUESTION]);
    expect(fallbacks()).toEqual([{ reason: 'autoplay', mode: 'speech_synthesis', turn: 'greeting' }]);
  });

  it('a clip the element cannot play falls back the same way', async () => {
    withSpeechSynthesis();
    playOutcome = 'error';
    const { result } = mount();
    await speak(() => result.current, QUESTION, 'greeting', GREETING);
    expect(spoken()).toEqual([QUESTION]);
    expect(fallbacks()).toEqual([{ reason: 'playback', mode: 'speech_synthesis', turn: 'greeting' }]);
  });

  it('with no speechSynthesis either, the line is silent: the event says so and nothing throws', async () => {
    faults = [502];
    const { result } = mount();
    await speak(() => result.current, QUESTION, 'greeting', GREETING);
    expect(played).toEqual([]);
    expect(fallbacks()).toEqual([{ reason: 'tts_failed', mode: 'silent', turn: 'greeting' }]);
    expect(result.current.speaking).toBe(false);
  });
});

describe('useRivetVoice — time to first heard', () => {
  it('fires once, on the first line heard after "Make it mine", with how long it took', async () => {
    const { result } = mount();
    // A line heard before the owner commits (the Ready opener) is not the measure.
    await speak(() => result.current, 'Walsh Plumbing is already set up.', 'ready');
    expect(firstHeard()).toEqual([]);

    act(() => result.current.unlock('make_it_mine'));
    await speak(() => result.current, QUESTION, 'greeting', GREETING);
    await speak(() => result.current, LINE_A, 'greeting', GREETING);
    expect(firstHeard()).toHaveLength(1);
    const [event] = firstHeard() as Array<{ ms_since_make_it_mine: number; source: string; gesture: string }>;
    expect(event.source).toBe('server');
    expect(event.gesture).toBe('make_it_mine');
    expect(Number.isInteger(event.ms_since_make_it_mine)).toBe(true);
    expect(event.ms_since_make_it_mine).toBeGreaterThanOrEqual(0);
  });

  it('counts a line spoken by speechSynthesis as heard, and says so', async () => {
    withSpeechSynthesis();
    faults = [429];
    const { result } = mount();
    act(() => result.current.unlock('keep_as_is'));
    await speak(() => result.current, "Here's what I've got. Tap anything to change it.", 'readback');
    expect(firstHeard()).toEqual([
      expect.objectContaining({ source: 'speech_synthesis', gesture: 'keep_as_is', ms_since_make_it_mine: expect.any(Number) }),
    ]);
  });
});

// ── The listening half (S3-5) ─────────────────────────────────
// The microphone and Deepgram's socket are the browser/vendor boundary: faked the way
// useDeepgramDictation.test.ts fakes them. Everything between them and the turn is real.
class FakeWebSocket {
  static OPEN = 1;
  static instances: FakeWebSocket[] = [];
  readyState = 0;
  url: string;
  protocols?: string | string[];
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  constructor(url: string, protocols?: string | string[]) {
    this.url = url;
    this.protocols = protocols;
    FakeWebSocket.instances.push(this);
  }
  send() {}
  close() {
    this.readyState = 3;
  }
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
  emit(obj: unknown) {
    this.onmessage?.({ data: JSON.stringify(obj) });
  }
  drop() {
    this.readyState = 3;
    this.onclose?.();
  }
  refuse() {
    this.readyState = 3;
    this.onerror?.();
    this.onclose?.();
  }
}
class FakeMediaRecorder {
  static instances: FakeMediaRecorder[] = [];
  state: 'inactive' | 'recording' = 'inactive';
  ondataavailable: unknown = null;
  constructor(readonly stream: unknown) {
    FakeMediaRecorder.instances.push(this);
  }
  start() {
    this.state = 'recording';
  }
  stop() {
    this.state = 'inactive';
  }
}
const trackStop = vi.fn();
const micStream = { getTracks: () => [{ stop: trackStop }] };
const getUserMedia = vi.fn(async () => micStream);

function withMic() {
  FakeWebSocket.instances = [];
  FakeMediaRecorder.instances = [];
  trackStop.mockReset();
  getUserMedia.mockReset();
  getUserMedia.mockImplementation(async () => micStream);
  vi.stubGlobal('WebSocket', FakeWebSocket as unknown as typeof WebSocket);
  vi.stubGlobal('MediaRecorder', FakeMediaRecorder as unknown as typeof MediaRecorder);
  vi.stubGlobal('navigator', { ...navigator, mediaDevices: { getUserMedia } });
}

const LABELS = [
  { key: 'a', label: 'Book it on the call' },
  { key: 'b', label: 'Hold it for me' },
] as const;
const voiceInputs = () => track.trackFunnel.mock.calls.filter(([e]) => e === 'v3_voice_input').map(([, , extra]) => extra);
const socket = () => FakeWebSocket.instances.at(-1)!;
const say = (transcript: string) =>
  act(() => {
    socket().emit({ is_final: true, speech_final: true, channel: { alternatives: [{ transcript }] } });
  });
const partial = (transcript: string) =>
  act(() => {
    socket().emit({ is_final: false, channel: { alternatives: [{ transcript }] } });
  });

/** The shell's voice with one turn listening, the way the shell and OptionPairTurn compose them. */
const SCREEN: UtteranceScreen = { options: LABELS };

function mountTurn(over: { enabled?: boolean; screen?: UtteranceScreen } = {}) {
  const onResult = vi.fn();
  const screen = over.screen ?? SCREEN;
  const view = renderHook(
    ({ enabled }: { enabled: boolean }) => {
      const voice = useRivetVoice({ funnel: FUNNEL });
      const listening = useRivetTurnListener(voice, { turn: 'booking_posture', screen, enabled, onResult });
      return { voice, listening };
    },
    { initialProps: { enabled: over.enabled ?? true } },
  );
  return { ...view, onResult };
}

/** "Make it mine": the tap that unlocks the audio and asks for the microphone, once. */
async function makeItMine(result: { current: { voice: RivetVoice } }) {
  act(() => {
    result.current.voice.unlock('make_it_mine');
    result.current.voice.openMic();
  });
  await settle();
}

describe('useRivetVoice — listening (S3-5)', () => {
  beforeEach(withMic);

  it('asks for the microphone inside the "Make it mine" tap, after the audio is unlocked, and only once', async () => {
    const { result } = mountTurn();
    act(() => {
      result.current.voice.unlock('make_it_mine');
      result.current.voice.openMic();
      expect(play).toHaveBeenCalledTimes(1);
      expect(getUserMedia).toHaveBeenCalledTimes(1);
    });
    expect(play.mock.invocationCallOrder[0]).toBeLessThan(getUserMedia.mock.invocationCallOrder[0]);
    await settle();
    act(() => result.current.voice.openMic());
    expect(getUserMedia).toHaveBeenCalledTimes(1);
    expect(result.current.voice.input).toBe('on');
  });

  it('opens one socket for the turn with a fresh token, in English, with both labels and first/second as keyterms', async () => {
    const { result } = mountTurn();
    await makeItMine(result);
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(sent.filter((r) => r.path.startsWith('/api/voice/stream-token'))).toEqual([
      { method: 'POST', path: '/api/voice/stream-token?language=en', body: undefined },
    ]);
    const url = new URL(socket().url);
    expect(url.searchParams.getAll('keyterm')).toEqual(['Book it on the call', 'Hold it for me', 'first', 'second']);
    expect(url.searchParams.get('language')).toBe('en');
    expect(url.searchParams.get('utterance_end_ms')).toBe('1200');
    expect(socket().protocols).toEqual(['bearer', 'dg-1']);
    act(() => socket().open());
    expect(FakeMediaRecorder.instances[0].stream).toBe(micStream);
    expect(result.current.listening.listening).toBe(true);
  });

  it('pauses Rivet within 200 ms of the first words the owner says over him', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'] });
    try {
      withSpeechSynthesis();
      const pause = vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
      const { result } = mountTurn();
      await makeItMine(result);
      act(() => socket().open());
      await speak(() => result.current.voice, QUESTION, 'booking_posture', [QUESTION]);
      expect(result.current.voice.speaking).toBe(true);
      pause.mockClear();
      const cancel = (globalThis.speechSynthesis as unknown as { cancel: ReturnType<typeof vi.fn> }).cancel;
      cancel.mockClear();

      partial('the sec');
      await act(async () => {
        await vi.advanceTimersByTimeAsync(200);
      });
      expect(pause).toHaveBeenCalled();
      expect(cancel).toHaveBeenCalled();
      expect(result.current.voice.speaking).toBe(false);
      expect(result.current.listening.partial).toBe('the sec');
    } finally {
      vi.useRealTimers();
    }
  });

  it('matches "the second one" to the second card with no request but the token', async () => {
    const { result, onResult } = mountTurn();
    await makeItMine(result);
    act(() => socket().open());
    const before = sent.length;
    say('the second one');
    expect(onResult).toHaveBeenCalledWith(expect.objectContaining({ kind: 'pick', key: 'b', transcript: 'the second one' }));
    expect(onResult).toHaveBeenCalledTimes(1);
    expect(sent.slice(before)).toEqual([]);
    expect(result.current.listening.missed).toBeNull();
  });

  it('an unclear answer is never silent: Rivet says what he heard and what the turn accepts, then an example', async () => {
    const { result, onResult } = mountTurn();
    await makeItMine(result);
    act(() => socket().open());
    const before = sent.length;
    say('banana');
    expect(onResult).toHaveBeenCalledWith({ kind: 'unclear', transcript: 'banana' });
    expect(result.current.listening.missed).toEqual({
      transcript: 'banana',
      reply: 'I heard “banana”. Tap one, or say first or second.',
      count: 1,
    });
    await settle();
    expect(sent.slice(before)).toEqual([
      { method: 'POST', path: '/api/voice/tts', body: { text: 'I heard “banana”. Tap one, or say first or second.' } },
    ]);

    say('something else');
    expect(result.current.listening.missed?.reply).toBe(
      'I heard “something else”. Tap one, or say first or second. For example, say “first”.',
    );
    say('the first one');
    expect(result.current.listening.missed).toBeNull();
  });

  it('sorts help and commands on a screen that offers them, and boosts the command phrases', async () => {
    const { result, onResult } = mountTurn({
      screen: { help: ['repeat'], commands: [{ id: 'make_it_mine', phrases: ['make it mine'] }] },
    });
    await makeItMine(result);
    expect(new URL(socket().url).searchParams.getAll('keyterm')).toEqual(['make it mine']);
    act(() => socket().open());
    say('say that again');
    say("let's make it mine");
    expect(onResult.mock.calls.map(([u]) => u)).toEqual([
      { kind: 'help', help: 'repeat', transcript: 'say that again' },
      { kind: 'command', command: 'make_it_mine', transcript: "let's make it mine" },
    ]);
    expect(result.current.listening.missed).toBeNull();
  });

  it('a turn paused while its socket is still starting listens again when it resumes', async () => {
    // The shell's save flickers `enabled` as a turn opens: the start in flight is cancelled, and the
    // turn must not take that as "stop listening".
    const { result, rerender } = mountTurn({ enabled: false });
    await makeItMine(result);
    expect(FakeWebSocket.instances).toHaveLength(0);
    rerender({ enabled: true }); // the start asks for its token...
    rerender({ enabled: false }); // ...and is cancelled before it arrives
    rerender({ enabled: true });
    await settle();
    expect(FakeWebSocket.instances).toHaveLength(1);
    act(() => socket().open());
    expect(result.current.listening.listening).toBe(true);
  });

  it('a socket dropped mid-turn is reopened once with a new token, on the same microphone', async () => {
    const { result } = mountTurn();
    await makeItMine(result);
    act(() => socket().open());
    act(() => socket().drop());
    await settle();
    expect(FakeWebSocket.instances).toHaveLength(2);
    expect(socket().protocols).toEqual(['bearer', 'dg-2']);
    act(() => socket().open());
    expect(getUserMedia).toHaveBeenCalledTimes(1);
    expect(trackStop).not.toHaveBeenCalled();
    expect(FakeMediaRecorder.instances.at(-1)!.stream).toBe(micStream);
    expect(FakeMediaRecorder.instances.at(-1)!.state).toBe('recording');
    expect(result.current.listening.listening).toBe(true);

    // Only once: a second drop leaves the turn to the cards.
    act(() => socket().drop());
    await settle();
    expect(FakeWebSocket.instances).toHaveLength(2);
    expect(result.current.listening.listening).toBe(false);
    expect(result.current.listening.available).toBe(true);
  });

  it('when the first socket is refused with keyterms, reopens once without them and keeps them off for the pass', async () => {
    const { result, rerender } = mountTurn();
    await makeItMine(result);
    act(() => socket().refuse());
    await settle();
    expect(FakeWebSocket.instances).toHaveLength(2);
    expect(new URL(socket().url).searchParams.getAll('keyterm')).toEqual([]);
    expect(voiceInputs()).toEqual([{ state: 'keyterms_off' }]);
    act(() => socket().open());
    expect(result.current.listening.listening).toBe(true);

    // The next turn opens without them, and says nothing again.
    rerender({ enabled: false });
    rerender({ enabled: true });
    await settle();
    expect(new URL(socket().url).searchParams.getAll('keyterm')).toEqual([]);
    expect(voiceInputs()).toEqual([{ state: 'keyterms_off' }]);
  });

  it('a refused microphone leaves the turn to the cards: denied once, never asked again, nothing matched', async () => {
    getUserMedia.mockImplementation(async () => {
      throw new DOMException('Permission denied', 'NotAllowedError');
    });
    const { result, onResult } = mountTurn();
    await makeItMine(result);
    expect(result.current.voice.input).toBe('denied');
    expect(result.current.listening.available).toBe(false);
    expect(voiceInputs()).toEqual([{ state: 'denied' }]);
    act(() => result.current.voice.openMic());
    act(() => result.current.listening.toggle());
    await settle();
    expect(getUserMedia).toHaveBeenCalledTimes(1);
    expect(sent.filter((r) => r.path.startsWith('/api/voice/stream-token'))).toEqual([]);
    expect(FakeWebSocket.instances).toEqual([]);
    expect(onResult).not.toHaveBeenCalled();
  });

  it('no transcription here (the token route answers 503): unavailable once, and the microphone is let go', async () => {
    tokenStatus = 503;
    const { result } = mountTurn();
    await makeItMine(result);
    expect(result.current.voice.input).toBe('unavailable');
    expect(result.current.listening.available).toBe(false);
    expect(voiceInputs()).toEqual([{ state: 'unavailable' }]);
    expect(trackStop).toHaveBeenCalled();
    expect(FakeWebSocket.instances).toEqual([]);
  });

  it('a browser that cannot listen says so once and never asks for the microphone', async () => {
    vi.stubGlobal('MediaRecorder', undefined);
    const { result } = mountTurn();
    await makeItMine(result);
    expect(result.current.voice.input).toBe('unsupported');
    expect(result.current.listening.available).toBe(false);
    expect(getUserMedia).not.toHaveBeenCalled();
    expect(voiceInputs()).toEqual([{ state: 'unsupported' }]);
  });

  it('after 6 s of quiet once Rivet is done, stops listening and says so once; the mic tap listens again', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'] });
    try {
      const { result } = mountTurn();
      await makeItMine(result);
      act(() => socket().open());
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5_900);
      });
      expect(result.current.listening.quiet).toBe(false);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(200);
      });
      expect(result.current.listening.quiet).toBe(true);
      expect(result.current.listening.listening).toBe(false);

      act(() => result.current.listening.toggle());
      await settle();
      expect(FakeWebSocket.instances).toHaveLength(2);
      act(() => socket().open());
      expect(result.current.listening.listening).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a closed turn closes its socket but keeps the microphone for the next one', async () => {
    const { result, rerender, unmount } = mountTurn();
    await makeItMine(result);
    const first = socket();
    act(() => first.open());
    rerender({ enabled: false });
    expect(first.readyState).toBe(3);
    expect(trackStop).not.toHaveBeenCalled();
    unmount();
    expect(trackStop).toHaveBeenCalled();
  });
});
