/**
 * U10 — LLMGateway → trace exporter hook (plan 2026-09-05-001, R10).
 *
 * Drives the real gateway with an inline provider (pattern:
 * gateway-metrics.test.ts) and a spy exporter, and pins:
 *   - the success event's fields come from values the gateway already has;
 *   - a failover-served response carries providerPath / fallbackStage /
 *     degraded (the resilience stack wraps the PROVIDER, so the gateway hook
 *     sees them);
 *   - the error event carries the message + latency and the gateway still
 *     rethrows;
 *   - an exporter that throws never touches the completion and is logged
 *     with the correlation id (the aiRunRepo best-effort contract).
 */
import { describe, it, expect, vi } from 'vitest';
import {
  LLMGateway,
  type LLMProvider,
  type LLMRequest,
  type LLMResponse,
} from '../../../src/ai/gateway/gateway';
import { computeCostMicroCents } from '../../../src/ai/gateway/model-pricing';
import { ProviderFailoverWrapper } from '../../../src/ai/gateway/compose-resilience';
import type {
  LLMTraceCompletionEvent,
  LLMTraceExporter,
} from '../../../src/ai/gateway/trace-exporter';

function providerOf(complete: (req: LLMRequest) => Promise<LLMResponse>): LLMProvider {
  return { name: 'stub', complete, isAvailable: async () => true };
}

function okResponse(over: Partial<LLMResponse> = {}): LLMResponse {
  return {
    content: '{"intentType":"create_invoice"}',
    model: 'gpt-4o-mini',
    provider: 'openai',
    tokenUsage: { input: 200, output: 40, total: 240 },
    latencyMs: 0,
    ...over,
  };
}

function spyExporter(onEvent?: (e: LLMTraceCompletionEvent) => void) {
  const events: LLMTraceCompletionEvent[] = [];
  const exporter: LLMTraceExporter = {
    recordCompletion: vi.fn((e: LLMTraceCompletionEvent) => {
      events.push(e);
      onEvent?.(e);
    }),
    flush: vi.fn(async () => {}),
  };
  return { exporter, events };
}

function logger() {
  return { info: vi.fn(), error: vi.fn() };
}

function gatewayWith(
  provider: LLMProvider,
  exporter: LLMTraceExporter | undefined,
  log?: ReturnType<typeof logger>,
): LLMGateway {
  return new LLMGateway(
    { defaultProvider: 'stub' },
    new Map([['stub', provider]]),
    log,
    undefined,
    exporter,
  );
}

const request: LLMRequest = {
  taskType: 'classify_intent',
  tenantId: 'tenant-trace',
  messages: [{ role: 'user', content: 'invoice Acme for the tune-up' }],
  metadata: {
    tenantId: 'tenant-trace',
    correlationId: 'corr-abc',
    sessionId: 'voice-sess-9',
    promptVersionId: 'classify-v7',
  },
};

