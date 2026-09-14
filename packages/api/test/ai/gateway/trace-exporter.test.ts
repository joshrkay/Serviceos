/**
 * U10 — Langfuse trace exporter (plan 2026-09-05-001, R10).
 *
 * The Langfuse client is a fake injected through the exporter's `client`
 * option: these tests pin the PAYLOAD contract (what leaves the gateway),
 * never the SDK's transport. No network, and the `langfuse` module is never
 * required — the module-absent path is covered explicitly.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  LangfuseTraceExporter,
  NoopTraceExporter,
  createTraceExporterFromConfig,
  microCentsToUsd,
  type LLMTraceCompletionEvent,
  type LangfuseClientLike,
  type LangfuseGenerationBody,
  type LangfuseTraceBody,
} from '../../../src/ai/gateway/trace-exporter';

function fakeClient() {
  const traces: LangfuseTraceBody[] = [];
  const generations: LangfuseGenerationBody[] = [];
  const shutdownAsync = vi.fn(async () => {});
  const client: LangfuseClientLike = {
    trace: (body) => {
      traces.push(body);
      return {
        generation: (g) => {
          generations.push(g);
        },
      };
    },
    shutdownAsync,
  };
  return { client, traces, generations, shutdownAsync };
}

function logger() {
  return { info: vi.fn(), error: vi.fn() };
}

function event(overrides: Partial<LLMTraceCompletionEvent> = {}): LLMTraceCompletionEvent {
  return {
    correlationId: 'corr-1',
    tenantId: 'tenant-a',
    taskType: 'classify_intent',
    sessionId: 'voice-sess-1',
    resolvedModel: 'meta-llama/llama-3.1-8b-instruct',
    servedModel: 'gpt-4o-mini',
    provider: 'openai',
    providerPath: ['openai/gpt-4o-mini'],
    fallbackStage: 'primary',
    cached: false,
    degraded: false,
    promptVersionId: 'classify-v7',
    tokenUsage: { input: 120, output: 30, total: 150 },
    costMicroCents: 2_700_000,
    latencyMs: 250,
    startedAt: new Date('2026-09-05T10:00:00.000Z'),
    input: [
      { role: 'system', content: 'You are the Rivet dispatcher.' },
      { role: 'user', content: 'Book a tune-up' },
    ],
    output: '{"intentType":"create_appointment"}',
    ...overrides,
  };
}

function exporterWith(opts: { captureContent?: boolean; logger?: ReturnType<typeof logger> } = {}) {
  const fc = fakeClient();
  const ex = new LangfuseTraceExporter({
    baseUrl: 'https://cloud.langfuse.com',
    captureContent: opts.captureContent ?? false,
    logger: opts.logger,
    client: fc.client,
  });
  return { ex, ...fc };
}

describe('LangfuseTraceExporter — payload contract', () => {
  it('trace id is the correlationId, grouped by sessionId, tenant as tag + metadata, never a userId', () => {
    const { ex, traces } = exporterWith();
    ex.recordCompletion(event());

    expect(traces).toHaveLength(1);
    expect(traces[0]).toMatchObject({
      id: 'corr-1',
      name: 'classify_intent',
      sessionId: 'voice-sess-1',
      tags: ['tenant:tenant-a'],
    });
    expect(traces[0].metadata).toMatchObject({ tenantId: 'tenant-a' });
    expect('userId' in traces[0]).toBe(false);
  });

  it('generation carries task, resolved + served model, provider path, usage, USD cost, latency and prompt version', () => {
    const { ex, generations } = exporterWith();
    ex.recordCompletion(event());

    expect(generations).toHaveLength(1);
    const g = generations[0];
    expect(g.name).toBe('classify_intent');
    expect(g.model).toBe('gpt-4o-mini');
    expect(g.level).toBe('DEFAULT');
    expect(g.version).toBe('classify-v7');
    expect(g.startTime).toEqual(new Date('2026-09-05T10:00:00.000Z'));
    expect(g.endTime).toEqual(new Date('2026-09-05T10:00:00.250Z'));
    expect(g.usageDetails).toEqual({ input: 120, output: 30, total: 150 });
    // 2,700,000 micro-cents = 2.7 cents = $0.027 — converted at the boundary only.
    expect(g.costDetails?.total).toBeCloseTo(0.027, 10);
    expect(g.metadata).toMatchObject({
      tenantId: 'tenant-a',
      correlationId: 'corr-1',
      taskType: 'classify_intent',
      resolvedModel: 'meta-llama/llama-3.1-8b-instruct',
      servedModel: 'gpt-4o-mini',
      provider: 'openai',
      providerPath: ['openai/gpt-4o-mini'],
      fallbackStage: 'primary',
      cached: false,
      degraded: false,
      promptVersionId: 'classify-v7',
      latencyMs: 250,
      costMicroCents: 2_700_000,
    });
    expect('userId' in g).toBe(false);
  });

  it('an unpriced model (costMicroCents null) exports no costDetails; a cache hit exports an explicit zero', () => {
    const { ex, generations } = exporterWith();
    ex.recordCompletion(event({ costMicroCents: null }));
    ex.recordCompletion(event({ cached: true, costMicroCents: 0, latencyMs: 0 }));

    expect(generations[0].costDetails).toBeUndefined();
    expect(generations[0].metadata).toMatchObject({ costMicroCents: null });
    expect(generations[1].costDetails).toEqual({ total: 0 });
    expect(generations[1].metadata).toMatchObject({ cached: true });
  });

  it('capture off (default) exports no input or output on the trace or the generation', () => {
    const { ex, traces, generations } = exporterWith();
    ex.recordCompletion(event());

    expect('input' in traces[0]).toBe(false);
    expect('output' in traces[0]).toBe(false);
    expect('input' in generations[0]).toBe(false);
    expect('output' in generations[0]).toBe(false);
  });

  it('capture on exports messages only after redaction: phone numbers, emails and Authorization values never leave', () => {
    const { ex, generations } = exporterWith({ captureContent: true });
    ex.recordCompletion(
      event({
        input: [
          { role: 'system', content: 'Integration header — Authorization: Bearer sk-live-abc123' },
          { role: 'user', content: 'Call me back at (415) 867-5309 or jane.doe@example.com' },
        ],
        output: 'Sure — I will call (415) 867-5309 shortly.',
      }),
    );

    const g = generations[0];
    const input = g.input as Array<{ role: string; content: string }>;
    expect(input).toHaveLength(2);
    expect(input[0].role).toBe('system');
    expect(input[1].role).toBe('user');

    const exported = JSON.stringify(input);
    expect(exported).not.toContain('sk-live-abc123');
    expect(exported).not.toContain('867-5309');
    expect(exported).not.toContain('jane.doe@example.com');
    expect(exported).toContain('[REDACTED]');
    expect(exported).toContain('[phone]');

    expect(g.output).not.toContain('867-5309');
    expect(g.output).toContain('[phone]');
  });

  it('capture on never exports image bytes (snapshot redaction runs first)', () => {
    const { ex, generations } = exporterWith({ captureContent: true });
    ex.recordCompletion(
      event({
        input: [
          {
            role: 'user',
            content: 'What is this?',
            parts: [{ type: 'image', url: 'data:image/png;base64,AAAAQUFBQQ==' }],
          },
        ],
      }),
    );

    expect(JSON.stringify(generations[0].input)).not.toContain('base64,AAAAQUFBQQ==');
  });

  it('a failure event exports level ERROR with the message and latency, and no usage or cost', () => {
    const { ex, generations } = exporterWith();
    ex.recordCompletion(
      event({
        error: 'Provider openai failed: 503 upstream',
        tokenUsage: undefined,
        costMicroCents: undefined,
        output: undefined,
        latencyMs: 1_900,
      }),
    );

    const g = generations[0];
    expect(g.level).toBe('ERROR');
    expect(g.statusMessage).toBe('Provider openai failed: 503 upstream');
    expect(g.usageDetails).toBeUndefined();
    expect(g.costDetails).toBeUndefined();
    expect(g.metadata).toMatchObject({ latencyMs: 1_900, error: 'Provider openai failed: 503 upstream' });
  });

  it('flush shuts the client down (queued events drained) and never throws', async () => {
    const log = logger();
    const { ex, shutdownAsync } = exporterWith({ logger: log });
    await ex.flush();
    expect(shutdownAsync).toHaveBeenCalledTimes(1);
    expect(log.error).not.toHaveBeenCalled();

    shutdownAsync.mockRejectedValueOnce(new Error('langfuse unreachable'));
    await expect(ex.flush()).resolves.toBeUndefined();
    expect(log.error).toHaveBeenCalledWith(
      expect.stringContaining('flush'),
      expect.objectContaining({ error: 'langfuse unreachable' }),
    );
  });
});

describe('NoopTraceExporter', () => {
  it('records nothing and flushes instantly', async () => {
    const ex = new NoopTraceExporter();
    expect(() => ex.recordCompletion(event())).not.toThrow();
    await expect(ex.flush()).resolves.toBeUndefined();
  });
});

describe('createTraceExporterFromConfig', () => {
  const base = { LANGFUSE_BASE_URL: 'https://cloud.langfuse.com', LANGFUSE_CAPTURE_CONTENT: false };

  it('no keys → NoopTraceExporter and the client is never constructed', () => {
    const createClient = vi.fn();
    const ex = createTraceExporterFromConfig(base, undefined, { createClient });
    expect(ex).toBeInstanceOf(NoopTraceExporter);
    expect(createClient).not.toHaveBeenCalled();
  });

  it('one key only → NoopTraceExporter (a half-configured exporter never sends)', () => {
    const createClient = vi.fn();
    expect(
      createTraceExporterFromConfig({ ...base, LANGFUSE_PUBLIC_KEY: 'pk' }, undefined, { createClient }),
    ).toBeInstanceOf(NoopTraceExporter);
    expect(
      createTraceExporterFromConfig({ ...base, LANGFUSE_SECRET_KEY: 'sk' }, undefined, { createClient }),
    ).toBeInstanceOf(NoopTraceExporter);
    expect(createClient).not.toHaveBeenCalled();
  });

  it('both keys → LangfuseTraceExporter constructed with the configured base URL and capture flag', () => {
    const { client } = fakeClient();
    const createClient = vi.fn(() => client);
    const ex = createTraceExporterFromConfig(
      {
        LANGFUSE_PUBLIC_KEY: 'pk-live',
        LANGFUSE_SECRET_KEY: 'sk-live',
        LANGFUSE_BASE_URL: 'https://langfuse.internal.example',
        LANGFUSE_CAPTURE_CONTENT: true,
      },
      undefined,
      { createClient },
    );

    expect(ex).toBeInstanceOf(LangfuseTraceExporter);
    expect(createClient).toHaveBeenCalledWith({
      publicKey: 'pk-live',
      secretKey: 'sk-live',
      baseUrl: 'https://langfuse.internal.example',
    });
    expect((ex as LangfuseTraceExporter).baseUrl).toBe('https://langfuse.internal.example');
    expect((ex as LangfuseTraceExporter).captureContent).toBe(true);
  });

  it('keys present but the langfuse module is absent → NoopTraceExporter with a logged error', () => {
    const log = logger();
    const ex = createTraceExporterFromConfig(
      { ...base, LANGFUSE_PUBLIC_KEY: 'pk', LANGFUSE_SECRET_KEY: 'sk' },
      log,
      { createClient: () => null },
    );
    expect(ex).toBeInstanceOf(NoopTraceExporter);
    expect(log.error).toHaveBeenCalledWith(expect.stringContaining('langfuse'), expect.anything());
  });
});

describe('microCentsToUsd', () => {
  it('converts the gateway unit (1 cent = 1,000,000 micro-cents) to USD', () => {
    expect(microCentsToUsd(100_000_000)).toBe(1);
    expect(microCentsToUsd(0)).toBe(0);
    expect(microCentsToUsd(2_700_000)).toBeCloseTo(0.027, 10);
  });
});
