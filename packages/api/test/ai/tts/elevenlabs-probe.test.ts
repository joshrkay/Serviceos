/**
 * #1536 — ElevenLabsTtsProvider.probe(): the cheapest request that proves the
 * key holds the Text to Speech permission. ElevenLabs exposes no permission
 * introspection endpoint scoped to text_to_speech, so the probe is a
 * one-character synthesis. Seam: the provider's public probe() with fetch
 * stubbed — no real provider calls.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { ElevenLabsTtsProvider } from '../../../src/ai/tts/tts-provider';

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function stubFetch(impl: (url: string, init?: RequestInit) => Promise<Response>) {
  const fn = vi.fn(impl);
  globalThis.fetch = fn as unknown as typeof fetch;
  return fn;
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('#1536 — ElevenLabsTtsProvider.probe', () => {
  it('reports missing_permissions for the 401 a key without Text to Speech gets', async () => {
    stubFetch(async () =>
      json(401, {
        detail: {
          status: 'missing_permissions',
          message: 'The API key you used is missing the permission text_to_speech to execute this operation.',
        },
      }),
    );

    const result = await new ElevenLabsTtsProvider('sk_test_key', 'voice-1').probe(new AbortController().signal);

    expect(result).toEqual({ ok: false, reason: 'missing_permissions' });
  });

  it('is ok after a 1-character authenticated synthesis on the configured voice', async () => {
    const fetchFn = stubFetch(async () => new Response(Buffer.from([0, 0]), { status: 200 }));

    const result = await new ElevenLabsTtsProvider('sk_test_key', 'voice-1').probe(new AbortController().signal);

    expect(result).toEqual({ ok: true });
    const [url, init] = fetchFn.mock.calls[0];
    expect(url).toContain('/v1/text-to-speech/voice-1');
    expect((init?.headers as Record<string, string>)['xi-api-key']).toBe('sk_test_key');
    expect(JSON.parse(String(init?.body)).text).toHaveLength(1);
  });

  it('reports unauthorized for an invalid key and unreachable when the request fails', async () => {
    const provider = new ElevenLabsTtsProvider('sk_test_key');

    stubFetch(async () => json(401, { detail: { status: 'invalid_api_key', message: 'Invalid API key' } }));
    expect(await provider.probe(new AbortController().signal)).toEqual({ ok: false, reason: 'unauthorized' });

    stubFetch(async () => {
      throw new TypeError('fetch failed');
    });
    expect(await provider.probe(new AbortController().signal)).toEqual({ ok: false, reason: 'unreachable' });

    stubFetch(async () => json(503, { detail: 'upstream down' }));
    expect(await provider.probe(new AbortController().signal)).toEqual({ ok: false, reason: 'unreachable' });
  });
});

describe('#1536 — ElevenLabsTtsProvider.synthesize rejection', () => {
  it('names the status and safe code, never the provider message', async () => {
    stubFetch(async () =>
      json(401, {
        detail: {
          status: 'missing_permissions',
          message: 'The API key you used is missing the permission text_to_speech to execute this operation.',
        },
      }),
    );

    const err = await new ElevenLabsTtsProvider('sk_test_key')
      .synthesize({ text: 'hello' })
      .then(() => null, (e: unknown) => e as Error & { code?: string });

    expect(err?.message).toBe('ElevenLabs TTS error (401 missing_permissions)');
    expect(err?.code).toBe('missing_permissions');
  });
});
