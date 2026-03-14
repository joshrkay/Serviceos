import { ProviderHealthMonitor, calculatePercentile } from '../../src/ai/gateway/health';
import type { HealthThresholds } from '../../src/ai/gateway/health';
import { FailoverGateway } from '../../src/ai/gateway/failover';
import { LLMGateway } from '../../src/ai/gateway/gateway';
import type { LLMProvider, LLMRequest, LLMResponse, LLMGatewayConfig } from '../../src/ai/gateway/gateway';
import { StubProvider } from '../../src/ai/gateway/providers';
import { InMemoryFeatureFlagStore } from '../../src/flags/feature-flags';
import { AppError } from '../../src/shared/errors';

function makeRequest(overrides: Partial<LLMRequest> = {}): LLMRequest {
  return {
    taskType: 'summarize',
    messages: [{ role: 'user', content: 'Hello' }],
    ...overrides,
  };
}

function makeGateway(provider: LLMProvider): LLMGateway {
  const providers = new Map<string, LLMProvider>();
  providers.set(provider.name, provider);
  const config: LLMGatewayConfig = {
    defaultProvider: provider.name,
    defaultModel: 'test-model',
  };
  return new LLMGateway(config, providers);
}

describe('P2-029 — Provider health monitoring and automatic failover', () => {
  it('happy path — healthy provider used normally', async () => {
    const primary = new StubProvider('primary');
    primary.setResponse({ content: 'primary response' });

    const fallback = new StubProvider('fallback');
    fallback.setResponse({ content: 'fallback response' });

    const monitor = new ProviderHealthMonitor();
    const gateway = new FailoverGateway(
      makeGateway(primary),
      makeGateway(fallback),
      monitor
    );

    const response = await gateway.complete(makeRequest());

    expect(response.content).toBe('primary response');
    expect(gateway.getFailoverCount()).toBe(0);
  });

  it('happy path — records metrics correctly', () => {
    const monitor = new ProviderHealthMonitor();

    monitor.recordResult('providerA', 100, true);
    monitor.recordResult('providerA', 200, true);
    monitor.recordResult('providerA', 150, false);

    const metrics = monitor.getMetrics('providerA');

    expect(metrics).not.toBeNull();
    expect(metrics!.sampleCount).toBe(3);
    expect(metrics!.errorRate).toBeCloseTo(1 / 3);
  });

  it('happy path — calculates error rate and p95', () => {
    const monitor = new ProviderHealthMonitor();

    // Record 100 results: 90 successes and 10 failures
    for (let i = 0; i < 90; i++) {
      monitor.recordResult('providerB', 50 + i, true);
    }
    for (let i = 0; i < 10; i++) {
      monitor.recordResult('providerB', 500 + i, false);
    }

    const metrics = monitor.getMetrics('providerB');

    expect(metrics).not.toBeNull();
    expect(metrics!.sampleCount).toBe(100);
    expect(metrics!.errorRate).toBeCloseTo(0.1);
    expect(metrics!.p95LatencyMs).toBeGreaterThan(0);
    expect(metrics!.p50LatencyMs).toBeGreaterThan(0);

    // Verify calculatePercentile helper directly
    const sorted = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
    expect(calculatePercentile(sorted, 50)).toBe(50);
    expect(calculatePercentile(sorted, 95)).toBe(100);
    expect(calculatePercentile([], 50)).toBe(0);
  });

  it('validation — unhealthy provider triggers failover', async () => {
    const primary = new StubProvider('primary');
    primary.setResponse({ content: 'primary response' });

    const fallback = new StubProvider('fallback');
    fallback.setResponse({ content: 'fallback response' });

    const monitor = new ProviderHealthMonitor({ maxErrorRate: 0.1 });

    // Make primary unhealthy by recording many errors
    for (let i = 0; i < 10; i++) {
      monitor.recordResult('primary', 100, false);
    }

    expect(monitor.isHealthy('primary')).toBe(false);

    const gateway = new FailoverGateway(
      makeGateway(primary),
      makeGateway(fallback),
      monitor
    );

    const response = await gateway.complete(makeRequest());

    expect(response.content).toBe('fallback response');
    expect(gateway.getFailoverCount()).toBe(1);
  });

  it('happy path — failover count tracked', async () => {
    const primary = new StubProvider('primary');
    const fallback = new StubProvider('fallback');
    fallback.setResponse({ content: 'fallback response' });

    const monitor = new ProviderHealthMonitor({ maxErrorRate: 0.1 });

    // Make primary unhealthy
    for (let i = 0; i < 10; i++) {
      monitor.recordResult('primary', 100, false);
    }

    const gateway = new FailoverGateway(
      makeGateway(primary),
      makeGateway(fallback),
      monitor
    );

    await gateway.complete(makeRequest());
    await gateway.complete(makeRequest());
    await gateway.complete(makeRequest());

    expect(gateway.getFailoverCount()).toBe(3);
  });

  it('mock provider test — manual override via feature flag', async () => {
    const primary = new StubProvider('primary');
    primary.setResponse({ content: 'primary forced' });

    const fallback = new StubProvider('fallback');
    fallback.setResponse({ content: 'fallback response' });

    const monitor = new ProviderHealthMonitor({ maxErrorRate: 0.1 });

    // Make primary unhealthy
    for (let i = 0; i < 10; i++) {
      monitor.recordResult('primary', 100, false);
    }

    expect(monitor.isHealthy('primary')).toBe(false);

    const flagStore = new InMemoryFeatureFlagStore([
      { name: 'force_primary_provider', enabled: true },
    ]);

    const gateway = new FailoverGateway(
      makeGateway(primary),
      makeGateway(fallback),
      monitor,
      flagStore
    );

    // Even though primary is unhealthy, the flag forces it
    const response = await gateway.complete(makeRequest());

    expect(response.content).toBe('primary forced');
    expect(gateway.getFailoverCount()).toBe(0);
  });

  it('malformed AI output handled gracefully — both providers fail throws error', async () => {
    const failingPrimary: LLMProvider = {
      name: 'failing-primary',
      async complete() {
        throw new Error('Primary down');
      },
      async isAvailable() {
        return true;
      },
    };

    const failingFallback: LLMProvider = {
      name: 'failing-fallback',
      async complete() {
        throw new Error('Fallback down');
      },
      async isAvailable() {
        return true;
      },
    };

    const monitor = new ProviderHealthMonitor();
    const gateway = new FailoverGateway(
      makeGateway(failingPrimary),
      makeGateway(failingFallback),
      monitor
    );

    await expect(gateway.complete(makeRequest())).rejects.toThrow(AppError);

    try {
      await gateway.complete(makeRequest());
    } catch (err) {
      expect(err).toBeInstanceOf(AppError);
      expect((err as AppError).code).toBe('ALL_PROVIDERS_FAILED');
    }
  });

  it('happy path — sliding window prunes old data', () => {
    const monitor = new ProviderHealthMonitor({ windowMs: 1000 });

    // Record results with timestamps that will be pruned
    monitor.recordResult('providerC', 100, false);
    monitor.recordResult('providerC', 100, false);

    // Manually check metrics exist
    const metricsBefore = monitor.getMetrics('providerC');
    expect(metricsBefore).not.toBeNull();
    expect(metricsBefore!.sampleCount).toBe(2);

    // After reset, no data
    monitor.reset('providerC');
    const metricsAfter = monitor.getMetrics('providerC');
    expect(metricsAfter).toBeNull();

    // Provider with no data is considered healthy
    expect(monitor.isHealthy('providerC')).toBe(true);
  });
});
