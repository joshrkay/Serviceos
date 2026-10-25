/**
 * Eval/test harnesses vs the production per-tenant token budget.
 *
 * Since #1431 the live voice eval (and #1426 path smoke, #1450 Layer 2) build
 * the PRODUCTION gateway. Its per-tenant token-bucket (tenant-quota.ts
 * DEFAULT_TIER_CONFIG) is a fairness cap for real tenants. Under the
 * pre-GATEWAY-01 bucket a sequential eval sample on one pseudo-tenant drained
 * the classifier bucket and died with
 * "Per-tenant token budget exceeded for tenant system:classify_intent"
 * (gh run 36500073030). Harnesses still inject their own quota store through
 * `opts.resilience.quota`, so an eval never depends on the live tier table;
 * production keeps the default budget unchanged.
 *
 * Seams: `createLLMGateway(...).complete()` (production default, unchanged),
 * `buildLiveGateway(...)` (voice-eval), `createLayer2Gateway(...)` (Layer 2),
 * `createHarnessLLMGateway(...)` (shared harness builder, used by path smoke).
 * All driven over a real socket at a local stub OpenAI-compatible server — no
 * paid calls.
 */
import { createServer, type Server } from 'http';
import type { AddressInfo } from 'net';

import { afterEach, describe, expect, it } from 'vitest';

import { createLLMGateway } from '../../../src/ai/gateway/factory';
import type { LLMGateway } from '../../../src/ai/gateway/gateway';
import { loadConfig, resetConfig } from '../../../src/shared/config';
import { buildLiveGateway } from '../../../../voice-eval/live-support';
import { AgentEventBus } from '../../../src/ai/voice-quality/event-bus';
import {
  createLayer2Gateway,
  selectLayer2Providers,
} from '../../../src/ai/gateway/real-layer-two-factory';
import { DEFAULT_TIER_CONFIG } from '../../../src/ai/gateway/tenant-quota';

// classifier_standard (the tier an untiered classify_intent call lands in)
// holds bucketCapacity tokens. Each call below is estimated — and billed by
// the stub — at capacity / 3.5 tokens, so the production bucket admits
// exactly 3 calls; the 4th and 5th are rejected (refilling the half-call
// shortfall takes seconds at the tier's refill rate; the test takes
// milliseconds). Derived, so a resize of the tier does not break the pin.
const CLASSIFIER_TIER = DEFAULT_TIER_CONFIG.classifier_standard;
const CALL_TOKENS = Math.floor(CLASSIFIER_TIER.bucketCapacity / 3.5);
const PROMPT_CHARS = CALL_TOKENS * 4; // chars/4 → CALL_TOKENS estimated tokens
const CALLS = 5;

function startStub(): Promise<{ server: Server; baseUrl: string; hits: () => number }> {
  let hits = 0;
  const server = createServer((req, res) => {
    req.on('data', () => {});
    req.on('end', () => {
      hits++;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          id: 'chatcmpl-test',
          object: 'chat.completion',
          created: 0,
          model: 'gpt-4o-mini-2024-07-18',
          choices: [
            {
              index: 0,
              message: { role: 'assistant', content: '{"intentType":"create_job"}' },
              finish_reason: 'stop',
            },
          ],
          usage: { prompt_tokens: CALL_TOKENS, completion_tokens: 10, total_tokens: CALL_TOKENS + 10 },
        }),
      );
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({ server, baseUrl: `http://127.0.0.1:${port}/v1`, hits: () => hits });
    });
  });
}

function prodEnv(baseUrl: string): Record<string, string> {
  return {
    AI_PROVIDER_API_KEY: 'sk-prod-test',
    AI_PROVIDER_BASE_URL: baseUrl,
    AI_DEFAULT_MODEL: 'gpt-4o-mini',
    AI_CLASSIFY_INTENT_DEADLINE_MS: '12000',
    OPENAI_API_KEY: 'sk-speech-test',
  };
}

const bigPrompt = 'x'.repeat(PROMPT_CHARS);

/** Run CALLS sequential classify calls; returns how many succeeded + first error. */
async function runSequentialClassify(
  gateway: LLMGateway,
): Promise<{ ok: number; firstError: unknown }> {
  let ok = 0;
  let firstError: unknown = null;
  for (let i = 0; i < CALLS; i++) {
    try {
      await gateway.complete({
        taskType: 'classify_intent',
        tenantId: 'system',
        messages: [
          { role: 'system', content: bigPrompt },
          { role: 'user', content: `utterance ${i}` },
        ],
      });
      ok++;
    } catch (err) {
      firstError ??= err;
    }
  }
  return { ok, firstError };
}

describe('harness gateways vs the production per-tenant token budget', () => {
  let server: Server | null = null;
  const savedEnv = { ...process.env };

  afterEach(async () => {
    process.env = { ...savedEnv };
    resetConfig();
    if (server) {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server!.close(() => resolve()));
      server = null;
    }
  });

  it('production createLLMGateway still enforces the per-tenant classifier budget (unchanged)', async () => {
    const stub = await startStub();
    server = stub.server;
    const env = prodEnv(stub.baseUrl);
    delete process.env.REDIS_URL;

    // Preconditions: one call alone never trips the in-flight hard bound, and
    // the 4th call's shortfall cannot refill while the test runs.
    expect(CALL_TOKENS + 2_048).toBeLessThan(CLASSIFIER_TIER.hardUpperBoundTokens);
    expect((CALL_TOKENS / 2) / CLASSIFIER_TIER.refillTokensPerSec).toBeGreaterThan(5);

    const { ok, firstError } = await runSequentialClassify(createLLMGateway(loadConfig(env)));

    expect(ok).toBe(3);
    expect(stub.hits()).toBe(3);
    expect(String((firstError as Error)?.message)).toMatch(
      /Per-tenant token budget exceeded for tenant system:classify_intent/,
    );
  }, 30_000);

  it('voice-eval buildLiveGateway runs a sequential sample past the default classifier bucket', async () => {
    const stub = await startStub();
    server = stub.server;
    const env = prodEnv(stub.baseUrl);
    delete process.env.REDIS_URL;

    const gateway = await buildLiveGateway(
      { kind: 'production', model: 'gpt-4o-mini' } as never,
      () => {},
      env,
    );
    const { ok, firstError } = await runSequentialClassify(gateway);

    expect(firstError).toBeNull();
    expect(ok).toBe(CALLS);
    expect(stub.hits()).toBe(CALLS);
  }, 30_000);

  it('Layer 2 createLayer2Gateway runs a sequential script past the default classifier bucket', async () => {
    const stub = await startStub();
    server = stub.server;
    const env = prodEnv(stub.baseUrl);
    delete process.env.REDIS_URL;
    const plan = selectLayer2Providers(env);
    if (!plan.ok) throw new Error(plan.error);
    let cents = 0;

    const gateway = createLayer2Gateway({
      llm: plan.llm,
      env,
      bus: new AgentEventBus(),
      costTracker: { addCents: (n) => (cents += n), totalCents: () => cents },
    });
    const { ok, firstError } = await runSequentialClassify(gateway);

    expect(firstError).toBeNull();
    expect(ok).toBe(CALLS);
    expect(stub.hits()).toBe(CALLS);
  }, 30_000);
});
