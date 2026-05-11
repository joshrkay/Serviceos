/**
 * P0-027 — Hardened OpenAI Whisper transcription provider tests.
 *
 * Exercises the new {@link WhisperTranscriptionProvider} with mocked `fetch`:
 *  - Happy path (transcript surfaces, request shape correct, model overrideable).
 *  - 25 MB pre-flight guard rejects oversized audio without calling the API.
 *  - Network timeout produces {@link WhisperTimeoutError}, not a fake transcript.
 *  - 429 produces {@link WhisperRateLimitError} with `retryAfterSeconds` parsed.
 *  - 5xx produces a retriable {@link WhisperServerError}.
 *  - 4xx (invalid audio / bad key) produces {@link WhisperClientError}.
 *  - Factory: missing `OPENAI_API_KEY` returns {@link DevNoopTranscriptionProvider}
 *    AND logs a warning (not the audit-flagged hardcoded mock).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  WhisperTranscriptionProvider,
  WhisperTimeoutError,
  WhisperRateLimitError,
  WhisperServerError,
  WhisperClientError,
  WhisperFileTooLargeError,
  WHISPER_MAX_BYTES,
  createWhisperTranscriptionProvider,
  DevNoopTranscriptionProvider,
} from '../../src/voice/transcription-providers';

function audioOk(sizeBytes = 1024, type = 'audio/webm'): Response {
  const bytes = new Uint8Array(sizeBytes);
  return new Response(new Blob([bytes], { type }), { status: 200, statusText: 'OK' });
}

function jsonRes(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  });
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('P0-027 WhisperTranscriptionProvider', () => {
  describe('happy path', () => {
    it('fetches audio, posts multipart/form to Whisper, and returns the transcript', async () => {
      const fetchMock = vi
        .fn<Parameters<typeof fetch>, ReturnType<typeof fetch>>()
        .mockResolvedValueOnce(audioOk(2048))
        .mockResolvedValueOnce(jsonRes({ text: 'hello world' }));

      const provider = new WhisperTranscriptionProvider('sk_test', 'whisper-1', fetchMock);
      const result = await provider.transcribe('https://cdn.example/audio.webm');

      expect(result.transcript).toBe('hello world');
      expect(result.metadata.provider).toBe('openai-whisper');
      expect(result.metadata.model).toBe('whisper-1');
      expect(typeof result.metadata.processedAt).toBe('string');

      // Fetch #1: signed audio URL.
      expect(fetchMock.mock.calls[0][0]).toBe('https://cdn.example/audio.webm');

      // Fetch #2: Whisper API.
      const [whisperUrl, whisperInit] = fetchMock.mock.calls[1] as [string, RequestInit];
      expect(whisperUrl).toBe('https://api.openai.com/v1/audio/transcriptions');
      expect(whisperInit.method).toBe('POST');
      expect((whisperInit.headers as Record<string, string>).Authorization).toBe('Bearer sk_test');
      expect(whisperInit.body).toBeInstanceOf(FormData);
      const fd = whisperInit.body as FormData;
      expect(fd.get('model')).toBe('whisper-1');
      expect(fd.get('file')).toBeInstanceOf(Blob);
    });

    it('honours the configurable model and forwards a language hint when provided', async () => {
      const fetchMock = vi
        .fn<Parameters<typeof fetch>, ReturnType<typeof fetch>>()
        .mockResolvedValueOnce(audioOk(512))
        .mockResolvedValueOnce(jsonRes({ text: 'bonjour' }));

      const provider = new WhisperTranscriptionProvider('sk_test', 'whisper-large-v3', fetchMock);
      const result = await provider.transcribe('https://cdn.example/fr.webm', { language: 'fr' });

      expect(result.metadata.model).toBe('whisper-large-v3');
      const fd = (fetchMock.mock.calls[1] as [string, RequestInit])[1].body as FormData;
      expect(fd.get('model')).toBe('whisper-large-v3');
      expect(fd.get('language')).toBe('fr');
    });

    it('returns an empty transcript when Whisper returns no text', async () => {
      const fetchMock = vi
        .fn<Parameters<typeof fetch>, ReturnType<typeof fetch>>()
        .mockResolvedValueOnce(audioOk(64))
        .mockResolvedValueOnce(jsonRes({}));
      const provider = new WhisperTranscriptionProvider('sk_test', 'whisper-1', fetchMock);
      const result = await provider.transcribe('https://cdn.example/silence.webm');
      expect(result.transcript).toBe('');
    });
  });

  describe('error handling', () => {
    it('throws WhisperTimeoutError when the upstream hangs past the timeout', async () => {
      const fetchMock = vi
        .fn<Parameters<typeof fetch>, ReturnType<typeof fetch>>()
        .mockResolvedValueOnce(audioOk(64))
        .mockImplementationOnce((_url, init) => {
          const signal = (init as RequestInit | undefined)?.signal;
          return new Promise<Response>((_resolve, reject) => {
            if (!signal) return;
            signal.addEventListener('abort', () => {
              const err = new Error('aborted') as Error & { name: string };
              err.name = 'AbortError';
              reject(err);
            });
          });
        });

      const provider = new WhisperTranscriptionProvider('sk_test', 'whisper-1', fetchMock, 100);
      const pending = provider.transcribe('https://cdn.example/audio.webm');
      let captured: unknown;
      const settled = pending.then(
        (v) => {
          captured = { value: v };
        },
        (e) => {
          captured = { error: e };
        }
      );

      await Promise.resolve();
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(101);
      await settled;

      expect(captured).toBeDefined();
      expect((captured as { error: unknown }).error).toBeInstanceOf(WhisperTimeoutError);
      expect(((captured as { error: WhisperTimeoutError }).error).timeoutMs).toBe(100);
    });

    it('throws WhisperRateLimitError with parsed Retry-After on 429', async () => {
      const fetchMock = vi
        .fn<Parameters<typeof fetch>, ReturnType<typeof fetch>>()
        .mockResolvedValueOnce(audioOk(64))
        .mockResolvedValueOnce(
          new Response('rate limited', {
            status: 429,
            headers: new Headers({ 'retry-after': '5' }),
          })
        );
      const provider = new WhisperTranscriptionProvider('sk_test', 'whisper-1', fetchMock);

      await expect(
        provider.transcribe('https://cdn.example/audio.webm')
      ).rejects.toMatchObject({
        name: 'WhisperRateLimitError',
        retryAfterSeconds: 5,
        retriable: true,
      });
    });

    it('falls back to retryAfterSeconds=null when Retry-After is absent', async () => {
      const fetchMock = vi
        .fn<Parameters<typeof fetch>, ReturnType<typeof fetch>>()
        .mockResolvedValueOnce(audioOk(64))
        .mockResolvedValueOnce(new Response('slow down', { status: 429 }));
      const provider = new WhisperTranscriptionProvider('sk_test', 'whisper-1', fetchMock);

      const errRaw = await provider
        .transcribe('https://cdn.example/audio.webm')
        .catch((e) => e as WhisperRateLimitError);
      expect(errRaw).toBeInstanceOf(WhisperRateLimitError);
      const err = errRaw as WhisperRateLimitError;
      expect(err.retryAfterSeconds).toBeNull();
    });

    it('throws a retriable WhisperServerError on 5xx', async () => {
      const fetchMock = vi
        .fn<Parameters<typeof fetch>, ReturnType<typeof fetch>>()
        .mockResolvedValueOnce(audioOk(64))
        .mockResolvedValueOnce(new Response('boom', { status: 503 }));
      const provider = new WhisperTranscriptionProvider('sk_test', 'whisper-1', fetchMock);

      const errRaw = await provider
        .transcribe('https://cdn.example/audio.webm')
        .catch((e) => e as WhisperServerError);
      expect(errRaw).toBeInstanceOf(WhisperServerError);
      const err = errRaw as WhisperServerError;
      expect(err.status).toBe(503);
      expect(err.retriable).toBe(true);
    });

    it('throws a non-retriable WhisperClientError with a clear message on invalid audio (400)', async () => {
      const fetchMock = vi
        .fn<Parameters<typeof fetch>, ReturnType<typeof fetch>>()
        .mockResolvedValueOnce(audioOk(64))
        .mockResolvedValueOnce(new Response('Invalid file format', { status: 400 }));
      const provider = new WhisperTranscriptionProvider('sk_test', 'whisper-1', fetchMock);

      const errRaw = await provider
        .transcribe('https://cdn.example/audio.webm')
        .catch((e) => e as WhisperClientError);
      expect(errRaw).toBeInstanceOf(WhisperClientError);
      const err = errRaw as WhisperClientError;
      expect(err.status).toBe(400);
      expect(err.retriable).toBe(false);
      expect(err.message).toContain('Invalid file format');
    });

    it('throws a non-retriable WhisperClientError on 401 (bad API key)', async () => {
      const fetchMock = vi
        .fn<Parameters<typeof fetch>, ReturnType<typeof fetch>>()
        .mockResolvedValueOnce(audioOk(64))
        .mockResolvedValueOnce(new Response('invalid key', { status: 401 }));
      const provider = new WhisperTranscriptionProvider('bad', 'whisper-1', fetchMock);

      const errRaw = await provider
        .transcribe('https://cdn.example/audio.webm')
        .catch((e) => e as WhisperClientError);
      expect(errRaw).toBeInstanceOf(WhisperClientError);
      const err = errRaw as WhisperClientError;
      expect(err.status).toBe(401);
    });

    it('throws WhisperClientError when the audio URL itself fails to fetch', async () => {
      const fetchMock = vi
        .fn<Parameters<typeof fetch>, ReturnType<typeof fetch>>()
        .mockResolvedValueOnce(new Response('not found', { status: 404 }));
      const provider = new WhisperTranscriptionProvider('sk_test', 'whisper-1', fetchMock);

      await expect(
        provider.transcribe('https://cdn.example/missing.webm')
      ).rejects.toBeInstanceOf(WhisperClientError);
      // Whisper API must NOT be called when the audio fetch failed.
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
  });

  describe('25 MB pre-flight size guard', () => {
    it('rejects audio larger than 25MB BEFORE calling the Whisper API', async () => {
      const fetchMock = vi
        .fn<Parameters<typeof fetch>, ReturnType<typeof fetch>>()
        .mockResolvedValueOnce(audioOk(WHISPER_MAX_BYTES + 1));
      const provider = new WhisperTranscriptionProvider('sk_test', 'whisper-1', fetchMock);

      const errRaw = await provider
        .transcribe('https://cdn.example/huge.webm')
        .catch((e) => e as WhisperFileTooLargeError);
      expect(errRaw).toBeInstanceOf(WhisperFileTooLargeError);
      const err = errRaw as WhisperFileTooLargeError;
      expect(err.retriable).toBe(false);
      expect(err.message).toMatch(/25 MB|25165824/);
      // Confirm no upload attempt was made.
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('accepts audio at exactly the limit', async () => {
      const fetchMock = vi
        .fn<Parameters<typeof fetch>, ReturnType<typeof fetch>>()
        .mockResolvedValueOnce(audioOk(WHISPER_MAX_BYTES))
        .mockResolvedValueOnce(jsonRes({ text: 'ok' }));
      const provider = new WhisperTranscriptionProvider('sk_test', 'whisper-1', fetchMock);
      const result = await provider.transcribe('https://cdn.example/edge.webm');
      expect(result.transcript).toBe('ok');
    });
  });
});

describe('P0-027 createWhisperTranscriptionProvider factory', () => {
  it('returns DevNoopTranscriptionProvider and logs a warning when OPENAI_API_KEY is missing', () => {
    const warn = vi.fn();
    const provider = createWhisperTranscriptionProvider({}, { logger: { warn } });
    expect(provider).toBeInstanceOf(DevNoopTranscriptionProvider);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toMatch(/AI_PROVIDER_API_KEY/);
  });

  it('returns WhisperTranscriptionProvider when OPENAI_API_KEY is set', () => {
    const warn = vi.fn();
    const provider = createWhisperTranscriptionProvider(
      { OPENAI_API_KEY: 'sk_live' },
      { logger: { warn } }
    );
    expect(provider).toBeInstanceOf(WhisperTranscriptionProvider);
    expect(warn).not.toHaveBeenCalled();
  });

  it('honours WHISPER_MODEL override from env', async () => {
    const fetchMock = vi
      .fn<Parameters<typeof fetch>, ReturnType<typeof fetch>>()
      .mockResolvedValueOnce(audioOk(64))
      .mockResolvedValueOnce(jsonRes({ text: 'x' }));
    const provider = createWhisperTranscriptionProvider(
      { OPENAI_API_KEY: 'sk_live', WHISPER_MODEL: 'whisper-large-v3' },
      { fetchImpl: fetchMock }
    );
    const result = await provider.transcribe('https://cdn.example/audio.webm');
    expect(result.metadata.model).toBe('whisper-large-v3');
  });
});
