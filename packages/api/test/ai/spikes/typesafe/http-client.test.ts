import { describe, expect, it } from 'vitest';
import { createHttpSystemOneClient } from '../../../../src/ai/spikes/typesafe/http-client';

describe('createHttpSystemOneClient', () => {
  it('POSTs the request with a bearer key and returns the parsed answers', async () => {
    const seen: { url?: string; init?: RequestInit } = {};
    const fakeFetch = (async (url: string, init: RequestInit) => {
      seen.url = url;
      seen.init = init;
      return new Response(JSON.stringify({ answers: { q: { noul: 0.7 } } }), { status: 200 });
    }) as unknown as typeof fetch;

    const client = createHttpSystemOneClient({ apiKey: 'k_test', fetchImpl: fakeFetch });
    const res = await client.systemOne({
      state: 'hi',
      model: 'jev-latest',
      questions: { q: { type: 'noul', instructions: 'x?' } },
    });

    expect(seen.url).toBe('https://api.typesafe.ai/v1/systemone');
    expect((seen.init?.headers as Record<string, string>).Authorization).toBe('Bearer k_test');
    expect(res.answers.q.noul).toBe(0.7);
  });

  it('throws with the status on a non-2xx response and never echoes the key', async () => {
    const fakeFetch = (async () => new Response('nope', { status: 401 })) as unknown as typeof fetch;
    const client = createHttpSystemOneClient({ apiKey: 'k_secret', fetchImpl: fakeFetch });
    const err = await client
      .systemOne({ state: 'hi', model: 'jev-latest', questions: {} })
      .catch((e: Error) => e);
    expect((err as Error).message).toContain('401');
    expect((err as Error).message).not.toContain('k_secret');
  });
});
