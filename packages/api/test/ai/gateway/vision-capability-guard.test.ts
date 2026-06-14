/**
 * F-A U4 — vision-capability guard, config, and cache bypass.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createMockLLMGateway } from '../../../src/ai/gateway/factory';
import { CachingGatewayWrapper, InMemoryCacheStore } from '../../../src/ai/gateway/cache';
import { isVisionCapableModel } from '../../../src/config/ai-routing';
import type { LLMRequest } from '../../../src/ai/gateway/gateway';

const imagePart = { type: 'image' as const, url: 'https://example.com/leak.jpg' };

function imageReq(model: string, taskType = 'draft_estimate'): LLMRequest {
  return {
    taskType,
    model,
    messages: [{ role: 'user', content: 'what work?', parts: [imagePart] }],
  };
}

describe('isVisionCapableModel', () => {
  const original = { ...process.env };
  beforeEach(() => {
    delete process.env.AI_VISION_CAPABLE_MODELS;
  });
  afterEach(() => {
    Object.assign(process.env, original);
    for (const k of Object.keys(process.env)) if (!(k in original)) delete process.env[k];
  });

  it('recognizes built-in default vision models, including namespaced ids', () => {
    expect(isVisionCapableModel('gpt-4o')).toBe(true);
    expect(isVisionCapableModel('openai/gpt-4o')).toBe(true);
    expect(isVisionCapableModel('claude-sonnet-4-6')).toBe(true);
    expect(isVisionCapableModel('text-davinci-003')).toBe(false);
    expect(isVisionCapableModel('')).toBe(false);
  });

  it('treats dated/versioned snapshots and namespaced ids as the base family', () => {
    expect(isVisionCapableModel('gpt-4o-2024-08-06')).toBe(true);
    expect(isVisionCapableModel('openai/gpt-4o-mini-2024-07-18')).toBe(true);
    expect(isVisionCapableModel('openrouter/openai/gpt-4o')).toBe(true);
    // shares a numeric prefix but is a different family — must stay false
    expect(isVisionCapableModel('gpt-3.5-turbo')).toBe(false);
  });

  it('honors AI_VISION_CAPABLE_MODELS overrides', () => {
    expect(isVisionCapableModel('my-vlm')).toBe(false);
    process.env.AI_VISION_CAPABLE_MODELS = 'my-vlm, another-vlm';
    expect(isVisionCapableModel('my-vlm')).toBe(true);
    expect(isVisionCapableModel('another-vlm')).toBe(true);
  });
});

describe('LLMGateway vision-capability guard', () => {
  it('forwards image parts to the provider when the resolved model is vision-capable', async () => {
    const { gateway, provider } = createMockLLMGateway('{"ok":true}');
    const res = await gateway.complete(imageReq('gpt-4o'));
    expect(res.content).toBe('{"ok":true}');
    const calls = provider.getCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0].messages[0].parts).toEqual([imagePart]);
  });

  it('accepts an image request on a dated snapshot of a vision model', async () => {
    const { gateway, provider } = createMockLLMGateway('{"ok":1}');
    await gateway.complete(imageReq('gpt-4o-2024-08-06'));
    expect(provider.getCalls()).toHaveLength(1);
  });

  it('throws before dispatch when images are routed to a non-vision model', async () => {
    const { gateway, provider } = createMockLLMGateway();
    await expect(gateway.complete(imageReq('text-only-model'))).rejects.toThrow(/vision-capable/);
    expect(provider.getCalls()).toHaveLength(0);
  });

  it('leaves text-only requests unaffected on any model', async () => {
    const { gateway, provider } = createMockLLMGateway('ok');
    const res = await gateway.complete({
      taskType: 'draft_estimate',
      model: 'text-only-model',
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(res.content).toBe('ok');
    expect(provider.getCalls()).toHaveLength(1);
  });
});

describe('CachingGatewayWrapper — image requests bypass the cache', () => {
  function wrap() {
    const { gateway, provider } = createMockLLMGateway('{"r":1}');
    const cached = new CachingGatewayWrapper(
      gateway,
      new InMemoryCacheStore(),
      { enabled: true, defaultTtlMs: 60_000, deterministicTaskTypes: ['intent_classification'] },
      'system',
    );
    return { cached, provider };
  }

  it('never serves an image request from cache', async () => {
    const { cached, provider } = wrap();
    const req: LLMRequest = {
      taskType: 'intent_classification',
      model: 'gpt-4o',
      messages: [{ role: 'user', content: 'x', parts: [imagePart] }],
    };
    await cached.complete(req);
    await cached.complete(req);
    expect(cached.getStats().hits).toBe(0);
    expect(provider.getCalls()).toHaveLength(2);
  });

  it('still caches the equivalent text request (control)', async () => {
    const { cached, provider } = wrap();
    const req: LLMRequest = {
      taskType: 'intent_classification',
      model: 'gpt-4o',
      messages: [{ role: 'user', content: 'x' }],
    };
    await cached.complete(req);
    await cached.complete(req);
    expect(cached.getStats().hits).toBe(1);
    expect(provider.getCalls()).toHaveLength(1);
  });
});
