/**
 * #8b + H1 (review of #1676) — the emergency page ladder resolves ONLY when a
 * human accepts the hand-off, and keeps paging for a voicemail pickup.
 *
 * `/dial-result` fires when the bridged call ENDS, so a dispatcher on a live
 * emergency call was paged as "unanswered". But Twilio's own "answered" signal
 * cannot fix that: a carrier voicemail answering the dispatcher's phone looks
 * exactly like a human (child leg `in-progress`, DialCallStatus `completed`),
 * and silencing the ladder on it would stop paging for a real unanswered
 * emergency — the casualty direction. So the whisper is a screen: only a
 * person pressing 1 marks the hand-off answered, live AND durably (audit), and
 * a screened leg that was never accepted is not a `transferred` call even if
 * Twilio reports `completed`. The ladder worker here has NO live session store
 * — the split web/worker topology. The routes are mounted exactly as app.ts
 * mounts them, with a credential getter that honors the dialled-number binding
 * (`to`), so the child-leg screen is proven to stay off it (M5).
 */
import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import twilio from 'twilio';
import { createTelephonyRouter } from '../../src/routes/telephony';
import { mountWhisperRoute } from '../../src/telephony/whisper-route';
import { WhisperCache } from '../../src/telephony/whisper-cache';
import { createTransferScreenHooks } from '../../src/telephony/transfer-screening';
import { TwilioGatherAdapter } from '../../src/telephony/twilio-adapter';
import { VoiceSessionStore } from '../../src/ai/agents/customer-calling/voice-session-store';
import { InMemoryAuditRepository } from '../../src/audit/audit';
import { InMemoryVoiceSessionRepository } from '../../src/voice/voice-session';
import {
  createEmergencyPageResolvedCheck,
  createEmergencyPageWorker,
  EMERGENCY_PAGE_JOB_TYPE,
  type EmergencyPageJobPayload,
} from '../../src/telephony/emergency-page-retry';
import type { TwilioAuthTokenGetter } from '../../src/telephony/twilio-signature';
import type { QueueMessage } from '../../src/queues/queue';
import type { LLMGateway } from '../../src/ai/gateway/gateway';
import { createLogger } from '../../src/logging/logger';

const logger = createLogger({ service: 'test', environment: 'test', level: 'error' });
const TENANT = 'tenant-ladder';
const OTHER_TENANT = 'tenant-other';
const PUBLIC_BASE_URL = 'https://api.test';
const TOKEN = 'tenant-token';
const TENANT_DID = '+15125550999';
/** The dispatcher's mobile happens to be ANOTHER tenant's DID. */
const DISPATCHER = '+15125550101';
const OWNER = '+15125550199';

