/**
 * P8-012 — Feature-flag dispatch in the telephony /voice route.
 *
 * Mounts the telephony router with a fake adapter and verifies:
 *   - flag off (default) → adapter.handleInbound is invoked (Gather TwiML).
 *   - flag on            → adapter.handleInboundForStream is invoked
 *                          (<Connect><Stream/></Connect> TwiML).
 *
 * We use a minimal stub adapter rather than the real
 * TwilioGatherAdapter so this test stays focused on routing.
 */

import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import twilio from 'twilio';
import { createTelephonyRouter } from '../../../src/routes/telephony';

const AUTH_TOKEN = 'test-tw-flag-token';
const PUBLIC_BASE_URL = 'https://api.test';

function makeFakeAdapter() {
  const handleInbound = vi.fn().mockResolvedValue(
    `<?xml version="1.0" encoding="UTF-8"?><Response><Gather/></Response>`,
  );
  const handleInboundForStream = vi.fn().mockResolvedValue(
    `<?xml version="1.0" encoding="UTF-8"?><Response><Connect><Stream url="wss://x/"/></Connect></Response>`,
  );
  // The router only looks at these two methods on the inbound path; supply
  // empty stubs for the rest of the surface so types line up.
  return {
    adapter: {
      handleInbound,
      handleInboundForStream,
      handleGather: vi.fn(),
    } as unknown as Parameters<typeof createTelephonyRouter>[0]['adapter'],
    handleInbound,
    handleInboundForStream,
  };
}

function signedVoicePost(app: express.Application, params: Record<string, string>) {
  const url = `${PUBLIC_BASE_URL}/api/telephony/voice`;
  const sig = twilio.getExpectedTwilioSignature(AUTH_TOKEN, url, params);
  return request(app)
    .post('/api/telephony/voice')
    .set('X-Twilio-Signature', sig)
    .type('form')
    .send(params);
}

describe('P8-012 mediaStreamsEnabled flag dispatch', () => {
  it('flag off → adapter.handleInbound (Gather path)', async () => {
    const { adapter, handleInbound, handleInboundForStream } = makeFakeAdapter();
    const app = express();
    app.use(
      '/api/telephony',
      createTelephonyRouter({
        adapter,
        authTokenGetter: () => AUTH_TOKEN,
        publicBaseUrl: PUBLIC_BASE_URL,
        resolveTenantId: () => 'tenant-1',
        // mediaStreamsEnabled omitted → false
      }),
    );
    const res = await signedVoicePost(app, {
      CallSid: 'CA-flag-off',
      From: '+15125550100',
      To: '+15125550999',
    });
    expect(res.status).toBe(200);
    expect(handleInbound).toHaveBeenCalledTimes(1);
    expect(handleInboundForStream).not.toHaveBeenCalled();
    expect(res.text).toContain('<Gather');
  });

  it('flag on → adapter.handleInboundForStream (Stream path)', async () => {
    const { adapter, handleInbound, handleInboundForStream } = makeFakeAdapter();
    const app = express();
    app.use(
      '/api/telephony',
      createTelephonyRouter({
        adapter,
        authTokenGetter: () => AUTH_TOKEN,
        publicBaseUrl: PUBLIC_BASE_URL,
        resolveTenantId: () => 'tenant-1',
        mediaStreamsEnabled: true,
      }),
    );
    const res = await signedVoicePost(app, {
      CallSid: 'CA-flag-on',
      From: '+15125550100',
      To: '+15125550999',
    });
    expect(res.status).toBe(200);
    expect(handleInboundForStream).toHaveBeenCalledTimes(1);
    expect(handleInbound).not.toHaveBeenCalled();
    expect(res.text).toContain('<Connect>');
    expect(res.text).toContain('<Stream');
  });
});
