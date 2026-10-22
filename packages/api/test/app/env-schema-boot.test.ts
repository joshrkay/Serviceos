/**
 * createApp() runs validateEnvSchema() at boot. Before this, the schema was
 * only exercised by tests, so its production-only refusals (Clerk test keys,
 * CORS_ORIGIN='true', DEV_AUTH_BYPASS / CLERK_DEV_HMAC_TOKENS=true) never
 * guarded a real deploy. Each case fails at the schema check, before any
 * route or DB pool is touched.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const PROD_ENV = {
  NODE_ENV: 'production',
  DATABASE_URL: 'postgres://user@127.0.0.1:5432/never_connected',
  CLERK_SECRET_KEY: 'sk_live_dummy',
  CLERK_PUBLISHABLE_KEY: 'pk_live_dummy',
  CORS_ORIGIN: 'https://app.invalid',
};

describe('createApp() enforces the production env schema at boot', () => {
  let saved: NodeJS.ProcessEnv;

  beforeEach(() => {
    saved = { ...process.env };
    vi.resetModules();
  });

  afterEach(() => {
    process.env = saved;
  });

  const boot = async (overrides: Record<string, string>) => {
    Object.assign(process.env, PROD_ENV, overrides);
    const { createApp } = await import('../../src/app');
    return () => createApp();
  };

  it('refuses Clerk test keys in production', async () => {
    const start = await boot({ CLERK_PUBLISHABLE_KEY: 'pk_test_dummy' });
    expect(start).toThrow(/pk_live_/);
  });

  it("refuses CORS_ORIGIN='true' in production", async () => {
    const start = await boot({ CORS_ORIGIN: 'true' });
    expect(start).toThrow(/CORS_ORIGIN/);
  });

  it('refuses DEV_AUTH_BYPASS=true in production', async () => {
    const start = await boot({ DEV_AUTH_BYPASS: 'true' });
    expect(start).toThrow(/DEV_AUTH_BYPASS/);
  });
});
