/**
 * APP-LEVEL proof for the kill-switch review.
 *
 * Boots the REAL createApp() under production's credential + flag shape and
 * asserts (a) messageDelivery is now non-null — i.e. 36d30807's decoupling
 * really did remove the accident that kept production dark — and (b) with
 * TELEPHONY_ENABLED=false + EMAIL_ENABLED=false, booting and running the app
 * makes ZERO outbound calls to Twilio/SendGrid.
 *
 * Own file: createApp() caches config process-wide, so it must not share a
 * worker with the unit suites.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import request from 'supertest';

// The local dev Postgres has no `rls_app_runtime` role, and production config
// requires RLS_RUNTIME_ROLE=true. Stub only that boot probe — nothing on the
// delivery path — so the boot reaches the wiring this test is about.
vi.mock('../../src/db/rls-runtime-role', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  verifyRlsRuntimeRole: async () => undefined,
}));

const FORBIDDEN = ['api.twilio.com', 'comms.twilio.com', 'api.sendgrid.com'];
const fetchCalls: string[] = [];
let realFetch: typeof globalThis.fetch;
let app: any;

beforeAll(async () => {
  realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: any) => {
    const url = typeof input === 'string' ? input : (input?.url ?? String(input));
    fetchCalls.push(url);
    throw new Error(`OUTBOUND TRIPWIRE: ${url}`);
  }) as any;

  Object.assign(process.env, {
    NODE_ENV: 'production',
    PROCESS_ROLE: 'web',
    // production's telephony credentials (dummy values)
    TWILIO_ACCOUNT_SID: 'ACdummydummydummydummydummydummy00',
    TWILIO_AUTH_TOKEN: 'dummy_auth_token_not_real',
    TWILIO_FROM_NUMBER: '+15550001111',
    TWILIO_DEFAULT_TENANT_ID: '11111111-1111-1111-1111-111111111111',
    // the kill switch, both channels off
    TELEPHONY_ENABLED: 'false',
    EMAIL_ENABLED: 'false',
    STORAGE_ENABLED: 'false',
    // production-shaped required config (dummy)
    // Local dev Postgres via OS-trust auth — no secret is embedded here.
    DATABASE_URL: `postgres://${process.env.USER}@127.0.0.1:5432/serviceos_dev`,
    CLERK_SECRET_KEY: 'sk_live_dummy',
    CLERK_PUBLISHABLE_KEY: 'pk_live_dummy',
    CLERK_WEBHOOK_SECRET: 'whsec_dummy',
    STRIPE_WEBHOOK_SECRET: 'whsec_stripe_dummy',
    AI_PROVIDER_API_KEY: 'sk-dummy',
    CORS_ORIGIN: 'https://app.invalid',
    RLS_RUNTIME_ROLE: 'true',
    TENANT_ENCRYPTION_KEY: 'a'.repeat(64),
    STRIPE_SECRET_KEY: 'sk_test_dummy',
    DB_SSL: 'false',
  });
  for (const k of [
    'SENDGRID_API_KEY',
    'SENDGRID_FROM_EMAIL',
    'TWILIO_EMAIL_FROM_ADDRESS',
    'TWILIO_EMAIL_FROM_NAME',
  ]) {
    delete process.env[k];
  }

  const { createApp } = await import('../../src/app');
  app = createApp();
});

afterAll(async () => {
  globalThis.fetch = realFetch;
  // Let boot-time async hydration (feature flags) settle before the pool closes.
  await new Promise((r) => setTimeout(r, 500));
  await app?.gracefulDrain?.('test');
});

describe('createApp() under production config', () => {
  it('boots without throwing (validateFeatureRequiredConfig either/or gate passes)', () => {
    expect(app).toBeTruthy();
  });

  it('RISK CONFIRMED: messageDelivery/sendService are LIVE with no email creds', async () => {
    const res = await request(app).get('/api/telephony/health');
    expect(res.status).toBe(200);
    // Pre-36d30807 this was false in production (missing SendGrid creds forced
    // rawMessageDelivery = null). If it is true, every sweep is a live object
    // and the kill switch is the only thing left.
    expect(res.body.capabilities.messageDelivery).toBe(true);
    expect(res.body.warnings).not.toContain(
      'send_invoice disabled — TWILIO_FROM_NUMBER / SENDGRID_* missing',
    );
  });

  it('boot + a health request make ZERO calls to Twilio/SendGrid', () => {
    const bad = fetchCalls.filter((u) => FORBIDDEN.some((h) => u.includes(h)));
    expect(bad, JSON.stringify(bad)).toEqual([]);
  });
});
