import NodeWebSocket from 'ws';
import { TranscriptionProvider } from './voice-service';
import type { DownloadUrlPolicy, DownloadUrlRejection } from '../files/download-url-policy';

export type FetchLike = typeof fetch;

export interface TranscriptionResult {
  transcript: string;
  metadata: Record<string, unknown>;
}

/**
 * Dev/test fallback — used when no OPENAI_API_KEY is configured so the
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

/**
 * Whisper decodes the upload by the multipart filename's extension, so the
 * extension MUST match the actual bytes. Web records `audio/webm`; native
 * mobile records AAC-in-MP4 (`audio/mp4` / `audio/x-m4a`). Derive the
 * filename from the fetched blob's Content-Type (R2 returns the stored
 * type) and fall back to `webm` when the type is unknown.
 */
export function whisperUploadFilename(contentType: string | undefined): string {
  const base = (contentType ?? '').split(';')[0].trim().toLowerCase();
  if (base.includes('mp4') || base.includes('m4a')) return 'audio.m4a';
  if (base.includes('wav')) return 'audio.wav';
  if (base.includes('ogg')) return 'audio.ogg';
  if (base.includes('mpeg') || base.includes('mp3')) return 'audio.mp3';
  if (base.includes('flac')) return 'audio.flac';
  return 'audio.webm';
}

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

/**
 * H2 — the audio URL is not one the configured storage provider mints, so it
 * is never fetched. Non-retriable: the same URL is refused on every attempt.
 * The message names the rule, never the URL (it becomes the recording's
 * user-visible errorMessage).
 */
export class AudioUrlRejectedError extends Error {
  readonly code = 'AUDIO_URL_REJECTED';
  readonly retriable = false;
  constructor(public readonly reason: DownloadUrlRejection) {
    super(`Audio URL refused: not a download URL of the configured storage (${reason})`);
    this.name = 'AudioUrlRejectedError';
  }
}

export interface WhisperTranscriptionProviderOptions {
  apiKey: string;
  /**
   * H2 — only URLs this policy accepts are fetched. Required, no default:
   * production builds it from the storage config (createStorageProvider's
   * `downloadUrlPolicy`), so a missing wire is a compile error, not an
   * open fetch.
   */
  audioUrlPolicy: DownloadUrlPolicy;
  model?: string;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
  maxBytes?: number;
  /** Where audio-fetch diagnostics go (the URL never goes into an error). */
  logger?: Pick<Console, 'warn'>;
}

export interface WhisperTranscribeOptions {
  /** Optional ISO-639-1 language hint. P11-002: 'en' / 'es' threaded
   *  through from the voice session's detected language. */
  language?: string;
}

export class WhisperTranscriptionProvider implements TranscriptionProvider {
  private readonly apiKey: string;
  private readonly audioUrlPolicy: DownloadUrlPolicy;
  private readonly model: string;
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;
  private readonly maxBytes: number;
  private readonly logger: Pick<Console, 'warn'>;

  constructor(options: WhisperTranscriptionProviderOptions) {
    this.apiKey = options.apiKey;
    this.audioUrlPolicy = options.audioUrlPolicy;
    this.model = options.model ?? 'whisper-1';
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.maxBytes = options.maxBytes ?? WHISPER_MAX_BYTES;
    this.logger = options.logger ?? console;
  }

