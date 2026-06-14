/**
 * F-A review fix — image-bearing requests are excluded from shadow sampling
 * (vision calls are expensive and the shadow model may be text-only).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  InMemoryShadowComparisonStore,
  ShadowComparisonGateway,
  ShadowComparisonConfig,
} from '../../../src/ai/evaluation/shadow-comparison';
import { StubProvider } from '../../../src/ai/gateway/providers';
import type { LLMRequest } from '../../../src/ai/gateway/gateway';

describe('ShadowComparisonGateway — image requests skip shadow sampling', () => {
  let store: InMemoryShadowComparisonStore;
  let primary: StubProvider;
  let shadow: StubProvider;
  const config: ShadowComparisonConfig = {
    enabled: true,
    samplingRate: 1.0, // force sampling
    shadowProvider: 'shadow',
    sampleFn: () => 0,
  };

  beforeEach(() => {
    store = new InMemoryShadowComparisonStore();
    primary = new StubProvider('primary');
    shadow = new StubProvider('shadow');
  });

  it('does not sample (no shadow call) for an image-bearing request', async () => {
    const gateway = new ShadowComparisonGateway(primary, shadow, store, config);
    const req: LLMRequest = {
      taskType: 'draft_estimate',
      messages: [
        { role: 'user', content: 'what work?', parts: [{ type: 'image', url: 'https://x/y.jpg' }] },
      ],
    };
    const res = await gateway.complete(req);
    expect(res.provider).toBe('primary');
    expect(gateway.getComparisonCount()).toBe(0);
    expect((await store.getAll()).length).toBe(0);
  });

  it('still samples an equivalent text request (control)', async () => {
    const gateway = new ShadowComparisonGateway(primary, shadow, store, config);
    await gateway.complete({
      taskType: 'draft_estimate',
      messages: [{ role: 'user', content: 'what work?' }],
    });
    expect(gateway.getComparisonCount()).toBe(1);
  });
});
