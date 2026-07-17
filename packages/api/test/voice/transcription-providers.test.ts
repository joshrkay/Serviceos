/**
 * P0-027 — Hardened Whisper transcription provider tests.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  DevNoopTranscriptionProvider,
  WhisperTranscriptionProvider,
  WhisperTimeoutError,
  WhisperFileTooLargeError,
  WhisperRateLimitError,
  WhisperServerError,
  WhisperClientError,
  WHISPER_MAX_BYTES,
  createWhisperTranscriptionProvider,
  DeepgramStreamingProvider,
  DEEPGRAM_OPEN_TIMEOUT_MS,
} from '../../src/voice/transcription-providers';

function audioResponse(ok = true, status = 200, sizeBytes = 1024): Response {
  return new Response(new Blob([new Uint8Array(sizeBytes)], { type: 'audio/webm' }), {
    status,
    statusText: ok ? 'OK' : 'ERR',
  });
}

describe('DevNoopTranscriptionProvider', () => {
  it('returns a deterministic dev-mode placeholder', async () => {
    const provider = new DevNoopTranscriptionProvider();
    const result = await provider.transcribe('https://cdn.example/audio.webm');

    expect(result.transcript).toContain('[Dev mode]');
    expect(result.metadata.provider).toBe('dev-fallback');
  });
});

describe('WhisperTranscriptionProvider', () => {
  it('fetches audio then posts to Whisper with bearer auth and form body', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(audioResponse())
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ text: 'hello world' }), { status: 200 })
      );
    const provider = new WhisperTranscriptionProvider('sk_test', 'whisper-1', fetchMock);

    const result = await provider.transcribe('https://cdn.example/audio.webm');

    expect(result.transcript).toBe('hello world');
    expect(result.metadata.provider).toBe('openai-whisper');
    expect(result.metadata.model).toBe('whisper-1');
    expect(result.metadata.processedAt).toBeTruthy();

    expect(fetchMock.mock.calls[0][0]).toBe('https://cdn.example/audio.webm');

    const [whisperUrl, whisperInit] = fetchMock.mock.calls[1];
    expect(whisperUrl).toBe('https://api.openai.com/v1/audio/transcriptions');
    expect(whisperInit.method).toBe('POST');
    expect((whisperInit.headers as Record<string, string>).Authorization).toBe('Bearer sk_test');
    expect(whisperInit.body).toBeInstanceOf(FormData);
  });

  it('throws WhisperClientError when the audio URL returns non-OK', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response('not found', { status: 404 }));
    const provider = new WhisperTranscriptionProvider('sk_test', 'whisper-1', fetchMock);

    await expect(provider.transcribe('https://cdn.example/missing.webm')).rejects.toThrow(
      WhisperClientError
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('throws WhisperRateLimitError on 429', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(audioResponse())
      .mockResolvedValueOnce(new Response('rate limited', { status: 429 }));
    const provider = new WhisperTranscriptionProvider('sk_test', 'whisper-1', fetchMock);

    await expect(provider.transcribe('https://cdn.example/audio.webm')).rejects.toThrow(
      WhisperRateLimitError
    );
  });

  it('throws WhisperServerError on 5xx', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(audioResponse())
      .mockResolvedValueOnce(new Response('internal error', { status: 503 }));
    const provider = new WhisperTranscriptionProvider('sk_test', 'whisper-1', fetchMock);

    await expect(provider.transcribe('https://cdn.example/audio.webm')).rejects.toThrow(
      WhisperServerError
    );
  });

  it('throws WhisperFileTooLargeError when audio exceeds size limit', async () => {
    const oversizedBlob = new Blob([new Uint8Array(WHISPER_MAX_BYTES + 1)], {
      type: 'audio/webm',
    });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(oversizedBlob, { status: 200 }));
    const provider = new WhisperTranscriptionProvider('sk_test', 'whisper-1', fetchMock);

    await expect(provider.transcribe('https://cdn.example/audio.webm')).rejects.toThrow(
      WhisperFileTooLargeError
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('returns empty transcript when Whisper body has no text field', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(audioResponse())
      .mockResolvedValueOnce(new Response(JSON.stringify({}), { status: 200 }));
    const provider = new WhisperTranscriptionProvider('sk_test', 'whisper-1', fetchMock);

    const result = await provider.transcribe('https://cdn.example/audio.webm');
    expect(result.transcript).toBe('');
  });

  it('includes language param when provided', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(audioResponse())
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ text: 'hola mundo' }), { status: 200 })
      );
    const provider = new WhisperTranscriptionProvider('sk_test', 'whisper-1', fetchMock);

    await provider.transcribe('https://cdn.example/audio.webm', { language: 'es' });

    const formData = fetchMock.mock.calls[1][1].body as FormData;
    expect(formData.get('language')).toBe('es');
  });
});

describe('createWhisperTranscriptionProvider', () => {
  it('returns WhisperTranscriptionProvider when OPENAI_API_KEY is set', () => {
    const provider = createWhisperTranscriptionProvider({ OPENAI_API_KEY: 'sk_live' });
    expect(provider).toBeInstanceOf(WhisperTranscriptionProvider);
  });

  it('returns DevNoopTranscriptionProvider and warns when neither key is set', () => {
    const warnMock = vi.fn();
    const provider = createWhisperTranscriptionProvider({}, { logger: { warn: warnMock } });
    expect(provider).toBeInstanceOf(DevNoopTranscriptionProvider);
    expect(warnMock).toHaveBeenCalledWith(expect.stringContaining('AI_PROVIDER_API_KEY'));
  });

  it('falls back to AI_PROVIDER_API_KEY when OPENAI_API_KEY is missing', () => {
    const warnMock = vi.fn();
    const provider = createWhisperTranscriptionProvider(
      { AI_PROVIDER_API_KEY: 'sk-test-fallback' },
      { logger: { warn: warnMock } },
    );
    expect(provider).not.toBeInstanceOf(DevNoopTranscriptionProvider);
    expect(warnMock).not.toHaveBeenCalled();
  });
});

describe('DeepgramStreamingProvider URL builder', () => {
  const provider = new DeepgramStreamingProvider('test-key');

  it('uses default 600ms endpointing when no override is supplied', () => {
    const url = (provider as unknown as {
      buildWsUrl: (lang: 'en' | 'es', options?: { keywords?: ReadonlyArray<string>; endpointingMs?: number }) => string;
    }).buildWsUrl('en');
    expect(url).toContain('endpointing=600');
  });

  it('honors a custom endpointing override', () => {
    const url = (provider as unknown as {
      buildWsUrl: (lang: 'en' | 'es', options?: { keywords?: ReadonlyArray<string>; endpointingMs?: number }) => string;
    }).buildWsUrl('en', { endpointingMs: 450 });
    expect(url).toContain('endpointing=450');
  });

  it('appends URL-encoded keywords when provided', () => {
    const url = (provider as unknown as {
      buildWsUrl: (lang: 'en' | 'es', options?: { keywords?: ReadonlyArray<string>; endpointingMs?: number }) => string;
    }).buildWsUrl('en', { keywords: ['heat pump:3', 'P-trap:3'] });
    expect(url).toContain('keywords=heat%20pump%3A3');
    expect(url).toContain('keywords=P-trap%3A3');
    // Both should appear as separate query params (joined by &)
    expect(url).toMatch(/keywords=heat%20pump%3A3&keywords=P-trap%3A3|keywords=P-trap%3A3&keywords=heat%20pump%3A3/);
  });

  it('omits the keywords parameter when the list is empty', () => {
    const url = (provider as unknown as {
      buildWsUrl: (lang: 'en' | 'es', options?: { keywords?: ReadonlyArray<string>; endpointingMs?: number }) => string;
    }).buildWsUrl('en', { keywords: [] });
    expect(url).not.toContain('keywords=');
  });
});

describe('DeepgramStreamingProvider open timeout (VOX-01)', () => {
  let originalWebSocket: typeof WebSocket;

  beforeEach(() => {
    originalWebSocket = global.WebSocket;
    vi.useFakeTimers();
  });

  afterEach(() => {
    global.WebSocket = originalWebSocket;
    vi.useRealTimers();
  });

  it('rejects and closes the socket when the WS handshake never opens', async () => {
    // Fake WS that NEVER fires open/error — models a stalled Deepgram
    // handshake. Without a bound, `await openSession` would hang forever
    // with caller audio already bridged (dead air). The bound must reject.
    let closed = false;
    const fakeWs = {
      readyState: 0,
      addEventListener: vi.fn(), // deliberately never invokes any listener
      send: vi.fn(),
      close: vi.fn(() => {
        closed = true;
      }),
    };
    global.WebSocket = vi.fn(function () { return fakeWs; }) as unknown as typeof WebSocket;

    const provider = new DeepgramStreamingProvider('test-key');
    const openPromise = provider.openSession(
      () => undefined,
      () => undefined,
      () => undefined,
    );
    // Attach the rejection assertion BEFORE advancing timers so the
    // rejection is never unhandled.
    const assertion = expect(openPromise).rejects.toThrow(/deepgram_open_timeout/);
    await vi.advanceTimersByTimeAsync(DEEPGRAM_OPEN_TIMEOUT_MS + 50);
    await assertion;
    expect(closed).toBe(true);
  });

  it('resolves normally when the socket opens before the timeout', async () => {
    const listeners: Record<string, (e: unknown) => void> = {};
    const fakeWs = {
      readyState: 0,
      addEventListener: vi.fn((event: string, fn: (e: unknown) => void) => {
        listeners[event] = fn;
      }),
      send: vi.fn(),
      close: vi.fn(),
    };
    global.WebSocket = vi.fn(function () { return fakeWs; }) as unknown as typeof WebSocket;

    const provider = new DeepgramStreamingProvider('test-key');
    const openPromise = provider.openSession(
      () => undefined,
      () => undefined,
      () => undefined,
    );
    // Fire open well within the bound.
    await vi.advanceTimersByTimeAsync(10);
    fakeWs.readyState = 1;
    listeners['open']?.({});
    const session = await openPromise;
    expect(session).toHaveProperty('send');
    expect(fakeWs.close).not.toHaveBeenCalled();
  });
});
