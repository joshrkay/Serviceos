/**
 * WS7 — POST /api/telephony/voice/gather-fallback.
 *
 * Target of the mid-call REST redirect. Verifies:
 *   - Known CallSid → Gather TwiML that continues the SAME session
 *     (`action=/api/telephony/gather?sid=<sessionId>`), never a <Stream>.
 *   - Unknown CallSid → falls through to adapter.handleInbound (fresh Gather).
 *   - Signature is enforced by the shared router middleware (unsigned → 403).
 */

import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import twilio from 'twilio';
import { createTelephonyRouter } from '../../src/routes/telephony';
import { TwilioGatherAdapter } from '../../src/telephony/twilio-adapter';
import { VoiceSessionStore } from '../../src/ai/agents/customer-calling/voice-session-store';
import type { LLMGateway, LLMResponse } from '../../src/ai/gateway/gateway';
import { InMemoryAuditRepository } from '../../src/audit/audit';

const AUTH_TOKEN = 'test-fallback-token';
const PUBLIC_BASE_URL = 'https://api.test';

function makeFakeAdapter() {
  const handleInbound = vi.fn().mockResolvedValue(
    `<?xml version="1.0" encoding="UTF-8"?><Response><Gather/></Response>`,
  );
  return {
    adapter: {
      handleInbound,
      handleInboundForStream: vi.fn(),
      handleGather: vi.fn(),
      takePendingTransferTwiml: vi.fn(() => undefined),
    } as unknown as Parameters<typeof createTelephonyRouter>[0]['adapter'],
    handleInbound,
  };
}

function signedFallbackPost(app: express.Application, params: Record<string, string>) {
  const url = `${PUBLIC_BASE_URL}/api/telephony/voice/gather-fallback`;
  const sig = twilio.getExpectedTwilioSignature(AUTH_TOKEN, url, params);
  return request(app)
    .post('/api/telephony/voice/gather-fallback')
    .set('X-Twilio-Signature', sig)
    .type('form')
    .send(params);
}

function mountApp(opts: {
  adapter: Parameters<typeof createTelephonyRouter>[0]['adapter'];
  voiceSessionStore?: VoiceSessionStore;
  auditRepo?: InMemoryAuditRepository;
}) {
  const app = express();
  app.use(
    '/api/telephony',
    createTelephonyRouter({
      adapter: opts.adapter,
      authTokenGetter: () => AUTH_TOKEN,
      publicBaseUrl: PUBLIC_BASE_URL,
      resolveTenantId: () => 'tenant-1',
      ...(opts.voiceSessionStore ? { voiceSessionStore: opts.voiceSessionStore } : {}),
      ...(opts.auditRepo ? { auditRepo: opts.auditRepo } : {}),
      businessName: 'Test Co',
    }),
  );
  return app;
}

describe('WS7 POST /voice/gather-fallback', () => {
  it('known CallSid → Gather TwiML continuing the SAME session (no <Stream>)', async () => {
    const store = new VoiceSessionStore({ startInterval: false });
    const session = store.create('tenant-1', 'telephony', { callSid: 'CA-known' });
    const { adapter, handleInbound } = makeFakeAdapter();
    const app = mountApp({ adapter, voiceSessionStore: store });

    const res = await signedFallbackPost(app, {
      CallSid: 'CA-known',
      From: '+15125550100',
      To: '+15125550999',
    });

    expect(res.status).toBe(200);
    expect(res.text).toContain('<Gather');
    expect(res.text).toContain(`sid=${session.id}`);
    expect(res.text).toContain('/api/telephony/gather');
    expect(res.text).not.toContain('<Stream');
    // Existing session continued in-place — no fresh inbound session.
    expect(handleInbound).not.toHaveBeenCalled();
  });

  it('unknown CallSid → adapter.handleInbound (fresh Gather session)', async () => {
    const store = new VoiceSessionStore({ startInterval: false });
    const { adapter, handleInbound } = makeFakeAdapter();
    const app = mountApp({ adapter, voiceSessionStore: store });

    const res = await signedFallbackPost(app, {
      CallSid: 'CA-unknown',
      From: '+15125550100',
      To: '+15125550999',
    });

    expect(res.status).toBe(200);
    expect(handleInbound).toHaveBeenCalledTimes(1);
    expect(handleInbound).toHaveBeenCalledWith(
      expect.objectContaining({ callSid: 'CA-unknown', tenantId: 'tenant-1' }),
    );
    expect(res.text).not.toContain('<Stream');
  });

  it('no voiceSessionStore wired → treats CallSid as unknown (fresh Gather)', async () => {
    const { adapter, handleInbound } = makeFakeAdapter();
    const app = mountApp({ adapter });

    const res = await signedFallbackPost(app, {
      CallSid: 'CA-x',
      From: '+15125550100',
      To: '+15125550999',
    });

    expect(res.status).toBe(200);
    expect(handleInbound).toHaveBeenCalledTimes(1);
  });

  it('rejects an unsigned request (inherited signature middleware)', async () => {
    const store = new VoiceSessionStore({ startInterval: false });
    store.create('tenant-1', 'telephony', { callSid: 'CA-known' });
    const { adapter } = makeFakeAdapter();
    const app = mountApp({ adapter, voiceSessionStore: store });

    const res = await request(app)
      .post('/api/telephony/voice/gather-fallback')
      .type('form')
      .send({ CallSid: 'CA-known', From: '+15125550100', To: '+15125550999' });

    expect(res.status).toBe(403);
  });
});

