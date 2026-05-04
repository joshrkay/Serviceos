import { TranscriptionProvider } from './voice-service';

export type FetchLike = typeof fetch;

export interface TranscriptionResult {
  transcript: string;
  metadata: Record<string, unknown>;
}

/**
 * Production transcription provider backed by OpenAI Whisper.
 *
 * Accepts a signed audio URL (typically an R2 presigned GET), streams the
 * bytes into the Whisper API, and returns the transcript + provenance
 * metadata. `fetchImpl` is injectable so tests can exercise the request
 * shape and error handling without a network.
 */
export class OpenAiWhisperProvider implements TranscriptionProvider {
  constructor(
    private readonly apiKey: string,
    private readonly fetchImpl: FetchLike = fetch
  ) {}

  async transcribe(audioUrl: string): Promise<TranscriptionResult> {
    const audioResponse = await this.fetchImpl(audioUrl);
    if (!audioResponse.ok) {
      throw new Error(
        `Failed to fetch audio from ${audioUrl}: ${audioResponse.status}`
      );
    }
    const audioBlob = await audioResponse.blob();

    const fd = new FormData();
    fd.append('file', audioBlob, 'audio.webm');
    fd.append('model', 'whisper-1');

    const res = await this.fetchImpl('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.apiKey}` },
      body: fd,
    });
    if (!res.ok) {
      const errBody = await res.text();
      throw new Error(`Whisper API error ${res.status}: ${errBody}`);
    }

    const data = (await res.json()) as { text?: string };
    return {
      transcript: data.text ?? '',
      metadata: {
        provider: 'openai-whisper',
        model: 'whisper-1',
        processedAt: new Date().toISOString(),
      },
    };
  }
}

/**
 * Dev/test fallback — used when no AI_PROVIDER_API_KEY is configured so the
 * app can boot and the voice pipeline exercises end-to-end without a network.
 */
export class DevNoopTranscriptionProvider implements TranscriptionProvider {
  async transcribe(audioUrl: string): Promise<TranscriptionResult> {
    return {
      transcript: `[Dev mode] Transcription not available. Audio: ${audioUrl}`,
      metadata: {
        provider: 'dev-fallback',
        processedAt: new Date().toISOString(),
      },
    };
  }
}

export function createTranscriptionProvider(apiKey: string | undefined): TranscriptionProvider {
  if (apiKey) {
    return new OpenAiWhisperProvider(apiKey);
  }
  return new DevNoopTranscriptionProvider();
}

/**
 * P0-027 — Hardened Whisper transcription provider.
 *
 * Differences from {@link OpenAiWhisperProvider}:
 *  - Configurable model (defaults to `whisper-1`).
 *  - Configurable timeout via `AbortController` so a hung upstream cannot
 *    starve the worker. Throws {@link WhisperTimeoutError} on expiry.
 *  - Pre-flight 25 MB size guard; rejects oversized audio BEFORE calling
 *    the API, surfaced as {@link WhisperFileTooLargeError}.
 *  - Maps upstream HTTP errors to typed errors:
 *      - 429 → {@link WhisperRateLimitError} (carries `retryAfterSeconds`)
 *      - 5xx → {@link WhisperServerError} (`retriable: true`)
 *      - 4xx → {@link WhisperClientError} (e.g. invalid audio, bad key)
 *  - Does NOT silently retry. Retries are the worker's job.
 *
 * Wiring into `app.ts` is owed to P0-023 (Wave 1C); this story only adds the
 * provider + factory.
 */

/** OpenAI's documented Whisper upload limit. */
export const WHISPER_MAX_BYTES = 25 * 1024 * 1024;

export class WhisperTimeoutError extends Error {
  readonly code = 'WHISPER_TIMEOUT';
  readonly retriable = true;
  constructor(public readonly timeoutMs: number) {
    super(`Whisper request timed out after ${timeoutMs}ms`);
    this.name = 'WhisperTimeoutError';
  }
}

export class WhisperFileTooLargeError extends Error {
  readonly code = 'WHISPER_FILE_TOO_LARGE';
  readonly retriable = false;
  constructor(public readonly sizeBytes: number, public readonly maxBytes = WHISPER_MAX_BYTES) {
    super(
      `Audio file is ${sizeBytes} bytes; Whisper rejects files over ${maxBytes} bytes (25 MB).`
    );
    this.name = 'WhisperFileTooLargeError';
  }
}

