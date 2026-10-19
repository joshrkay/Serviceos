/**
 * LCR-04 — a database brownout must not drop live or inbound calls.
 *
 * Twilio does not retry a 5xx voice webhook, and no number had a
 * VoiceFallbackUrl, so a tenant-lookup throw on /voice (503), a throw inside
 * handleGather ("try again later" + <Hangup/>), or a credential-lookup throw in
 * the signature layer (500) all ended the call with no voicemail. These tests
 * drive the real router with a database that throws.
 */
import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import twilio from 'twilio';
import { createTelephonyRouter, createDidTenantResolver } from '../../src/routes/telephony';
import { createVoicemailStatusRouter } from '../../src/telephony/voicemail-status-route';
import { TwilioGatherAdapter } from '../../src/telephony/twilio-adapter';
import { VoiceSessionStore } from '../../src/ai/agents/customer-calling/voice-session-store';
import type { LLMGateway } from '../../src/ai/gateway/gateway';
import { buildPhoneNumberWebhooks } from '../../src/integrations/twilio/provisioning';

const AUTH_TOKEN = 'lcr04-token';
const BASE = 'https://api.test';
const TENANT = 'tenant-lcr04';
const FROM = '+15125550100';
const TO = '+15125550999';

function gateway(): LLMGateway {
  return {
    complete: vi.fn().mockResolvedValue({
      content: '{"intentType":"unknown","confidence":0,"reasoning":"x"}',
      model: 'm',
      provider: 'p',
      tokenUsage: { input: 1, output: 1, total: 2 },
      latencyMs: 1,
    }),
  } as unknown as LLMGateway;
}

const dbDownRepo = () => ({ findByNumber: vi.fn(() => Promise.reject(new Error('db down'))) });

function mount(overrides: Partial<Parameters<typeof createTelephonyRouter>[0]> = {}) {
  const store = new VoiceSessionStore({ startInterval: false });
  const adapter = new TwilioGatherAdapter({ store, gateway: gateway(), businessName: 'Acme', publicBaseUrl: BASE });
  const app = express();
  app.use(
    '/api/telephony',
    createTelephonyRouter({
      adapter,
      authTokenGetter: () => AUTH_TOKEN,
      publicBaseUrl: BASE,
      resolveTenantId: () => undefined,
      businessName: 'Acme',
      nodeEnv: 'production',
      voiceSessionStore: store,
      ...overrides,
    }),
  );
  return { app, store, adapter };
}

function signed(app: express.Application, path: string, params: Record<string, string>) {
  const sig = twilio.getExpectedTwilioSignature(AUTH_TOKEN, `${BASE}${path}`, params);
  return request(app).post(path).set('X-Twilio-Signature', sig).type('form').send(params);
}

function expectVoicemail(text: string) {
  expect(text).toContain('<Record');
  expect(text).not.toContain('try again later');
  // The DB-free callback carries the caller and the dialled number, so the
  // voicemail can be attached to the tenant once the database is back.
  expect(text).toContain(
    `recordingStatusCallback="${BASE}/api/telephony/voicemail-status?From=${encodeURIComponent(FROM)}&amp;To=${encodeURIComponent(TO)}"`,
  );
}

describe('LCR-04 — POST /voice/fallback (the number\'s VoiceFallbackUrl)', () => {
  it('answers fixed voicemail TwiML without touching the database or the credential lookup', async () => {
    const repo = dbDownRepo();
    const authTokenGetter = vi.fn(() => {
      throw new Error('credential lookup must not run');
    });
    const { app } = mount({ phoneNumberRepo: repo, authTokenGetter });
    // The path Twilio is given as the number's VoiceFallbackUrl at purchase
    // (and by the backfill) must be the path this router serves.
    const provisionedPath = buildPhoneNumberWebhooks(BASE, TENANT).voiceFallbackUrl.slice(BASE.length);
    expect(provisionedPath).toBe('/api/telephony/voice/fallback');
    const res = await request(app)
      .post(provisionedPath)
      .type('form')
      .send({ CallSid: 'CA-fb', From: FROM, To: TO });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/xml/);
    expectVoicemail(res.text);
    expect(res.text).toContain('Thanks for calling Acme');
    expect(repo.findByNumber).not.toHaveBeenCalled();
    expect(authTokenGetter).not.toHaveBeenCalled();
  });
});