  async transcribe(
    audioUrl: string,
    options: WhisperTranscribeOptions = {}
  ): Promise<TranscriptionResult> {
    // 0) H2 — never fetch a URL the configured storage did not mint.
    const rejection = this.audioUrlPolicy.rejectionFor(audioUrl);
    if (rejection) {
      this.logger.warn('[transcription] audio URL refused by storage policy', {
        reason: rejection,
        audio: withoutQuery(audioUrl),
      });
      throw new AudioUrlRejectedError(rejection);
    }

    // 1) Fetch audio bytes from the signed URL — bounded in time (H2: fetch
    //    has no default timeout; a stalled GET would pin the worker) and
    //    never redirected: the policy vetted THIS URL, not wherever a 3xx
    //    points (storage presigned GETs answer directly).
    const audioSignal = AbortSignal.timeout(this.timeoutMs);
    let audioRes: Response;
    try {
      audioRes = await this.fetchImpl(audioUrl, { signal: audioSignal, redirect: 'error' });
    } catch (err) {
      if (audioSignal.aborted) {
        throw new WhisperTimeoutError(this.timeoutMs);
      }
      throw err;
    }
    if (!audioRes.ok) {
      // H2 — never the URL: this message becomes the recording's
      // user-visible errorMessage, and the URL is a presigned secret.
      await audioRes.body?.cancel().catch(() => undefined);
      this.logger.warn('[transcription] audio fetch failed', {
        status: audioRes.status,
        audio: withoutQuery(audioUrl),
      });
      const message = `Failed to fetch audio: HTTP ${audioRes.status}`;
      // Storage 5xx / 429 is transient (retriable); any other status is not.
      if (audioRes.status >= 500 || audioRes.status === 429) {
        throw new WhisperServerError(audioRes.status, message);
      }
      throw new WhisperClientError(audioRes.status, message);
    }
    // H2 — a declared length over the cap is refused before a byte is read.
    const declaredBytes = Number(audioRes.headers.get('content-length'));
    if (Number.isFinite(declaredBytes) && declaredBytes > this.maxBytes) {
      await audioRes.body?.cancel().catch(() => undefined);
      throw new WhisperFileTooLargeError(declaredBytes, this.maxBytes);
    }

    // 2) Read the body under a byte cap — rejects (and cancels the stream)
    //    on the chunk that crosses the cap, so neither a lying nor a missing
    //    Content-Length can make the process buffer an unbounded response.
    //    The cap is Whisper's own upload limit, so this also stands in for
    //    the old post-download size check.
    let audioBlob: Blob;
    try {
      audioBlob = await readBodyCapped(audioRes, this.maxBytes);
    } catch (err) {
      if (audioSignal.aborted) {
        throw new WhisperTimeoutError(this.timeoutMs);
      }
      throw err;
    }

    // 3) Build multipart form. Field names are required by Whisper.
    const fd = new FormData();
    fd.append('file', audioBlob, whisperUploadFilename(audioBlob.type));
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

/** H2 — origin + path only: a presigned URL's query string is its signature. */
function withoutQuery(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return '<unparseable url>';
  }
}

/**
 * H2 — drain `res.body` into a Blob typed by its Content-Type, throwing
 * {@link WhisperFileTooLargeError} (after cancelling the stream) as soon as
 * more than `maxBytes` have arrived.
 */
async function readBodyCapped(res: Response, maxBytes: number): Promise<Blob> {
  const type = res.headers.get('content-type') ?? '';
  if (!res.body) return new Blob([], { type });
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    if (received > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new WhisperFileTooLargeError(received, maxBytes);
    }
    chunks.push(value);
  }
  return new Blob(chunks, { type });
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
    onClose: () => void,
    /** P11-002: optional language hint ('en' | 'es'); defaults to 'en'. */
    language?: 'en' | 'es',
    options?: { keywords?: ReadonlyArray<string>; endpointingMs?: number }
  ): Promise<StreamingSession>;
}

/**
 * Deepgram Nova-3 real-time streaming transcription provider.
 *
 * Uses native WebSocket where available, otherwise ws on Node 20. Requires DEEPGRAM_API_KEY.
 * Audio must be raw PCM: 16 kHz, 16-bit signed little-endian mono.
 * Deepgram fires interim_results so the state machine can detect
 * caller interruptions before the utterance is complete.
 *
 * P8-012 wires this into the Twilio Media Streams WebSocket handler.
 * Whisper stays in place for the existing async technician voice path.
 */

/**
 * VOX-01 — upper bound on the Deepgram WS handshake. Deliberately far
 * tighter than the blocking-request bounds (TTS/Whisper 30s, Vapi 20s):
 * this runs on the live-call hot path with caller audio already bridged,
 * so a stall here is immediate dead air. A WS upgrade that hasn't
 * completed in a few seconds is not going to; fail fast to the
 * closeWs('deepgram_open_failed') path instead of hanging the call.
 */
export const DEEPGRAM_OPEN_TIMEOUT_MS = 5_000;

/**
 * A2 — true for any Nova-3 variant (`nova-3`, `nova-3-general`, etc.).
 * Nova-3 models understand Deepgram's `keyterm` prompting param; everything
 * else (Nova-2 pins, base/enhanced) falls back to the legacy `keywords`
 * param that `buildWsUrl` used unconditionally before this fix.
 */
