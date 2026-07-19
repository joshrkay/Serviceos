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

/**
 * Detects an MP3 payload masquerading as raw PCM. Two signatures: an "ID3"
 * tag prefix, or an MPEG-1 Layer III frame header (0xFF 0xFA/0xFB …) —
 * the ONLY frame shape ElevenLabs mp3_44100_* streams emit. Restricting to
 * that exact shape matters because raw PCM16LE near silence legitimately
 * produces 0xFF/0x00 byte runs (e.g. sample -1 then +64 is FF FF 40 00,
 * which passes a generic MP3-header validity check); under the MPEG-1
 * Layer III restriction the second byte must be 0xFA/0xFB, reachable only
 * from a "loud" first sample of exactly -1025/-1281 — and for that residue
 * the next-frame sync-word check below rejects the coincidence, since real
 * MP3 frames repeat the sync at the computed frame boundary and PCM does
 * not. Free-form (0000) and invalid (1111) bitrates are excluded both as
 * non-ElevenLabs and because a frame size can't be computed for them.
 */
export function looksLikeMp3(buf: Buffer): boolean {
  if (buf.length >= 3 && buf[0] === 0x49 && buf[1] === 0x44 && buf[2] === 0x33) return true; // "ID3"
  if (buf.length < 4 || buf[0] !== 0xff || (buf[1] & 0xe0) !== 0xe0) return false;
  const versionBits = (buf[1] >> 3) & 0x03; // 11 = MPEG-1
  const layerBits = (buf[1] >> 1) & 0x03; // 01 = Layer III
  const bitrateBits = (buf[2] >> 4) & 0x0f; // 0000 free / 1111 invalid
  const sampleRateBits = (buf[2] >> 2) & 0x03; // 11 = reserved
  if (versionBits !== 0x03 || layerBits !== 0x01 || bitrateBits === 0x00 || bitrateBits === 0x0f || sampleRateBits === 0x03) {
    return false;
  }
  const bitrateKbps = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0][bitrateBits];
  const sampleRate = [44100, 48000, 32000, 0][sampleRateBits];
  const padding = (buf[2] >> 1) & 0x01;
  const frameSize = Math.floor((144 * bitrateKbps * 1000) / sampleRate) + padding;
  if (buf.length >= frameSize + 2) {
    return buf[frameSize] === 0xff && (buf[frameSize + 1] & 0xe0) === 0xe0;
  }
  // Strict MPEG-1 Layer III header but the chunk is too short to verify the
  // next sync — treat as MP3 (random PCM hitting 0xFF 0xFA/0xFB plus valid
  // bitrate/rate bits is ~2e-5 per stream, vs. certain static if we let a
  // real MP3 through).
  return true;
}

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
 * The URL must pin `output_format=pcm_16000`: the endpoint's default is
 * mp3_44100, and every consumer of these chunks treats them as raw
 * PCM16@16k (the media-streams adapter mu-law-encodes the bytes directly),
 * so an unpinned stream plays as static with no error. The buffered REST
 * path already guards against this class of bug (`isRawPcmContentType`);
 * `looksLikeMp3` below is the streaming-side equivalent, checked on the
 * first frame so a provider-side default change fails loud instead of
 * playing noise to a live caller.
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
      `?model_id=${modelId}&output_format=pcm_16000&xi-api-key=${apiKey}`;
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

    let firstAudioChecked = false;
    // Runt-prefix buffer for the format guard: the classification must see
    // the TRUE STREAM START. If the provider splits a compressed header
    // across messages (e.g. "ff fb" then "90 44 …"), checking each chunk at
    // its own offset would miss the signature and stream MP3 as PCM static.
    // Sub-4-byte prefixes are therefore held (not played — 2 bytes of PCM is
    // ~60µs, inaudible) and prepended to the next chunk before classifying.
    let pendingFirstAudio: Buffer | null = null;
    ws.addEventListener('message', (msg: MessageEvent) => {
      try {
        const data = JSON.parse(String(msg.data)) as {
          audio?: string;
          isFinal?: boolean;
        };
        if (data.audio) {
          let pcm = Buffer.from(data.audio, 'base64');
          // First-frame format guard (see class doc): compressed audio here
          // means the output_format pin was lost or the provider default
          // changed — fail the turn loudly so the adapter's recovery path
          // runs, instead of mu-law-encoding MP3 bytes into caller static.
          if (!firstAudioChecked) {
            if (pendingFirstAudio) {
              pcm = Buffer.concat([pendingFirstAudio, pcm]);
              pendingFirstAudio = null;
            }
            if (pcm.length > 0 && pcm.length < 4) {
              // Hold the runt, but fall through (no early return): the same
              // message may also carry isFinal, whose flush below must run.
              pendingFirstAudio = pcm;
              pcm = Buffer.alloc(0);
            } else if (pcm.length >= 4) {
              firstAudioChecked = true;
              if (looksLikeMp3(pcm)) {
                if (!errorState) {
                  errorState = new Error(
                    'ElevenLabs stream returned compressed (MP3) audio — expected pcm_16000; refusing to play static',
                  );
                }
                try {
                  ws.close();
                } catch {
                  /* swallow */
                }
                finish();
                return;
              }
            }
          }
          if (pcm.length > 0) push({ pcm, isFinal: false });
        }
        if (data.isFinal) {
          // Flush a held runt so no audio is silently dropped at end-of-stream
          // (a <4-byte total stream can't be classified — deliver as-is).
          if (pendingFirstAudio) {
            push({ pcm: pendingFirstAudio, isFinal: false });
            pendingFirstAudio = null;
          }
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
