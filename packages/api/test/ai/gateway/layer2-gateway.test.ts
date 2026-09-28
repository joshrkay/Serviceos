/**
 * #1331 — the Layer 2 gateway runs on the PRODUCTION gateway factory.
 *
 * Seam 2: `createLayer2Gateway(...).complete()` in real-layer-two-factory.ts,
 * driven over a real socket at a local stub OpenAI-compatible server (no paid
 * calls). With a production selection the stub must see the production key +
 * model (built by `createLLMGateway(loadConfig(env))`), transient failures
 * must be retried exactly LAYER_TWO_MAX_RETRIES (2) times, and a stalled
 * vendor must be abandoned at the Layer 2 per-call deadline (#1385) instead
 * of holding a script past vitest's 60 s budget.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'http';
import type { AddressInfo } from 'net';

import { afterEach, describe, expect, it } from 'vitest';

import { AgentEventBus } from '../../../src/ai/voice-quality/event-bus';
import {
  createLayer2Gateway,
  selectLayer2Providers,
} from '../../../src/ai/gateway/real-layer-two-factory';
import { resetConfig } from '../../../src/shared/config';

interface SeenRequest {
  authorization: string | undefined;
  model: string;
}

type Handler = (req: IncomingMessage, res: ServerResponse, n: number) => void;

function startStub(handler: Handler): Promise<{ server: Server; baseUrl: string; seen: SeenRequest[] }> {
  const seen: SeenRequest[] = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const parsed = JSON.parse(body || '{}') as { model?: string };
      seen.push({ authorization: req.headers.authorization, model: parsed.model ?? '' });
      handler(req, res, seen.length);
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({ server, baseUrl: `http://127.0.0.1:${port}/v1`, seen });
    });
  });
}

function prodEnv(baseUrl: string): Record<string, string> {
  return {
    AI_PROVIDER_API_KEY: 'sk-prod-test',
    AI_PROVIDER_BASE_URL: baseUrl,
    AI_DEFAULT_MODEL: 'gpt-4o-mini',
    OPENAI_API_KEY: 'sk-speech-test',
  };
}

function buildGateway(env: Record<string, string>, overrides: { requestTimeoutMs?: number } = {}) {
  const plan = selectLayer2Providers(env);
  if (!plan.ok) throw new Error(plan.error);
  let cents = 0;
  const bus = new AgentEventBus();
  const gateway = createLayer2Gateway({
    llm: plan.llm,
    env,
    bus,
    costTracker: { addCents: (n) => (cents += n), totalCents: () => cents },
    ...overrides,
  });
  return { gateway, bus, spent: () => cents };
}

describe('#1331 — createLayer2Gateway (production provider)', () => {
  let server: Server | null = null;

  afterEach(async () => {
    resetConfig();
    if (server) {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server!.close(() => resolve()));
      server = null;
    }
  });

  it('calls the production provider config and retries a 5xx exactly twice before failing', async () => {
    const stub = await startStub((_req, res) => {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'upstream exploded' } }));
    });
    server = stub.server;
    const { gateway } = buildGateway(prodEnv(stub.baseUrl));

    await expect(
      gateway.complete({
        taskType: 'voice_quality_perceived_completion',
        messages: [{ role: 'user', content: 'hi' }],
      }),
    ).rejects.toThrow();

    expect(stub.seen).toHaveLength(3);
    for (const r of stub.seen) {
      expect(r).toEqual({ authorization: 'Bearer sk-prod-test', model: 'gpt-4o-mini' });
    }
  });

  it('gives a harness judge call the Layer 2 per-call deadline, not the 1.5 s voice hot-path tier deadline', async () => {
    // A healthy judge reply that takes 2 s: the lightweight tier's 1.5 s
    // production deadline (built for classify on the live call) would abort
    // it; the Layer 2 judge budget must not.
    const stub = await startStub((_req, res) => {
      setTimeout(() => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(completion('{"perceivedSatisfaction":"acceptable"}')));
      }, 2_000);
    });
    server = stub.server;
    const { gateway, bus, spent } = buildGateway(prodEnv(stub.baseUrl), { requestTimeoutMs: 5_000 });

    const res = await gateway.complete({
      taskType: 'voice_quality_perceived_completion',
      messages: [{ role: 'user', content: 'grade this call' }],
    });

    expect(res.content).toBe('{"perceivedSatisfaction":"acceptable"}');
    expect(stub.seen).toHaveLength(1);
    // The spend reaches the suite tracker and the bus, priced at the model
    // that served it — OpenAI list price for gpt-4o-mini, $0.15 / $0.60 per
    // MTok: 1,000 in × 15¢/MTok = 0.015¢ ; 100 out × 60¢/MTok = 0.006¢.
    // (Haiku-harness pricing would book ≥ 2¢ — ~100x — and trip caps sized
    // for gpt-4o-mini.)
    expect(spent()).toBeCloseTo(0.021, 6);
    expect(bus.events().some((e) => e.type === 'cost_incurred')).toBe(true);
  }, 10_000);

  it('abandons a vendor that never answers at the per-call deadline (#1385), well inside the 1.5 s tier deadline and the SDK 60 s timeout', async () => {
    const stub = await startStub(() => {
      // Accept the request, never write a byte back.
    });
    server = stub.server;
    const { gateway } = buildGateway(prodEnv(stub.baseUrl), { requestTimeoutMs: 500 });

    const outcome = await Promise.race([
      gateway
        .complete({ taskType: 'voice_quality_reprompt_judge', messages: [{ role: 'user', content: 'hi' }] })
        .then(
          () => 'resolved',
          () => 'rejected',
        ),
      new Promise<string>((resolve) => setTimeout(() => resolve('still waiting after 1.2s'), 1_200)),
    ]);

    expect(outcome).toBe('rejected');
  }, 10_000);
});

function completion(content: string) {
  return {
    id: 'chatcmpl-test',
    object: 'chat.completion',
    created: 0,
    model: 'gpt-4o-mini-2024-07-18',
    choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 1_000, completion_tokens: 100, total_tokens: 1_100 },
  };
}