function isNova3ModelFamily(model: string): boolean {
  return model.toLowerCase().startsWith('nova-3');
}

/**
 * A2 follow-up — strip a trailing `:<digits>` weight suffix before a term
 * is emitted under Deepgram's `keyterm` param. `term:weight` is the legacy
 * `keywords` (Nova-2) boost format; Deepgram's Nova-3 `keyterm` prompting
 * docs do not describe weight-suffix support, so passing 'P-trap:3' through
 * unchanged risks sending the literal junk phrase "P-trap:3" instead of
 * boosting "P-trap". Only a FINAL ':<digits>' is stripped, so a term with a
 * legitimate internal colon (none in today's packs, but handled
 * defensively) keeps everything except a trailing numeric suffix.
 * `keywords` (Nova-2 path) is untouched — Nova-2 documents weights.
 */
function stripKeytermWeightSuffix(term: string): string {
  return term.replace(/:\d+$/, '');
}

export class DeepgramStreamingProvider implements StreamingTranscriptionProvider {
  private readonly defaultLanguage: 'en' | 'es';
  /** A2 — Deepgram model pin; drives which boost param buildWsUrl emits. */
  private readonly model: string;

  constructor(
    private readonly apiKey: string,
    /** P11-002: per-session default; openSession() can override per-call. */
    defaultLanguage: 'en' | 'es' = 'en',
    /**
     * A2 — Deepgram model pin. Defaults to 'nova-3' (this provider's only
     * supported model until now). Exposed so a future Nova-2 pin can still
     * request term boosting through the param it actually supports.
     */
    model: string = 'nova-3'
  ) {
    if (!apiKey) throw new Error('DeepgramStreamingProvider requires DEEPGRAM_API_KEY');
    this.defaultLanguage = defaultLanguage;
    this.model = model;
  }

  /** Build the Deepgram WS URL for a given language. Exposed for testing. */
  private buildWsUrl(
    language: 'en' | 'es',
    options: { keywords?: ReadonlyArray<string>; endpointingMs?: number } = {}
  ): string {
    const endpointing = options.endpointingMs ?? 600;
    let url =
      'wss://api.deepgram.com/v1/listen' +
      `?model=${this.model}&language=${language}&encoding=linear16&sample_rate=16000` +
      `&channels=1&interim_results=true&smart_format=true&endpointing=${endpointing}`;
    if (options.keywords && options.keywords.length > 0) {
      // A2 — Nova-3 replaced Deepgram's legacy `keywords` boost param with
      // `keyterm` prompting; `keywords` is a Nova-2-era feature that Nova-3
      // silently ignores (no error, no boost — a no-op worse than sending
      // nothing, since it looks wired but does nothing). Detect the model
      // family so a future Nova-2 pin still boosts through the param IT
      // supports.
      //
      // Term format is NOT unchanged across the flip: callers (vertical
      // packs) supply `term:weight` (e.g. 'P-trap:3'), which is `keywords`'
      // documented weighted-boost format on Nova-2. `keyterm` prompting on
      // Nova-3 does not document weight-suffix support, so a trailing
      // `:<digits>` is stripped for the keyterm path only — see
      // stripKeytermWeightSuffix. `keywords` keeps the weight suffix as-is
      // since Nova-2 supports it. URL-encoding is unchanged either way.
      //
      // NOTE: keyterm prompting's Deepgram docs describe it as English-only
      // support at this time; this provider still sends the same boost
      // terms on `language=es` sessions (deliberate on this branch — no
      // Spanish-specific term list exists yet). TODO: live-check against
      // Deepgram whether es keyterm requests are silently ignored (mirroring
      // the keywords no-op above) or rejected, and gate/translate
      // accordingly once confirmed.
      const paramName = isNova3ModelFamily(this.model) ? 'keyterm' : 'keywords';
      const params = options.keywords
        .map((k) => {
          const term = paramName === 'keyterm' ? stripKeytermWeightSuffix(k) : k;
          return `${paramName}=${encodeURIComponent(term)}`;
        })
        .join('&');
      url += `&${params}`;
    }
    return url;
  }

