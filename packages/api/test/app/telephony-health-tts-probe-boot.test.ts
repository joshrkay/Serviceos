/**
 * #1536 — app-level wiring: the REAL createApp() serves /api/telephony/health
 * with the TTS provider probe, so an ElevenLabs key without the Text to
 * Speech permission reports `tts: false` instead of the config-only `true`.
 * Hermetic boot (no DATABASE_URL → InMemory repos); fetch is stubbed, so no
 * real provider call is made.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { createApp, type AppWithLifecycle } from '../../src/app';
import { resetConfig } from '../../src/shared/config';

const KEYS = ['NODE_ENV', 'DEV_AUTH_BYPASS', 'DATABASE_URL', 'PROCESS_ROLE', 'TTS_PROVIDER', 'ELEVENLABS_API_KEY'];

describe('#1536 — createApp() wires the TTS probe into /api/telephony/health', () => {
  let app: AppWithLifecycle;
  let prev: Record<string, string | undefined>;
  const realFetch = globalThis.fetch;
  const elevenLabsCalls: string[] = [];

  beforeAll(() => {
    prev = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
    process.env.NODE_ENV = 'dev';
    process.env.DEV_AUTH_BYPASS = 'true';
    process.env.PROCESS_ROLE = 'web';
    process.env.TTS_PROVIDER = 'elevenlabs';
    process.env.ELEVENLABS_API_KEY = 'el_dummy_not_real';
    delete process.env.DATABASE_URL;
    globalThis.fetch = (async (input: unknown) => {
      const url = typeof input === 'string' ? input : String((input as { url?: string })?.url ?? input);
      if (url.startsWith('https://api.elevenlabs.io/')) {
        elevenLabsCalls.push(url);
        return new Response(
          JSON.stringify({ detail: { status: 'missing_permissions', message: 'missing text_to_speech' } }),
          { status: 401, headers: { 'content-type': 'application/json' } },
        );
      }
      return new Response('not stubbed', { status: 404 });
    }) as typeof fetch;
    resetConfig();
    app = createApp();
  });

  afterAll(async () => {
    globalThis.fetch = realFetch;
    await app.gracefulDrain('test-cleanup');
    resetConfig();
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it('reports tts:false / missing_permissions, probing ElevenLabs once across repeated hits', async () => {
    const first = await request(app).get('/api/telephony/health');
    const second = await request(app).get('/api/telephony/health');

    expect(first.status).toBe(200);
    expect(first.body.capabilities.tts).toBe(false);
    expect(first.body.ttsCheck).toMatchObject({ status: 'failed', reason: 'missing_permissions' });
    expect(second.body.ttsCheck).toMatchObject({ status: 'failed', reason: 'missing_permissions' });
    expect(elevenLabsCalls.filter((u) => u.includes('/v1/text-to-speech/'))).toHaveLength(1);
  });
});
