import type { TtsStreamChunk, TtsSynthesizeStreamInput } from './tts-provider';

export interface ElevenLabsStreamConnectionOpts {
  apiKey: string;
  voiceId: string;
  modelId: string;
  /** Optional override for the WebSocket URL (used in tests). */
  baseUrl?: string;
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
    const queue: TtsStreamChunk[] = [];
    let done = false;
    let waiter: { resolve: (v: IteratorResult<TtsStreamChunk>) => void; reject: (err: Error) => void } | null = null;
    let errorState: Error | null = null;

    const push = (chunk: TtsStreamChunk): void => {
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
        if (errorState) {
          const e = errorState;
          errorState = null;
          return Promise.reject(e);
        }
        const queued = queue.shift();
        if (queued) return Promise.resolve({ value: queued, done: false });
        if (done) return Promise.resolve({ value: undefined as unknown as TtsStreamChunk, done: true });
        return new Promise((resolve, reject) => {
          waiter = { resolve, reject };
        });
      },
      return: (): Promise<IteratorResult<TtsStreamChunk>> => {
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