  async openSession(
    onEvent: StreamingTranscriptCallback,
    onError: (err: Error) => void,
    onClose: () => void,
    language?: 'en' | 'es',
    options: { keywords?: ReadonlyArray<string>; endpointingMs?: number } = {}
  ): Promise<StreamingSession> {
    // Node 22 native WebSocket follows the WHATWG spec and does not accept
    // a headers option. Deepgram supports authentication via subprotocols.
    const lang = language ?? this.defaultLanguage;
    // Node 20 (the deployed image) has no global WebSocket by default.
    // ws implements the WHATWG event/client subset used by these providers.
    const WebSocketClient: typeof globalThis.WebSocket = globalThis.WebSocket ??
      (NodeWebSocket as unknown as typeof globalThis.WebSocket);
    const ws = new WebSocketClient(this.buildWsUrl(lang, options), ['token', this.apiKey]);

    // Attach message listener BEFORE awaiting open to avoid missing frames
    // that Deepgram sends immediately on connection.
    //
    // VOX-01 — bound the handshake. Twilio has already bridged caller audio
    // by the time we open Deepgram, so if the WS upgrade stalls (no 'open',
    // no 'error') an unbounded `await openPromise` would leave `deepgram`
    // null and silently drop every inbound frame until the 30-minute idle
    // timer — dead air for the whole call. Every other provider bounds its
    // calls (TTS/Whisper 30s, Vapi 20s); a few seconds is ample for a WS
    // upgrade. On expiry we reject (and close the socket) so the caller's
    // existing catch path (closeWs(1011,'deepgram_open_failed')) runs. This
    // bound lives inside openSession, so BOTH call sites — the initial open
    // and the language-switch reopen in mediastream-adapter — inherit it.
    const openPromise = new Promise<void>((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        try {
          ws.close();
        } catch {
          /* swallow — we are already failing the open */
        }
        reject(
          new Error(
            `deepgram_open_timeout: no open/error within ${DEEPGRAM_OPEN_TIMEOUT_MS}ms`,
          ),
        );
      }, DEEPGRAM_OPEN_TIMEOUT_MS);
      if (typeof timer.unref === 'function') timer.unref();
      ws.addEventListener(
        'open',
        () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
      ws.addEventListener(
        'error',
        (e) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          reject(new Error(String(e)));
        },
        { once: true },
      );
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
        if (ws.readyState === WebSocketClient.OPEN) ws.send(chunk);
      },
      finish() {
        // Deepgram flushes on close_stream message
        if (ws.readyState === WebSocketClient.OPEN) {
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
 * P0-027 factory — returns the hardened Whisper provider when an OpenAI-
 * compatible key is configured, otherwise returns the dev no-op (NOT a
 * fake-data mock) and logs a warning so missing-key in production is loud.
 *
 * Falls back to AI_PROVIDER_API_KEY (the documented production secret in
 * shared/config.ts) when OPENAI_API_KEY is unset, so deployments that only
 * set the canonical key still get real transcription instead of placeholder
 * text.
 *
 * Wiring into `app.ts` is owed to P0-023 (Wave 1C).
 */
export function createWhisperTranscriptionProvider(
  env: { OPENAI_API_KEY?: string; AI_PROVIDER_API_KEY?: string; WHISPER_MODEL?: string },
  deps: {
    /** H2 — createStorageProvider(...).downloadUrlPolicy in app.ts. */
    audioUrlPolicy: DownloadUrlPolicy;
    fetchImpl?: FetchLike;
    logger?: Pick<Console, 'warn'>;
  }
): TranscriptionProvider {
  const logger = deps.logger ?? console;
  const apiKey = env.OPENAI_API_KEY || env.AI_PROVIDER_API_KEY;
  if (apiKey) {
    return new WhisperTranscriptionProvider({
      apiKey,
      audioUrlPolicy: deps.audioUrlPolicy,
      model: env.WHISPER_MODEL ?? 'whisper-1',
      fetchImpl: deps.fetchImpl,
    });
  }
  logger.warn(
    '[transcription] Neither OPENAI_API_KEY nor AI_PROVIDER_API_KEY set — ' +
      'using DevNoopTranscriptionProvider. STT will return placeholder text. ' +
      'Set AI_PROVIDER_API_KEY in production.'
  );
  return new DevNoopTranscriptionProvider();
}
