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
import { InMemoryVoiceSessionStore } from '../../src/telephony/voice-session-store';
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
  const store = new InMemoryVoiceSessionStore();
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
  let store: InMemoryVoiceSessionStore;
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
