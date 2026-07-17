import type { TtsStreamChunk, TtsSynthesizeStreamInput } from './tts-provider';

/**
 * VOX-33 — max wait for the NEXT audio frame (connect→first-frame and
 * between-frames both). The REST synthesize() path already bounds itself
 * with AbortSignal.timeout(30s); the streaming path had no timer at all,
 * so a silent stall (WS opens but never emits, or goes quiet mid-utterance)
 * would hang the consumer's `for await` until the 30-minute call idle
 * timeout — ~1200x the 1.5s voice-turn SLO, i.e. dead air for the caller.
 *
 * The bound is per-frame (re-armed on every chunk), not a whole-stream
 * ceiling, so a long-but-healthy utterance streaming steadily is never
 * cut off — only genuine silence trips it. 4s is comfortably above the
 * ~250-800ms real time-to-first-frame yet far below the idle-timeout
 * catastrophe, and the reject feeds the same error path as a WS error,
 * which the media-streams adapter now recovers from (VOX-35).
 */
export const ELEVENLABS_STREAM_INACTIVITY_MS = 4_000;

export interface ElevenLabsStreamConnectionOpts {
  apiKey: string;
  voiceId: string;
  modelId: string;
  /** Optional override for the WebSocket URL (used in tests). */
  baseUrl?: string;
  /** Test seam / tuning override for the per-frame inactivity bound (ms). */
  inactivityTimeoutMs?: number;
}

/**
 * Thin wrapper over the ElevenLabs WebSocket streaming TTS endpoint.
 *
 * Endpoint: wss://api.elevenlabs.io/v1/text-to-speech/{voice_id}/stream-input
 *
 * Audio frames arrive as JSON messages of shape `{ audio: <base64 pcm> }`
 * or `{ isFinal: true }`. We yield each base64 frame as a Buffer in a PCM
 * stream chunk and emit a final `isFinal=true` chunk when the upstream
 * signals end-of-stream OR the WebSocket closes.
 *
 * The caller can abort mid-stream by passing an AbortSignal — this closes
 * the WebSocket immediately so we stop paying for audio we will not play.
 */
export class ElevenLabsStreamConnection {
  private readonly baseUrl: string;

  constructor(private readonly opts: ElevenLabsStreamConnectionOpts) {
    this.baseUrl = opts.baseUrl ?? 'wss://api.elevenlabs.io';
  }

  synthesize(input: TtsSynthesizeStreamInput): AsyncIterable<TtsStreamChunk> {
    const { apiKey, voiceId, modelId } = this.opts;
    const baseUrl = this.baseUrl;
    return {
      [Symbol.asyncIterator]: () => this.openIterator(baseUrl, voiceId, apiKey, modelId, input),
    };
  }

