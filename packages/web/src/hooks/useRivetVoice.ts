import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { trackFunnel, type FunnelContext } from '../lib/analytics';
import { apiFetch } from '../utils/api-fetch';
import { useTTS } from './useTTS';

/**
 * S3-3 (plan U4) — Rivet speaks, in the tenant's voice from the server.
 *
 * One HTMLAudioElement, created lazily and unlocked inside a tap (iOS lets an
 * element play later only if it played inside a user gesture), then kept warm
 * for the whole pass. A choice turn's lines (the question and the two option
 * lines) arrive in one `POST /api/voice/tts/batch`; the next turn is fetched
 * once the current one has arrived, so it downloads while the current line
 * plays and the client is never more than one turn ahead (the per-user clip
 * budget is about 18 clips a minute for a fast owner, inside the 20). Lines
 * outside the seven turns go through the single-clip `POST /api/voice/tts`.
 * A clip already received replays from memory, or after a reload from the
 * free `GET /api/voice/tts/clip/:hash`; nothing is charged twice.
 *
 * Fallback order, per line: the server clip, then the browser's
 * speechSynthesis (`useTTS`), then silence (the heading is on screen). A 429,
 * 501, 502, a network failure, an element error or a refused `play()`
 * degrades the rest of that turn and records `v3_tts_fallback` once for it.
 * Nothing here blocks a turn: the cards and Next render whatever happens.
 *
 * The listening half (mic, barge-in, first/second) is S3-5.
 */

export type RivetVoiceGesture = 'start' | 'make_it_mine' | 'keep_as_is';
type TtsFallbackReason = 'rate_limited' | 'not_configured' | 'tts_failed' | 'network' | 'playback' | 'autoplay';

export interface SpeakOptions {
  /** The turn this line belongs to: a choice key, or 'ready' / 'readback' / 'trial' / 'number'. */
  turn: string;
  /** The whole turn's lines (question, then the two option lines): fetched together as one batch. */
  with?: readonly string[];
}

export interface RivetVoice {
  /** Call inside a tap handler: plays the kept-warm element so later lines may play. */
  unlock: (gesture: RivetVoiceGesture) => void;
  /** Say one line, interrupting whatever Rivet was saying. Resolves when it is done (or given up). */
  speak: (text: string, opts: SpeakOptions) => Promise<void>;
  /** Fetch a turn's lines ahead of time, after anything already being fetched. */
  prefetch: (lines: readonly string[]) => void;
  /** Stop speaking. */
  stop: () => void;
  /** Rivet is speaking right now (a server clip or speechSynthesis). */
  speaking: boolean;
}

interface Clip {
  src: string;
  hash: string;
}
type Held = { clip: Clip } | { failed: TtsFallbackReason };

/** A 44-byte WAV with no samples: what the unlock plays inside the tap. */
const SILENT_WAV = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQAAAAA=';
/** One turn, as the batch route bounds it. */
const BATCH_MAX_ITEMS = 3;
/** Per-viewer convenience: the hashes of clips already heard, so a reload replays them for free. */
const HASH_INDEX_KEY = 'rivet-voice:clip-hashes';
const HASH_INDEX_MAX = 64;

function reasonForStatus(status: number): TtsFallbackReason {
  if (status === 429) return 'rate_limited';
  if (status === 501) return 'not_configured';
  return 'tts_failed';
}

const dataUri = (contentType: string, audio: string) => `data:${contentType};base64,${audio}`;

