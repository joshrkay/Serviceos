/**
 * LCR-05 — a /gather turn for a session this process does not hold.
 *
 * Voice sessions live in the memory of the process that answered the call. On
 * a deploy the next /gather of a live Gather call reaches the NEW process
 * (Railway switches traffic as soon as it is healthy), where the session id
 * in `?sid=` is unknown. That turn used to answer "I'm sorry, your session
 * has ended. Please call again." and hang up on a caller mid-conversation.
 *
 * Now the call starts over as a fresh disclosed session for the dialled
 * number's tenant (the same greeting + recording notice /voice gives), and
 * the restart is logged as deploy-induced. Without From/To (a request that
 * cannot name the call's number) the old hang-up stays.
 */

import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import twilio from 'twilio';
import { createTelephonyRouter } from '../../src/routes/telephony';
import { TwilioGatherAdapter } from '../../src/telephony/twilio-adapter';
import { VoiceSessionStore } from '../../src/ai/agents/customer-calling/voice-session-store';
import type { LLMGateway, LLMResponse } from '../../src/ai/gateway/gateway';

const AUTH_TOKEN = 'test-tw-token-lcr05';
const PUBLIC_BASE_URL = 'https://api.test';
const TENANT_ID = 'tenant-lcr05';
const CALLER = '+15125550100';
const DIALLED = '+15125550999';

const RECORDING_NOTICE = 'This call may be recorded for quality and training purposes.';
const SESSION_ENDED = 'your session has ended';

function makeGateway(): LLMGateway {
  const response: LLMResponse = {
    content: '{"intentType":"unknown","confidence":0,"reasoning":"x"}',
    model: 'mock',
    provider: 'mock',
    tokenUsage: { input: 1, output: 1, total: 2 },
    latencyMs: 1,
  };
  return { complete: vi.fn().mockResolvedValue(response) } as unknown as LLMGateway;
}

/** One process: its own in-memory session store, adapter and router. */
function buildProcess() {
  const store = new VoiceSessionStore({ startInterval: false });
  const gateway = makeGateway();
  const adapter = new TwilioGatherAdapter({
    store,
    gateway,
    businessName: 'Acme Plumbing',
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
      voiceSessionStore: store,
    }),
  );
  return { app, store, adapter, gateway };
}

function signedPost(app: express.Application, path: string, params: Record<string, string>) {
  const sig = twilio.getExpectedTwilioSignature(AUTH_TOKEN, `${PUBLIC_BASE_URL}${path}`, params);
  return request(app).post(path).set('X-Twilio-Signature', sig).type('form').send(params);
}

function gatherSid(twiml: string): string | undefined {
  return /gather\?sid=([^"&]+)/.exec(twiml)?.[1];
}

describe('LCR-05 — /gather for a session this process does not hold (deploy cut-over)', () => {
  it('starts the call over as a fresh disclosed session instead of hanging up', async () => {
    // Old process answered the call and handed the caller a Gather.
    const oldProcess = buildProcess();
    const voice = await signedPost(oldProcess.app, '/api/telephony/voice', {
      CallSid: 'CA-deploy-1',
      From: CALLER,
      To: DIALLED,
    });
    expect(voice.status).toBe(200);
    const staleSid = gatherSid(voice.text);
    expect(staleSid).toBeDefined();

    // Deploy: the caller's next turn reaches the new process, which never saw it.
    const newProcess = buildProcess();
    const path = `/api/telephony/gather?sid=${staleSid}`;
    const res = await signedPost(newProcess.app, path, {
      CallSid: 'CA-deploy-1',
      From: CALLER,
      To: DIALLED,
      SpeechResult: 'my furnace stopped working',
      Confidence: '0.9',
    });

    expect(res.status).toBe(200);
    expect(res.text).not.toContain('<Hangup/>');
    expect(res.text).not.toContain(SESSION_ENDED);
    // The same greeting and recording notice a fresh /voice gives.
    expect(res.text).toContain('Thank you for calling Acme Plumbing.');
    expect(res.text).toContain(RECORDING_NOTICE);
    // The next turn goes to a session the new process holds.
    const freshSid = gatherSid(res.text);
    expect(freshSid).toBeDefined();
    expect(freshSid).not.toBe(staleSid);
    const fresh = newProcess.store.findByCallSid('CA-deploy-1');
    expect(fresh?.id).toBe(freshSid);
    expect(fresh?.tenantId).toBe(TENANT_ID);
    expect(fresh?.callerPhone).toBe(CALLER);
  });

  it('a Twilio retry of the same stale turn reuses the restarted session (no second session)', async () => {
    const proc = buildProcess();
    const params = {
      CallSid: 'CA-deploy-2',
      From: CALLER,
      To: DIALLED,
      SpeechResult: 'hello',
      Confidence: '0.9',
    };
    const first = await signedPost(proc.app, '/api/telephony/gather?sid=stale-2', params);
    const second = await signedPost(proc.app, '/api/telephony/gather?sid=stale-2', params);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(second.text).not.toContain('<Hangup/>');
    expect(gatherSid(second.text)).toBe(gatherSid(first.text));
    expect(proc.store.liveCount()).toBe(1);
  });

  it('logs the restart as deploy-induced', async () => {
    const proc = buildProcess();
    const info = vi.spyOn(process.stdout, 'write');
    try {
      await proc.adapter.handleGather({
        sessionId: 'stale-3',
        callSid: 'CA-deploy-3',
        speechResult: 'hello',
        confidence: 0.9,
        tenantId: TENANT_ID,
        from: CALLER,
        to: DIALLED,
      });
      const lines = info.mock.calls.map((c) => String(c[0]));
      expect(lines.some((l) => l.includes('deploy_induced_restart'))).toBe(true);
    } finally {
      info.mockRestore();
    }
  });

  it('without From/To there is no number to start over on: the old hang-up stays', async () => {
    const proc = buildProcess();
    const twiml = await proc.adapter.handleGather({
      sessionId: 'stale-4',
      callSid: 'CA-deploy-4',
      speechResult: 'hello',
      confidence: 0.9,
      tenantId: TENANT_ID,
    });
    expect(twiml).toContain(SESSION_ENDED);
    expect(twiml).toContain('<Hangup/>');
    expect(proc.store.liveCount()).toBe(0);
  });
});
