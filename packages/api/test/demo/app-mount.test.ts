/**
 * S6-3 — the demo start route as the real app mounts it: under `/public`
 * (so the per-IP limiter applies), answering 503 DEMO_DISABLED with the
 * kill switch unset, and also when switched on with no database.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { createApp, type AppWithLifecycle } from '../../src/app';
import { resetConfig } from '../../src/shared/config';

const KEYS = ['NODE_ENV', 'PROCESS_ROLE', 'DATABASE_URL', 'AI_PROVIDER_API_KEY', 'CLERK_PUBLISHABLE_KEY', 'REDIS_URL', 'DEMO_CALLS_ENABLED'];
const body = { phone: '(512) 555-0142', trade: 'plumbing', businessName: 'Austin Pipe Pros' };
const DISABLED = { error: 'DEMO_DISABLED', message: "The demo call isn't available right now." };

describe('POST /public/demo/calls in the real app', () => {
  const prev: Record<string, string | undefined> = {};
  let app: AppWithLifecycle;

  beforeAll(() => {
    for (const k of KEYS) prev[k] = process.env[k];
    process.env.NODE_ENV = 'test';
    process.env.PROCESS_ROLE = 'web';
    for (const k of ['DATABASE_URL', 'AI_PROVIDER_API_KEY', 'CLERK_PUBLISHABLE_KEY', 'REDIS_URL', 'DEMO_CALLS_ENABLED']) delete process.env[k];
    resetConfig();
    app = createApp();
  });

  afterAll(async () => {
    await app.gracefulDrain('test-cleanup');
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    resetConfig();
  });

  it('answers 503 DEMO_DISABLED with DEMO_CALLS_ENABLED unset', async () => {
    const res = await request(app).post('/public/demo/calls').send(body);
    expect(res.status).toBe(503);
    expect(res.body).toEqual(DISABLED);
  });

  it('answers 503 DEMO_DISABLED when switched on with no database', async () => {
    process.env.DEMO_CALLS_ENABLED = 'true';
    try {
      const res = await request(app).post('/public/demo/calls').send(body);
      expect(res.status).toBe(503);
      expect(res.body).toEqual(DISABLED);
    } finally {
      delete process.env.DEMO_CALLS_ENABLED;
    }
  });

  it('sits under the /public per-IP limiter (30 a minute)', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 31; i += 1) statuses.push((await request(app).post('/public/demo/calls').send(body)).status);
    expect(statuses.slice(0, 28).every((s) => s === 503)).toBe(true);
    expect(statuses[30]).toBe(429);
  });
});