async function harness() {
  const store = new VoiceSessionStore({ startInterval: false });
  const auditRepo = new InMemoryAuditRepository();
  const voiceSessionRepo = new InMemoryVoiceSessionRepository();
  const gather = new TwilioGatherAdapter({
    store,
    gateway: { complete: vi.fn() } as unknown as LLMGateway,
    businessName: 'Acme Plumbing',
    publicBaseUrl: PUBLIC_BASE_URL,
    auditRepo,
    voiceSessionRepo,
  });
  await gather.handleInboundForStream({ callSid: 'CA-parent', from: '+15125550100', tenantId: TENANT });
  const session = store.findByCallSid('CA-parent')!;
  const whisperCache = new WhisperCache();
  whisperCache.set('esc_1', 'Emergency call from a customer: basement flooding.', TENANT, {
    sessionId: session.id,
  });

  // The dialled-number binding, as production resolves it: a number owned by
  // another tenant refuses; the tenant's own DID verifies as that tenant.
  const bindingGetter: TwilioAuthTokenGetter = ({ to }) =>
    to === DISPATCHER
      ? { outcome: 'refuse', reason: 'credential_not_owner', tenantId: OTHER_TENANT }
      : { outcome: 'verify', authToken: TOKEN, path: 'tenant_integration', tenantId: TENANT };
  // The AccountSid view the whisper mount uses.
  const accountSidView: TwilioAuthTokenGetter = () => ({
    outcome: 'verify',
    authToken: TOKEN,
    path: 'subaccount_lookup',
    tenantId: TENANT,
  });

  const app = express();
  const hooks = createTransferScreenHooks({ store, auditRepo });
  mountWhisperRoute(app, {
    whisperCache,
    credentialView: accountSidView,
    publicBaseUrl: () => PUBLIC_BASE_URL,
    onScreenOffered: hooks.onScreenOffered,
    onAccepted: hooks.onAccepted,
  });
  app.use(
    '/api/telephony',
    createTelephonyRouter({
      adapter: gather,
      authTokenGetter: bindingGetter,
      publicBaseUrl: PUBLIC_BASE_URL,
      resolveTenantId: () => TENANT,
      voiceSessionStore: store,
    }),
  );

  const sendSms = vi.fn(async () => ({ ok: true }));
  const queue = { send: vi.fn(async () => 'job') };
  const worker = createEmergencyPageWorker({
    queue: queue as never,
    sendSms,
    resolvePagePhone: async () => OWNER,
    // The worker process: no live session store, only the durable stores.
    isResolved: createEmergencyPageResolvedCheck({ voiceSessionRepo, auditRepo }),
    auditRepo,
  });
  const runLadderStep = () =>
    worker.handle(
      {
        id: 'job-1',
        type: EMERGENCY_PAGE_JOB_TYPE,
        payload: {
          tenantId: TENANT,
          sessionId: session.id,
          callSid: 'CA-parent',
          callerPhone: '+15125550100',
          emergencyDescription: 'basement flooding',
          businessName: 'Acme Plumbing',
          attempt: 1,
          maxPages: 3,
          intervalMs: 120_000,
        },
        attempts: 0,
        maxAttempts: 5,
        idempotencyKey: 'k-1',
        createdAt: new Date().toISOString(),
      } as QueueMessage<EmergencyPageJobPayload>,
      logger,
    );

  const signedPost = (path: string, params: Record<string, string>) => {
    const sig = twilio.getExpectedTwilioSignature(TOKEN, `${PUBLIC_BASE_URL}${path}`, params);
    return request(app).post(path).set('X-Twilio-Signature', sig).type('form').send(params);
  };
  /** The dispatcher (child) leg: its `To` is the dispatcher's number. */
  const childLeg = { CallSid: 'CA-child', ParentCallSid: 'CA-parent', AccountSid: 'AC_sub', To: DISPATCHER, Called: DISPATCHER };
  const pickUp = () => signedPost('/api/telephony/whisper/esc_1', childLeg);
  const press = (digit: string) =>
    signedPost('/api/telephony/whisper/esc_1/accept', { ...childLeg, Digits: digit });
  /** The parent call's Dial action: its `To` is the tenant's DID. */
  const dialResult = (status: string) =>
    signedPost(`/api/telephony/dial-result?sid=${encodeURIComponent(session.id)}`, {
      CallSid: 'CA-parent',
      DialCallStatus: status,
      From: '+15125550100',
      To: TENANT_DID,
    });

  return { session, sendSms, queue, runLadderStep, pickUp, press, dialResult };
}

describe('#8b/H1 emergency page ladder × screened hand-off', () => {
  it('control: while nobody has accepted, the ladder pages the owner', async () => {
    const h = await harness();
    await h.runLadderStep();
    expect(h.sendSms).toHaveBeenCalledTimes(1);
    expect(h.sendSms.mock.calls[0][0]).toMatchObject({ to: OWNER });
  });

  it('a human pressing 1 stops the ladder — no "unanswered" page while the bridged call is live', async () => {
    const h = await harness();
    expect((await h.pickUp()).status).toBe(200);
    const res = await h.press('1');
    expect(res.status).toBe(200); // served on the whisper mount, never the To-bound router

    await h.runLadderStep();
    expect(h.sendSms).not.toHaveBeenCalled();
    expect(h.queue.send).not.toHaveBeenCalled(); // the rest of the ladder is never enqueued
  });

  it('single-process topology: the live session flag alone resolves the ladder', async () => {
    const h = await harness();
    await h.pickUp();
    await h.press('1');
    const isResolved = createEmergencyPageResolvedCheck({
      store: { peek: () => h.session },
    });
    expect(await isResolved(TENANT, h.session.id)).toBe(true);
  });

  it('voicemail picks up (no keypress): the ladder keeps paging and the call is NOT stamped transferred', async () => {
    const h = await harness();
    await h.pickUp(); // the mailbox "answers" and the screen plays to it
    // …nobody presses 1. Even if Twilio reports the Dial as completed:
    const res = await h.dialResult('completed');

    expect(res.status).toBe(200);
    expect(h.session.terminalReason).not.toBe('transferred');
    expect(res.text).not.toBe('<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>');
    await h.runLadderStep();
    expect(h.sendSms).toHaveBeenCalledTimes(1);
  });

  it('an accepted screened call that ends completed is stamped transferred, as before', async () => {
    const h = await harness();
    await h.pickUp();
    await h.press('1');
    await h.dialResult('completed');
    expect(h.session.terminalReason).toBe('transferred');
  });
});
