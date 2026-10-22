import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { trackFunnel, type FunnelContext } from '../lib/analytics';
import { interpretUtterance, unclearReply, type Utterance, type UtteranceScreen } from '../lib/onboarding-utterance';
import { apiFetch } from '../utils/api-fetch';
import { dictationSupported, useDeepgramDictation } from './useDeepgramDictation';
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
 * S3-5 — Rivet listens. The microphone is asked for once, inside the "Make it
 * mine" tap after the audio is unlocked (or inside a tap on the mic, for an
 * owner who came back to a turn), and kept for the whole pass, so there is one
 * permission prompt. Each turn opens its own Deepgram socket with a fresh 30 s
 * token (`useRivetTurnListener`) and closes it when the turn goes, so no socket
 * outlives its token. A refused microphone, a browser that cannot listen, or
 * no transcription on the server (503) leaves every turn to the cards, with no
 * banner. `v3_voice_input` records which, once per mount.
 */

export type RivetVoiceGesture = 'start' | 'make_it_mine' | 'keep_as_is';
type TtsFallbackReason = 'rate_limited' | 'not_configured' | 'tts_failed' | 'network' | 'playback' | 'autoplay';

/**
 * Whether Rivet can hear the owner this pass: `off` (not asked yet), `asking` (the
 * browser is asking), `on` (the microphone is held), or one of the three ways it
 * cannot: the owner said no, the browser cannot, or the server has no transcription.
 */
export type VoiceInputState = 'off' | 'asking' | 'on' | 'denied' | 'unsupported' | 'unavailable';
type VoiceInputEvent = 'denied' | 'unsupported' | 'unavailable' | 'keyterms_off';
const CANNOT_LISTEN: ReadonlySet<VoiceInputState> = new Set(['denied', 'unsupported', 'unavailable']);

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
  /** Call inside a tap, after `unlock`: ask for the microphone once, for the whole pass. */
  openMic: () => void;
  input: VoiceInputState;
  /** The microphone, while it is held. */
  stream: MediaStream | null;
  /** Deepgram refused the option-label boost once this pass: open sockets without it. */
  keytermsOff: boolean;
  /** For the turn listening: transcription is not set up here, or the boost was refused. */
  noteInput: (event: 'unavailable' | 'keyterms_off') => void;
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

  const [input, setInput] = useState<VoiceInputState>('off');
  const inputRef = useRef<VoiceInputState>('off');
  const [stream, setStream] = useState<MediaStream | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [keytermsOff, setKeytermsOff] = useState(false);
  const inputEventsSent = useRef(new Set<VoiceInputEvent>());
  const mounted = useRef(true);

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

  const recordInput = useCallback((event: VoiceInputEvent) => {
    if (inputEventsSent.current.has(event)) return;
    inputEventsSent.current.add(event);
    trackFunnel('v3_voice_input', funnelRef.current, { state: event });
  }, []);

  const moveInput = useCallback(
    (next: VoiceInputState) => {
      inputRef.current = next;
      setInput(next);
      if (next === 'denied' || next === 'unsupported' || next === 'unavailable') recordInput(next);
    },
    [recordInput],
  );

  const letGoOfMic = useCallback(() => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    setStream(null);
  }, []);

  const openMic = useCallback(() => {
    if (inputRef.current !== 'off') return;
    if (!dictationSupported()) {
      moveInput('unsupported');
      return;
    }
    moveInput('asking');
    let asked: Promise<MediaStream>;
    try {
      // Called inside the tap, so the browser ties its prompt to the owner's gesture.
      asked = navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    } catch (err) {
      asked = Promise.reject(err instanceof Error ? err : new Error(String(err)));
    }
    asked.then(
      (held) => {
        if (!mounted.current) {
          held.getTracks().forEach((t) => t.stop());
          return;
        }
        streamRef.current = held;
        setStream(held);
        moveInput('on');
      },
      (err: unknown) => {
        if (!mounted.current) return;
        const refused = err instanceof DOMException && (err.name === 'NotAllowedError' || err.name === 'SecurityError');
        moveInput(refused ? 'denied' : 'unavailable');
      },
    );
  }, [moveInput]);

  const noteInput = useCallback(
    (event: 'unavailable' | 'keyterms_off') => {
      if (event === 'keyterms_off') {
        setKeytermsOff(true);
        recordInput('keyterms_off');
        return;
      }
      if (CANNOT_LISTEN.has(inputRef.current)) return;
      letGoOfMic();
      moveInput('unavailable');
    },
    [letGoOfMic, moveInput, recordInput],
  );

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      streamRef.current?.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    };
  }, []);

  const speaking = audioPlaying || ttsSpeaking;
  return useMemo(
    () => ({ unlock, speak, prefetch: fetchBatch, stop, speaking, openMic, input, stream, keytermsOff, noteInput }),
    [unlock, speak, fetchBatch, stop, speaking, openMic, input, stream, keytermsOff, noteInput],
  );
}

