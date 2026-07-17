/**
 * WS3 (voice ingestion resilience) — /voice realtime-vs-Gather decision matrix.
 *
 * Extends the P8-012 flag-dispatch test: when the global master switch
 * (mediaStreamsEnabled) is ON, the route additionally consults the per-tenant
 * `voice_realtime` flag, the realtime prerequisites probe, and the health
 * circuit. Every one of those failing — including a flag-read throw — must
 * degrade to the proven Gather path.
 *
 * Decision table asserted here:
 *   global OFF                      → Gather (flag never consulted)
 *   global ON, tenant flag OFF      → Gather
 *   global ON, prereqs missing      → Gather (flag never consulted)
 *   global ON, circuit OPEN         → Gather (flag never consulted)
 *   global ON, flag read THROWS     → Gather
 *   global ON, all healthy          → Stream
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import twilio from 'twilio';

// OBS — capture recordVoiceError calls without touching the real PostHog SDK.
const recordVoiceErrorMock = vi.fn();
vi.mock('../../../src/analytics/posthog', () => ({
  recordVoiceError: (...args: unknown[]) => recordVoiceErrorMock(...args),
}));

import { createTelephonyRouter } from '../../../src/routes/telephony';

beforeEach(() => {
  recordVoiceErrorMock.mockClear();
});

const AUTH_TOKEN = 'test-ws3-fallback-token';
const PUBLIC_BASE_URL = 'https://api.test';

function makeFakeAdapter() {
  const handleInbound = vi.fn().mockResolvedValue(
    `<?xml version="1.0" encoding="UTF-8"?><Response><Gather/></Response>`,
  );
  const handleInboundForStream = vi.fn().mockResolvedValue(
    `<?xml version="1.0" encoding="UTF-8"?><Response><Connect><Stream url="wss://x/"/></Connect></Response>`,
  );
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

function mountRouter(
  extra: Partial<Parameters<typeof createTelephonyRouter>[0]>,
): {
  app: express.Application;
  handleInbound: ReturnType<typeof vi.fn>;
  handleInboundForStream: ReturnType<typeof vi.fn>;
} {
  const { adapter, handleInbound, handleInboundForStream } = makeFakeAdapter();
  const app = express();
  app.use(
    '/api/telephony',
    createTelephonyRouter({
      adapter,
      authTokenGetter: () => AUTH_TOKEN,
      publicBaseUrl: PUBLIC_BASE_URL,
      resolveTenantId: () => 'tenant-1',
      phoneNumberRepo: {
        findByNumber: async () => ({ tenantId: 'tenant-1' }),
      } as unknown as Parameters<typeof createTelephonyRouter>[0]['phoneNumberRepo'],
      ...extra,
    }),
  );
  return { app, handleInbound, handleInboundForStream };
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

const VOICE_PARAMS = {
  CallSid: 'CA-ws3',
  From: '+15125550100',
  To: '+15125550999',
};

// A prereq probe that always says "ready" and a closed circuit — the healthy
// baseline the individual gates are toggled against.
const READY_PREREQ = () => true;
const CLOSED_CIRCUIT = { isOpen: () => false };

describe('WS3 /voice realtime-vs-Gather decision matrix', () => {
  it('global OFF → Gather (flag never consulted)', async () => {
    const isEnabled = vi.fn().mockResolvedValue(true);
    const { app, handleInbound, handleInboundForStream } = mountRouter({
      // mediaStreamsEnabled omitted → false
      tenantFeatureFlags: { isEnabledForTenantWithDefault: isEnabled },
      realtimePrerequisitesMet: READY_PREREQ,
      realtimeCircuit: CLOSED_CIRCUIT,
    });
    const res = await signedVoicePost(app, VOICE_PARAMS);
    expect(res.status).toBe(200);
    expect(handleInbound).toHaveBeenCalledTimes(1);
    expect(handleInboundForStream).not.toHaveBeenCalled();
    expect(isEnabled).not.toHaveBeenCalled();
  });

  it('global ON, all healthy → Stream', async () => {
    const isEnabled = vi.fn().mockResolvedValue(true);
    const { app, handleInbound, handleInboundForStream } = mountRouter({
      mediaStreamsEnabled: true,
      tenantFeatureFlags: { isEnabledForTenantWithDefault: isEnabled },
      realtimePrerequisitesMet: READY_PREREQ,
      realtimeCircuit: CLOSED_CIRCUIT,
    });
    const res = await signedVoicePost(app, VOICE_PARAMS);
    expect(res.status).toBe(200);
    expect(handleInboundForStream).toHaveBeenCalledTimes(1);
    expect(handleInbound).not.toHaveBeenCalled();
    expect(isEnabled).toHaveBeenCalledWith('tenant-1', 'voice_realtime', true);
  });

  it('global ON, tenant flag OFF → Gather', async () => {
    const isEnabled = vi.fn().mockResolvedValue(false);
    const { app, handleInbound, handleInboundForStream } = mountRouter({
      mediaStreamsEnabled: true,
      tenantFeatureFlags: { isEnabledForTenantWithDefault: isEnabled },
      realtimePrerequisitesMet: READY_PREREQ,
      realtimeCircuit: CLOSED_CIRCUIT,
    });
    const res = await signedVoicePost(app, VOICE_PARAMS);
    expect(res.status).toBe(200);
    expect(handleInbound).toHaveBeenCalledTimes(1);
    expect(handleInboundForStream).not.toHaveBeenCalled();
  });

  it('global ON, prereqs missing → Gather (flag never consulted)', async () => {
    const isEnabled = vi.fn().mockResolvedValue(true);
    const { app, handleInbound, handleInboundForStream } = mountRouter({
      mediaStreamsEnabled: true,
      tenantFeatureFlags: { isEnabledForTenantWithDefault: isEnabled },
      realtimePrerequisitesMet: () => false,
      realtimeCircuit: CLOSED_CIRCUIT,
    });
    const res = await signedVoicePost(app, VOICE_PARAMS);
    expect(res.status).toBe(200);
    expect(handleInbound).toHaveBeenCalledTimes(1);
    expect(handleInboundForStream).not.toHaveBeenCalled();
    expect(isEnabled).not.toHaveBeenCalled();
  });

  it('global ON, circuit OPEN → Gather (flag never consulted)', async () => {
    const isEnabled = vi.fn().mockResolvedValue(true);
    const { app, handleInbound, handleInboundForStream } = mountRouter({
      mediaStreamsEnabled: true,
      tenantFeatureFlags: { isEnabledForTenantWithDefault: isEnabled },
      realtimePrerequisitesMet: READY_PREREQ,
      realtimeCircuit: { isOpen: () => true },
    });
    const res = await signedVoicePost(app, VOICE_PARAMS);
    expect(res.status).toBe(200);
    expect(handleInbound).toHaveBeenCalledTimes(1);
    expect(handleInboundForStream).not.toHaveBeenCalled();
    expect(isEnabled).not.toHaveBeenCalled();
    // OBS — fired after the Gather-fallback decision is already made above.
    expect(recordVoiceErrorMock).toHaveBeenCalledWith(
      expect.objectContaining({
        errorKind: 'realtime_circuit_open',
        channel: 'gather',
        callSid: 'CA-ws3',
        tenantId: 'tenant-1',
      }),
    );
  });

  it('global ON, flag read THROWS → Gather (fail toward the proven path)', async () => {
    const isEnabled = vi.fn().mockRejectedValue(new Error('pg down'));
    const { app, handleInbound, handleInboundForStream } = mountRouter({
      mediaStreamsEnabled: true,
      tenantFeatureFlags: { isEnabledForTenantWithDefault: isEnabled },
      realtimePrerequisitesMet: READY_PREREQ,
      realtimeCircuit: CLOSED_CIRCUIT,
    });
    const res = await signedVoicePost(app, VOICE_PARAMS);
    expect(res.status).toBe(200);
    expect(handleInbound).toHaveBeenCalledTimes(1);
    expect(handleInboundForStream).not.toHaveBeenCalled();
  });

  it('global ON, no per-tenant deps wired → Stream (legacy: global flag alone decides)', async () => {
    const { app, handleInbound, handleInboundForStream } = mountRouter({
      mediaStreamsEnabled: true,
      // tenantFeatureFlags / realtimePrerequisitesMet / realtimeCircuit omitted
    });
    const res = await signedVoicePost(app, VOICE_PARAMS);
    expect(res.status).toBe(200);
    expect(handleInboundForStream).toHaveBeenCalledTimes(1);
    expect(handleInbound).not.toHaveBeenCalled();
  });
});

// ─── OBS — the handleInbound catch never 5xxs by design (graceful hangup
// TwiML so Twilio doesn't retry), which makes it invisible to recordApiError.
// voice_error(inbound_handler_failed) is the only backend signal for it. ────
describe('WS3/OBS voice_error — inbound handler failure', () => {
  it('adapter.handleInbound throws → still 200s graceful hangup TwiML, and fires voice_error', async () => {
    const handleInbound = vi.fn().mockRejectedValue(new Error('adapter boom'));
    const handleInboundForStream = vi.fn();
    const { app } = mountRouter({
      // mediaStreamsEnabled omitted → Gather path, exercises handleInbound.
      adapter: {
        handleInbound,
        handleInboundForStream,
        handleGather: vi.fn(),
      } as unknown as Parameters<typeof createTelephonyRouter>[0]['adapter'],
    });
    const res = await signedVoicePost(app, VOICE_PARAMS);

    expect(res.status).toBe(200);
    expect(res.text).toContain('technical difficulties');
    // OBS — fired after the graceful hangup TwiML is already queued above.
    expect(recordVoiceErrorMock).toHaveBeenCalledWith(
      expect.objectContaining({
        errorKind: 'inbound_handler_failed',
        channel: 'gather',
        callSid: 'CA-ws3',
        tenantId: 'tenant-1',
      }),
    );
  });
});