export class WhisperRateLimitError extends Error {
  readonly code = 'WHISPER_RATE_LIMITED';
  readonly retriable = true;
  constructor(public readonly retryAfterSeconds: number | null, public readonly body: string) {
    super(
      `Whisper rate limited (429)${
        retryAfterSeconds !== null ? `; retry after ${retryAfterSeconds}s` : ''
      }: ${body}`
    );
    this.name = 'WhisperRateLimitError';
  }
}

export class WhisperServerError extends Error {
  readonly code = 'WHISPER_SERVER_ERROR';
  readonly retriable = true;
  constructor(public readonly status: number, public readonly body: string) {
    super(`Whisper server error ${status}: ${body}`);
    this.name = 'WhisperServerError';
  }
}

export class WhisperClientError extends Error {
  readonly code = 'WHISPER_CLIENT_ERROR';
  readonly retriable = false;
  constructor(public readonly status: number, public readonly body: string) {
    super(`Whisper client error ${status}: ${body}`);
    this.name = 'WhisperClientError';
  }
}

export interface WhisperTranscribeOptions {
  /** Optional ISO-639-1 language hint. */
  language?: string;
}

export class WhisperTranscriptionProvider implements TranscriptionProvider {
  constructor(
    private readonly apiKey: string,
    private readonly model: string = 'whisper-1',
    private readonly fetchImpl: FetchLike = fetch,
    private readonly timeoutMs: number = 30_000,
    private readonly maxBytes: number = WHISPER_MAX_BYTES
  ) {}

  async transcribe(
    audioUrl: string,
    options: WhisperTranscribeOptions = {}
  ): Promise<TranscriptionResult> {
    // 1) Fetch audio bytes from the signed URL.
    const audioRes = await this.fetchImpl(audioUrl);
    if (!audioRes.ok) {
      throw new WhisperClientError(
        audioRes.status,
        `Failed to fetch audio from ${audioUrl}: HTTP ${audioRes.status}`
      );
    }
    const audioBlob = await audioRes.blob();

    // 2) Pre-flight size guard — reject before upload to save bandwidth and
    //    return a clear error rather than letting OpenAI return a 413.
    if (audioBlob.size > this.maxBytes) {
      throw new WhisperFileTooLargeError(audioBlob.size, this.maxBytes);
    }

    // 3) Build multipart form. Field names are required by Whisper.
    const fd = new FormData();
    fd.append('file', audioBlob, 'audio.webm');
    fd.append('model', this.model);
    if (options.language) {
      fd.append('language', options.language);
    }

    // 4) Issue request with an AbortController-backed timeout.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    let res: Response;
    try {
      res = await this.fetchImpl('https://api.openai.com/v1/audio/transcriptions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.apiKey}` },
        body: fd,
        signal: controller.signal,
      });
    } catch (err) {
      if (controller.signal.aborted) {
        throw new WhisperTimeoutError(this.timeoutMs);
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }

    // 5) Map non-OK responses to typed errors. The worker decides whether to
    //    retry based on the `retriable` flag / specific error class.
    if (!res.ok) {
      const body = await safeReadText(res);
      if (res.status === 429) {
        const retryAfter = parseRetryAfter(res.headers.get('retry-after'));
        throw new WhisperRateLimitError(retryAfter, body);
      }
      if (res.status === 413) {
        // Defense-in-depth: should be unreachable thanks to the pre-flight
        // size guard, but surface a clear error if OpenAI's limit changes.
        throw new WhisperFileTooLargeError(audioBlob.size, this.maxBytes);
      }
      if (res.status >= 500) {
        throw new WhisperServerError(res.status, body);
      }
      throw new WhisperClientError(res.status, body);
    }

    const data = (await res.json()) as { text?: string };
    return {
      transcript: data.text ?? '',
      metadata: {
        provider: 'openai-whisper',
        model: this.model,
        processedAt: new Date().toISOString(),
      },
    };
  }
}

async function safeReadText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return '';
  }
}

/** Parses the HTTP `Retry-After` header. Supports delta-seconds and HTTP-date. */
function parseRetryAfter(value: string | null): number | null {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.ceil(seconds);
  }
  const dateMs = Date.parse(value);
  if (!Number.isNaN(dateMs)) {
    const delta = Math.ceil((dateMs - Date.now()) / 1000);
    return delta > 0 ? delta : 0;
  }
  return null;
}

// ─── Streaming STT (Deepgram) — required by P8-012 Media Streams ─────────────

export interface StreamingTranscriptEvent {
  type: 'partial' | 'final';
  transcript: string;
  confidence: number;
  isFinal: boolean;
}

export type StreamingTranscriptCallback = (event: StreamingTranscriptEvent) => void;

