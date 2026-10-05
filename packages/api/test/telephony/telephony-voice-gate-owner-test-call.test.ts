/**
 * #1605 — the owner's own test call must pass the §10 go-live gate while
 * the tenant is not_live, so the onboarding test-call step can complete
 * without the owner needing to Skip + manually "Turn on AI answering"
 * first (see docs/decisions.md and voice/go-live.ts `maybeAutoGoLiveOnInboundEnd`).
 *
 * Wires the REAL createVoiceGate (not a stub VoiceGate fn) behind the real
 * route, backed by a mock Pool, to prove the gate's own not_live decision
 * — not just the route's TwiML branching — treats the owner's caller-ID
 * specially.
 */

import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import twilio from 'twilio';
import { createTelephonyRouter } from '../../src/routes/telephony';
import { TwilioGatherAdapter } from '../../src/telephony/twilio-adapter';
import { VoiceSessionStore } from '../../src/ai/agents/customer-calling/voice-session-store';
import { createVoiceGate } from '../../src/voice/voice-gate';
import type { LLMGateway, LLMResponse } from '../../src/ai/gateway/gateway';
import type { AuditRepository } from '../../src/audit/audit';
import type { Pool } from 'pg';

const AUTH_TOKEN = 'test-tw-token-owner-test-call';
const PUBLIC_BASE_URL = 'https://api.test';
const TENANT_ID = 'tenant-owner-test-call';
const OWNER_PHONE = '+14805550100';

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

/** A not_live, trialing tenant whose owner_phone/business_phone are on file. */
function mockPool(opts: { ownerPhone?: string | null; businessPhone?: string | null } = {}): Pool {
  return {
    query: vi.fn(async (sql: string) => {
      if (sql.includes('FROM tenants')) {
        return { rows: [{ subscription_status: 'trialing', past_due_grace_until: null }] };
      }
      if (sql.includes('voice_agent_live_at')) {
        return { rows: [{ voice_agent_live_at: null }] };
      }
      if (sql.includes('owner_phone')) {
        return {
          rows: [
            {
              owner_phone: opts.ownerPhone ?? OWNER_PHONE,
              business_phone: opts.businessPhone ?? null,
            },
          ],
        };
      }
      return { rows: [] };
    }),
  } as unknown as Pool;
}

function mockAudit(): AuditRepository {
  return { create: vi.fn(async () => undefined) } as unknown as AuditRepository;
}

function buildHarness(pool: Pool) {
  const store = new VoiceSessionStore();
  const adapter = new TwilioGatherAdapter({
    store,
    gateway: makeGateway(),
    businessName: 'Test Co',
    publicBaseUrl: PUBLIC_BASE_URL,
  });
  const voiceGate = createVoiceGate({ pool, auditRepo: mockAudit() });

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

function signedVoice(app: express.Application, params: Record<string, string>) {
  const path = '/api/telephony/voice';
  const url = `${PUBLIC_BASE_URL}${path}`;
  const sig = twilio.getExpectedTwilioSignature(AUTH_TOKEN, url, params);
  return request(app).post(path).set('X-Twilio-Signature', sig).type('form').send(params);
}

describe('POST /api/telephony/voice — #1605 owner test call vs. not_live gate', () => {
  it('lets the owner\'s own caller-ID through as an AI-answered test session while not_live', async () => {
    const { app, store } = buildHarness(mockPool({ ownerPhone: OWNER_PHONE }));

    const res = await signedVoice(app, {
      CallSid: 'CA-owner-test-call',
      From: OWNER_PHONE,
      To: '+15125550999',
    });

    expect(res.status).toBe(200);
    expect(res.text).toContain('<Gather');
    expect(res.text).not.toContain('AI assistant yet');
    expect(store.size()).toBe(1);
  });
});
