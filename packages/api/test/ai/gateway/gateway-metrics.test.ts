import { afterEach, describe, expect, it } from 'vitest';
import { metricsRegistry } from '../../../src/monitoring/metrics';
import { LLMGateway } from '../../../src/ai/gateway/gateway';
import { StubProvider } from '../../../src/ai/gateway/providers';

describe('LLMGateway classifier metrics', () => {
  afterEach(() => metricsRegistry.resetMetrics());

  it('labels classifier requests with task_type', async () => {
    const provider = new StubProvider('stub');
    provider.setResponse({
      content: '{}',
      tokenUsage: { input: 1, output: 1, total: 2 },
    });
    const gateway = new LLMGateway(
      { defaultProvider: 'stub' },
      new Map([['stub', provider]]),
    );

    await gateway.complete({
      taskType: 'classify_intent',
      tenantId: 'tenant-metrics',
      messages: [{ role: 'user', content: 'classify this' }],
    });

    const metrics = await metricsRegistry.metrics();
    expect(metrics).toContain('gateway_requests_total{tenant_tier="standard",model="meta-llama/llama-3.1-8b-instruct",provider="stub",outcome="success",task_type="classify_intent"} 1');
  });
});
