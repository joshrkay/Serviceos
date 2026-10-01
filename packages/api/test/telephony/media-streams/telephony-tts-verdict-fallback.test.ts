/**
 * #1536 follow-up — the /voice Stream-vs-Gather decision reads the cached TTS
 * probe verdict. A key the provider definitively refuses (missing_permissions
 * / unauthorized) can speak no reply on the media-streams path, so the call
 * takes the Gather path (Twilio <Say>, which works) instead of a voiceless
 * Stream. A transient or absent verdict (unknown / unreachable / none yet)
 * keeps today's behaviour. Seam: the /voice route via supertest with a stub
 * health check.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import twilio from 'twilio';

const warn = vi.fn();
vi.mock('../../../src/logging/logger', async (orig) => {
  const real = await orig<typeof import('../../../src/logging/logger')>();
  return {
    ...real,
    createLogger: (opts: Parameters<typeof real.createLogger>[0]) => {
      const l = real.createLogger(opts);
      return { ...l, warn: (...a: unknown[]) => warn(...a) };
    },
  };
});

import { createTelephonyRouter } from '../../../src/routes/telephony';
import { createTtsHealthCheck, type TtsHealthCheck, type TtsHealthState } from '../../../src/ai/tts/tts-health';

beforeEach(() => warn.mockClear());

const AUTH_TOKEN = 'test-1536-verdict-token';
const PUBLIC_BASE_URL = 'https://api.test';
const GATHER_TWIML = `<?xml version="1.0" encoding="UTF-8"?><Response><Gather/></Response>`;
const STREAM_TWIML = `<?xml version="1.0" encoding="UTF-8"?><Response><Connect><Stream url="wss://x/"/></Connect></Response>`;

function stubHealth(state: TtsHealthState | null): TtsHealthCheck {
  return {
    check: async () => state ?? { status: 'unknown', reason: 'probe_pending' },
    latest: () => state,
  };
}

function mount(ttsHealth: TtsHealthCheck) {
  const app = express();
  app.use(
    '/api/telephony',
    createTelephonyRouter({
      adapter: {
        handleInbound: vi.fn().mockResolvedValue(GATHER_TWIML),
        handleInboundForStream: vi.fn().mockResolvedValue(STREAM_TWIML),
        handleGather: vi.fn(),
      } as unknown as Parameters<typeof createTelephonyRouter>[0]['adapter'],
      authTokenGetter: () => AUTH_TOKEN,
      publicBaseUrl: PUBLIC_BASE_URL,
      resolveTenantId: () => 'tenant-1',
      phoneNumberRepo: {
        findByNumber: async () => ({ tenantId: 'tenant-1' }),
      } as unknown as Parameters<typeof createTelephonyRouter>[0]['phoneNumberRepo'],
      mediaStreamsEnabled: true,
      realtimePrerequisitesMet: () => true,
      realtimeCircuit: { isOpen: () => false },
      ttsHealth,
    }),
  );
  return app;
}

function voicePost(app: express.Application) {
  const params = { CallSid: 'CA-1536', From: '+15125550100', To: '+15125550999' };
  const sig = twilio.getExpectedTwilioSignature(AUTH_TOKEN, `${PUBLIC_BASE_URL}/api/telephony/voice`, params);
  return request(app).post('/api/telephony/voice').set('X-Twilio-Signature', sig).type('form').send(params);
}

describe('#1536 — /voice consults the cached TTS verdict', () => {
  it('failed / missing_permissions → Gather TwiML, with one warning naming the code', async () => {
    const res = await voicePost(mount(stubHealth({ status: 'failed', reason: 'missing_permissions' })));

    expect(res.status).toBe(200);
    expect(res.text).toBe(GATHER_TWIML);
    const ttsWarnings = warn.mock.calls.filter(([msg]) => String(msg).includes('TTS'));
    expect(ttsWarnings).toHaveLength(1);
    expect(ttsWarnings[0][0]).toContain('Gather fallback');
    expect(ttsWarnings[0][1]).toMatchObject({ reason: 'missing_permissions' });
  });

  it('failed / unauthorized → Gather TwiML', async () => {
    const res = await voicePost(mount(stubHealth({ status: 'failed', reason: 'unauthorized' })));
    expect(res.text).toBe(GATHER_TWIML);
  });

  it.each<[string, TtsHealthState | null]>([
    ['ok', { status: 'ok' }],
    ['no verdict yet', null],
    ['unknown / probe_pending', { status: 'unknown', reason: 'probe_pending' }],
    ['failed / unreachable (transient)', { status: 'failed', reason: 'unreachable' }],
    ['config_only', { status: 'config_only' }],
  ])('%s → Stream, as before, with no TTS warning', async (_label, state) => {
    const res = await voicePost(mount(stubHealth(state)));
    expect(res.text).toBe(STREAM_TWIML);
    expect(warn.mock.calls.filter(([msg]) => String(msg).includes('TTS'))).toEqual([]);
  });

  it('with the real check: the first call never waits on the probe; once the refusal is cached, the next call takes Gather', async () => {
    const provider = {
      synthesize: async () => {
        throw new Error('unused');
      },
      probe: vi.fn(async () => ({ ok: false as const, reason: 'missing_permissions' })),
    };
    const app = mount(createTtsHealthCheck({ provider }));

    const first = await voicePost(app);
    await new Promise((r) => setTimeout(r, 0));
    const second = await voicePost(app);

    expect(first.text).toBe(STREAM_TWIML);
    expect(second.text).toBe(GATHER_TWIML);
    expect(provider.probe).toHaveBeenCalledTimes(1);
  });
});
