/**
 * Multi-variation simulation of the production voice top-50 breaker cascade.
 * These are the same failure shapes seen in prod artifacts (Request was aborted,
 * assistant 503s, half-open reopen) — without network.
 */
import { describe, it, expect } from 'vitest';
import {
  CircuitBreakerRegistry,
  BreakerOpenError,
  DEFAULT_BREAKER,
} from '../../../src/ai/gateway/breaker';
import { ProviderBreakerWrapper } from '../../../src/ai/gateway/compose-resilience';
import { DeadlineExceededError } from '../../../src/ai/gateway/deadline';
import type { LLMProvider, LLMRequest, LLMResponse } from '../../../src/ai/gateway/gateway';

function req(overrides: Partial<LLMRequest> = {}): LLMRequest {
  return {
    taskType: 'classify_intent',
    messages: [{ role: 'user', content: 'schedule an appointment' }],
    tenantId: 'tenant-qa',
    tenantTier: 'standard',
    model: 'gpt-4o-mini',
    ...overrides,
  };
}

function ok(provider: string): LLMResponse {
  return {
    content: '{"intentType":"create_appointment","confidence":0.9}',
    model: 'gpt-4o-mini',
    provider,
    tokenUsage: { input: 10, output: 10, total: 20 },
    latencyMs: 40,
  };
}

describe('breaker abort cascade variations', () => {
  it('variation A — burst of classify aborts never opens breaker; next classify succeeds', async () => {
    let mode: 'abort' | 'ok' = 'abort';
    const inner: LLMProvider = {
      name: 'openai',
      complete: async () => {
        if (mode === 'abort') throw new Error('Request was aborted.');
        return ok('openai');
      },
      isAvailable: async () => true,
    };
    const reg = new CircuitBreakerRegistry({
      ...DEFAULT_BREAKER,
      consecutiveFailureThreshold: 5,
      countThreshold: 10,
      failureRate: 0.5,
    });
    const wrapped = new ProviderBreakerWrapper(inner, reg);

    for (let i = 0; i < 30; i++) {
      await expect(wrapped.complete(req())).rejects.toThrow('Request was aborted.');
    }
    mode = 'ok';
    const res = await wrapped.complete(req());
    expect(res.content).toContain('create_appointment');
    await expect(wrapped.complete(req())).resolves.toBeTruthy();
  });

  it('variation B — assistant 503 storm does not block classify_intent', async () => {
    const inner: LLMProvider = {
      name: 'openai',
      complete: async (r) => {
        if (r.taskType !== 'classify_intent') {
          throw Object.assign(new Error('assistant 503'), { status: 503 });
        }
        return ok('openai');
      },
      isAvailable: async () => true,
    };
    const reg = new CircuitBreakerRegistry({
      ...DEFAULT_BREAKER,
      consecutiveFailureThreshold: 3,
      countThreshold: 100,
    });
    const wrapped = new ProviderBreakerWrapper(inner, reg);

    for (let i = 0; i < 3; i++) {
      await expect(
        wrapped.complete(req({ taskType: 'assistant.general' })),
      ).rejects.toThrow('assistant 503');
    }
    await expect(
      wrapped.complete(req({ taskType: 'assistant.general' })),
    ).rejects.toBeInstanceOf(BreakerOpenError);

    // Voice classify still healthy on its own cell.
    for (let i = 0; i < 5; i++) {
      await expect(wrapped.complete(req())).resolves.toMatchObject({
        content: expect.stringContaining('create_appointment'),
      });
    }
  });

  it('variation C — mixed abort + DeadlineExceeded + success under half-open recovers', async () => {
    const fail503 = Object.assign(new Error('boom'), { status: 503 });
    const reg = new CircuitBreakerRegistry({
      ...DEFAULT_BREAKER,
      consecutiveFailureThreshold: 2,
      countThreshold: 100,
      cooldownMs: 15,
      halfOpenProbeCount: 2,
      halfOpenSuccessRatio: 1,
    });
    const failWrapped = new ProviderBreakerWrapper(
      {
        name: 'openai',
        complete: async () => {
          throw fail503;
        },
        isAvailable: async () => false,
      },
      reg,
    );
    for (let i = 0; i < 2; i++) {
      await expect(failWrapped.complete(req())).rejects.toThrow('boom');
    }
    await expect(failWrapped.complete(req())).rejects.toBeInstanceOf(BreakerOpenError);
    await new Promise((r) => setTimeout(r, 25));

    const abortWrapped = new ProviderBreakerWrapper(
      {
        name: 'openai',
        complete: async () => {
          throw new DeadlineExceededError(100);
        },
        isAvailable: async () => true,
      },
      reg,
      'openai',
    );
    await expect(abortWrapped.complete(req())).rejects.toBeInstanceOf(DeadlineExceededError);

    const okWrapped = new ProviderBreakerWrapper(
      {
        name: 'openai',
        complete: async () => ok('openai'),
        isAvailable: async () => true,
      },
      reg,
      'openai',
    );
    await expect(okWrapped.complete(req())).resolves.toBeTruthy();
    await expect(okWrapped.complete(req())).resolves.toBeTruthy();
    // Closed — further calls succeed without BreakerOpenError.
    await expect(okWrapped.complete(req())).resolves.toBeTruthy();
  });

  it('variation D — 503s still trip breaker (health signal preserved)', async () => {
    const reg = new CircuitBreakerRegistry({
      ...DEFAULT_BREAKER,
      consecutiveFailureThreshold: 3,
      countThreshold: 100,
      cooldownMs: 50,
    });
    const wrapped = new ProviderBreakerWrapper(
      {
        name: 'openai',
        complete: async () => {
          throw Object.assign(new Error('503'), { status: 503 });
        },
        isAvailable: async () => false,
      },
      reg,
    );
    for (let i = 0; i < 3; i++) {
      await expect(wrapped.complete(req())).rejects.toThrow('503');
    }
    await expect(wrapped.complete(req())).rejects.toBeInstanceOf(BreakerOpenError);
  });
});