// ─── WS7 — the degraded session is actually CONTINUABLE over Gather ─────────

const TENANT = 'tenant-1';

function makeGateway(content: string): LLMGateway {
  const response: LLMResponse = {
    content,
    model: 'mock',
    provider: 'mock',
    tokenUsage: { input: 1, output: 1, total: 2 },
    latencyMs: 1,
  };
  return { complete: vi.fn().mockResolvedValue(response) } as unknown as LLMGateway;
}

function signedPost(app: express.Application, path: string, params: Record<string, string>) {
  const url = `${PUBLIC_BASE_URL}${path}`;
  const sig = twilio.getExpectedTwilioSignature(AUTH_TOKEN, url, params);
  return request(app).post(path).set('X-Twilio-Signature', sig).type('form').send(params);
}

/** Real adapter + store harness, mirroring telephony-routes.test.ts. */
function realHarness() {
  const store = new VoiceSessionStore({ startInterval: false });
  const gateway = makeGateway(
    JSON.stringify({
      intentType: 'draft_estimate',
      confidence: 0.91,
      reasoning: 'clear command',
      extractedEntities: {},
    }),
  );
  const adapter = new TwilioGatherAdapter({
    store,
    gateway,
    businessName: 'Test Co',
    publicBaseUrl: PUBLIC_BASE_URL,
  });
  const app = mountApp({ adapter, voiceSessionStore: store });
  return { app, store, adapter };
}

/**
 * Establish a session exactly as the media-streams path does:
 * handleInboundForStream creates it, initializeStreamSession runs the
 * disclosure/greeting/caller-ID FSM bootstrap (same one the WS adapter
 * invokes after Deepgram opens), and caller_known lands it in
 * intent_capture (no DB pool → ask_caller, mirroring the existing
 * twilio-adapter test pattern).
 */
async function establishStreamSession(h: ReturnType<typeof realHarness>, callSid: string) {
  await h.adapter.handleInboundForStream({ callSid, from: '+15125550100', tenantId: TENANT });
  await h.adapter.initializeStreamSession({ callSid, tenantId: TENANT });
  const session = h.store.findByCallSid(callSid)!;
  if (session.machine.currentState === 'ask_caller') {
    session.machine.dispatch({ type: 'caller_known', customerId: 'cust-1' });
  }
  return session;
}

describe('WS7 — full continued turn after degrade (stream session → Gather)', () => {
  it('fallback TwiML → POST /gather with a SpeechResult → shared turn processor drives the SAME FSM', async () => {
    const h = realHarness();
    const session = await establishStreamSession(h, 'CA-cont');

    // 1. Mid-call degrade: Twilio re-requests TwiML from the fallback route.
    const fallback = await signedFallbackPost(h.app, {
      CallSid: 'CA-cont',
      From: '+15125550100',
      To: '+15125550999',
    });
    expect(fallback.status).toBe(200);
    expect(fallback.text).toContain('<Gather');
    expect(fallback.text).toContain(`sid=${session.id}`);
    expect(fallback.text).not.toContain('<Stream');

    // 2. The caller speaks into the continued Gather leg.
    const path = `/api/telephony/gather?sid=${session.id}`;
    const res = await signedPost(h.app, path, {
      CallSid: 'CA-cont',
      SpeechResult: 'Create an invoice for Acme for 450 dollars',
      Confidence: '0.93',
      From: '+15125550100',
      To: '+15125550999',
    });

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/xml/);
    // Classified by the shared processor → readback confirm on the SAME FSM.
    expect(res.text).toMatch(/<Say.*confirm/i);
    expect(res.text).not.toContain('<Stream');
    expect(session.machine.currentState).toBe('intent_confirm');
    // The caller turn landed on the continued session's transcript.
    expect(session.transcript.some((t) => t.includes('Create an invoice'))).toBe(true);
  });

  it('the trailing <Redirect> silence re-POST (empty SpeechResult) reprompts gracefully', async () => {
    const h = realHarness();
    const session = await establishStreamSession(h, 'CA-cont-silence');

    await signedFallbackPost(h.app, {
      CallSid: 'CA-cont-silence',
      From: '+15125550100',
      To: '+15125550999',
    });

    const path = `/api/telephony/gather?sid=${session.id}`;
    const res = await signedPost(h.app, path, {
      CallSid: 'CA-cont-silence',
      SpeechResult: '',
      Confidence: '0',
      From: '+15125550100',
      To: '+15125550999',
    });

    // Empty speech maps to confidence_low → bounded reprompt, never a 5xx
    // and never a hangup of the live caller.
    expect(res.status).toBe(200);
    expect(res.text).toContain('<Gather');
    expect(res.text).not.toContain('<Stream');
    expect(session.ended).toBe(false);
  });
});

