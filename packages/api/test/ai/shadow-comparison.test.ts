import {
  InMemoryShadowComparisonStore,
  ShadowComparisonGateway,
  ShadowComparisonConfig,
  ShadowComparisonStore,
} from '../../src/ai/evaluation/shadow-comparison';
import { StubProvider } from '../../src/ai/gateway/providers';
import { LLMRequest } from '../../src/ai/gateway/gateway';

function makeRequest(overrides?: Partial<LLMRequest>): LLMRequest {
  return {
    taskType: 'draft_estimate',
    messages: [{ role: 'user', content: 'Generate an estimate' }],
    ...overrides,
  };
}

describe('P2-030 — Model performance shadow comparison', () => {
  let store: ShadowComparisonStore;
  let primaryProvider: StubProvider;
  let shadowProvider: StubProvider;

  beforeEach(() => {
    store = new InMemoryShadowComparisonStore();
    primaryProvider = new StubProvider('primary');
    shadowProvider = new StubProvider('shadow');
    primaryProvider.setResponse({ content: 'primary response' });
    shadowProvider.setResponse({ content: 'shadow response' });
  });

  it('happy path — primary response returned regardless of shadow', async () => {
    const config: ShadowComparisonConfig = {
      enabled: true,
      samplingRate: 1.0,
      shadowProvider: 'shadow',
      sampleFn: () => 0,
    };
    const gateway = new ShadowComparisonGateway(primaryProvider, shadowProvider, store, config);

    const response = await gateway.complete(makeRequest());

    expect(response.content).toBe('primary response');
    expect(response.provider).toBe('primary');
  });

  it('happy path — shadow called at configured rate', async () => {
    const config: ShadowComparisonConfig = {
      enabled: true,
      samplingRate: 1.0,
      shadowProvider: 'shadow',
      sampleFn: () => 0, // always below 1.0, so always sampled
    };
    const gateway = new ShadowComparisonGateway(primaryProvider, shadowProvider, store, config);

    await gateway.complete(makeRequest());

    const results = await store.getAll();
    expect(results.length).toBe(1);
    expect(results[0].primaryResponse.content).toBe('primary response');
    expect(results[0].shadowResponse?.content).toBe('shadow response');
    expect(results[0].taskType).toBe('draft_estimate');
  });

  it('happy path — shadow not called when rate is 0', async () => {
    const config: ShadowComparisonConfig = {
      enabled: true,
      samplingRate: 0,
      shadowProvider: 'shadow',
      sampleFn: () => 0.5, // 0.5 is not < 0, so no shadow
    };
    const gateway = new ShadowComparisonGateway(primaryProvider, shadowProvider, store, config);

    const response = await gateway.complete(makeRequest());

    expect(response.content).toBe('primary response');
    const results = await store.getAll();
    expect(results.length).toBe(0);
    expect(gateway.getComparisonCount()).toBe(0);
  });

  it('happy path — shadow failure does not affect primary', async () => {
    const failingShadow = new StubProvider('shadow-fail');
    failingShadow.setAvailable(false);
    // Make shadow throw on complete
    const originalComplete = failingShadow.complete.bind(failingShadow);
    failingShadow.complete = async () => {
      throw new Error('Shadow provider unavailable');
    };

    const config: ShadowComparisonConfig = {
      enabled: true,
      samplingRate: 1.0,
      shadowProvider: 'shadow-fail',
      sampleFn: () => 0,
    };
    const gateway = new ShadowComparisonGateway(primaryProvider, failingShadow, store, config);

    const response = await gateway.complete(makeRequest());

    expect(response.content).toBe('primary response');
    const results = await store.getAll();
    expect(results.length).toBe(1);
    expect(results[0].shadowResponse).toBeUndefined();
    expect(results[0].shadowError).toBe('Shadow provider unavailable');
  });

  it('happy path — comparison result stored', async () => {
    const config: ShadowComparisonConfig = {
      enabled: true,
      samplingRate: 1.0,
      shadowProvider: 'shadow',
      sampleFn: () => 0,
    };
    const gateway = new ShadowComparisonGateway(primaryProvider, shadowProvider, store, config);

    await gateway.complete(makeRequest());

    const results = await store.getAll();
    expect(results.length).toBe(1);
    expect(results[0].id).toBeDefined();
    expect(results[0].comparisonGroupId).toBeDefined();
    expect(results[0].sampledAt).toBeInstanceOf(Date);
    expect(gateway.getComparisonCount()).toBe(1);
  });

  it('mock provider test — sampling rate respected', async () => {
    let callCount = 0;
    const config: ShadowComparisonConfig = {
      enabled: true,
      samplingRate: 0.5,
      shadowProvider: 'shadow',
      sampleFn: () => {
        callCount++;
        // Alternate: first call sampled (0.1 < 0.5), second not (0.9 >= 0.5)
        return callCount % 2 === 1 ? 0.1 : 0.9;
      },
    };
    const gateway = new ShadowComparisonGateway(primaryProvider, shadowProvider, store, config);

    await gateway.complete(makeRequest()); // sampled
    await gateway.complete(makeRequest()); // not sampled
    await gateway.complete(makeRequest()); // sampled

    const results = await store.getAll();
    expect(results.length).toBe(2);
    expect(gateway.getComparisonCount()).toBe(2);
  });

  it('malformed AI output handled gracefully — shadow error logged not thrown', async () => {
    const badShadow = new StubProvider('bad-shadow');
    badShadow.complete = async () => {
      throw new Error('Malformed JSON in response');
    };

    const config: ShadowComparisonConfig = {
      enabled: true,
      samplingRate: 1.0,
      shadowProvider: 'bad-shadow',
      sampleFn: () => 0,
    };
    const gateway = new ShadowComparisonGateway(primaryProvider, badShadow, store, config);

    // Should not throw
    const response = await gateway.complete(makeRequest());

    expect(response.content).toBe('primary response');
    const results = await store.getAll();
    expect(results.length).toBe(1);
    expect(results[0].shadowError).toBe('Malformed JSON in response');
    expect(results[0].shadowResponse).toBeUndefined();
  });
});
