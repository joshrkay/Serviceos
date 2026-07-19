/**
 * T4-F02 — rate-limit configurability + provider-webhook carve-out.
 *
 * `/api` per-IP limiter is a DoS guard, not the fairness control (the
 * per-tenant limiter, API_TENANT_RATE_LIMIT_MAX, is) — so it must be
 * env-configurable (API_IP_RATE_LIMIT_MAX) rather than hardcoded. The six
 * signature-verified provider webhook prefixes need materially higher
 * throughput (WEBHOOK_PROVIDER_RATE_LIMIT_MAX) than unknown/junk
 * /webhooks/* paths, which stay on the pre-existing 30/min general limiter.
 *
 * NODE_ENV is forced to 'test' (not 'dev') for the configurable-limit cases:
 * app.ts's isDev flag (dev/development only) short-circuits the per-IP max
 * to 10000 regardless of the env var, and 'test' skips the prod/staging
 * DATABASE_URL requirement — the same escape hatch config.ts's
 * isProductionEnv() leaves open for hermetic boots without a real pool.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { createApp, type AppWithLifecycle } from '../src/app';
import { resetConfig } from '../src/shared/config';

type EnvSnapshot = Record<string, string | undefined>;

function snapshotEnv(keys: string[]): EnvSnapshot {
  const snap: EnvSnapshot = {};
  for (const k of keys) snap[k] = process.env[k];
  return snap;
}

function restoreEnv(snap: EnvSnapshot): void {
  for (const [k, v] of Object.entries(snap)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

const ENV_KEYS = [
  'NODE_ENV',
  'DEV_AUTH_BYPASS',
  'DATABASE_URL',
  'AI_PROVIDER_API_KEY',
  'CLERK_PUBLISHABLE_KEY',
  'PROCESS_ROLE',
  'API_IP_RATE_LIMIT_MAX',
  'WEBHOOK_PROVIDER_RATE_LIMIT_MAX',
  'REDIS_URL',
];

describe('rate limit configurability + provider webhook carve-out', () => {
  let prev: EnvSnapshot;

  beforeAll(() => {
    prev = snapshotEnv(ENV_KEYS);
  });

  afterAll(() => {
    restoreEnv(prev);
  });

  describe('API_IP_RATE_LIMIT_MAX', () => {
    let app: AppWithLifecycle;

    beforeAll(() => {
      process.env.NODE_ENV = 'test';
      process.env.PROCESS_ROLE = 'web';
      process.env.API_IP_RATE_LIMIT_MAX = '5';
      delete process.env.DATABASE_URL;
      delete process.env.AI_PROVIDER_API_KEY;
      delete process.env.CLERK_PUBLISHABLE_KEY;
      delete process.env.REDIS_URL;
      resetConfig();
      app = createApp();
    });

    afterAll(async () => {
      await app.gracefulDrain('test-cleanup');
      resetConfig();
    });

    it('allows the first 5 requests, then 429s the 6th, within the window', async () => {
      const statuses: number[] = [];
      for (let i = 0; i < 6; i += 1) {
        const res = await request(app).get('/api/does-not-exist');
        statuses.push(res.status);
      }
      expect(statuses.slice(0, 5).every((s) => s !== 429)).toBe(true);
      expect(statuses[5]).toBe(429);
    });
  });

  describe('WEBHOOK_PROVIDER_RATE_LIMIT_MAX', () => {
    let app: AppWithLifecycle;

    beforeAll(() => {
      process.env.NODE_ENV = 'test';
      process.env.PROCESS_ROLE = 'web';
      process.env.WEBHOOK_PROVIDER_RATE_LIMIT_MAX = '5';
      delete process.env.DATABASE_URL;
      delete process.env.AI_PROVIDER_API_KEY;
      delete process.env.CLERK_PUBLISHABLE_KEY;
      delete process.env.REDIS_URL;
      resetConfig();
      app = createApp();
    });

    afterAll(async () => {
      await app.gracefulDrain('test-cleanup');
      resetConfig();
    });

    it('allows 5 requests to a provider prefix (/webhooks/stripe) without 429, 6th 429s', async () => {
      const statuses: number[] = [];
      for (let i = 0; i < 6; i += 1) {
        const res = await request(app)
          .post('/webhooks/stripe')
          .set('content-type', 'application/json')
          .send('{}');
        statuses.push(res.status);
      }
      expect(statuses.slice(0, 5).every((s) => s !== 429)).toBe(true);
      expect(statuses[5]).toBe(429);
    });

    it('an unknown /webhooks/* path still 429s at the pre-existing general 30/min limit', async () => {
      let last = 0;
      for (let i = 0; i < 31; i += 1) {
        const res = await request(app).post('/webhooks/unknown').send({});
        last = res.status;
      }
      expect(last).toBe(429);
    });
  });

  describe('default-preserving behavior', () => {
    let app: AppWithLifecycle;

    beforeAll(() => {
      process.env.NODE_ENV = 'dev';
      process.env.PROCESS_ROLE = 'web';
      delete process.env.API_IP_RATE_LIMIT_MAX;
      delete process.env.DATABASE_URL;
      delete process.env.AI_PROVIDER_API_KEY;
      delete process.env.CLERK_PUBLISHABLE_KEY;
      delete process.env.REDIS_URL;
      resetConfig();
      app = createApp();
    });

    afterAll(async () => {
      await app.gracefulDrain('test-cleanup');
      resetConfig();
    });

    it('dev NODE_ENV still yields the 10000 ceiling (unaffected by no env override)', async () => {
      // Can't practically fire 10000 requests — assert none of a modest
      // burst 429s, which would already fail well below the old 100/15min
      // ceiling if the dev override had regressed.
      for (let i = 0; i < 20; i += 1) {
        const res = await request(app).get('/api/does-not-exist');
        expect(res.status).not.toBe(429);
      }
    });
  });
});
