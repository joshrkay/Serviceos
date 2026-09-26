/**
 * #1061 — `/gather`, `/dial-result` and `/callback-message` resolve their
 * tenant from `To` through the SAME `phoneNumberRepo` as `/voice`, and never
 * silently fall back to `TWILIO_DEFAULT_TENANT_ID` outside dev.
 *
 * Before: these three handlers called the legacy `resolveTenantId` callback
 * directly. In app.ts that callback was a second copy of the DID SQL that
 * returned `TWILIO_DEFAULT_TENANT_ID` on a miss, on a missing `To`, and on any
 * DB error — in every environment — so a webhook without `To` ran the E1 path
 * under the env default tenant and every audit write landed under the wrong
 * tenant.
 *
 * Harness mirrors test/routes/telephony-tenant-lookup.test.ts (signed Twilio
 * webhooks against the real router + adapter, in-memory repo).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import twilio from 'twilio';
import {
  createTelephonyRouter,
  createDidTenantResolver,
} from '../../src/routes/telephony';
import { TwilioGatherAdapter } from '../../src/telephony/twilio-adapter';
import { VoiceSessionStore } from '../../src/ai/agents/customer-calling/voice-session-store';
import type { LLMGateway, LLMResponse } from '../../src/ai/gateway/gateway';
import { InMemoryPhoneNumberRepository } from '../../src/integrations/twilio/phone-number-repository';
import type { SentryClient } from '../../src/monitoring/sentry';

const AUTH_TOKEN = 'test-tw-token-1061';
const PUBLIC_BASE_URL = 'https://api.test';
const TENANT_ID = 'tenant-1061-owner';
const DEFAULT_TENANT_ID = 'tenant-1061-env-default';
const KNOWN_NUMBER = '+15125550961';
const CALLER = '+15125550100';

function makeGateway(): LLMGateway {
  const response: LLMResponse = {
    content: JSON.stringify({
      intentType: 'create_invoice',
      confidence: 0.91,
      reasoning: 'clear command',
      extractedEntities: {},
    }),
    model: 'mock',
    provider: 'mock',
    tokenUsage: { input: 1, output: 1, total: 2 },
    latencyMs: 1,
  };
  return { complete: vi.fn().mockResolvedValue(response) } as unknown as LLMGateway;
}

function makeFakeSentry(): SentryClient {
  return {
    captureException: () => 'no-op',
    captureMessage: () => 'captured',
    setTag: () => {},
    setUser: () => {},
    startTransaction: () => ({ finish: () => {}, setStatus: () => {} }),
    withScope: <T>(cb: (scope: { setTag(): void; captureException(): string }) => T): T =>
      cb({ setTag: () => {}, captureException: () => 'noop' }),
  };
}

function buildHarness(nodeEnv: 'production' | 'staging' | 'development') {
  const store = new VoiceSessionStore({ startInterval: false });
  const adapter = new TwilioGatherAdapter({
    store,
    gateway: makeGateway(),
    businessName: 'Test Co',
    publicBaseUrl: PUBLIC_BASE_URL,
  });
  const handleGatherSpy = vi.spyOn(adapter, 'handleGather');
  const phoneRepo = new InMemoryPhoneNumberRepository({ [KNOWN_NUMBER]: TENANT_ID });
  // The legacy callback as app.ts used to wire it: env default on every miss.
  const legacyResolveSpy = vi.fn(() => DEFAULT_TENANT_ID);

  const app = express();
  app.use(
    '/api/telephony',
    createTelephonyRouter({
      adapter,
      authTokenGetter: () => AUTH_TOKEN,
      publicBaseUrl: PUBLIC_BASE_URL,
      phoneNumberRepo: phoneRepo,
      resolveTenantId: legacyResolveSpy,
      sentry: makeFakeSentry(),
      nodeEnv,
    }),
  );
  return { app, store, adapter, handleGatherSpy, legacyResolveSpy };
}

function signedPost(app: express.Application, path: string, params: Record<string, string>) {
  const url = `${PUBLIC_BASE_URL}${path}`;
  const sig = twilio.getExpectedTwilioSignature(AUTH_TOKEN, url, params);
  return request(app).post(path).set('X-Twilio-Signature', sig).type('form').send(params);
}

async function startCall(app: express.Application, store: VoiceSessionStore, callSid: string) {
  const res = await signedPost(app, '/api/telephony/voice', {
    CallSid: callSid,
    From: CALLER,
    To: KNOWN_NUMBER,
  });
  expect(res.status).toBe(200);
  const sessions = Array.from(
    (store as unknown as { sessions: Map<string, { id: string; tenantId: string }> }).sessions.values(),
  );
  expect(sessions).toHaveLength(1);
  expect(sessions[0]!.tenantId).toBe(TENANT_ID);
  return sessions[0]!.id;
}

describe('#1061 — /gather + /dial-result resolve the tenant through phoneNumberRepo', () => {
  const originalDefault = process.env.TWILIO_DEFAULT_TENANT_ID;

  beforeEach(() => {
    process.env.TWILIO_DEFAULT_TENANT_ID = DEFAULT_TENANT_ID;
  });
  afterEach(() => {
    if (originalDefault !== undefined) process.env.TWILIO_DEFAULT_TENANT_ID = originalDefault;
    else delete process.env.TWILIO_DEFAULT_TENANT_ID;
    vi.restoreAllMocks();
  });

  it('/gather in prod: tenant comes from the repo, the legacy resolver is never consulted', async () => {
    const { app, store, handleGatherSpy, legacyResolveSpy } = buildHarness('production');
    const sid = await startCall(app, store, 'CA-1061-g1');

    const res = await signedPost(app, `/api/telephony/gather?sid=${sid}`, {
      CallSid: 'CA-1061-g1',
      SpeechResult: 'hello',
      Confidence: '0.9',
      From: CALLER,
      To: KNOWN_NUMBER,
    });

    expect(res.status).toBe(200);
    expect(handleGatherSpy).toHaveBeenCalledTimes(1);
    expect(handleGatherSpy.mock.calls[0]![0].tenantId).toBe(TENANT_ID);
    expect(legacyResolveSpy).not.toHaveBeenCalled();
  });

  it('/gather in prod WITHOUT To/From: no env-default tenant, graceful hangup, E1 path never runs', async () => {
    const { app, store, handleGatherSpy, legacyResolveSpy } = buildHarness('production');
    const sid = await startCall(app, store, 'CA-1061-g2');

    const res = await signedPost(app, `/api/telephony/gather?sid=${sid}`, {
      CallSid: 'CA-1061-g2',
      SpeechResult: 'hello',
      Confidence: '0.9',
    });

    expect(res.status).toBe(200);
    expect(res.text).toContain('<Hangup');
    expect(handleGatherSpy).not.toHaveBeenCalled();
    expect(legacyResolveSpy).not.toHaveBeenCalled();
  });

  it('/gather in staging with an unowned To: refused, not routed to the env default', async () => {
    const { app, store, handleGatherSpy } = buildHarness('staging');
    const sid = await startCall(app, store, 'CA-1061-g3');

    const res = await signedPost(app, `/api/telephony/gather?sid=${sid}`, {
      CallSid: 'CA-1061-g3',
      SpeechResult: 'hello',
      Confidence: '0.9',
      From: CALLER,
      To: '+18005550000',
    });

    expect(res.status).toBe(200);
    expect(res.text).toContain('<Hangup');
    expect(handleGatherSpy).not.toHaveBeenCalled();
  });

  it('/gather in prod: a repo outage is a 503 (Twilio retries), never the env default', async () => {
    const store = new VoiceSessionStore({ startInterval: false });
    const adapter = new TwilioGatherAdapter({
      store,
      gateway: makeGateway(),
      businessName: 'Test Co',
      publicBaseUrl: PUBLIC_BASE_URL,
    });
    const handleGatherSpy = vi.spyOn(adapter, 'handleGather');
    const app = express();
    app.use(
      '/api/telephony',
      createTelephonyRouter({
        adapter,
        authTokenGetter: () => AUTH_TOKEN,
        publicBaseUrl: PUBLIC_BASE_URL,
        phoneNumberRepo: { findByNumber: vi.fn().mockRejectedValue(new Error('db down')) },
        resolveTenantId: () => DEFAULT_TENANT_ID,
        sentry: makeFakeSentry(),
        nodeEnv: 'production',
      }),
    );

    const res = await signedPost(app, '/api/telephony/gather?sid=sess-x', {
      CallSid: 'CA-1061-g4',
      SpeechResult: 'hello',
      Confidence: '0.9',
      From: CALLER,
      To: KNOWN_NUMBER,
    });
    expect(res.status).toBe(503);
    expect(handleGatherSpy).not.toHaveBeenCalled();
  });

  it('/dial-result in prod: tenant comes from the repo, the legacy resolver is never consulted', async () => {
    const { app, store, legacyResolveSpy } = buildHarness('production');
    const sid = await startCall(app, store, 'CA-1061-d1');

    const res = await signedPost(app, `/api/telephony/dial-result?sid=${sid}`, {
      CallSid: 'CA-1061-d1',
      DialCallStatus: 'completed',
      From: CALLER,
      To: KNOWN_NUMBER,
    });

    // Not the 403 a DEFAULT-tenant resolution produces against a session
    // that belongs to TENANT_ID.
    expect(res.status).toBe(200);
    expect(legacyResolveSpy).not.toHaveBeenCalled();
  });

  it('/dial-result in prod WITHOUT To/From: graceful hangup, no env-default tenant', async () => {
    const { app, store, legacyResolveSpy } = buildHarness('production');
    const sid = await startCall(app, store, 'CA-1061-d2');

    const res = await signedPost(app, `/api/telephony/dial-result?sid=${sid}`, {
      CallSid: 'CA-1061-d2',
      DialCallStatus: 'completed',
    });

    expect(res.status).toBe(200);
    expect(res.text).toContain('<Hangup');
    expect(legacyResolveSpy).not.toHaveBeenCalled();
  });

  it('/callback-message in prod WITHOUT To/From: graceful hangup, no env-default tenant', async () => {
    const { app, store, legacyResolveSpy } = buildHarness('production');
    const sid = await startCall(app, store, 'CA-1061-c1');

    const res = await signedPost(app, `/api/telephony/callback-message?sid=${sid}`, {
      CallSid: 'CA-1061-c1',
      SpeechResult: 'call me back',
    });

    expect(res.status).toBe(200);
    expect(res.text).toContain('<Hangup');
    expect(legacyResolveSpy).not.toHaveBeenCalled();
  });

  it('/gather in dev with an unowned To: env default is used, with the dev-fallback WARN', async () => {
    const { app, handleGatherSpy } = buildHarness('development');
    const stdoutChunks: string[] = [];
    const stdoutSpy = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation(((chunk: unknown) => {
        stdoutChunks.push(String(chunk));
        return true;
      }) as typeof process.stdout.write);

    await signedPost(app, '/api/telephony/gather?sid=sess-unknown', {
      CallSid: 'CA-1061-g5',
      SpeechResult: 'hello',
      Confidence: '0.9',
      From: CALLER,
      To: '+18005550000',
    });
    stdoutSpy.mockRestore();

    expect(handleGatherSpy).toHaveBeenCalledTimes(1);
    expect(handleGatherSpy.mock.calls[0]![0].tenantId).toBe(DEFAULT_TENANT_ID);
    expect(stdoutChunks.join('')).toContain('telephony.tenant_lookup_dev_fallback');
  });
});

describe('#1061 — createDidTenantResolver (the app.ts payload-alias fallback)', () => {
  const originalDefault = process.env.TWILIO_DEFAULT_TENANT_ID;
  beforeEach(() => {
    process.env.TWILIO_DEFAULT_TENANT_ID = DEFAULT_TENANT_ID;
  });
  afterEach(() => {
    if (originalDefault !== undefined) process.env.TWILIO_DEFAULT_TENANT_ID = originalDefault;
    else delete process.env.TWILIO_DEFAULT_TENANT_ID;
    vi.restoreAllMocks();
  });

  const repo = () => new InMemoryPhoneNumberRepository({ [KNOWN_NUMBER]: TENANT_ID });

  it('resolves an owned DID through the repository', async () => {
    const resolve = createDidTenantResolver({ phoneNumberRepo: repo(), nodeEnv: 'production' });
    expect(await resolve({ to: KNOWN_NUMBER, from: CALLER })).toBe(TENANT_ID);
  });

  it.each(['production', 'prod', 'staging'])(
    'in %s: a miss, a missing To, or a lookup error is undefined — never the env default',
    async (nodeEnv) => {
      const resolve = createDidTenantResolver({ phoneNumberRepo: repo(), nodeEnv });
      expect(await resolve({ to: '+18005550000', from: CALLER })).toBeUndefined();
      expect(await resolve({ to: '', from: '' })).toBeUndefined();
      const broken = createDidTenantResolver({
        phoneNumberRepo: { findByNumber: vi.fn().mockRejectedValue(new Error('db down')) },
        nodeEnv,
      });
      expect(await broken({ to: KNOWN_NUMBER, from: CALLER })).toBeUndefined();
      const noRepo = createDidTenantResolver({ nodeEnv });
      expect(await noRepo({ to: KNOWN_NUMBER, from: CALLER })).toBeUndefined();
    },
  );

  it('in dev: a miss falls back to the env default with a WARN', async () => {
    const stdoutChunks: string[] = [];
    const stdoutSpy = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation(((chunk: unknown) => {
        stdoutChunks.push(String(chunk));
        return true;
      }) as typeof process.stdout.write);
    const resolve = createDidTenantResolver({ phoneNumberRepo: repo(), nodeEnv: 'development' });
    const got = await resolve({ to: '+18005550000', from: CALLER });
    stdoutSpy.mockRestore();
    expect(got).toBe(DEFAULT_TENANT_ID);
    expect(stdoutChunks.join('')).toContain('telephony.tenant_lookup_dev_fallback');
  });
});
