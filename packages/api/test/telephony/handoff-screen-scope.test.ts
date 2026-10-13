/**
 * Round-3 review of #1676 — the press-1 screen is scoped to EMERGENCY-CLASS
 * hand-offs only.
 *
 * The screen exists so a carrier voicemail can never "answer" an emergency and
 * silence the page ladder. Applied to every transfer it would regress flows
 * that work in production today: an IVR-fronted transfer number or an
 * untrained receptionist cannot press 1, so ordinary "I want a person"
 * transfers would fall to callback. So the screen is an explicit producer
 * opt-in (default OFF): E2/emergency escalations, the P12-004 immediate
 * emergency dial, the vulnerable-caller patches, and the /dial-result cascade
 * of a screened leg. Every other transfer is byte-for-byte what origin/main
 * emits — the GOLDEN strings below were produced by running origin/main
 * (ddc176f1f) on the same scenarios (UUIDs normalized) — and keeps main's
 * `completed → transferred` semantics. Only the realtime delivery fix applies
 * to them.
 */
import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import twilio from 'twilio';
import { TwilioGatherAdapter } from '../../src/telephony/twilio-adapter';
import { DefaultTwilioCallControl } from '../../src/telephony/twilio-call-control';
import { VoiceSessionStore } from '../../src/ai/agents/customer-calling/voice-session-store';
import { InMemoryOnCallRepository } from '../../src/oncall/rotation';
import { InMemoryAuditRepository } from '../../src/audit/audit';
import { createTelephonyRouter } from '../../src/routes/telephony';
import { whisperRouter } from '../../src/telephony/whisper-route';
import { WhisperCache } from '../../src/telephony/whisper-cache';
import { emergencyImmediateDial } from '../../src/ai/skills/escalate-to-human';
import { patchOwnerThrough } from '../../src/ai/skills/patch-owner-through';
import type { LLMGateway } from '../../src/ai/gateway/gateway';

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;
const norm = (s: string) => s.replace(UUID, '<uuid>');
const TENANT = 'tenant-golden';
const BASE = 'https://api.test';
const XML = '<?xml version="1.0" encoding="UTF-8"?>';

/** origin/main's output for the same scenarios (see header). */
const GOLDEN = {
  dial_plain: `${XML}<Response><Dial timeout="20" action="https://api.test/api/telephony/dial-result?sid=s1" method="POST"><Number>+15125550101</Number></Dial></Response>`,
  dial_whisper: `${XML}<Response><Dial timeout="20" action="https://api.test/api/telephony/dial-result?sid=s1" method="POST"><Number url="https://api.test/api/telephony/whisper/esc_1">+15125550101</Number></Dial></Response>`,
  gather_frustration_rotation: `${XML}<Response><Dial timeout="20" action="https://api.test/api/telephony/dial-result?sid=<uuid>" method="POST"><Number url="https://api.test/api/telephony/whisper/esc_<uuid>">+15125550101</Number></Dial></Response>`,
  gather_frustration_business_line: `${XML}<Response><Dial timeout="20" action="https://api.test/api/telephony/dial-result?sid=<uuid>" method="POST"><Number>+15125550100</Number></Dial></Response>`,
  gather_frustration_transfer_number: `${XML}<Response><Dial timeout="20" action="https://api.test/api/telephony/dial-result?sid=<uuid>" method="POST"><Number url="https://api.test/api/telephony/whisper/esc_<uuid>">+15125550300</Number></Dial></Response>`,
  dial_result_completed: `${XML}<Response><Hangup/></Response>`,
  dial_result_no_answer: `${XML}<Response><Dial timeout="20" action="https://api.test/api/telephony/dial-result?sid=<uuid>" method="POST"><Number>+15125550102</Number></Dial></Response>`,
  whisper_get: `${XML}<Response><Say>Incoming call from Sam about a leak.</Say></Response>`,
  whisper_get_unknown: `${XML}<Response/>`,
};

