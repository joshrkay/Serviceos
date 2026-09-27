/**
 * #1223 — the /voice webhook forwards Twilio's STIR/SHAKEN verdict
 * (`StirVerstat`) to the adapter on BOTH transports, so owner-line authority
 * can be gated on A-attestation. The value rides the signed webhook body.
 */
import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import twilio from 'twilio';
import { createTelephonyRouter } from '../../src/routes/telephony';

const AUTH_TOKEN = 'test-tw-stir-token';
const PUBLIC_BASE_URL = 'https://api.test';

function makeApp(mediaStreamsEnabled: boolean) {
  const handleInbound = vi.fn().mockResolvedValue('<Response><Gather/></Response>');
  const handleInboundForStream = vi.fn().mockResolvedValue('<Response><Connect/></Response>');
  const app = express();
  app.use(
    '/api/telephony',
    createTelephonyRouter({
      adapter: { handleInbound, handleInboundForStream, handleGather: vi.fn() } as unknown as Parameters<
        typeof createTelephonyRouter
      >[0]['adapter'],
      authTokenGetter: () => AUTH_TOKEN,
      publicBaseUrl: PUBLIC_BASE_URL,
      resolveTenantId: () => 'tenant-1',
      mediaStreamsEnabled,
    }),
  );
  return { app, handleInbound, handleInboundForStream };
}

function signedPost(app: express.Application, path: string, params: Record<string, string>) {
  const sig = twilio.getExpectedTwilioSignature(AUTH_TOKEN, `${PUBLIC_BASE_URL}/api/telephony${path}`, params);
  return request(app).post(`/api/telephony${path}`).set('X-Twilio-Signature', sig).type('form').send(params);
}

const PARAMS = {
  CallSid: 'CA-stir',
  From: '+15125550100',
  To: '+15125550999',
  StirVerstat: 'TN-Validation-Passed-B',
};

describe('#1223 — /voice forwards StirVerstat', () => {
  it('Gather transport', async () => {
    const { app, handleInbound } = makeApp(false);
    const res = await signedPost(app, '/voice', PARAMS);
    expect(res.status).toBe(200);
    expect(handleInbound).toHaveBeenCalledWith(
      expect.objectContaining({ callSid: 'CA-stir', stirVerstat: 'TN-Validation-Passed-B' }),
    );
  });

  it('Media Streams transport', async () => {
    const { app, handleInboundForStream } = makeApp(true);
    await signedPost(app, '/voice', PARAMS);
    expect(handleInboundForStream).toHaveBeenCalledWith(
      expect.objectContaining({ callSid: 'CA-stir', stirVerstat: 'TN-Validation-Passed-B' }),
    );
  });

  it('gather-fallback fresh session', async () => {
    const { app, handleInbound } = makeApp(false);
    await signedPost(app, '/voice/gather-fallback', { ...PARAMS, CallSid: 'CA-stir-fb' });
    expect(handleInbound).toHaveBeenCalledWith(
      expect.objectContaining({ callSid: 'CA-stir-fb', stirVerstat: 'TN-Validation-Passed-B' }),
    );
  });

  it('omits stirVerstat when Twilio sent none', async () => {
    const { app, handleInbound } = makeApp(false);
    const { StirVerstat: _omit, ...noStir } = PARAMS;
    await signedPost(app, '/voice', noStir);
    expect(handleInbound.mock.calls[0]![0]).not.toHaveProperty('stirVerstat');
  });
});

describe('#1223 — after-hours voicemail carries StirVerstat onto the signed callback URL', () => {
  it('threads the /voice verdict into the voicemail TwiML', async () => {
    const handleInbound = vi.fn();
    // Tenant hours: a one-minute window, so "now" is (almost surely) closed.
    const pool = {
      query: vi.fn(async () => ({
        rows: [{ business_hours: { mon: { open: '00:00', close: '00:01' } }, timezone: 'UTC' }],
      })),
    };
    const app = express();
    app.use(
      '/api/telephony',
      createTelephonyRouter({
        adapter: { handleInbound, handleInboundForStream: vi.fn(), handleGather: vi.fn() } as unknown as Parameters<
          typeof createTelephonyRouter
        >[0]['adapter'],
        authTokenGetter: () => AUTH_TOKEN,
        publicBaseUrl: PUBLIC_BASE_URL,
        resolveTenantId: () => 'tenant-1',
        pool: pool as never,
        settingsRepo: { findByTenant: async () => ({}) } as never,
      }),
    );
    const res = await signedPost(app, '/voice', PARAMS);
    expect(res.status).toBe(200);
    expect(res.text).toContain('<Record');
    expect(res.text).toContain('StirVerstat=TN-Validation-Passed-B');
    expect(handleInbound).not.toHaveBeenCalled();
  });
});