/** The shell's voice, for the screens it renders. Null outside the v3 shell: those screens stay silent. */
export const RivetVoiceContext = createContext<RivetVoice | null>(null);

/** Rivet is speaking (for the "Speaking" mark). False outside the shell. */
export function useRivetSpeaking(): boolean {
  return useContext(RivetVoiceContext)?.speaking ?? false;
}

/**
 * Rivet can hear the owner on this screen: inside the shell, on a browser that can listen, and
 * nothing has ruled it out this pass (a refused microphone, no transcription on the server).
 * Copy that tells the owner to say something reads this, so it never promises what cannot happen.
 */
export function useRivetCanListen(): boolean {
  const voice = useContext(RivetVoiceContext);
  return voice !== null && dictationSupported() && !CANNOT_LISTEN.has(voice.input);
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

/** Deepgram's trailing silence that ends an utterance (the spec's 1.2 s). */
const UTTERANCE_END_MS = 1200;
/** Quiet this long once Rivet is done, and the turn stops listening ("Take your time"). */
const QUIET_MS = 6000;

/** The last answer that meant nothing on this screen: what was heard, and what Rivet said back. */
export interface RivetMiss {
  transcript: string;
  /** `unclearReply`: shown in the transcript card and said aloud. */
  reply: string;
  /** Misses in a row on this turn, this one included. */
  count: number;
}

export interface RivetListening {
  /** The mic belongs on this turn: the shell can listen, and nothing has ruled it out. */
  available: boolean;
  /** The turn's socket is open and the owner's words are being heard. */
  listening: boolean;
  /** What is being heard right now (the interim words), for the transcript card. */
  partial: string;
  /** The owner was quiet for 6 s after Rivet finished: the turn stopped listening. Once per turn. */
  quiet: boolean;
  /** The last answer was unclear (cleared by the next one that wasn't). */
  missed: RivetMiss | null;
  /** The mic tap: stop listening, or listen again (asking for the microphone if it never was). */
  toggle: () => void;
}

export interface RivetTurnListenerOptions {
  /** The turn listening (a choice key, or the screen's name). */
  turn: string;
  /** What this screen listens for: its cards, help, commands, free answers. Its words are sent to Deepgram as keyterms. */
  screen: UtteranceScreen;
  /** False while the owner is typing or an answer is being saved: the socket is closed. */
  enabled: boolean;
  /**
   * Every finished utterance, already sorted (`interpretUtterance`). An `unclear` one has
   * also been answered: Rivet says what he heard and what the screen accepts (`missed`).
   */
  onResult: (utterance: Utterance) => void;
}

/** What Deepgram is told to listen for on a screen: the card labels, "first"/"second", and its command phrases. */
function screenKeyterms(screen: UtteranceScreen): string[] {
  const terms = screen.options ? [screen.options[0].label, screen.options[1].label, 'first', 'second'] : [];
  for (const command of screen.commands ?? []) terms.push(...command.phrases);
  return terms;
}

/**
 * One screen listening, on the shell's microphone: a Deepgram socket opened when the
 * screen is up (fresh token, English, the screen's words boosted) and closed when it
 * goes. The owner talking over Rivet stops him at once (barge-in, the
 * useConversationVoice rule). Each finished utterance is sorted on the client
 * (`interpretUtterance`) before any server call. An unclear one is never silent:
 * Rivet says what he heard and what the screen accepts, with an example from the
 * second miss. A socket that drops mid-turn is reopened once with a new token on
 * the same microphone; a socket refused at open with the boost is reopened once
 * without it, and the boost stays off for the pass.
 */
export function useRivetTurnListener(voice: RivetVoice | null, opts: RivetTurnListenerOptions): RivetListening {
  const { turn, screen, enabled } = opts;
  const voiceRef = useRef(voice);
  voiceRef.current = voice;
  const onResultRef = useRef(opts.onResult);
  onResultRef.current = opts.onResult;
  const screenRef = useRef(screen);
  screenRef.current = screen;
  const [missed, setMissed] = useState<RivetMiss | null>(null);
  const missesRef = useRef(0);

  const supported = dictationSupported();
  const input = voice?.input ?? 'off';
  const available = voice !== null && supported && !CANNOT_LISTEN.has(input);

  // The owner wants this turn heard: on by default once the mic is being held or asked for.
  const [wanted, setWanted] = useState(input === 'on' || input === 'asking');
  const [attempt, setAttempt] = useState(0);
  const [quiet, setQuiet] = useState(false);
  // Bumped on every word heard: restarts the quiet clock.
  const [heardWords, setHeardWords] = useState(0);
  const reopened = useRef(false);
  const keytermsTried = useRef(false);
  const starting = useRef(false);
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;

  // The mic was asked for while this turn was up (a mic tap on a returning owner's turn).
  useEffect(() => {
    if (input === 'asking') setWanted(true);
  }, [input]);

  const keyterms = voice?.keytermsOff ? undefined : screenKeyterms(screen);

  const dictation = useDeepgramDictation({
    stream: voice?.stream ?? undefined,
    language: 'en',
    keyterms,
    utteranceEndMs: UTTERANCE_END_MS,
    onPartial: (text) => {
      if (!text.trim()) return;
      // Barge-in: the owner talking over Rivet stops him (audio element and speechSynthesis).
      voiceRef.current?.stop();
      setHeardWords((n) => n + 1);
    },
    onUtteranceEnd: (text) => {
      if (!enabledRef.current) return;
      setHeardWords((n) => n + 1);
      const utterance = interpretUtterance(text, screenRef.current);
      if (utterance.kind === 'unclear') {
        missesRef.current += 1;
        const reply = unclearReply(utterance.transcript, missesRef.current, screenRef.current);
        setMissed({ transcript: utterance.transcript, reply, count: missesRef.current });
        void voiceRef.current?.speak(reply, { turn });
      } else {
        missesRef.current = 0;
        setMissed(null);
      }
      onResultRef.current(utterance);
    },
    onClose: ({ opened }) => {
      const v = voiceRef.current;
      if (!opened && keytermsTried.current && v && !v.keytermsOff) {
        // Refused at open with the boost on: the plan tier may not have it. Once more, without.
        v.noteInput('keyterms_off');
        setAttempt((n) => n + 1);
        return;
      }
      if (!reopened.current) {
        reopened.current = true;
        setAttempt((n) => n + 1);
        return;
      }
      setWanted(false);
    },
  });
  const { stop: stopDictation, isRecording } = dictation;
  // The latest start, read by the effect below: it runs on `live` and `attempt` only, never because
  // the dictation hook re-created its callback.
  const startRef = useRef(dictation.start);
  startRef.current = dictation.start;

  const live = available && enabled && wanted && input === 'on' && voice.stream !== null;
  const liveRef = useRef(live);
  liveRef.current = live;
  useEffect(() => {
    if (!live || starting.current) return;
    starting.current = true;
    keytermsTried.current = !voiceRef.current?.keytermsOff;
    void startRef
      .current()
      .then((outcome) => {
        if (outcome === 'unavailable') voiceRef.current?.noteInput('unavailable');
        // Cancelled: the turn paused (an answer saving, the owner typing) while this start was asking for
        // its token. Not a refusal: if the turn is listening again by now, start over.
        else if (outcome === 'cancelled') {
          starting.current = false;
          if (liveRef.current) setAttempt((n) => n + 1);
        } else if (outcome !== 'connecting') setWanted(false);
      })
      .finally(() => {
        starting.current = false;
      });
  }, [live, attempt]);

  useEffect(() => {
    if (!live) stopDictation();
  }, [live, stopDictation]);

  // Quiet: 6 s with no words once Rivet has finished, then the turn stops listening.
  const speaking = voice?.speaking ?? false;
  useEffect(() => {
    if (!isRecording || speaking) return;
    const timer = setTimeout(() => {
      setQuiet(true);
      setWanted(false);
    }, QUIET_MS);
    return () => clearTimeout(timer);
  }, [isRecording, speaking, heardWords, turn]);

  const toggle = useCallback(() => {
    const v = voiceRef.current;
    if (!v || !dictationSupported() || CANNOT_LISTEN.has(v.input)) return;
    if (live || isRecording) {
      setWanted(false);
      return;
    }
    reopened.current = false;
    if (v.input === 'off') v.openMic();
    setWanted(true);
    setAttempt((n) => n + 1);
  }, [live, isRecording]);

  return { available, listening: isRecording && live, partial: live ? dictation.partial : '', quiet, missed, toggle };
}
