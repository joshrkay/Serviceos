/**
 * P2-030 — Sampling rate statistical test.
 *
 * Over 1000 calls, the observed shadow-call rate should be within ±5% of the
 * configured rate. Also verifies the ai_run_id linkage requirement.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  InMemoryShadowComparisonStore,
  ShadowComparisonGateway,
  ShadowComparisonConfig,
} from '../../../src/ai/evaluation/shadow-comparison';
import { StubProvider } from '../../../src/ai/gateway/providers';
import type { LLMRequest } from '../../../src/ai/gateway/gateway';

function makeRequest(overrides?: Partial<LLMRequest>): LLMRequest {
  return {
    taskType: 'draft_estimate',
    messages: [{ role: 'user', content: 'hello' }],
    tenantId: 'tenant-123',
    metadata: { aiRunId: 'run-abc' },
    ...overrides,
  };
}

describe('P2-030 — Sampling rate statistical test', () => {
  let store: InMemoryShadowComparisonStore;
  let primary: StubProvider;
  let shadow: StubProvider;

  beforeEach(() => {
    store = new InMemoryShadowComparisonStore();
    primary = new StubProvider('primary');
    shadow = new StubProvider('shadow');
    primary.setResponse({ content: 'primary' });
    shadow.setResponse({ content: 'shadow' });
  });

  it('10% sampling rate is within ±5% over 1000 calls', async () => {
    const targetRate = 0.1;
    const config: ShadowComparisonConfig = {
      enabled: true,
      samplingRate: targetRate,
      shadowProvider: 'shadow',
    };
    const gateway = new ShadowComparisonGateway(primary, shadow, store, config);

    const calls = 1000;
    for (let i = 0; i < calls; i++) {
      await gateway.complete(makeRequest());
    }

    const actualRate = gateway.getComparisonCount() / calls;
    expect(actualRate).toBeGreaterThanOrEqual(targetRate - 0.05);
    expect(actualRate).toBeLessThanOrEqual(targetRate + 0.05);
  });

  it('shadow failure never blocks primary response', async () => {
    const failingShadow = new StubProvider('fail-shadow');
    failingShadow.complete = async () => {
      throw new Error('shadow down');
    };

    const config: ShadowComparisonConfig = {
      enabled: true,
      samplingRate: 1.0,
      shadowProvider: 'fail-shadow',
      sampleFn: () => 0,
    };
    const gateway = new ShadowComparisonGateway(primary, failingShadow, store, config);

    const response = await gateway.complete(makeRequest());

    // Primary response returned despite shadow failure
    expect(response.content).toBe('primary');
    expect(response.provider).toBe('primary');

    // Comparison still stored with error
    const results = await store.getAll();
    expect(results.length).toBe(1);
    expect(results[0].shadowError).toBe('shadow down');
    expect(results[0].shadowResponse).toBeUndefined();
  });

  it('comparison result links to tenantId and aiRunId when supplied via request', async () => {
    const config: ShadowComparisonConfig = {
      enabled: true,
      samplingRate: 1.0,
      shadowProvider: 'shadow',
      sampleFn: () => 0,
    };
    const gateway = new ShadowComparisonGateway(primary, shadow, store, config);

    await gateway.complete(makeRequest({ tenantId: 'tenant-xyz' }));

    const results = await store.getAll();
    expect(results.length).toBe(1);
    // tenantId is passed through from request
    expect(results[0].tenantId).toBe('tenant-xyz');
    // aiRunId linkage: run-abc comes from makeRequest's metadata.aiRunId
    expect(results[0].aiRunId).toBe('run-abc');
  });
});
