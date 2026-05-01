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
