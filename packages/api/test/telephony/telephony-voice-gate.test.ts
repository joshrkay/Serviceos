/**
 * §10 onboarding — Gate A (subscription) + Gate B (trial caps) at the
 * inbound POST /api/telephony/voice webhook. Complements unit tests on
 * evaluateTrialCap / createVoiceGate by asserting the TwiML branch.
 */

import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import twilio from 'twilio';
import { createTelephonyRouter } from '../../src/routes/telephony';
import { TwilioGatherAdapter } from '../../src/telephony/twilio-adapter';
import { VoiceSessionStore } from '../../src/ai/agents/customer-calling/voice-session-store';
import type { LLMGateway, LLMResponse } from '../../src/ai/gateway/gateway';
import type { VoiceGate } from '../../src/voice/voice-gate';

const AUTH_TOKEN = 'test-tw-token-voice-gate';
const PUBLIC_BASE_URL = 'https://api.test';
const TENANT_ID = 'tenant-voice-gate-test';

function makeGateway(): LLMGateway {
  const response: LLMResponse = {
    content: JSON.stringify({
      intentType: 'create_invoice',
      confidence: 0.91,
      reasoning: 'clear command',
      extractedEntities: {},
    }),
    model: 'mock',
    provider: 'mock',
    tokenUsage: { input: 1, output: 1, total: 2 },
    latencyMs: 1,
  };
  return { complete: vi.fn().mockResolvedValue(response) } as unknown as LLMGateway;
}

function buildHarness(voiceGate: VoiceGate) {
  const store = new VoiceSessionStore();
  const adapter = new TwilioGatherAdapter({
    store,
    gateway: makeGateway(),
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
      voiceGate,
    }),
  );
  return { app, store };
}

function signedVoice(
  app: express.Application,
  params: Record<string, string>,
) {
  const path = '/api/telephony/voice';
  const url = `${PUBLIC_BASE_URL}${path}`;
  const sig = twilio.getExpectedTwilioSignature(AUTH_TOKEN, url, params);
  return request(app)
    .post(path)
    .set('X-Twilio-Signature', sig)
    .type('form')
    .send(params);
}

const baseParams = {
  CallSid: 'CA-gate-1',
  From: '+15125550100',
  To: '+15125550999',
};

describe('POST /api/telephony/voice — §10 voiceGate', () => {
  it('returns Gather TwiML when gate allows (trialing, under caps)', async () => {
    const voiceGate: VoiceGate = vi.fn(async () => ({ allowed: true }));
    const { app, store } = buildHarness(voiceGate);

    const res = await signedVoice(app, baseParams);

    expect(res.status).toBe(200);
    expect(res.text).toContain('<Gather');
    expect(voiceGate).toHaveBeenCalledWith({
      tenantId: TENANT_ID,
      callSid: 'CA-gate-1',
    });
    expect(store.size()).toBe(1);
  });

  it('returns voicemail TwiML when Gate A blocks (no_billing)', async () => {
    const voiceGate: VoiceGate = vi.fn(async () => ({
      allowed: false,
      reason: 'no_billing' as const,
    }));
    const { app, store } = buildHarness(voiceGate);

    const res = await signedVoice(app, { ...baseParams, CallSid: 'CA-gate-no-billing' });

    expect(res.status).toBe(200);
    expect(res.text).toContain('<Record');
    expect(res.text).not.toContain('<Gather');
    expect(store.size()).toBe(0);
  });

  it('returns voicemail TwiML when Gate B blocks (trial_cap_daily)', async () => {
    const voiceGate: VoiceGate = vi.fn(async () => ({
      allowed: false,
      reason: 'trial_cap_daily' as const,
    }));
    const { app } = buildHarness(voiceGate);

    const res = await signedVoice(app, { ...baseParams, CallSid: 'CA-gate-daily' });

    expect(res.status).toBe(200);
    expect(res.text).toContain('being set up');
    expect(res.text).toContain('<Record');
    expect(res.text).not.toContain('<Gather');
  });

  it('returns voicemail TwiML when Gate B blocks (trial_cap_total)', async () => {
    const voiceGate: VoiceGate = vi.fn(async () => ({
      allowed: false,
      reason: 'trial_cap_total' as const,
    }));
    const { app } = buildHarness(voiceGate);

    const res = await signedVoice(app, { ...baseParams, CallSid: 'CA-gate-total' });

    expect(res.status).toBe(200);
    expect(res.text).toContain('<Record');
    expect(res.text).not.toContain('<Gather');
  });
});