describe('LCR-04 — webhook catch-alls take a voicemail instead of a 5xx or a hang-up', () => {
  it('/voice: a tenant-lookup throw answers 200 voicemail, not a 503 Twilio never retries', async () => {
    const { app } = mount({ phoneNumberRepo: dbDownRepo() });
    const res = await signed(app, '/api/telephony/voice', { CallSid: 'CA-v1', From: FROM, To: TO });
    expect(res.status).toBe(200);
    expectVoicemail(res.text);
  });

  it('/voice: the adapter throwing answers voicemail, not "try again later" + hang-up', async () => {
    const { app, adapter } = mount({ phoneNumberRepo: { findByNumber: async () => ({ tenantId: TENANT }) } as never });
    vi.spyOn(adapter, 'handleInbound').mockRejectedValue(new Error('boom'));
    const res = await signed(app, '/api/telephony/voice', { CallSid: 'CA-v2', From: FROM, To: TO });
    expect(res.status).toBe(200);
    expectVoicemail(res.text);
  });

  it('/gather: a tenant-lookup throw with a live session keeps the turn going on the session\'s tenant', async () => {
    const { app, store, adapter } = mount({ phoneNumberRepo: dbDownRepo() });
    const session = store.create(TENANT, 'telephony', { callSid: 'CA-g1' });
    const handleGather = vi.spyOn(adapter, 'handleGather').mockResolvedValue('<Response><Gather/></Response>');
    const res = await signed(app, `/api/telephony/gather?sid=${session.id}`, {
      CallSid: 'CA-g1', SpeechResult: 'my furnace stopped', Confidence: '0.9', From: FROM, To: TO,
    });
    expect(res.status).toBe(200);
    expect(handleGather).toHaveBeenCalledWith(expect.objectContaining({ sessionId: session.id, tenantId: TENANT }));
  });

  it('/gather: a tenant-lookup throw with no session answers voicemail, not a 503', async () => {
    const { app } = mount({ phoneNumberRepo: dbDownRepo() });
    const res = await signed(app, '/api/telephony/gather?sid=sess-gone', {
      CallSid: 'CA-g2', SpeechResult: 'hi', Confidence: '0.9', From: FROM, To: TO,
    });
    expect(res.status).toBe(200);
    expectVoicemail(res.text);
  });

  it('/gather: handleGather throwing answers voicemail, not "try again later" + hang-up', async () => {
    const { app, store, adapter } = mount({ phoneNumberRepo: { findByNumber: async () => ({ tenantId: TENANT }) } as never });
    const session = store.create(TENANT, 'telephony', { callSid: 'CA-g3' });
    vi.spyOn(adapter, 'handleGather').mockRejectedValue(new Error('classify timeout'));
    const res = await signed(app, `/api/telephony/gather?sid=${session.id}`, {
      CallSid: 'CA-g3', SpeechResult: 'hi', Confidence: '0.9', From: FROM, To: TO,
    });
    expect(res.status).toBe(200);
    expectVoicemail(res.text);
  });

  it('/dial-result: a tenant-lookup throw with a live session still runs the dial result on the session\'s tenant', async () => {
    const { app, store } = mount({ phoneNumberRepo: dbDownRepo() });
    const session = store.create(TENANT, 'telephony', { callSid: 'CA-d1' });
    const res = await signed(app, `/api/telephony/dial-result?sid=${session.id}`, {
      CallSid: 'CA-d1', DialCallStatus: 'completed', From: FROM, To: TO,
    });
    expect(res.status).toBe(200);
    expect(res.text).not.toContain('<Record');
    expect(session.ended).toBe(true);
  });

  it('/dial-result: a tenant-lookup throw with no session answers voicemail, not a 503', async () => {
    const { app } = mount({ phoneNumberRepo: dbDownRepo() });
    const res = await signed(app, '/api/telephony/dial-result?sid=sess-gone', {
      CallSid: 'CA-d2', DialCallStatus: 'no-answer', From: FROM, To: TO,
    });
    expect(res.status).toBe(200);
    expectVoicemail(res.text);
  });

  it('/voice/gather-fallback: a tenant-lookup throw for an unknown call answers voicemail, not a 503', async () => {
    const { app } = mount({ phoneNumberRepo: dbDownRepo() });
    const res = await signed(app, '/api/telephony/voice/gather-fallback', { CallSid: 'CA-gf', From: FROM, To: TO });
    expect(res.status).toBe(200);
    expectVoicemail(res.text);
  });
});