export interface StreamingSession {
  /** Push raw PCM audio (16 kHz, 16-bit mono LE) into the stream. */
  send(chunk: Buffer): void;
  /** Signal end of audio — provider flushes any pending results, then closes. */
  finish(): void;
  /** Abort immediately without waiting for results. */
  destroy(): void;
}

export interface StreamingTranscriptionProvider {
  openSession(
    onEvent: StreamingTranscriptCallback,
    onError: (err: Error) => void,
    onClose: () => void
  ): Promise<StreamingSession>;
}

/**
 * Deepgram Nova-3 real-time streaming transcription provider.
 *
 * Uses Node 22's native `WebSocket`. Requires DEEPGRAM_API_KEY.
 * Audio must be raw PCM: 16 kHz, 16-bit signed little-endian mono.
 * Deepgram fires interim_results so the state machine can detect
 * caller interruptions before the utterance is complete.
 *
 * P8-012 wires this into the Twilio Media Streams WebSocket handler.
 * Whisper stays in place for the existing async technician voice path.
 */
export class DeepgramStreamingProvider implements StreamingTranscriptionProvider {
  private readonly wsUrl: string;

  constructor(private readonly apiKey: string) {
    if (!apiKey) throw new Error('DeepgramStreamingProvider requires DEEPGRAM_API_KEY');
    this.wsUrl =
      'wss://api.deepgram.com/v1/listen' +
      '?model=nova-3&language=en&encoding=linear16&sample_rate=16000' +
      '&channels=1&interim_results=true&smart_format=true&endpointing=300';
  }

  async openSession(
    onEvent: StreamingTranscriptCallback,
    onError: (err: Error) => void,
    onClose: () => void
  ): Promise<StreamingSession> {
    // Node 22 native WebSocket follows the WHATWG spec and does not accept
    // a headers option. Pass the API key via query param instead.
    const ws = new WebSocket(`${this.wsUrl}&token=${this.apiKey}`);

    // Attach message listener BEFORE awaiting open to avoid missing frames
    // that Deepgram sends immediately on connection.
    const openPromise = new Promise<void>((resolve, reject) => {
      ws.addEventListener('open', () => resolve(), { once: true });
      ws.addEventListener('error', (e) => reject(new Error(String(e))), { once: true });
    });

    ws.addEventListener('message', (msg) => {
      try {
        const data = JSON.parse(msg.data as string) as {
          type?: string;
          channel?: { alternatives?: Array<{ transcript: string; confidence: number }> };
          is_final?: boolean;
        };
        if (data.type !== 'Results') return;
        const alt = data.channel?.alternatives?.[0];
        if (!alt || alt.transcript.trim() === '') return;
        onEvent({
          type: data.is_final ? 'final' : 'partial',
          transcript: alt.transcript,
          confidence: alt.confidence ?? 1,
          isFinal: data.is_final ?? false,
        });
      } catch {
        // malformed JSON from provider — ignore single frame
      }
    });

    ws.addEventListener('error', (e) => onError(new Error(String(e))));
    ws.addEventListener('close', () => onClose());

    await openPromise;

    return {
      send(chunk: Buffer) {
        if (ws.readyState === WebSocket.OPEN) ws.send(chunk);
      },
      finish() {
        // Deepgram flushes on close_stream message
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'CloseStream' }));
        }
      },
      destroy() {
        ws.close();
      },
    };
  }
}

/**
 * P0-027 factory — returns the hardened Whisper provider when the OpenAI key
 * is configured, otherwise returns the dev no-op (NOT a fake-data mock) and
 * logs a warning so missing-key in production is loud.
 *
 * Wiring into `app.ts` is owed to P0-023 (Wave 1C).
 */
export function createWhisperTranscriptionProvider(
  env: { OPENAI_API_KEY?: string; WHISPER_MODEL?: string },
  deps: { fetchImpl?: FetchLike; logger?: Pick<Console, 'warn'> } = {}
): TranscriptionProvider {
  const logger = deps.logger ?? console;
  if (env.OPENAI_API_KEY) {
    return new WhisperTranscriptionProvider(
      env.OPENAI_API_KEY,
      env.WHISPER_MODEL ?? 'whisper-1',
      deps.fetchImpl
    );
  }
  logger.warn(
    '[transcription] OPENAI_API_KEY missing — using DevNoopTranscriptionProvider. ' +
      'STT will return placeholder text. Set OPENAI_API_KEY in production.'
  );
  return new DevNoopTranscriptionProvider();
}
