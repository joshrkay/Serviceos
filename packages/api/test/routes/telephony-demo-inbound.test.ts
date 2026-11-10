/**
 * Inbound /voice on the public demo line.
 *
 * A demo tenant has no billing, so the §10 voice gate (subscription, go-live,
 * usage caps) would send every call to voicemail; the demo guard replaces it
 * with its own caps. A caller over a cap hears a polite "demo limit reached"
 * message and the call hangs up before any session or AI turn exists. A real
 * tenant's calls go through the gate exactly as they always did.
 */
import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import twilio from 'twilio';
import { createTelephonyRouter } from '../../src/routes/telephony';
import { TwilioGatherAdapter } from '../../src/telephony/twilio-adapter';
import { VoiceSessionStore } from '../../src/ai/agents/customer-calling/voice-session-store';
import type { LLMGateway } from '../../src/ai/gateway/gateway';
import { InMemoryPhoneNumberRepository } from '../../src/integrations/twilio/phone-number-repository';
import type { VoiceGate } from '../../src/voice/voice-gate';
import type { DemoInboundGuard, DemoInboundVerdict } from '../../src/demo/inbound-limits';

const AUTH_TOKEN = 'test-tw-token-demo-inbound';
const PUBLIC_BASE_URL = 'https://api.test';
const DEMO_TENANT = 'tenant-demo-plumbing-1';
const REAL_TENANT = 'tenant-real-acme';
const DEMO_NUMBER = '+16025550100';
const REAL_NUMBER = '+15125550999';
const CALLER = '+15125550123';

function buildHarness(opts: {
  verdict?: DemoInboundVerdict | (() => Promise<DemoInboundVerdict>);
  gate?: VoiceGate;
  withGuard?: boolean;
}) {
  const store = new VoiceSessionStore({ startInterval: false });
  const gateway = { complete: vi.fn() } as unknown as LLMGateway;
  const adapter = new TwilioGatherAdapter({
    store,
    gateway,
    businessName: 'Test Co',
    publicBaseUrl: PUBLIC_BASE_URL,
  });
  const voiceGate: VoiceGate =
    opts.gate ?? vi.fn(async () => ({ allowed: true, businessHours: null, afterHoursVoiceMode: 'ai_answering' as const }));
  const check = vi.fn(async ({ tenantId }: { tenantId: string; from: string }): Promise<DemoInboundVerdict> => {
    if (typeof opts.verdict === 'function') return opts.verdict();
    if (opts.verdict) return opts.verdict;
    return tenantId === DEMO_TENANT ? { demo: true, allowed: true } : { demo: false };
  });
  const demoInbound: Pick<DemoInboundGuard, 'check'> = { check };

  const app = express();
  app.use(
    '/api/telephony',
    createTelephonyRouter({
      adapter,
      authTokenGetter: () => AUTH_TOKEN,
      publicBaseUrl: PUBLIC_BASE_URL,
      phoneNumberRepo: new InMemoryPhoneNumberRepository({
        [DEMO_NUMBER]: DEMO_TENANT,
        [REAL_NUMBER]: REAL_TENANT,
      }),
      resolveTenantId: () => undefined,
      nodeEnv: 'production',
      voiceGate,
      ...(opts.withGuard === false ? {} : { demoInbound }),
    }),
  );
  const sessionTenants = () =>
    Array.from((store as unknown as { sessions: Map<string, { tenantId: string }> }).sessions.values()).map(
      (s) => s.tenantId,
    );
  return { app, voiceGate, check, sessionTenants };
}

function signedVoice(app: express.Application, params: Record<string, string>) {
  const path = '/api/telephony/voice';
  const sig = twilio.getExpectedTwilioSignature(AUTH_TOKEN, `${PUBLIC_BASE_URL}${path}`, params);
  return request(app).post(path).set('X-Twilio-Signature', sig).type('form').send(params);
}

