/**
 * PRIV-3 — a card number a caller recites must not reach the LLM provider,
 * the ai_runs input snapshot, or the trace exporter.
 *
 * Drives the REAL LLMGateway (inline provider, in-memory ai_runs repo, spy
 * exporter) and the real CachingGatewayWrapper cache-hit path, which writes
 * its own ai_runs snapshot from the raw request without passing through the
 * gateway.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  LLMGateway,
  type LLMProvider,
  type LLMRequest,
  type LLMResponse,
} from '../../../src/ai/gateway/gateway';
import { CachingGatewayWrapper, InMemoryCacheStore } from '../../../src/ai/gateway/cache';
import { InMemoryAiRunRepository } from '../../../src/ai/ai-run';
import type {
  LLMTraceCompletionEvent,
  LLMTraceExporter,
} from '../../../src/ai/gateway/trace-exporter';

const PAN_SPACED = '4111 1111 1111 1111';
const PAN_DIGITS = '4111111111111111';
const TENANT = '00000000-0000-4000-8000-0000000000aa';

function recordingProvider() {
  const seen: LLMRequest[] = [];
  const provider: LLMProvider = {
    name: 'stub',
    isAvailable: async () => true,
    complete: async (req: LLMRequest): Promise<LLMResponse> => {
      seen.push(req);
      return {
        content: '{"intentType":"lookup_balance"}',
        model: 'gpt-4o-mini',
        provider: 'openai',
        tokenUsage: { input: 10, output: 5, total: 15 },
        latencyMs: 0,
      };
    },
  };
  return { provider, seen };
}

function spyExporter() {
  const events: LLMTraceCompletionEvent[] = [];
  const exporter: LLMTraceExporter = {
    recordCompletion: vi.fn((e: LLMTraceCompletionEvent) => {
      events.push(e);
    }),
    flush: vi.fn(async () => {}),
  };
  return { exporter, events };
}

function callerRequest(): LLMRequest {
  return {
    taskType: 'classify_intent',
    tenantId: TENANT,
    messages: [
      { role: 'system', content: 'Classify the caller utterance.' },
      {
        role: 'user',
        content: `caller: can I just pay now, my card is ${PAN_SPACED}, expires 09/27`,
        parts: [{ type: 'text', text: `again: ${PAN_DIGITS}` }],
      },
    ],
    metadata: { tenantId: TENANT },
  };
}

describe('LLMGateway — card numbers in user-role text (PRIV-3)', () => {
  it('sends the provider a request with the card number replaced', async () => {
    const { provider, seen } = recordingProvider();
    const gateway = new LLMGateway({ defaultProvider: 'stub' }, new Map([['stub', provider]]));
    await gateway.complete(callerRequest());
    const sent = JSON.stringify(seen[0].messages);
    expect(sent).not.toContain(PAN_SPACED);
    expect(sent).not.toContain(PAN_DIGITS);
    expect(seen[0].messages[1].content).toBe(
      'caller: can I just pay now, my card is [card number], expires 09/27',
    );
    expect(seen[0].messages[1].parts).toEqual([{ type: 'text', text: 'again: [card number]' }]);
    // System text is not caller speech and is passed through as written.
    expect(seen[0].messages[0].content).toBe('Classify the caller utterance.');
  });

  it('writes an ai_runs input snapshot with no card number', async () => {
    const { provider } = recordingProvider();
    const repo = new InMemoryAiRunRepository();
    const gateway = new LLMGateway(
      { defaultProvider: 'stub' },
      new Map([['stub', provider]]),
      undefined,
      repo,
    );
    const res = await gateway.complete(callerRequest());
    const run = await repo.findById(TENANT, res.aiRunId!);
    const snapshot = JSON.stringify(run?.inputSnapshot);
    expect(snapshot).toContain('[card number]');
    expect(snapshot).not.toContain(PAN_SPACED);
    expect(snapshot).not.toContain(PAN_DIGITS);
  });

  it('hands the trace exporter input with no card number', async () => {
    const { provider } = recordingProvider();
    const { exporter, events } = spyExporter();
    const gateway = new LLMGateway(
      { defaultProvider: 'stub' },
      new Map([['stub', provider]]),
      undefined,
      undefined,
      exporter,
    );
    await gateway.complete(callerRequest());
    const exported = JSON.stringify(events[0].input);
    expect(exported).not.toContain(PAN_SPACED);
    expect(exported).not.toContain(PAN_DIGITS);
  });

  it('the cache-hit path writes its ai_runs snapshot with no card number', async () => {
    const { provider, seen } = recordingProvider();
    const repo = new InMemoryAiRunRepository();
    const gateway = new LLMGateway({ defaultProvider: 'stub' }, new Map([['stub', provider]]));
    const cached = new CachingGatewayWrapper(
      gateway,
      new InMemoryCacheStore(),
      { enabled: true, defaultTtlMs: 60_000, deterministicTaskTypes: ['classify_intent'] },
      TENANT,
      repo,
    );
    await cached.complete(callerRequest()); // miss → fills the cache
    await cached.complete(callerRequest()); // hit → snapshot written by the wrapper
    expect(seen).toHaveLength(1);
    await new Promise<void>((r) => { setTimeout(r, 0); }); // the hit's snapshot write is fire-and-forget
    const runs = await repo.findByTaskType(TENANT, 'classify_intent');
    const hitRun = runs.find((r) => r.createdBy === 'gateway-cache');
    expect(hitRun).toBeDefined();
    const snapshot = JSON.stringify(hitRun?.inputSnapshot);
    expect(snapshot).not.toContain(PAN_SPACED);
    expect(snapshot).not.toContain(PAN_DIGITS);
  });
});