describe('LCR-04 — the outage voicemail is retried, not dropped, while the database is still down', () => {
  it('createDidTenantResolver: in production a lookup throw propagates (it is not a "no tenant" miss)', async () => {
    const resolve = createDidTenantResolver({ phoneNumberRepo: dbDownRepo() as never, nodeEnv: 'production' });
    await expect(resolve({ to: TO, from: FROM })).rejects.toThrow('db down');
  });

  it('createDidTenantResolver: development keeps the failure-soft dev seam', async () => {
    const resolve = createDidTenantResolver({ phoneNumberRepo: dbDownRepo() as never, nodeEnv: 'development' });
    await expect(resolve({ to: TO, from: FROM })).resolves.toBe(process.env.TWILIO_DEFAULT_TENANT_ID || undefined);
  });

  it('/voicemail-status: a tenant-fallback throw answers 500 so the callback is delivered again, not 200-dropped', async () => {
    const store = new VoiceSessionStore({ startInterval: false });
    const app = express();
    app.use(
      '/api/telephony',
      createVoicemailStatusRouter({
        store,
        authTokenGetter: () => AUTH_TOKEN,
        publicBaseUrl: BASE,
        resolveTenantIdFallback: () => Promise.reject(new Error('db down')),
      }),
    );
    const path = `/api/telephony/voicemail-status?From=${encodeURIComponent(FROM)}&To=${encodeURIComponent(TO)}`;
    const res = await signed(app, path, {
      CallSid: 'CA-vm', RecordingSid: 'RE-vm', RecordingUrl: 'https://api.twilio.com/rec/RE-vm', RecordingStatus: 'completed',
    });
    expect(res.status).toBe(500);
  });
});

describe('LCR-04 — a live call is verified against its own session\'s tenant', () => {
  it('/gather and /dial-result hand the session\'s tenant to the credential lookup (the outage cache is keyed on it)', async () => {
    const authTokenGetter = vi.fn(() => AUTH_TOKEN);
    const { app, store, adapter } = mount({
      authTokenGetter,
      phoneNumberRepo: { findByNumber: async () => ({ tenantId: TENANT }) } as never,
    });
    const session = store.create(TENANT, 'telephony', { callSid: 'CA-t1' });
    vi.spyOn(adapter, 'handleGather').mockResolvedValue('<Response/>');
    await signed(app, `/api/telephony/gather?sid=${session.id}`, {
      CallSid: 'CA-t1', SpeechResult: 'hi', Confidence: '0.9', From: FROM, To: TO,
    });
    await signed(app, `/api/telephony/dial-result?sid=${session.id}`, {
      CallSid: 'CA-t1', DialCallStatus: 'completed', From: FROM, To: TO,
    });
    const calls = authTokenGetter.mock.calls as unknown as Array<[Record<string, unknown>]>;
    expect(calls.map((c) => c[0].tenantId)).toEqual([TENANT, TENANT]);
  });

  it('an unknown ?sid= keeps the dialled-number binding', async () => {
    const authTokenGetter = vi.fn(() => AUTH_TOKEN);
    const { app } = mount({ authTokenGetter, phoneNumberRepo: { findByNumber: async () => ({ tenantId: TENANT }) } as never });
    await signed(app, '/api/telephony/gather?sid=nope', {
      CallSid: 'CA-t2', SpeechResult: 'hi', Confidence: '0.9', From: FROM, To: TO,
    });
    const calls = authTokenGetter.mock.calls as unknown as Array<[Record<string, unknown>]>;
    expect(calls[0][0]).toEqual({ to: TO });
  });
});

describe('LCR-04 — /callback-message keeps the caller\'s message through an outage', () => {
  it('a failed call-me-back write answers voicemail, not a 503 that drops the caller mid-message', async () => {
    const TENANT_UUID = '00000000-0000-4000-8000-0000000000aa';
    const { app, store } = mount({
      phoneNumberRepo: { findByNumber: async () => ({ tenantId: TENANT_UUID }) } as never,
      callMeBackRepo: { create: vi.fn().mockRejectedValue(new Error('db down')) } as never,
    });
    const session = store.create(TENANT_UUID, 'telephony', { callSid: 'CA-cb' });
    const res = await signed(app, `/api/telephony/callback-message?sid=${session.id}`, {
      CallSid: 'CA-cb', SpeechResult: 'please call me about my furnace', From: FROM, To: TO,
    });
    expect(res.status).toBe(200);
    expectVoicemail(res.text);
  });
});