// ─── PRIV-4 (review round 1) — a degrade before the greeting was heard ──────

const NOTICE = "Just so you know, I'm a virtual assistant, not a live person.";
const RECORDING_NOTICE =
  'This call may be recorded for quality and training purposes. By continuing, you consent to this recording.';

/** The <Say> verbs spoken BEFORE the <Gather> opens (the preamble). */
function preambleOf(twiml: string): string {
  const head = twiml.slice(0, twiml.indexOf('<Gather'));
  return [...head.matchAll(/<Say[^>]*>([^<]*)<\/Say>/g)].map((m) => m[1]).join(' ').replace(/&apos;/g, "'");
}

async function noticeRows(audit: InMemoryAuditRepository, tenantId: string, sessionId: string) {
  return (await audit.findByEntity(tenantId, 'voice_session', sessionId)).filter(
    (e) => e.eventType === 'virtual_assistant_notice.played',
  );
}

describe('PRIV-4 (review round 1) — the Gather fallback tells the caller they are talking to an assistant', () => {
  it('a degrade before establishment (STT never opened) speaks the assistant notice and the recording notice before the Gather, and ledgers the notice', async () => {
    const store = new VoiceSessionStore({ startInterval: false });
    const session = store.create(TENANT, 'telephony', { callSid: 'CA-degrade-early' });
    const audit = new InMemoryAuditRepository();
    const { adapter } = makeFakeAdapter();
    const app = mountApp({ adapter, voiceSessionStore: store, auditRepo: audit });

    const res = await signedFallbackPost(app, { CallSid: 'CA-degrade-early', From: '+15125550100', To: '+15125550999' });

    expect(res.status).toBe(200);
    expect(preambleOf(res.text)).toBe(`${NOTICE} ${RECORDING_NOTICE}`);
    const rows = await noticeRows(audit, TENANT, session.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].metadata).toMatchObject({ text: NOTICE, language: 'en' });
  });

  it('a degrade mid-greeting (recording notice latched, greeting never heard) still speaks the assistant notice', async () => {
    const h = realHarness();
    const audit = new InMemoryAuditRepository();
    const app = mountApp({ adapter: h.adapter, voiceSessionStore: h.store, auditRepo: audit });
    // Establishment ran (the greeting is queued) but the stream dropped before
    // its playback finished, so the point-of-evidence commit never ran.
    const session = await establishStreamSession(h, 'CA-degrade-mid');
    expect(session.recordingDisclosed).toBe(true);

    const res = await signedFallbackPost(app, { CallSid: 'CA-degrade-mid', From: '+15125550100', To: '+15125550999' });

    expect(preambleOf(res.text)).toBe(NOTICE);
    expect(await noticeRows(audit, TENANT, session.id)).toHaveLength(1);
  });

  it('a degrade after the greeting played speaks no notice again, and a second degrade never repeats it', async () => {
    const h = realHarness();
    const audit = new InMemoryAuditRepository();
    const app = mountApp({ adapter: h.adapter, voiceSessionStore: h.store, auditRepo: audit });
    const session = await establishStreamSession(h, 'CA-degrade-late');
    // The stream transport's point of evidence: the greeting finished playing.
    await h.adapter.commitRecordingConsent({ callSid: 'CA-degrade-late' });

    const first = await signedFallbackPost(app, { CallSid: 'CA-degrade-late', From: '+15125550100', To: '+15125550999' });
    expect(preambleOf(first.text)).toBe('');

    const early = h.store.create(TENANT, 'telephony', { callSid: 'CA-degrade-twice' });
    await signedFallbackPost(app, { CallSid: 'CA-degrade-twice', From: '+15125550100', To: '+15125550999' });
    const again = await signedFallbackPost(app, { CallSid: 'CA-degrade-twice', From: '+15125550100', To: '+15125550999' });
    expect(preambleOf(again.text)).toBe('');
    expect(await noticeRows(audit, TENANT, early.id)).toHaveLength(1);
    expect(await noticeRows(audit, TENANT, session.id)).toHaveLength(0);
  });
});