  private openIterator(
    baseUrl: string,
    voiceId: string,
    apiKey: string,
    modelId: string,
    input: TtsSynthesizeStreamInput
  ): AsyncIterator<TtsStreamChunk> {
    const url =
      `${baseUrl.replace(/^http/, 'ws')}/v1/text-to-speech/${voiceId}/stream-input` +
      `?model_id=${modelId}&xi-api-key=${apiKey}`;
    const ws = new WebSocket(url);
    const inactivityMs = this.opts.inactivityTimeoutMs ?? ELEVENLABS_STREAM_INACTIVITY_MS;
    const queue: TtsStreamChunk[] = [];
    let done = false;
    let waiter: { resolve: (v: IteratorResult<TtsStreamChunk>) => void; reject: (err: Error) => void } | null = null;
    let errorState: Error | null = null;

    // VOX-33 — per-frame inactivity timer. Armed only while a consumer is
    // actually awaiting the next frame; cleared on any activity (a pushed
    // chunk) or terminal state (finish/return). On expiry we synthesize a
    // WS-error-equivalent and close the socket so the same error path runs.
    let inactivityTimer: ReturnType<typeof setTimeout> | null = null;
    const clearInactivity = (): void => {
      if (inactivityTimer) {
        clearTimeout(inactivityTimer);
        inactivityTimer = null;
      }
    };
    const armInactivity = (): void => {
      clearInactivity();
      inactivityTimer = setTimeout(() => {
        inactivityTimer = null;
        if (done) return;
        if (!errorState) {
          errorState = new Error(
            `ElevenLabs stream inactivity timeout after ${inactivityMs}ms`,
          );
        }
        try {
          ws.close();
        } catch {
          /* swallow */
        }
        // Surface immediately in case the WS 'close' event is async (real
        // WHATWG sockets) — finish() is idempotent via the `done` guard.
        finish();
      }, inactivityMs);
      if (typeof inactivityTimer.unref === 'function') inactivityTimer.unref();
    };

    const push = (chunk: TtsStreamChunk): void => {
      // A frame arrived → activity. Cancel the stall timer; next() re-arms
      // it if the consumer has to wait again.
      clearInactivity();
      if (waiter) {
        const w = waiter;
        waiter = null;
        w.resolve({ value: chunk, done: false });
      } else {
        queue.push(chunk);
      }
    };

    const finish = (): void => {
      if (done) return;
      done = true;
      clearInactivity();
      if (waiter) {
        const w = waiter;
        waiter = null;
        if (errorState) {
          const e = errorState;
          errorState = null;
          w.reject(e);
        } else {
          w.resolve({ value: undefined as unknown as TtsStreamChunk, done: true });
        }
      }
    };

    ws.addEventListener('open', () => {
      // BOS frame carries voice settings — ElevenLabs requires a space-only
      // initial chunk to start the session. This aligns streaming voice
      // characteristics with the REST synthesize() path.
      ws.send(JSON.stringify({
        text: ' ',
        voice_settings: { stability: 0.5, similarity_boost: 0.75 },
      }));
      // Send the text payload + an empty terminator per ElevenLabs WS protocol.
      ws.send(JSON.stringify({ text: input.text + ' ' }));
      ws.send(JSON.stringify({ text: '' }));
    });

    ws.addEventListener('message', (msg: MessageEvent) => {
      try {
        const data = JSON.parse(String(msg.data)) as {
          audio?: string;
          isFinal?: boolean;
        };
        if (data.audio) {
          push({ pcm: Buffer.from(data.audio, 'base64'), isFinal: false });
        }
        if (data.isFinal) {
          push({ pcm: Buffer.alloc(0), isFinal: true });
        }
      } catch {
        // Drop malformed frame.
      }
    });

    ws.addEventListener('error', () => {
      errorState = new Error('ElevenLabs WS error');
      try {
        ws.close();
      } catch {
        /* swallow */
      }
    });

    ws.addEventListener('close', () => {
      // Signal end-of-stream. If the upstream already sent an isFinal message,
      // that chunk is already in the queue. Either way, mark the iterator done.
      finish();
    });

    input.signal?.addEventListener('abort', () => {
      try {
        ws.close();
      } catch {
        /* swallow */
      }
    });

    return {
      next: (): Promise<IteratorResult<TtsStreamChunk>> => {
        // VOX-35a — drain already-queued valid PCM BEFORE surfacing an
        // error. A WS 'error' can fire after good frames are queued; the
        // old order checked errorState first and discarded them, cutting
        // the utterance short (dead air). Deliver every buffered frame,
        // THEN report the error so the adapter's fallback runs only once
        // the good audio is exhausted.
        const queued = queue.shift();
        if (queued) return Promise.resolve({ value: queued, done: false });
        if (errorState) {
          const e = errorState;
          errorState = null;
          return Promise.reject(e);
        }
        if (done) return Promise.resolve({ value: undefined as unknown as TtsStreamChunk, done: true });
        return new Promise((resolve, reject) => {
          waiter = { resolve, reject };
          // Consumer is now waiting on the next frame — arm the stall bound.
          armInactivity();
        });
      },
      return: (): Promise<IteratorResult<TtsStreamChunk>> => {
        clearInactivity();
        try {
          ws.close();
        } catch {
          /* swallow */
        }
        finish();
        return Promise.resolve({ value: undefined as unknown as TtsStreamChunk, done: true });
      },
    };
  }
}
