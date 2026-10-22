import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { CircuitBreakerRegistry, DEFAULT_BREAKER } from '../../../src/ai/gateway/breaker';
import { createAiHealthRouter } from '../../../src/routes/ai-health';
import { clearAiCompletionProbeCache } from '../../../src/ai/gateway/readiness';
import type { LLMRequest, LLMResponse } from '../../../src/ai/gateway/gateway';

describe('GET /api/health/ai/completion', () => {
  const prevToken = process.env.METRICS_TOKEN;
  const prevEnv = process.env.NODE_ENV;

  beforeEach(() => {
    clearAiCompletionProbeCache();
    process.env.NODE_ENV = 'test';
    delete process.env.METRICS_TOKEN;
  });

  afterEach(() => {
    if (prevToken === undefined) delete process.env.METRICS_TOKEN;
    else process.env.METRICS_TOKEN = prevToken;
    process.env.NODE_ENV = prevEnv;
  });

  it('auth — rejects when METRICS_TOKEN set and bearer missing', async () => {
    process.env.METRICS_TOKEN = 'secret-metrics';
    const reg = new CircuitBreakerRegistry(DEFAULT_BREAKER);
    const app = express();
    app.use('/api/health', createAiHealthRouter(reg, [], {
      gateway: {
        complete: async (): Promise<LLMResponse> => ({
          content: 'ok',
          model: 'gpt-4o-mini',
          tokenUsage: { input: 1, output: 1, total: 2 },
        }),
      },
    }));

    const res = await request(app).get('/api/health/ai/completion');
    expect(res.status).toBe(401);
  });

  it('happy path — returns completionProbe.ok true', async () => {
    const complete = vi.fn(async (_req: LLMRequest): Promise<LLMResponse> => ({
      content: 'ok',
      model: 'gpt-4o-mini',
      tokenUsage: { input: 1, output: 1, total: 2 },
    }));
    const reg = new CircuitBreakerRegistry(DEFAULT_BREAKER);
    const app = express();
    app.use('/api/health', createAiHealthRouter(reg, [], { gateway: { complete } }));

    const res = await request(app).get('/api/health/ai/completion');
    expect(res.status).toBe(200);
    expect(res.body.completionProbe.ok).toBe(true);
    expect(res.body.completionProbe.model).toBe('gpt-4o-mini');
  });

  it('error path — ok false with errorCode when gateway throws', async () => {
    const reg = new CircuitBreakerRegistry(DEFAULT_BREAKER);
    const app = express();
    app.use(
      '/api/health',
      createAiHealthRouter(reg, [], {
        gateway: {
          complete: async () => {
            throw new Error('model does not exist');
          },
        },
      }),
    );

    const res = await request(app).get('/api/health/ai/completion');
    expect(res.status).toBe(200);
    expect(res.body.completionProbe.ok).toBe(false);
    expect(res.body.completionProbe.errorCode).toBe('model_not_found');
  });

  it('keeps the raw provider text behind the METRICS_TOKEN gate (GATEWAY-07)', async () => {
    process.env.METRICS_TOKEN = 'secret-metrics';
    const reg = new CircuitBreakerRegistry(DEFAULT_BREAKER);
    await reg
      .run({ provider: 'api.openai.com', modelFamily: 'gpt' }, async () => {
        throw Object.assign(new Error('Rate limit reached in organization org-abc123'), {
          status: 429,
        });
      })
      .catch(() => undefined);
    const app = express();
    app.use('/api/health', createAiHealthRouter(reg, [], {
      gateway: {
        complete: async (): Promise<LLMResponse> => ({
          content: 'ok',
          model: 'gpt-4o-mini',
          tokenUsage: { input: 1, output: 1, total: 2 },
        }),
      },
    }));

    const gated = await request(app)
      .get('/api/health/ai/completion')
      .set('Authorization', 'Bearer secret-metrics');
    expect(gated.status).toBe(200);
    expect(gated.body.completionProbe.providers[0].lastError).toContain('org-abc123');

    const publicListing = await request(app).get('/api/health/ai');
    expect(JSON.stringify(publicListing.body)).not.toContain('org-abc123');
    expect(publicListing.body.providers[0].lastErrorCode).toBe('rate_limited');
  });

  it('503 when gateway not wired', async () => {
    const reg = new CircuitBreakerRegistry(DEFAULT_BREAKER);
    const app = express();
    app.use('/api/health', createAiHealthRouter(reg));

    const res = await request(app).get('/api/health/ai/completion');
    expect(res.status).toBe(503);
    expect(res.body.error).toBe('AI_GATEWAY_UNAVAILABLE');
  });
});
