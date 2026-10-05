/**
 * #1595 — AI answering is the after-hours default; voicemail is opt-out.
 *
 * Owner decision 2026-10-04 (D-040): a tradesperson's after-hours emergency
 * must never land in a dead voicemail. The /voice webhook used to answer
 * every after-hours call with plain voicemail TwiML unless the tenant had
 * opted INTO `after_hours_voice_mode = 'ai_answering'`. These tests pin the
 * fork at the public seam — a signed Twilio POST /api/telephony/voice on a
 * tenant whose business hours say "closed":
 *
 *   (a) a tenant that never set the after-hours mode → the AI answers
 *       (adapter.handleInbound is called; no <Record>);
 *   (b) a tenant that explicitly chose 'voicemail' → voicemail TwiML
 *       (<Record> with the voicemail-status callback; the AI is never called);
 *   (c) the go-live gate still runs first — an after-hours call on a tenant
 *       that is not live gets the gate's voicemail, not the AI.
 */
import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import twilio from 'twilio';
import { createTelephonyRouter } from '../../src/routes/telephony';

const AUTH_TOKEN = 'test-tw-after-hours-token';
const PUBLIC_BASE_URL = 'https://api.test';
const TENANT_ID = '00000000-0000-4000-8000-000000001595';

/**
 * A schedule that is closed at every minute of every day: `open === close`
 * makes `localMinutes >= open && localMinutes < close` false for any clock,
 * so the test never depends on the wall time it runs at.
 */
const ALWAYS_CLOSED = Object.fromEntries(
  ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'].map((d) => [d, { open: '00:00', close: '00:00' }]),
);

type RouterDeps = Parameters<typeof createTelephonyRouter>[0];

function makeApp(opts: {
  escalationSettings?: Record<string, unknown>;
  voiceGate?: RouterDeps['voiceGate'];
}) {
  const handleInbound = vi.fn().mockResolvedValue('<Response><Gather/></Response>');
  const pool = {
    query: vi.fn(async () => ({
      rows: [{ business_hours: ALWAYS_CLOSED, timezone: 'UTC' }],
    })),
  };
  const settingsRepo = {
    findByTenant: async () => ({
      tenantId: TENANT_ID,
      ...(opts.escalationSettings ? { escalationSettings: opts.escalationSettings } : {}),
    }),
  };
  const app = express();
  app.use(
    '/api/telephony',
    createTelephonyRouter({
      adapter: {
        handleInbound,
        handleInboundForStream: vi.fn(),
        handleGather: vi.fn(),
      } as unknown as RouterDeps['adapter'],
      authTokenGetter: () => AUTH_TOKEN,
      publicBaseUrl: PUBLIC_BASE_URL,
      resolveTenantId: () => TENANT_ID,
      businessName: 'Acme Plumbing',
      pool: pool as never,
      settingsRepo: settingsRepo as never,
      ...(opts.voiceGate ? { voiceGate: opts.voiceGate } : {}),
    }),
  );
  return { app, handleInbound };
}

function signedVoicePost(app: express.Application, callSid: string) {
  const params = { CallSid: callSid, From: '+15125550100', To: '+15125550999' };
  const url = `${PUBLIC_BASE_URL}/api/telephony/voice`;
  const sig = twilio.getExpectedTwilioSignature(AUTH_TOKEN, url, params);
  return request(app)
    .post('/api/telephony/voice')
    .set('X-Twilio-Signature', sig)
    .type('form')
    .send(params);
}

describe('#1595 — POST /api/telephony/voice after hours', () => {
  it('(a) a tenant that never set the after-hours mode is answered by the AI, not voicemail', async () => {
    const { app, handleInbound } = makeApp({});

    const res = await signedVoicePost(app, 'CA-1595-default');

    expect(res.status).toBe(200);
    expect(handleInbound).toHaveBeenCalledWith(
      expect.objectContaining({ callSid: 'CA-1595-default', tenantId: TENANT_ID }),
    );
    expect(res.text).not.toContain('<Record');
    expect(res.text).not.toContain("We're not available right now");
  });

  it("(b) a tenant that explicitly chose 'voicemail' still gets voicemail, and the AI is never called", async () => {
    const { app, handleInbound } = makeApp({
      escalationSettings: { after_hours_voice_mode: 'voicemail' },
    });

    const res = await signedVoicePost(app, 'CA-1595-voicemail');

    expect(res.status).toBe(200);
    expect(res.text).toContain('<Record');
    expect(res.text).toContain('/api/telephony/voicemail-status');
    expect(res.text).toContain('Thanks for calling Acme Plumbing.');
    expect(handleInbound).not.toHaveBeenCalled();
  });

  it('(c) the go-live gate still runs first: an after-hours call on a tenant that is not live gets the gate voicemail, not the AI', async () => {
    const { app, handleInbound } = makeApp({
      voiceGate: async () => ({ allowed: false, reason: 'not_live' }),
    });

    const res = await signedVoicePost(app, 'CA-1595-not-live');

    expect(res.status).toBe(200);
    expect(res.text).toContain('<Record');
    expect(res.text).toContain('/api/telephony/recording');
    expect(handleInbound).not.toHaveBeenCalled();
  });
});