describe('inbound /voice — public demo line', () => {
  it.each([
    ['caller_limit' as const],
    ['daily_total' as const],
    ['unavailable' as const],
  ])('a demo call refused for %s hears the demo-limit message and is hung up, with no session and no AI turn', async (reason) => {
    const h = buildHarness({ verdict: { demo: true, allowed: false, reason } });

    const res = await signedVoice(h.app, { CallSid: 'CA-demo-1', From: CALLER, To: DEMO_NUMBER });

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/xml/);
    expect(res.text).toMatch(/<Say[^>]*>[^<]*demo[^<]*limit/i);
    expect(res.text).toContain('<Hangup/>');
    expect(res.text).not.toContain('<Gather');
    expect(h.sessionTenants()).toEqual([]);
    expect(h.voiceGate).not.toHaveBeenCalled();
  });

  it('asks the guard about this tenant and this caller', async () => {
    const h = buildHarness({});
    await signedVoice(h.app, { CallSid: 'CA-demo-2', From: CALLER, To: DEMO_NUMBER });
    expect(h.check).toHaveBeenCalledWith({ tenantId: DEMO_TENANT, from: CALLER });
  });

  it('an allowed demo call is answered by the demo tenant without the billing gate', async () => {
    const h = buildHarness({});

    const res = await signedVoice(h.app, { CallSid: 'CA-demo-3', From: CALLER, To: DEMO_NUMBER });

    expect(res.status).toBe(200);
    expect(res.text).toContain('<Gather');
    expect(res.text).not.toContain('<Hangup/>');
    expect(h.voiceGate).not.toHaveBeenCalled();
    expect(h.sessionTenants()).toEqual([DEMO_TENANT]);
  });

  it('a real tenant still goes through the voice gate, and is never refused by the demo caps', async () => {
    const h = buildHarness({});

    const res = await signedVoice(h.app, { CallSid: 'CA-real-1', From: CALLER, To: REAL_NUMBER });

    expect(res.text).toContain('<Gather');
    expect(res.text).not.toMatch(/demo/i);
    expect(h.voiceGate).toHaveBeenCalledTimes(1);
    expect(h.voiceGate).toHaveBeenCalledWith(expect.objectContaining({ tenantId: REAL_TENANT }));
    expect(h.sessionTenants()).toEqual([REAL_TENANT]);
  });

  it('a real tenant blocked by the gate is still blocked (voicemail), exactly as before the demo line existed', async () => {
    const gate: VoiceGate = vi.fn(async () => ({ allowed: false, reason: 'no_billing' as const }));
    const h = buildHarness({ gate });

    const res = await signedVoice(h.app, { CallSid: 'CA-real-2', From: CALLER, To: REAL_NUMBER });

    expect(gate).toHaveBeenCalledTimes(1);
    expect(res.text).toContain('<Record');
    expect(res.text).not.toMatch(/demo/i);
    expect(h.sessionTenants()).toEqual([]);
  });

  it('an unexpected guard failure does not grant the demo bypass: the call goes to the voice gate like any other', async () => {
    const gate: VoiceGate = vi.fn(async () => ({ allowed: false, reason: 'no_billing' as const }));
    const h = buildHarness({
      gate,
      verdict: async () => {
        throw new Error('guard blew up');
      },
    });

    const res = await signedVoice(h.app, { CallSid: 'CA-demo-4', From: CALLER, To: DEMO_NUMBER });

    expect(gate).toHaveBeenCalledTimes(1);
    expect(res.text).toContain('<Record');
    expect(h.sessionTenants()).toEqual([]);
  });

  it('with no demo guard wired, /voice behaves exactly as before', async () => {
    const h = buildHarness({ withGuard: false });

    const res = await signedVoice(h.app, { CallSid: 'CA-real-3', From: CALLER, To: REAL_NUMBER });

    expect(res.text).toContain('<Gather');
    expect(h.voiceGate).toHaveBeenCalledTimes(1);
  });
});
