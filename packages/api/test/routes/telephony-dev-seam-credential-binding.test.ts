/**
 * #1084 (1) — the dev-only `TWILIO_DEFAULT_TENANT_ID` seam must not accept a
 * call whose verifying credential belongs to a specific, DIFFERENT tenant.
 *
 * After #1082 an unowned (or absent) dialled number falls through to the
 * AccountSid credential path, so tenant A's own credential verifies — and
 * `resolveInboundTenantId` then routed the call into the env default tenant.
 * Refused in production/staging already; this closes the dev/test hole at the
 * seam itself (not by skipping the AccountSid path — the whisper leg needs it).
 *
 * The deployment-wide token (no tenant implied) still reaches the seam, and a
 * credential that IS the default tenant's own is still accepted.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import twilio from 'twilio';
import { createTelephonyRouter } from '../../src/routes/telephony';
import { TwilioGatherAdapter } from '../../src/telephony/twilio-adapter';
import { VoiceSessionStore } from '../../src/ai/agents/customer-calling/voice-session-store';
import type { LLMGateway, LLMResponse } from '../../src/ai/gateway/gateway';
import { InMemoryPhoneNumberRepository } from '../../src/integrations/twilio/phone-number-repository';
import type { SentryClient } from '../../src/monitoring/sentry';
import type { TwilioAuthTokenGetter } from '../../src/telephony/twilio-signature';

const AUTH_TOKEN = 'test-tw-token-1084';
const PUBLIC_BASE_URL = 'https://api.test';
const TENANT_A = 'tenant-1084-a';
const DEFAULT_TENANT_ID = 'tenant-1084-default';
const UNOWNED_NUMBER = '+18005550184';
const CALLER = '+15125550100';

function makeGateway(): LLMGateway {
  const response: LLMResponse = {
    content: '{"intentType":"unknown","confidence":0,"reasoning":"x"}',
    model: 'mock',
    provider: 'mock',
    tokenUsage: { input: 1, output: 1, total: 2 },
    latencyMs: 1,
  };
  return { complete: vi.fn().mockResolvedValue(response) } as unknown as LLMGateway;
}

const sentry: SentryClient = {
  captureException: () => 'no-op',
  captureMessage: () => 'captured',
  setTag: () => {},
  setUser: () => {},
  startTransaction: () => ({ finish: () => {}, setStatus: () => {} }),
  withScope: <T>(cb: (scope: { setTag(): void; captureException(): string }) => T): T =>
    cb({ setTag: () => {}, captureException: () => 'noop' }),
};

/** A credential decision as the #1072 resolver answers it. */
const verifiedAs = (tenantId?: string): TwilioAuthTokenGetter => () => ({
  outcome: 'verify',
  authToken: AUTH_TOKEN,
  path: tenantId ? 'subaccount_lookup' : 'deployment_fallback',
  ...(tenantId ? { tenantId } : {}),
});

function buildHarness(opts: {
  getter: TwilioAuthTokenGetter;
  legacy?: () => string | undefined;
}) {
  const store = new VoiceSessionStore({ startInterval: false });
  const adapter = new TwilioGatherAdapter({
    store,
    gateway: makeGateway(),
    businessName: 'Test Co',
    publicBaseUrl: PUBLIC_BASE_URL,
  });
  const app = express();
  app.use(
    '/api/telephony',
    createTelephonyRouter({
      adapter,
      authTokenGetter: opts.getter,
      publicBaseUrl: PUBLIC_BASE_URL,
      phoneNumberRepo: new InMemoryPhoneNumberRepository({}),
      resolveTenantId: opts.legacy ?? (() => undefined),
      sentry,
      nodeEnv: 'development',
    }),
  );
  const sessions = () =>
    Array.from(
      (store as unknown as { sessions: Map<string, { tenantId: string }> }).sessions.values(),
    );
  return { app, sessions };
}

function signedVoice(app: express.Application, params: Record<string, string>) {
  const path = '/api/telephony/voice';
  const sig = twilio.getExpectedTwilioSignature(AUTH_TOKEN, `${PUBLIC_BASE_URL}${path}`, params);
  return request(app).post(path).set('X-Twilio-Signature', sig).type('form').send(params);
}

describe('#1084 (1) — the dev default-tenant seam is bound to the verifying credential', () => {
  const original = process.env.TWILIO_DEFAULT_TENANT_ID;
  beforeEach(() => {
    process.env.TWILIO_DEFAULT_TENANT_ID = DEFAULT_TENANT_ID;
  });
  afterEach(() => {
    if (original !== undefined) process.env.TWILIO_DEFAULT_TENANT_ID = original;
    else delete process.env.TWILIO_DEFAULT_TENANT_ID;
    vi.restoreAllMocks();
  });

  it("tenant A's own credential + an unowned DID is NOT routed into the env default tenant", async () => {
    const { app, sessions } = buildHarness({ getter: verifiedAs(TENANT_A) });

    const res = await signedVoice(app, { CallSid: 'CA-1084-1', From: CALLER, To: UNOWNED_NUMBER });

    expect(res.status).toBe(200);
    expect(res.text).toMatch(/not in service/i);
    expect(sessions()).toHaveLength(0);
  });

  it('the same refusal applies when the dev legacy resolver is what produced the tenant', async () => {
    const { app, sessions } = buildHarness({
      getter: verifiedAs(TENANT_A),
      legacy: () => DEFAULT_TENANT_ID,
    });

    const res = await signedVoice(app, { CallSid: 'CA-1084-2', From: CALLER, To: UNOWNED_NUMBER });

    expect(res.status).toBe(200);
    expect(res.text).toMatch(/not in service/i);
    expect(sessions()).toHaveLength(0);
  });

  it("the default tenant's OWN credential still reaches the seam", async () => {
    const { app, sessions } = buildHarness({ getter: verifiedAs(DEFAULT_TENANT_ID) });

    const res = await signedVoice(app, { CallSid: 'CA-1084-3', From: CALLER, To: UNOWNED_NUMBER });

    expect(res.status).toBe(200);
    expect(res.text).toContain('<Gather');
    expect(sessions().map((s) => s.tenantId)).toEqual([DEFAULT_TENANT_ID]);
  });

  it('the deployment-wide token (no tenant implied) still reaches the seam', async () => {
    const { app, sessions } = buildHarness({ getter: verifiedAs(undefined) });

    const res = await signedVoice(app, { CallSid: 'CA-1084-4', From: CALLER, To: UNOWNED_NUMBER });

    expect(res.status).toBe(200);
    expect(res.text).toContain('<Gather');
    expect(sessions().map((s) => s.tenantId)).toEqual([DEFAULT_TENANT_ID]);
  });
});