/** A Dial leg carries the press-1 screen. */
const screened = (twiml: string) => /<Number url="[^"]*[?&]sid=[^"]*" method="GET">/.test(twiml) && twiml.includes('screen=1');

function gateway(): LLMGateway {
  return {
    complete: vi.fn().mockResolvedValue({
      content: '{"intentType":"unknown","confidence":0,"reasoning":"x"}',
      model: 'm',
      provider: 'm',
      tokenUsage: { input: 1, output: 1, total: 2 },
      latencyMs: 1,
    }),
  } as unknown as LLMGateway;
}

function gatherAdapter(opts: {
  store: VoiceSessionStore;
  phones?: Record<string, string | null>;
  businessLine?: string;
  transferNumber?: string;
  rotation?: Array<{ id: string; userId: string; orderIndex: number }>;
}) {
  return new TwilioGatherAdapter({
    store: opts.store,
    gateway: gateway(),
    businessName: 'Acme Plumbing',
    publicBaseUrl: BASE,
    onCallRepo: new InMemoryOnCallRepository(
      new Map([[TENANT, opts.rotation ?? [{ id: 'r1', userId: 'u1', orderIndex: 0 }]]]),
    ),
    auditRepo: new InMemoryAuditRepository(),
    callControl: new DefaultTwilioCallControl(),
    dispatcherPhoneResolver: async (_t: string, u: string) => (opts.phones ?? { u1: '+15125550101' })[u] ?? null,
    ...(opts.businessLine ? { businessPhoneFallbackResolver: async () => opts.businessLine! } : {}),
    ...(opts.transferNumber
      ? { settingsRepo: { findByTenant: async () => ({ transferNumber: opts.transferNumber }) } as never }
      : {}),
  } as never);
}

/** One Gather-transport caller turn; returns the webhook TwiML (normalized). */
async function gatherTurn(speech: string, opts: Omit<Parameters<typeof gatherAdapter>[0], 'store'> = {}) {
  const store = new VoiceSessionStore({ startInterval: false });
  const adapter = gatherAdapter({ store, ...opts });
  await adapter.handleInbound({ callSid: 'CA-g', from: '+15125550111', to: '+15125550999', tenantId: TENANT });
  const session = store.findByCallSid('CA-g')!;
  const twiml = await adapter.handleGather({
    sessionId: session.id,
    callSid: 'CA-g',
    speechResult: speech,
    confidence: 0.95,
    tenantId: TENANT,
  });
  return { twiml: norm(twiml), raw: twiml, store, adapter, session };
}

function signedDialResult(app: express.Application, actionUrl: string, status: string) {
  const url = new URL(actionUrl);
  const path = `${url.pathname}${url.search}`;
  const params = { CallSid: 'CA-g', DialCallStatus: status, From: '+15125550111', To: '+15125550999' };
  const sig = twilio.getExpectedTwilioSignature('tok', `${BASE}${path}`, params);
  return request(app).post(path).set('X-Twilio-Signature', sig).type('form').send(params);
}

function routerFor(h: { adapter: TwilioGatherAdapter; store: VoiceSessionStore }) {
  const app = express();
  app.use(
    '/api/telephony',
    createTelephonyRouter({
      adapter: h.adapter,
      authTokenGetter: () => 'tok',
      publicBaseUrl: BASE,
      resolveTenantId: () => TENANT,
      voiceSessionStore: h.store,
    }),
  );
  return app;
}

const actionOf = (twiml: string) => /<Dial [^>]*action="([^"]+)"/.exec(twiml)![1].replace(/&amp;/g, '&');