describe('LLMGateway — trace export', () => {
  it('success: one event with usage, cost, latency, prompt version, correlation id and session id', async () => {
    const { exporter, events } = spyExporter();
    const gateway = gatewayWith(providerOf(async () => okResponse()), exporter);

    const result = await gateway.complete(request);

    expect(events).toHaveLength(1);
    const e = events[0];
    expect(e).toMatchObject({
      correlationId: 'corr-abc',
      sessionId: 'voice-sess-9',
      tenantId: 'tenant-trace',
      taskType: 'classify_intent',
      promptVersionId: 'classify-v7',
      tokenUsage: { input: 200, output: 40, total: 240 },
      servedModel: 'gpt-4o-mini',
      provider: 'openai',
      cached: false,
      degraded: false,
      output: '{"intentType":"create_invoice"}',
    });
    expect(e.error).toBeUndefined();
    expect(typeof e.resolvedModel).toBe('string');
    expect(e.input).toEqual(request.messages);
    expect(e.startedAt).toBeInstanceOf(Date);
    expect(typeof e.latencyMs).toBe('number');
    expect(e.latencyMs).toBe(result.latencyMs);
    // The same figure the response carries — priced at the SERVED model.
    expect(e.costMicroCents).toBe(computeCostMicroCents('gpt-4o-mini', result.tokenUsage));
    expect(e.costMicroCents).toBe(result.costMicroCents);
  });

  it('fallback-served response: event carries providerPath, fallbackStage and degraded:true', async () => {
    const { exporter, events } = spyExporter();
    const gateway = gatewayWith(
      providerOf(async () =>
        okResponse({
          model: 'meta-llama/llama-3.1-8b-instruct',
          provider: 'openrouter',
          degraded: true,
          fallbackStage: 'fallback-provider',
          providerPath: ['openai/gpt-4o-mini', 'openrouter/meta-llama/llama-3.1-8b-instruct'],
        }),
      ),
      exporter,
    );

    await gateway.complete(request);

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      degraded: true,
      fallbackStage: 'fallback-provider',
      providerPath: ['openai/gpt-4o-mini', 'openrouter/meta-llama/llama-3.1-8b-instruct'],
      servedModel: 'meta-llama/llama-3.1-8b-instruct',
      provider: 'openrouter',
    });
  });

  it('failure: event carries the error message and latency, no usage, and the gateway still rethrows', async () => {
    const { exporter, events } = spyExporter();
    const gateway = gatewayWith(
      providerOf(async () => {
        throw new Error('upstream 503');
      }),
      exporter,
    );

    await expect(gateway.complete(request)).rejects.toThrow('upstream 503');

    expect(events).toHaveLength(1);
    const e = events[0];
    expect(e.error).toContain('upstream 503');
    expect(typeof e.latencyMs).toBe('number');
    expect(e.tokenUsage).toBeUndefined();
    expect(e.output).toBeUndefined();
    expect(e).toMatchObject({
      correlationId: 'corr-abc',
      sessionId: 'voice-sess-9',
      tenantId: 'tenant-trace',
      taskType: 'classify_intent',
      cached: false,
      degraded: false,
    });
    expect(e.input).toEqual(request.messages);
    // No resilience wrapper in the chain → no attempt trail; the routed
    // provider is the only candidate and the event stays un-annotated.
    expect(e.provider).toBe('stub');
    expect(e.providerPath).toBeUndefined();
    expect(e.fallbackStage).toBeUndefined();
  });

  // PR #975 review finding 6 — the failure-path event used to stamp the
  // PRIMARY resolved provider even when the request had failed over and it
  // was the FALLBACK that failed last, and it carried no providerPath /
  // fallbackStage at all. The resilience stack wraps the provider, so the
  // gateway only sees the error the failover wrapper gives up with — that
  // error now carries the attempt trail and the event is built from it.
  describe('failure after failover names the provider that actually failed', () => {
    function failing(name: string, err: Error & { status?: number }): LLMProvider {
      return {
        name,
        complete: async () => {
          throw err;
        },
        isAvailable: async () => true,
      };
    }

    it('primary and fallback both throw → provider = fallback, providerPath = [primary, fallback]', async () => {
      const { exporter, events } = spyExporter();
      const primaryErr = Object.assign(new Error('openai 503'), { status: 503 });
      const fallbackErr = Object.assign(new Error('openrouter 502'), { status: 502 });
      const stack = new ProviderFailoverWrapper([
        failing('openai', primaryErr),
        failing('openrouter', fallbackErr),
      ]);
      const gateway = gatewayWith(stack, exporter);

      await expect(gateway.complete(request)).rejects.toThrow('openrouter 502');

      expect(events).toHaveLength(1);
      const e = events[0];
      const model = e.resolvedModel;
      expect(e).toMatchObject({
        provider: 'openrouter',
        providerPath: [`openai:${model}`, `openrouter:${model}`],
        fallbackStage: 'fallback-provider',
        degraded: true,
        servedModel: model,
      });
      expect(e.error).toContain('openrouter 502');
    });

    it('primary throws 5xx, fallback rejects with a 4xx (re-thrown raw, no failover) → still attributed to the fallback', async () => {
      const { exporter, events } = spyExporter();
      const primaryErr = Object.assign(new Error('openai 503'), { status: 503 });
      const fallbackErr = Object.assign(new Error('openrouter 400 bad request'), { status: 400 });
      const stack = new ProviderFailoverWrapper([
        failing('openai', primaryErr),
        failing('openrouter', fallbackErr),
      ]);
      const gateway = gatewayWith(stack, exporter);

      await expect(gateway.complete(request)).rejects.toThrow('openrouter 400 bad request');

      const e = events[0];
      const model = e.resolvedModel;
      expect(e).toMatchObject({
        provider: 'openrouter',
        providerPath: [`openai:${model}`, `openrouter:${model}`],
        fallbackStage: 'fallback-provider',
        degraded: true,
      });
    });

    it('single provider in the stack fails → provider = that provider, one-entry providerPath, no fallback stage', async () => {
      const { exporter, events } = spyExporter();
      const stack = new ProviderFailoverWrapper([
        failing('openai', Object.assign(new Error('openai 503'), { status: 503 })),
      ]);
      const gateway = gatewayWith(stack, exporter);

      await expect(gateway.complete(request)).rejects.toThrow('openai 503');

      const e = events[0];
      expect(e.provider).toBe('openai');
      expect(e.providerPath).toEqual([`openai:${e.resolvedModel}`]);
      expect(e.fallbackStage).toBeUndefined();
      expect(e.degraded).toBe(false);
    });
  });

  it('isolation: an exporter that throws leaves the completion unchanged and is logged with the correlation id', async () => {
    const log = logger();
    const { exporter } = spyExporter(() => {
      throw new Error('langfuse queue full');
    });
    const gateway = gatewayWith(providerOf(async () => okResponse()), exporter, log);

    const result = await gateway.complete(request);

    expect(result.content).toBe('{"intentType":"create_invoice"}');
    expect(result.tokenUsage).toEqual({ input: 200, output: 40, total: 240 });
    expect(log.error).toHaveBeenCalledWith(
      expect.stringContaining('trace export'),
      expect.objectContaining({ correlationId: 'corr-abc', error: 'langfuse queue full' }),
    );
  });

  it('isolation on the error path: the provider error is what surfaces, not the exporter error', async () => {
    const log = logger();
    const { exporter } = spyExporter(() => {
      throw new Error('langfuse queue full');
    });
    const gateway = gatewayWith(
      providerOf(async () => {
        throw new Error('upstream 503');
      }),
      exporter,
      log,
    );

    await expect(gateway.complete(request)).rejects.toThrow('upstream 503');
    expect(log.error).toHaveBeenCalledWith(
      expect.stringContaining('trace export'),
      expect.objectContaining({ correlationId: 'corr-abc' }),
    );
  });

  it('no correlation id supplied → the gateway-minted id is the trace id; no session id → undefined', async () => {
    const { exporter, events } = spyExporter();
    const gateway = gatewayWith(providerOf(async () => okResponse()), exporter);

    await gateway.complete({ ...request, metadata: { tenantId: 'tenant-trace' } });

    expect(events[0].correlationId).toMatch(/^[0-9a-f-]{36}$/);
    expect(events[0].sessionId).toBeUndefined();
    expect(events[0].promptVersionId).toBeUndefined();
  });

  it('no exporter wired → the completion is unaffected', async () => {
    const gateway = gatewayWith(providerOf(async () => okResponse()), undefined);
    const result = await gateway.complete(request);
    expect(result.content).toBe('{"intentType":"create_invoice"}');
  });
});
