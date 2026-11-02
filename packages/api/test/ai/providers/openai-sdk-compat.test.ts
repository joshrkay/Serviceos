import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { zodResponseFormat } from 'openai/helpers/zod';
import { OpenAICompatibleProvider } from '../../../src/ai/providers/openai-compatible';
import type { LLMRequest } from '../../../src/ai/gateway/gateway';

// Exercise the real SDK's serialization, response decoding and error classes.
// Only the HTTP transport is stubbed: these tests cannot spend model credits.
afterEach(() => vi.unstubAllGlobals());

function provider() {
  return new OpenAICompatibleProvider({
    apiKey: 'test-key',
    baseURL: 'https://provider.invalid/v1',
    defaultHeaders: { 'HTTP-Referer': 'https://serviceos.example' },
  });
}

function request(overrides: Partial<LLMRequest> = {}): LLMRequest {
  return {
    taskType: 'classify_intent',
    tenantId: 'tenant-sdk-test',
    model: 'test-model',
    messages: [{ role: 'user', content: 'Schedule a visit' }],
    ...overrides,
  };
}

describe('OpenAI SDK compatibility', () => {
  it('preserves JSON mode, multimodal messages, headers and token accounting', async () => {
    const transport = vi.fn<typeof fetch>().mockResolvedValue(Response.json({
      choices: [{ message: { content: '{"ok":true}' } }],
      model: 'resolved-model',
      usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
    }));
    vi.stubGlobal('fetch', transport);
    const result = await provider().complete(request({
      responseFormat: 'json',
      maxTokens: 50,
      messages: [{ role: 'user', content: 'Inspect this', parts: [
        { type: 'image', url: 'https://example.com/photo.png', detail: 'low' },
      ] }],
    }));
    expect(transport).toHaveBeenCalledOnce();
    const [url, init] = transport.mock.calls[0];
    expect(String(url)).toBe('https://provider.invalid/v1/chat/completions');
    const headers = new Headers(init?.headers);
    expect(headers.get('authorization')).toBe('Bearer test-key');
    expect(headers.get('http-referer')).toBe('https://serviceos.example');
    expect(JSON.parse(String(init?.body))).toMatchObject({
      model: 'test-model', max_tokens: 50, response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: expect.stringContaining('JSON') },
        { role: 'user', content: [
          { type: 'text', text: 'Inspect this' },
          { type: 'image_url', image_url: { url: 'https://example.com/photo.png', detail: 'low' } },
        ] },
      ],
    });
    expect(result).toMatchObject({
      content: '{"ok":true}', model: 'resolved-model',
      tokenUsage: { input: 10, output: 2, total: 12 },
    });
  });

  it('decodes base64 embeddings into the expected numeric vector', async () => {
    const vector = new Float32Array(1536).fill(0.25);
    const transport = vi.fn<typeof fetch>().mockResolvedValue(Response.json({
      data: [{ embedding: Buffer.from(vector.buffer).toString('base64'), index: 0 }],
      model: 'text-embedding-3-small', usage: { total_tokens: 3 },
    }));
    vi.stubGlobal('fetch', transport);
    const result = await provider().createEmbedding('repair faucet');
    expect(result.embedding).toEqual(Array.from(vector));
    expect(result.tokenUsage).toBe(3);
    expect(JSON.parse(String(transport.mock.calls[0][1]?.body))).toMatchObject({
      input: 'repair faucet', model: 'text-embedding-3-small', encoding_format: 'base64',
    });
  });

  it('surfaces rate limits with Retry-After without SDK retries', async () => {
    const transport = vi.fn<typeof fetch>().mockImplementation(async () => Response.json({
      error: { message: 'Slow down', type: 'rate_limit_exceeded', code: 'rate_limit_exceeded' },
    }, { status: 429, headers: { 'retry-after': '2' } }));
    vi.stubGlobal('fetch', transport);
    await expect(provider().complete(request())).rejects.toMatchObject({
      name: 'ProviderRateLimitError', retryAfterMs: 2000,
    });
    expect(transport).toHaveBeenCalledOnce();
  });

  it('cancels an in-flight request when the gateway deadline aborts', async () => {
    let started!: () => void;
    const requestStarted = new Promise<void>((resolve) => { started = resolve; });
    const transport = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(new DOMException('Aborted', 'AbortError'));
        }, { once: true });
        started();
      });
    });
    vi.stubGlobal('fetch', transport);
    const controller = new AbortController();
    const result = provider().complete(request({ signal: controller.signal }));
    const assertion = expect(result).rejects.toMatchObject({ message: 'Request was aborted.' });
    await requestStarted;
    controller.abort();
    await assertion;
    expect(transport).toHaveBeenCalledOnce();
    expect(transport.mock.calls[0][1]?.signal?.aborted).toBe(true);
  });

  it('supports the application Zod 4 schemas in the SDK structured-output helper', () => {
    const schema = z.object({ ids: z.array(z.string()).max(2) });
    const format = zodResponseFormat(schema, 'selection');
    expect(format.json_schema).toMatchObject({
      name: 'selection', strict: true,
      schema: { properties: { ids: { type: 'array', maxItems: 2 } } },
    });
    expect(format.$parseRaw('{"ids":["a"]}')).toEqual({ ids: ['a'] });
    expect(() => format.$parseRaw('{"ids":["a","b","c"]}')).toThrow();
  });
});