function base64Of(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

function readHashIndex(): Map<string, string> {
  try {
    const raw = sessionStorage.getItem(HASH_INDEX_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : {};
    return new Map(Object.entries(parsed as Record<string, string>).filter(([, v]) => typeof v === 'string'));
  } catch {
    return new Map();
  }
}

function writeHashIndex(index: Map<string, string>): void {
  try {
    const recent = [...index.entries()].slice(-HASH_INDEX_MAX);
    sessionStorage.setItem(HASH_INDEX_KEY, JSON.stringify(Object.fromEntries(recent)));
  } catch {
    /* no storage (private window, blocked site data): replays still come from memory */
  }
}

interface ClipBody {
  clipHash: string;
  audio: string;
  contentType: string;
}

async function requestBatch(items: string[]): Promise<Map<string, Held>> {
  const out = new Map<string, Held>();
  try {
    const res = await apiFetch('/api/voice/tts/batch', { method: 'POST', body: JSON.stringify({ items }) });
    if (!res.ok) {
      const failed = reasonForStatus(res.status);
      for (const text of items) out.set(text, { failed });
      return out;
    }
    const body = (await res.json()) as { clips: Array<ClipBody & { text: string }> };
    for (const c of body.clips) out.set(c.text, { clip: { src: dataUri(c.contentType, c.audio), hash: c.clipHash } });
  } catch {
    for (const text of items) out.set(text, { failed: 'network' });
  }
  return out;
}

async function requestSingle(text: string): Promise<Held> {
  try {
    const res = await apiFetch('/api/voice/tts', { method: 'POST', body: JSON.stringify({ text }) });
    if (!res.ok) return { failed: reasonForStatus(res.status) };
    const c = (await res.json()) as ClipBody;
    return { clip: { src: dataUri(c.contentType, c.audio), hash: c.clipHash } };
  } catch {
    return { failed: 'network' };
  }
}

/** A clip the server already holds, read by hash: never charged, never synthesized. A miss is null. */
async function readByHash(hash: string): Promise<Clip | null> {
  try {
    const res = await apiFetch(`/api/voice/tts/clip/${hash}`);
    if (!res.ok) return null;
    const contentType = res.headers.get('Content-Type') ?? 'audio/mpeg';
    return { src: dataUri(contentType, base64Of(await res.arrayBuffer())), hash };
  } catch {
    return null;
  }
}

export function useRivetVoice(opts: { funnel: FunnelContext }): RivetVoice {
  const { speak: ttsSpeak, stop: ttsStop, isSpeaking: ttsSpeaking, isSupported: ttsSupported } = useTTS();
  const funnelRef = useRef(opts.funnel);
  funnelRef.current = opts.funnel;

  const [audioPlaying, setAudioPlaying] = useState(false);
  const elementRef = useRef<HTMLAudioElement | null>(null);
  const unlockedRef = useRef(false);
  const generation = useRef(0);
  const settlePlayback = useRef<(() => void) | null>(null);

  const held = useRef(new Map<string, Held>());
  const inflight = useRef(new Map<string, Promise<unknown>>());
  const batchChain = useRef<Promise<unknown>>(Promise.resolve());
  const hashIndex = useRef<Map<string, string> | null>(null);
  const degradedTurns = useRef(new Set<string>());

  const committed = useRef<{ at: number; gesture: RivetVoiceGesture } | null>(null);
  const firstHeardSent = useRef(false);

  const hashes = () => (hashIndex.current ??= readHashIndex());

  const keep = useCallback((text: string, result: Held) => {
    held.current.set(text, result);
    if ('clip' in result) {
      hashes().set(text, result.clip.hash);
      writeHashIndex(hashes());
    }
  }, []);

  const noteHeard = useCallback((source: 'server' | 'speech_synthesis') => {
    const commit = committed.current;
    if (!commit || firstHeardSent.current) return;
    firstHeardSent.current = true;
    trackFunnel('v3_first_heard', funnelRef.current, {
      ms_since_make_it_mine: Math.max(0, Math.round(performance.now() - commit.at)),
      source,
      gesture: commit.gesture,
    });
  }, []);

  useEffect(() => {
    if (ttsSpeaking) noteHeard('speech_synthesis');
  }, [ttsSpeaking, noteHeard]);

  const element = () => (elementRef.current ??= new Audio());

  const halt = useCallback(() => {
    const el = elementRef.current;
    if (el) {
      el.onplaying = null;
      el.onended = null;
      el.onerror = null;
      el.pause();
    }
    settlePlayback.current?.();
    settlePlayback.current = null;
    setAudioPlaying(false);
    ttsStop();
  }, [ttsStop]);

  useEffect(() => halt, [halt]);

  const unlock = useCallback((gesture: RivetVoiceGesture) => {
    if (gesture !== 'start' && !committed.current) committed.current = { at: performance.now(), gesture };
    if (unlockedRef.current) return;
    unlockedRef.current = true;
    const el = element();
    el.src = SILENT_WAV;
    try {
      // jsdom and some older engines return undefined rather than a promise.
      const started = el.play() as Promise<void> | undefined;
      if (started) {
        started.catch(() => {
          /* the next real clip tries again and degrades on its own */
        });
      }
    } catch {
      /* same */
    }
  }, []);

  const fetchBatch = useCallback(
    (lines: readonly string[]) => {
      const wanted = [...new Set(lines.map((l) => l.trim()).filter(Boolean))]
        .filter((t) => !held.current.has(t) && !inflight.current.has(t))
        .slice(0, BATCH_MAX_ITEMS);
      if (wanted.length === 0) return;
      // After whatever is already being fetched: the current turn first, then the next.
      const run = batchChain.current
        .then(() => requestBatch(wanted))
        .then((results) => {
          for (const text of wanted) keep(text, results.get(text) ?? { failed: 'tts_failed' });
        })
        .finally(() => {
          for (const text of wanted) inflight.current.delete(text);
        });
      batchChain.current = run.catch(() => undefined);
      for (const text of wanted) inflight.current.set(text, run);
    },
    [keep],
  );

  const fetchSingle = useCallback(
    (text: string) => {
      const run = (async () => {
        const known = hashes().get(text);
        const replay = known ? await readByHash(known) : null;
        keep(text, replay ? { clip: replay } : await requestSingle(text));
      })().finally(() => inflight.current.delete(text));
      inflight.current.set(text, run);
    },
    [keep],
  );

  const clipFor = useCallback(
    async (text: string, withLines?: readonly string[]): Promise<Held> => {
      if (!inflight.current.has(text)) {
        if (withLines?.some((l) => l.trim() === text)) fetchBatch(withLines);
        if (!inflight.current.has(text)) fetchSingle(text);
      }
      await inflight.current.get(text)?.catch(() => undefined);
      return held.current.get(text) ?? { failed: 'tts_failed' };
    },
    [fetchBatch, fetchSingle],
  );

  /** Plays one clip on the warm element. Resolves at its end (or when superseded); rejects with why it could not play. */
  const playClip = useCallback(
    (src: string, mine: number) =>
      new Promise<void>((resolve, reject) => {
        const el = element();
        let settled = false;
        const settle = (fn: () => void) => {
          if (settled) return;
          settled = true;
          settlePlayback.current = null;
          setAudioPlaying(false);
          fn();
        };
        settlePlayback.current = () => settle(resolve);
        el.onplaying = () => {
          if (mine !== generation.current) return;
          setAudioPlaying(true);
          noteHeard('server');
        };
        el.onended = () => settle(resolve);
        el.onerror = () => settle(() => reject(new Error('playback')));
        el.src = src;
        try {
          const started = el.play() as Promise<void> | undefined;
          if (started) {
            started.catch((err: unknown) =>
              settle(() => reject(new Error(err instanceof DOMException && err.name === 'NotAllowedError' ? 'autoplay' : 'playback'))),
            );
          }
        } catch {
          settle(() => reject(new Error('playback')));
        }
      }),
    [noteHeard],
  );

  const fallBack = useCallback(
    async (reason: TtsFallbackReason, turn: string, text: string, mine: number) => {
      const mode = ttsSupported ? 'speech_synthesis' : 'silent';
      if (!degradedTurns.current.has(turn)) {
        degradedTurns.current.add(turn);
        trackFunnel('v3_tts_fallback', funnelRef.current, { reason, mode, turn });
      }
      if (mode === 'speech_synthesis' && mine === generation.current) await ttsSpeak(text);
    },
    [ttsSupported, ttsSpeak],
  );

  const speak = useCallback(
    async (raw: string, { turn, with: withLines }: SpeakOptions) => {
      const text = raw.trim();
      if (!text) return;
      const mine = ++generation.current;
      halt();
      if (degradedTurns.current.has(turn)) {
        if (ttsSupported) await ttsSpeak(text);
        return;
      }
      // A clip already held plays in this same task (no await), so a line asked for inside a tap plays inside it.
      const result = held.current.get(text) ?? (await clipFor(text, withLines));
      if (mine !== generation.current) return;
      if ('failed' in result) {
        await fallBack(result.failed, turn, text, mine);
        return;
      }
      try {
        await playClip(result.clip.src, mine);
      } catch (err) {
        if (mine !== generation.current) return;
        await fallBack((err as Error).message === 'autoplay' ? 'autoplay' : 'playback', turn, text, mine);
      }
    },
    [halt, clipFor, playClip, fallBack, ttsSupported, ttsSpeak],
  );

  const stop = useCallback(() => {
    generation.current += 1;
    halt();
  }, [halt]);

  const speaking = audioPlaying || ttsSpeaking;
  return useMemo(() => ({ unlock, speak, prefetch: fetchBatch, stop, speaking }), [unlock, speak, fetchBatch, stop, speaking]);
}

/** The shell's voice, for the screens it renders. Null outside the v3 shell: those screens stay silent. */
export const RivetVoiceContext = createContext<RivetVoice | null>(null);

/** Rivet is speaking (for the "Speaking" mark). False outside the shell. */
export function useRivetSpeaking(): boolean {
  return useContext(RivetVoiceContext)?.speaking ?? false;
}

/**
 * Say `text` when the screen shows it (and again when it changes); stop when the screen goes.
 * `withLines` names the turn's batch, so a choice turn's lines arrive in one request.
 */
export function useRivetLine(turn: string, text: string | null | undefined, withLines?: readonly string[]): void {
  const voice = useContext(RivetVoiceContext);
  const speak = voice?.speak;
  const stop = voice?.stop;
  const linesKey = withLines?.join('\n') ?? '';
  useEffect(() => {
    if (!speak || !stop || !text) return;
    void speak(text, { turn, with: linesKey ? linesKey.split('\n') : undefined });
    return stop;
  }, [speak, stop, turn, text, linesKey]);
}
