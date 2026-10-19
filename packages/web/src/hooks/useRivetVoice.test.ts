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
 */
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const track = vi.hoisted(() => ({ trackFunnel: vi.fn(), track: vi.fn() }));
vi.mock('../lib/analytics', () => track);

import { useRivetVoice, type RivetVoice } from './useRivetVoice';

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
