/**
 * LCR-04 (review round 1) — under pool exhaustion a live Gather turn must
 * still answer well inside Twilio's ~15 s action timeout.
 *
 * Pool exhaustion does not reject a checkout: `pool.connect()` WAITS for a
 * free connection until connectionTimeoutMillis (5 s in prod, db/pool.ts) and
 * only then throws. Before this fix every /gather paid that wait four times:
 * the voicemail-status and recording sub-routers each ran their own signature
 * check on EVERY request (mounted with no path), each credential lookup read
 * its outage cache only after the 5 s throw, and the route then looked the
 * tenant up by DID again even though the live session knew it — about 20 s,
 * past Twilio's timeout, so the turn never proceeded.
 *
 * The real router, the real credential resolver and a pool whose checkout
 * hangs (rejecting only after a long "connection timeout"), with the
 * sub-routers mounted as app.ts mounts them.
 */
import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import twilio from 'twilio';
import type { Pool } from 'pg';
import { createTelephonyRouter } from '../../src/routes/telephony';
import { TwilioGatherAdapter } from '../../src/telephony/twilio-adapter';
import { VoiceSessionStore } from '../../src/ai/agents/customer-calling/voice-session-store';
import { createTwilioWebhookCredentialResolver } from '../../src/telephony/twilio-webhook-credential';
import { encrypt } from '../../src/integrations/crypto';
import type { LLMGateway } from '../../src/ai/gateway/gateway';
import type { StorageProvider } from '../../src/files/file-service';

const BASE = 'https://api.test';
const TENANT = 'tenant-lcr04-latency';
const SUBACCOUNT = 'AClcr04latency0000000000000000000';
const TOKEN = 'tenant-token-lcr04-latency';
const ENC_KEY = 'c'.repeat(64);
const FROM = '+15125550100';
const TO = '+15125550999';
/** The pool's "connectionTimeoutMillis" in this test: far past the bound below. */
const CHECKOUT_TIMEOUT_MS = 2_000;

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

/** A pool serving the tenant's integration row until `exhausted`, then checkouts wait and time out. */
function exhaustiblePool() {
  const state = { exhausted: false, checkouts: 0 };
  const row = {
    tenant_id: TENANT,
    subaccount_sid: SUBACCOUNT,
    auth_token_primary_enc: encrypt(TOKEN, ENC_KEY),
    auth_token_secondary_enc: null,
  };
  const client = {
    query: async (sql: string) => (/SELECT tenant_id/.test(sql) ? { rows: [row] } : { rows: [] }),
    release: () => undefined,
  };
  const pool = {
    connect: () => {
      state.checkouts += 1;
      if (!state.exhausted) return Promise.resolve(client);
      return new Promise((_resolve, reject) => {
        setTimeout(() => reject(new Error('timeout exceeded when trying to connect')), CHECKOUT_TIMEOUT_MS);
      });
    },
  } as unknown as Pool;
  return { pool, state };
}

function mount() {
  const { pool, state } = exhaustiblePool();
  const store = new VoiceSessionStore({ startInterval: false });
  const adapter = new TwilioGatherAdapter({ store, gateway: gateway(), businessName: 'Acme', publicBaseUrl: BASE });
  const repoState = { exhausted: false };
  const phoneNumberRepo = {
    findByNumber: vi.fn(() =>
      repoState.exhausted
        ? new Promise((_r, reject) => {
            setTimeout(() => reject(new Error('timeout exceeded')), CHECKOUT_TIMEOUT_MS);
          })
        : Promise.resolve({ tenantId: TENANT }),
    ),
  };
  const authTokenGetter = createTwilioWebhookCredentialResolver({
    pool,
    env: () => ({ TENANT_ENCRYPTION_KEY: ENC_KEY }) as NodeJS.ProcessEnv,
  });
  const app = express();
  app.use(
    '/api/telephony',
    createTelephonyRouter({
      adapter,
      authTokenGetter,
      publicBaseUrl: BASE,
      resolveTenantId: () => undefined,
      businessName: 'Acme',
      nodeEnv: 'production',
      voiceSessionStore: store,
      phoneNumberRepo: phoneNumberRepo as never,
      // Mounted as app.ts mounts them: both sub-routers sit in front of the
      // shared signature middleware.
      recording: {
        store,
        storage: {} as StorageProvider,
        storageBucket: 'serviceos-recordings',
      },
    }),
  );
  const exhaust = () => {
    state.exhausted = true;
    repoState.exhausted = true;
  };
  return { app, store, adapter, state, exhaust, phoneNumberRepo };
}

function signed(app: express.Application, path: string, params: Record<string, string>) {
  const sig = twilio.getExpectedTwilioSignature(TOKEN, `${BASE}${path}`, params);
  return request(app).post(path).set('X-Twilio-Signature', sig).type('form').send(params);
}

describe('LCR-04 — a live Gather turn under pool exhaustion', () => {
  it('runs the credential check once, answers from the cache within its bound, and carries the turn on the session', async () => {
    const h = mount();
    // The call was answered before the pool filled up (this primes the cache).
    const voice = await signed(h.app, '/api/telephony/voice', {
      CallSid: 'CA-lat-1',
      AccountSid: SUBACCOUNT,
      From: FROM,
      To: TO,
    });
    expect(voice.status).toBe(200);
    const session = h.store.findByCallSid('CA-lat-1')!;
    expect(session).toBeDefined();

    h.exhaust();
    h.state.checkouts = 0;
    const handleGather = vi.spyOn(h.adapter, 'handleGather').mockResolvedValue('<Response><Gather/></Response>');
    const lookupsBefore = h.phoneNumberRepo.findByNumber.mock.calls.length;
    const started = Date.now();
    const res = await signed(h.app, `/api/telephony/gather?sid=${session.id}`, {
      CallSid: 'CA-lat-1',
      AccountSid: SUBACCOUNT,
      From: FROM,
      To: TO,
      SpeechResult: 'my furnace stopped',
      Confidence: '0.9',
    });
    const elapsed = Date.now() - started;

    expect(res.status).toBe(200);
    expect(handleGather).toHaveBeenCalledWith(expect.objectContaining({ sessionId: session.id, tenantId: TENANT }));
    // One credential check, cut short by the lookup bound — not one per
    // sub-router, each waiting out the checkout timeout.
    expect(h.state.checkouts).toBe(1);
    expect(elapsed).toBeLessThan(CHECKOUT_TIMEOUT_MS);
    // The live session already knows its tenant: no DID lookup behind it.
    expect(h.phoneNumberRepo.findByNumber.mock.calls.length).toBe(lookupsBefore);
  });

  it('/dial-result for a live session carries on the session the same way', async () => {
    const h = mount();
    await signed(h.app, '/api/telephony/voice', { CallSid: 'CA-lat-2', AccountSid: SUBACCOUNT, From: FROM, To: TO });
    const session = h.store.findByCallSid('CA-lat-2')!;

    h.exhaust();
    h.state.checkouts = 0;
    const started = Date.now();
    const res = await signed(h.app, `/api/telephony/dial-result?sid=${session.id}`, {
      CallSid: 'CA-lat-2',
      AccountSid: SUBACCOUNT,
      From: FROM,
      To: TO,
      DialCallStatus: 'completed',
    });
    expect(res.status).toBe(200);
    expect(Date.now() - started).toBeLessThan(CHECKOUT_TIMEOUT_MS);
    expect(h.state.checkouts).toBe(1);
    expect(session.ended).toBe(true);
  });
});
