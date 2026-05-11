/**
 * HTTP round-trip test for the Twilio telephony router.
 *
 * Builds a real Express app + signed Twilio request → exercises
 * `requireTwilioSignature` and the adapter end-to-end.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import twilio from 'twilio';
import { createTelephonyRouter } from '../../src/routes/telephony';
import { TwilioGatherAdapter } from '../../src/telephony/twilio-adapter';
import { VoiceSessionStore } from '../../src/ai/agents/customer-calling/voice-session-store';
import type { LLMGateway, LLMResponse } from '../../src/ai/gateway/gateway';
import { DefaultTwilioCallControl } from '../../src/telephony/twilio-call-control';
import {
  InMemoryOnCallRepository,
  type OnCallEntry,
} from '../../src/oncall/rotation';
import { InMemoryAuditRepository } from '../../src/audit/audit';
import { InMemoryProposalRepository } from '../../src/proposals/proposal';
import { InMemoryVoiceSessionRepository } from '../../src/voice/voice-session';

const AUTH_TOKEN = 'test-tw-token-xyz';
const PUBLIC_BASE_URL = 'https://api.test';
const TENANT_ID = 'tenant-routes-test';

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

function buildHarness() {
  const store = new VoiceSessionStore();
  const gateway = makeGateway(
    JSON.stringify({
      intentType: 'create_invoice',
      confidence: 0.91,
      reasoning: 'clear command',
      extractedEntities: {},
    })
  );
  const adapter = new TwilioGatherAdapter({
    store,
    gateway,
    businessName: 'Test Co',
    publicBaseUrl: PUBLIC_BASE_URL,
  });

  const app = express();
  app.use(
    '/api/telephony',
    createTelephonyRouter({
      adapter,
      authTokenGetter: () => AUTH_TOKEN,
      publicBaseUrl: PUBLIC_BASE_URL,
      resolveTenantId: () => TENANT_ID,
    }),
  );
  return { app, store, gateway };
}

function signedRequest(
  app: express.Application,
  path: string,
  params: Record<string, string>,
) {
  const url = `${PUBLIC_BASE_URL}${path}`;
  const sig = twilio.getExpectedTwilioSignature(AUTH_TOKEN, url, params);
  return request(app)
    .post(path)
    .set('X-Twilio-Signature', sig)
    .type('form')
    .send(params);
}

describe('POST /api/telephony/voice', () => {
  it('rejects unsigned requests with 403', async () => {
    const { app } = buildHarness();
    const res = await request(app)
      .post('/api/telephony/voice')
      .type('form')
      .send({ CallSid: 'CA1', From: '+15125550100', To: '+15125550999' });
    expect(res.status).toBe(403);
  });

  it('accepts signed inbound webhook and returns TwiML', async () => {
    const { app, store } = buildHarness();
    const res = await signedRequest(app, '/api/telephony/voice', {
      CallSid: 'CA-route-1',
      From: '+15125550100',
      To: '+15125550999',
    });

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/xml/);
    expect(res.text).toContain('<Response');
    expect(res.text).toContain('<Gather');
    expect(res.text).toContain(`action="${PUBLIC_BASE_URL}/api/telephony/gather?sid=`);

    // Session was created.
    const ids = Array.from(
      (store as unknown as { sessions: Map<string, unknown> }).sessions.keys()
    );
    expect(ids).toHaveLength(1);
  });

  it('rejects requests missing CallSid/From/To with 400', async () => {
    const { app } = buildHarness();
    const res = await signedRequest(app, '/api/telephony/voice', {
      CallSid: 'CA1',
      // From, To missing
    });
    expect(res.status).toBe(400);
  });
});

describe('POST /api/telephony/gather', () => {
  let app: express.Application;
  let store: VoiceSessionStore;
  let sessionId: string;

  beforeEach(async () => {
    const harness = buildHarness();
    app = harness.app;
    store = harness.store;
    // Drive an inbound call to create a session.
    await signedRequest(app, '/api/telephony/voice', {
      CallSid: 'CA-rt-2',
      From: '+15125550100',
      To: '+15125550999',
    });
    const ids = Array.from(
      (store as unknown as { sessions: Map<string, unknown> }).sessions.keys()
    );
    sessionId = ids[0] as string;

    // Force into intent_capture so classification fires.
    const sess = await store.get(sessionId);
    if (sess && sess.machine.currentState === 'ask_caller') {
      sess.machine.dispatch({ type: 'caller_known', customerId: 'cust-1' });
    }
  });

  it('rejects unsigned gather requests with 403', async () => {
    const res = await request(app)
      .post(`/api/telephony/gather?sid=${sessionId}`)
      .type('form')
      .send({ CallSid: 'CA-rt-2', SpeechResult: 'hi', Confidence: '0.9' });
    expect(res.status).toBe(403);
  });

  it('round-trips a Gather speech callback', async () => {
    // Need to sign the URL exactly as the route is mounted (with query string).
    const path = `/api/telephony/gather?sid=${sessionId}`;
    const url = `${PUBLIC_BASE_URL}${path}`;
    const params = {
      CallSid: 'CA-rt-2',
      SpeechResult: 'Create an invoice for Acme for 450 dollars',
      Confidence: '0.93',
      From: '+15125550100',
      To: '+15125550999',
    };
    const sig = twilio.getExpectedTwilioSignature(AUTH_TOKEN, url, params);

    const res = await request(app)
      .post(path)
      .set('X-Twilio-Signature', sig)
      .type('form')
      .send(params);

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/xml/);
    expect(res.text).toContain('<Response');
    // After classification, we'll be in intent_confirm with a readback Say.
    expect(res.text).toMatch(/<Say.*confirm/i);

    const snap = await store.snapshot(sessionId);
    expect(snap?.state).toBe('intent_confirm');
  });

  it('400s when sid query param is missing', async () => {
    const path = '/api/telephony/gather';
    const url = `${PUBLIC_BASE_URL}${path}`;
    const params = { CallSid: 'CA-rt-2', SpeechResult: 'hi', Confidence: '0.9' };
    const sig = twilio.getExpectedTwilioSignature(AUTH_TOKEN, url, params);

    const res = await request(app)
      .post(path)
      .set('X-Twilio-Signature', sig)
      .type('form')
      .send(params);

    expect(res.status).toBe(400);
  });
});

// ─── P8-013 — POST /api/telephony/dial-result ────────────────────────────────

interface DialHarness {
  app: express.Application;
  store: VoiceSessionStore;
  adapter: TwilioGatherAdapter;
  callControl: DefaultTwilioCallControl;
  onCallRepo: InMemoryOnCallRepository;
  auditRepo: InMemoryAuditRepository;
  proposalRepo: InMemoryProposalRepository;
  voiceSessionRepo: InMemoryVoiceSessionRepository;
  resolver: ReturnType<typeof vi.fn>;
}

function makeRotation(entries: OnCallEntry[]): InMemoryOnCallRepository {
  return new InMemoryOnCallRepository(new Map([[TENANT_ID, entries]]));
}

function buildDialHarness(opts: {
  rotation: OnCallEntry[];
  phones: Record<string, string | null>;
}): DialHarness {
  const store = new VoiceSessionStore({ startInterval: false });
  const gateway = makeGateway('{"intentType":"unknown","confidence":0,"reasoning":"x"}');
  const onCallRepo = makeRotation(opts.rotation);
  const auditRepo = new InMemoryAuditRepository();
  const proposalRepo = new InMemoryProposalRepository();
  const callControl = new DefaultTwilioCallControl();
  const voiceSessionRepo = new InMemoryVoiceSessionRepository();
  const resolver = vi.fn(async (_t: string, userId: string) => opts.phones[userId] ?? null);

  const adapter = new TwilioGatherAdapter({
    store,
    gateway,
    businessName: 'Acme Plumbing',
    publicBaseUrl: PUBLIC_BASE_URL,
    callControl,
    dispatcherPhoneResolver: resolver,
    onCallRepo,
    auditRepo,
    proposalRepo,
    voiceSessionRepo,
  });

  const app = express();
  app.use(
    '/api/telephony',
    createTelephonyRouter({
      adapter,
      authTokenGetter: () => AUTH_TOKEN,
      publicBaseUrl: PUBLIC_BASE_URL,
      resolveTenantId: () => TENANT_ID,
      businessName: 'Acme Plumbing',
    }),
  );
  return {
    app,
    store,
    adapter,
    callControl,
    onCallRepo,
    auditRepo,
    proposalRepo,
    voiceSessionRepo,
    resolver,
  };
}

function signDialResult(
  app: express.Application,
  sessionId: string,
  params: Record<string, string>,
) {
  const path = `/api/telephony/dial-result?sid=${sessionId}`;
  const url = `${PUBLIC_BASE_URL}${path}`;
  const sig = twilio.getExpectedTwilioSignature(AUTH_TOKEN, url, params);
  return request(app)
    .post(path)
    .set('X-Twilio-Signature', sig)
    .type('form')
    .send(params);
}

describe('P8-013 POST /api/telephony/dial-result', () => {
  it('rejects unsigned dial-result requests with 403', async () => {
    const { app, store } = buildDialHarness({
      rotation: [{ id: 'r1', userId: 'u1', orderIndex: 0 }],
      phones: { u1: '+15125550101' },
    });
    const session = store.create(TENANT_ID, 'telephony', { callSid: 'CA-x' });
    const res = await request(app)
      .post(`/api/telephony/dial-result?sid=${session.id}`)
      .type('form')
      .send({ CallSid: 'CA-x', DialCallStatus: 'no-answer' });
    expect(res.status).toBe(403);
  });

  it('400s when sid query param is missing', async () => {
    const { app } = buildDialHarness({
      rotation: [],
      phones: {},
    });
    const path = '/api/telephony/dial-result';
    const url = `${PUBLIC_BASE_URL}${path}`;
    const params = { CallSid: 'CA-x', DialCallStatus: 'no-answer' };
    const sig = twilio.getExpectedTwilioSignature(AUTH_TOKEN, url, params);
    const res = await request(app)
      .post(path)
      .set('X-Twilio-Signature', sig)
      .type('form')
      .send(params);
    expect(res.status).toBe(400);
  });

  it('on no-answer, advances to next rotation entry and returns <Dial> for them', async () => {
    const { app, store, resolver, callControl } = buildDialHarness({
      rotation: [
        { id: 'r1', userId: 'u1', orderIndex: 0 },
        { id: 'r2', userId: 'u2', orderIndex: 1 },
      ],
      phones: { u1: '+15125550101', u2: '+15125550102' },
    });
    const session = store.create(TENANT_ID, 'telephony', { callSid: 'CA-cascade' });
    // Drive FSM into escalating so any dispatched proposal_queued lands cleanly.
    session.machine.dispatch({
      type: 'incoming_call',
      callSid: 'CA-cascade',
      from: '+15125550100',
      to: '+15125550999',
      tenantId: TENANT_ID,
    });
    session.machine.dispatch({ type: 'caller_identification_failed', reason: 'x' });
    // Simulate "u1 was already chosen and dialed by the prior
    // notify_oncall pass" — in production handleNotifyOncall calls
    // setCursorAfter when picking. The test bypasses handleNotifyOncall
    // by driving the FSM directly, so stamp the cursor explicitly.
    callControl.setCursorAfter(session.id, 0);

    const res = await signDialResult(app, session.id, {
      CallSid: 'CA-cascade',
      DialCallStatus: 'no-answer',
      From: '+15125550100',
      To: '+15125550999',
    });

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/xml/);
    expect(res.text).toContain('<Dial');
    // Next entry's phone (u2) should appear; first entry's must NOT be the only one.
    expect(res.text).toContain('+15125550102');
    // The resolver must have been queried for u2 specifically.
    const calledUsers = resolver.mock.calls.map((c) => c[1]);
    expect(calledUsers).toContain('u2');
  });

  it('on full rotation exhaustion, queues customer_callback_required proposal + audit and plays "we will call you back"', async () => {
    const { app, store, auditRepo, proposalRepo, callControl } = buildDialHarness({
      rotation: [{ id: 'r1', userId: 'u1', orderIndex: 0 }],
      phones: { u1: '+15125550101' },
    });
    const session = store.create(TENANT_ID, 'telephony', { callSid: 'CA-exh' });
    session.machine.dispatch({
      type: 'incoming_call',
      callSid: 'CA-exh',
      from: '+15125550100',
      to: '+15125550999',
      tenantId: TENANT_ID,
    });
    session.machine.dispatch({ type: 'caller_identification_failed', reason: 'x' });
    // Simulate u1 already-attempted via notify_oncall path.
    callControl.setCursorAfter(session.id, 0);

    const res = await signDialResult(app, session.id, {
      CallSid: 'CA-exh',
      DialCallStatus: 'no-answer',
      From: '+15125550100',
      To: '+15125550999',
    });

    expect(res.status).toBe(200);
    expect(res.text).toMatch(/Acme Plumbing/);
    expect(res.text).toMatch(/call you back/i);
    expect(res.text).toContain('<Hangup');

    // Proposal queued.
    const proposals = await proposalRepo.findByTenant(TENANT_ID);
    const callback = proposals.find((p) =>
      typeof (p.payload as Record<string, unknown>).intent === 'string' &&
      (p.payload as Record<string, unknown>).intent === 'customer_callback_required'
    );
    expect(callback).toBeDefined();
    expect(callback?.proposalType).toBe('voice_clarification');

    // Audit event for the callback.
    const audits = auditRepo.getAll();
    expect(audits.some((e) => e.eventType === 'customer_callback_required')).toBe(true);
  });

  it('on completed dial, hangs up our IVR leg without queueing a callback', async () => {
    const { app, store, proposalRepo } = buildDialHarness({
      rotation: [{ id: 'r1', userId: 'u1', orderIndex: 0 }],
      phones: { u1: '+15125550101' },
    });
    const session = store.create(TENANT_ID, 'telephony', { callSid: 'CA-ok' });
    session.machine.dispatch({
      type: 'incoming_call',
      callSid: 'CA-ok',
      from: '+15125550100',
      to: '+15125550999',
      tenantId: TENANT_ID,
    });
    session.machine.dispatch({ type: 'caller_identification_failed', reason: 'x' });

    const res = await signDialResult(app, session.id, {
      CallSid: 'CA-ok',
      DialCallStatus: 'completed',
      From: '+15125550100',
      To: '+15125550999',
    });

    expect(res.status).toBe(200);
    expect(res.text).toContain('<Hangup');
    expect(res.text).not.toMatch(/call you back/i);
    expect(res.text).not.toContain('<Dial');

    const proposals = await proposalRepo.findByTenant(TENANT_ID);
    expect(proposals).toHaveLength(0);
  });

  it('cascade: dispatcher 1 no-answer → dispatcher 2 dialed → dispatcher 2 no-answer → callback', async () => {
    const { app, store, proposalRepo, auditRepo, callControl } = buildDialHarness({
      rotation: [
        { id: 'r1', userId: 'u1', orderIndex: 0 },
        { id: 'r2', userId: 'u2', orderIndex: 1 },
      ],
      phones: { u1: '+15125550101', u2: '+15125550102' },
    });
    const session = store.create(TENANT_ID, 'telephony', { callSid: 'CA-full' });
    session.machine.dispatch({
      type: 'incoming_call',
      callSid: 'CA-full',
      from: '+15125550100',
      to: '+15125550999',
      tenantId: TENANT_ID,
    });
    session.machine.dispatch({ type: 'caller_identification_failed', reason: 'x' });
    // Simulate u1 already-attempted via notify_oncall path.
    callControl.setCursorAfter(session.id, 0);

    // First no-answer → cascade to u2.
    const res1 = await signDialResult(app, session.id, {
      CallSid: 'CA-full',
      DialCallStatus: 'no-answer',
      From: '+15125550100',
      To: '+15125550999',
    });
    expect(res1.text).toContain('<Dial');
    expect(res1.text).toContain('+15125550102');

    // Second no-answer (u2) → exhausted; queue callback.
    const res2 = await signDialResult(app, session.id, {
      CallSid: 'CA-full',
      DialCallStatus: 'no-answer',
      From: '+15125550100',
      To: '+15125550999',
    });
    expect(res2.text).toMatch(/call you back/i);
    expect(res2.text).toContain('Acme Plumbing');
    expect(res2.text).toContain('<Hangup');

    const proposals = await proposalRepo.findByTenant(TENANT_ID);
    const cb = proposals.find(
      (p) =>
        typeof (p.payload as Record<string, unknown>).intent === 'string' &&
        (p.payload as Record<string, unknown>).intent === 'customer_callback_required'
    );
    expect(cb).toBeDefined();
    expect(auditRepo.getAll().some((e) => e.eventType === 'customer_callback_required')).toBe(
      true,
    );
  });

  // ─── B2: voice_sessions outcome stamping at dial-result terminals ─────────

  it('B2: dial completed → stamps voice_sessions.outcome=completed', async () => {
    const { app, store, voiceSessionRepo } = buildDialHarness({
      rotation: [{ id: 'r1', userId: 'u1', orderIndex: 0 }],
      phones: { u1: '+15125550101' },
    });
    const session = store.create(TENANT_ID, 'telephony', { callSid: 'CA-stamp-ok' });
    await voiceSessionRepo.create({
      id: session.id,
      tenantId: TENANT_ID,
      channel: 'voice_inbound',
      callSid: 'CA-stamp-ok',
      state: session.machine.currentState,
    });
    session.machine.dispatch({
      type: 'incoming_call',
      callSid: 'CA-stamp-ok',
      from: '+15125550100',
      to: '+15125550999',
      tenantId: TENANT_ID,
    });
    session.machine.dispatch({ type: 'caller_identification_failed', reason: 'x' });

    await signDialResult(app, session.id, {
      CallSid: 'CA-stamp-ok',
      DialCallStatus: 'completed',
      From: '+15125550100',
      To: '+15125550999',
    });
    // Wait for the fire-and-forget markEnded to complete.
    await new Promise((resolve) => setImmediate(resolve));

    const row = await voiceSessionRepo.findById(TENANT_ID, session.id);
    expect(row?.outcome).toBe('completed');
    expect(row?.endedReason).toBe('transferred');
    expect(row?.endedAt).toBeInstanceOf(Date);
  });

  it('B2: rotation exhausted → stamps voice_sessions.outcome=callback_required', async () => {
    const { app, store, voiceSessionRepo, callControl } = buildDialHarness({
      rotation: [{ id: 'r1', userId: 'u1', orderIndex: 0 }],
      phones: { u1: '+15125550101' },
    });
    const session = store.create(TENANT_ID, 'telephony', { callSid: 'CA-stamp-cb' });
    await voiceSessionRepo.create({
      id: session.id,
      tenantId: TENANT_ID,
      channel: 'voice_inbound',
      callSid: 'CA-stamp-cb',
      state: session.machine.currentState,
    });
    session.machine.dispatch({
      type: 'incoming_call',
      callSid: 'CA-stamp-cb',
      from: '+15125550100',
      to: '+15125550999',
      tenantId: TENANT_ID,
    });
    session.machine.dispatch({ type: 'caller_identification_failed', reason: 'x' });
    // Simulate u1 already attempted via notify_oncall, so cascade lookup
    // walks past r1 and falls through to queueCallbackProposal.
    callControl.setCursorAfter(session.id, 0);

    const res = await signDialResult(app, session.id, {
      CallSid: 'CA-stamp-cb',
      DialCallStatus: 'no-answer',
      From: '+15125550100',
      To: '+15125550999',
    });
    expect(res.text).toMatch(/call you back/i);
    // Wait for the fire-and-forget markEnded to complete.
    await new Promise((resolve) => setImmediate(resolve));

    const row = await voiceSessionRepo.findById(TENANT_ID, session.id);
    expect(row?.outcome).toBe('callback_required');
    expect(row?.endedReason).toBe('normal_close');
    expect(row?.endedAt).toBeInstanceOf(Date);
  });
});

// ─── P8-014: POST /api/telephony/recording wiring ────────────────────────────

describe('POST /api/telephony/recording (P8-014 record_call)', () => {
  // recordInboundCall calls setTenantContext, which validates UUID format,
  // so this scenario uses a real UUID instead of the harness's symbolic id.
  const TENANT_UUID = '00000000-0000-0000-0000-000000000aaa';

  it('is mounted by createTelephonyRouter when `recording` deps are provided', async () => {
    const store = new VoiceSessionStore();
    const session = store.create(TENANT_UUID, 'telephony', { callSid: 'CA-route-rec' });
    expect(session.tenantId).toBe(TENANT_UUID);

    const gateway = makeGateway('{"intentType":"unknown","confidence":0,"reasoning":"x"}');
    const adapter = new TwilioGatherAdapter({
      store,
      gateway,
      businessName: 'Test Co',
      publicBaseUrl: PUBLIC_BASE_URL,
      recordingCallbackPath: '/api/telephony/recording',
    });

    let uploadedKey: string | null = null;
    const fakeStorage = {
      generateUploadUrl: async (
        bucket: string,
        key: string,
        contentType: string,
      ): Promise<string> => {
        uploadedKey = key;
        void bucket;
        void contentType;
        return 'https://s3.fake/upload';
      },
      generateDownloadUrl: async () => 'https://s3.fake/download',
      getObjectMetadata: async () => null,
      deleteObject: async () => undefined,
    };

    const fakePool = {
      connect: async () => ({
        query: async (sql: string) => {
          if (/SELECT id FROM voice_recordings/i.test(sql)) {
            return { rows: [] };
          }
          return { rows: [] };
        },
        release: () => undefined,
      }),
    } as unknown as import('pg').Pool;

    const fetchRecording = async () => Buffer.from('mp3-bytes');
    const uploadObject = async () => undefined;

    const app = express();
    app.use(
      '/api/telephony',
      createTelephonyRouter({
        adapter,
        authTokenGetter: () => AUTH_TOKEN,
        publicBaseUrl: PUBLIC_BASE_URL,
        resolveTenantId: () => TENANT_UUID,
        recording: {
          store,
          pool: fakePool,
          storage: fakeStorage,
          storageBucket: 'serviceos-recordings',
          twilioAccountSid: 'ACtest',
          twilioAuthToken: 'auth-test',
          options: { fetchRecording, uploadObject },
        },
      }),
    );

    const path = '/api/telephony/recording';
    const url = `${PUBLIC_BASE_URL}${path}`;
    const params = {
      CallSid: 'CA-route-rec',
      RecordingSid: 'RE-route',
      RecordingUrl: 'https://api.twilio.com/2010-04-01/RE-route',
      RecordingDuration: '10',
    };
    const sig = twilio.getExpectedTwilioSignature(AUTH_TOKEN, url, params);

    const res = await request(app)
      .post(path)
      .set('X-Twilio-Signature', sig)
      .type('form')
      .send(params);

    expect(res.status).toBe(200);
    // The route reached the storage layer with a tenant-scoped key.
    expect(uploadedKey).toBe(`${TENANT_UUID}/CA-route-rec.mp3`);
  });

  it('returns 403 for an unsigned recording webhook delivery', async () => {
    const { app } = buildHarness();
    // No `recording` deps wired in buildHarness — but the parent router
    // still applies the signature middleware. An unsigned request
    // should be rejected before reaching any handler.
    const res = await request(app)
      .post('/api/telephony/recording')
      .type('form')
      .send({
        CallSid: 'CA1',
        RecordingSid: 'RE1',
        RecordingUrl: 'https://x',
        RecordingDuration: '0',
      });
    expect(res.status).toBe(403);
  });
});
