/**
 * #1331 — a stalled vendor call must not hold a Layer 2 script hostage.
 *
 * The weekly Layer 2 run (35600368305) timed out at vitest's 60 s on
 * `update-customer-address-known-customer`; the harness report written in
 * `afterAll` shows the same script finishing later, all three floor runs
 * green, `durationMs: 94334` against a corpus norm of 14–34 s. Nothing
 * deadlocked — one run simply waited ~70 s on something.
 *
 * Every vendor wait in that run is an HTTPS call, and the LLM ones go through
 * `createRealLayerTwoGateway`: a raw OpenAI-SDK client pointed at Anthropic's
 * compat endpoint, built WITHOUT the production resilience stack
 * (`composeResilienceStack` — retry + per-tier deadline) and therefore on the
 * SDK's default 10-minute request timeout. A single slow response stalls the
 * whole script until vitest kills it, and the script's result then lands in
 * the report after vitest already scored it red.
 *
 * Seam: `createRealLayerTwoGateway(...).complete()`, driven over a real
 * socket at a local server that accepts the request and never answers.
 */
import { createServer, type Server } from 'http';
import type { AddressInfo } from 'net';

import { afterEach, describe, expect, it } from 'vitest';

import { AgentEventBus } from '../../../src/ai/voice-quality/event-bus';
import { createRealLayerTwoGateway } from '../../../src/ai/gateway/real-layer-two-factory';

function startStalledServer(): Promise<{ server: Server; baseUrl: string; requests: () => number }> {
  let requests = 0;
  const server = createServer(() => {
    // Accept the request, never write a byte back.
    requests += 1;
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({ server, baseUrl: `http://127.0.0.1:${port}/v1/`, requests: () => requests });
    });
  });
}

const costTracker = {
  addCents: () => undefined,
  totalCents: () => 0,
};

describe('#1331 — Layer 2 gateway bounds a stalled vendor call', () => {
  let server: Server | null = null;

  afterEach(async () => {
    if (server) {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server!.close(() => resolve()));
      server = null;
    }
  });

  it('gives up on a vendor that never answers instead of waiting out the SDK default', async () => {
    const stalled = await startStalledServer();
    server = stalled.server;
    const gateway = createRealLayerTwoGateway({
      apiKey: 'sk-ant-test',
      bus: new AgentEventBus(),
      costTracker,
      baseUrl: stalled.baseUrl,
      requestTimeoutMs: 300,
      maxRetries: 0,
    });

    const outcome = await Promise.race([
      gateway
        .complete({ taskType: 'voice.agent', messages: [{ role: 'user', content: 'hi' }] })
        .then(
          () => 'resolved',
          () => 'rejected',
        ),
      new Promise<string>((resolve) => setTimeout(() => resolve('still waiting after 3s'), 3_000)),
    ]);

    expect(outcome).toBe('rejected');
    expect(stalled.requests()).toBe(1);
  });
});