describe('screen scope — non-emergency transfers are exactly origin/main (Gather transport)', () => {
  it('dialDispatcher with no screen option emits main\'s bytes', () => {
    const cc = new DefaultTwilioCallControl();
    expect(cc.dialDispatcher('CA-1', '+15125550101', { actionUrl: `${BASE}/api/telephony/dial-result?sid=s1` })).toBe(
      GOLDEN.dial_plain,
    );
    expect(
      cc.dialDispatcher('CA-1', '+15125550101', {
        actionUrl: `${BASE}/api/telephony/dial-result?sid=s1`,
        whisperUrl: `${BASE}/api/telephony/whisper/esc_1`,
      }),
    ).toBe(GOLDEN.dial_whisper);
  });

  it('"I want a person" → rotation dispatcher: main\'s TwiML byte-for-byte, no screen', async () => {
    const { twiml } = await gatherTurn('I want to speak to a person');
    expect(twiml).toBe(GOLDEN.gather_frustration_rotation);
  });

  it('"I want a person" → business line: main\'s TwiML byte-for-byte, no screen', async () => {
    const { twiml } = await gatherTurn('I want to speak to a person', { phones: { u1: null }, businessLine: '+15125550100' });
    expect(twiml).toBe(GOLDEN.gather_frustration_business_line);
  });

  it('"I want a person" → transfer number: main\'s TwiML byte-for-byte, no screen', async () => {
    const { twiml } = await gatherTurn('I want to speak to a person', { transferNumber: '+15125550300' });
    expect(twiml).toBe(GOLDEN.gather_frustration_transfer_number);
  });

  it('a non-emergency leg that completes is stamped transferred with no keypress (main semantics)', async () => {
    const h = await gatherTurn('I want to speak to a person');
    const res = await signedDialResult(routerFor(h), actionOf(h.raw), 'completed');
    expect(norm(res.text)).toBe(GOLDEN.dial_result_completed);
    expect(h.session.terminalReason).toBe('transferred');
  });

  it('a non-emergency no-answer cascades to an unscreened next leg (main\'s TwiML)', async () => {
    const h = await gatherTurn('I want to speak to a person', {
      rotation: [
        { id: 'r1', userId: 'u1', orderIndex: 0 },
        { id: 'r2', userId: 'u2', orderIndex: 1 },
      ],
      phones: { u1: '+15125550101', u2: '+15125550102' },
    });
    const res = await signedDialResult(routerFor(h), actionOf(h.raw), 'no-answer');
    expect(norm(res.text)).toBe(GOLDEN.dial_result_no_answer);
  });

  it('the whisper of an unscreened leg is main\'s plain whisper (and main\'s empty response on a miss)', async () => {
    const cache = new WhisperCache();
    cache.set('esc_w', 'Incoming call from Sam about a leak.', TENANT);
    const app = express();
    app.use('/api/telephony', whisperRouter({ whisperCache: cache }));
    expect((await request(app).get('/api/telephony/whisper/esc_w')).text).toBe(GOLDEN.whisper_get);
    expect((await request(app).post('/api/telephony/whisper/esc_w')).text).toBe(GOLDEN.whisper_get);
    expect((await request(app).get('/api/telephony/whisper/nope')).text).toBe(GOLDEN.whisper_get_unknown);
  });
});

describe('screen scope — emergency-class hand-offs are screened (Gather transport + producers)', () => {
  it('an E2 emergency escalation leg is screened', async () => {
    const { raw } = await gatherTurn('my basement is flooding');
    expect(screened(raw)).toBe(true);
  });

  it('the P12-004 immediate emergency dial is screened', async () => {
    const result = await emergencyImmediateDial({
      intent: 'burst_pipe',
      presenceChecker: async () => false,
      tenantId: TENANT,
      sessionId: 'sess-p12',
      channel: 'telephony',
      callSid: 'CA-p12',
      onCallRepo: new InMemoryOnCallRepository(new Map([[TENANT, [{ id: 'r1', userId: 'u1', orderIndex: 0 }]]])),
      callControl: new DefaultTwilioCallControl(),
      dispatcherPhoneResolver: async () => '+15125550101',
      dialActionUrl: `${BASE}/api/telephony/dial-result?sid=sess-p12`,
    });
    expect(screened(result.escalation!.transfer!.fallbackTwiml!)).toBe(true);
  });

  it('the vulnerable-caller owner patch is screened', async () => {
    const result = await patchOwnerThrough(
      {
        tenantId: TENANT,
        sessionId: 'sess-v',
        callSid: 'CA-v',
        dialActionUrl: `${BASE}/api/telephony/dial-result?sid=sess-v`,
        reason: 'elderly caller, no heat',
        shopName: 'Acme Plumbing',
      },
      { callControl: new DefaultTwilioCallControl(), ownerPhoneResolver: async () => '+15125550177' },
    );
    expect(result.kind).toBe('bridged');
    expect(screened((result as { twiml: string }).twiml)).toBe(true);
  });

  it("an emergency leg's no-answer cascades to a SCREENED next leg", async () => {
    const h = await gatherTurn('my basement is flooding', {
      rotation: [
        { id: 'r1', userId: 'u1', orderIndex: 0 },
        { id: 'r2', userId: 'u2', orderIndex: 1 },
      ],
      phones: { u1: '+15125550101', u2: '+15125550102' },
    });
    const res = await signedDialResult(routerFor(h), actionOf(h.raw), 'no-answer');
    expect(res.text).toContain('+15125550102');
    expect(screened(res.text)).toBe(true);
  });

  it('an emergency leg that completes with nobody pressing 1 is NOT stamped transferred', async () => {
    const h = await gatherTurn('my basement is flooding');
    await signedDialResult(routerFor(h), actionOf(h.raw), 'completed');
    expect(h.session.terminalReason).not.toBe('transferred');
  });
});
