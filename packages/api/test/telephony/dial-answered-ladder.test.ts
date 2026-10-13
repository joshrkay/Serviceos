/**
 * #8b — the emergency page ladder resolves the moment the dispatcher ANSWERS.
 *
 * `/dial-result` (the `<Dial>` action) only fires when the bridged call ENDS,
 * and the ladder's `isResolved` only knew `ended_reason = 'transferred'`, so a
 * dispatcher talking to the caller for five minutes was texted "EMERGENCY page
 * 1/3 — transfer unanswered… Call back NOW" at +2/+4/+6 min and an URGENT
 * `emergency_unanswered` callback task was created. Every Dial now carries
 * `<Number statusCallbackEvent="answered">` → POST /api/telephony/dial-answered;
 * the answer is recorded on the live session AND durably (audit), and the
 * ladder reads both. The ladder worker here is built WITHOUT the live session
 * store — exactly the split web/worker topology, where the worker process
 * never holds the call.
 */
import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import twilio from 'twilio';
import { createTelephonyRouter } from '../../src/routes/telephony';
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
import type { QueueMessage } from '../../src/queues/queue';
import type { LLMGateway } from '../../src/ai/gateway/gateway';
import { createLogger } from '../../src/logging/logger';

const logger = createLogger({ service: 'test', environment: 'test', level: 'error' });
const TENANT = 'tenant-ladder';
const OTHER_TENANT = 'tenant-other';
const PUBLIC_BASE_URL = 'https://api.test';
const TOKEN = 'webhook-token';
const OTHER_TOKEN = 'other-tenant-token';
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

  const app = express();
  app.use(
    '/api/telephony',
    createTelephonyRouter({
      adapter: gather,
      // Tenant-bound credentials: each tenant's own token verifies as that tenant.
      authTokenGetter: ({ accountSid }) =>
        accountSid === 'AC_other'
          ? { outcome: 'verify', authToken: OTHER_TOKEN, path: 'subaccount_lookup', tenantId: OTHER_TENANT }
          : { outcome: 'verify', authToken: TOKEN, path: 'subaccount_lookup', tenantId: TENANT },
      publicBaseUrl: PUBLIC_BASE_URL,
      resolveTenantId: () => TENANT,
      voiceSessionStore: store,
    }),
  );

  const sendSms = vi.fn(async () => ({ ok: true }));
  const queue = { send: vi.fn(async () => 'job') };
  // The worker process: no live session store, only the durable stores.
  const worker = createEmergencyPageWorker({
    queue: queue as never,
    sendSms,
    resolvePagePhone: async () => OWNER,
    isResolved: createEmergencyPageResolvedCheck({ voiceSessionRepo, auditRepo }),
    auditRepo,
  });
  const runLadderStep = (attempt: number) =>
    worker.handle(
      {
        id: `job-${attempt}`,
        type: EMERGENCY_PAGE_JOB_TYPE,
        payload: {
          tenantId: TENANT,
          sessionId: session.id,
          callSid: 'CA-parent',
          callerPhone: '+15125550100',
          emergencyDescription: 'basement flooding',
          businessName: 'Acme Plumbing',
          attempt,
          maxPages: 3,
          intervalMs: 120_000,
        },
        attempts: 0,
        maxAttempts: 5,
        idempotencyKey: `k-${attempt}`,
        createdAt: new Date().toISOString(),
      } as QueueMessage<EmergencyPageJobPayload>,
      logger,
    );

  /** Twilio's answered status callback for the dispatcher (child) leg. */
  const answered = (params: Record<string, string>, token = TOKEN) => {
    const path = `/api/telephony/dial-answered?sid=${encodeURIComponent(session.id)}`;
    const body = {
      CallSid: 'CA-child',
      ParentCallSid: 'CA-parent',
      AccountSid: 'AC_tenant',
      CallStatus: 'in-progress',
      To: DISPATCHER,
      Called: DISPATCHER,
      ...params,
    };
    const sig = twilio.getExpectedTwilioSignature(token, `${PUBLIC_BASE_URL}${path}`, body);
    return request(app).post(path).set('X-Twilio-Signature', sig).type('form').send(body);
  };

  return { store, session, sendSms, queue, runLadderStep, answered };
}

describe('#8b emergency page ladder × dispatcher answered', () => {
  it('control: while nobody has answered, the ladder pages the owner', async () => {
    const h = await harness();
    await h.runLadderStep(1);
    expect(h.sendSms).toHaveBeenCalledTimes(1);
    expect(h.sendSms.mock.calls[0][0]).toMatchObject({ to: OWNER });
  });

  it('once the dispatcher answers, the ladder stops — no "unanswered" page while the bridged call is live', async () => {
    const h = await harness();

    const res = await h.answered({});
    expect(res.status).toBeLessThan(300);

    await h.runLadderStep(1);
    expect(h.sendSms).not.toHaveBeenCalled();
    // …and the rest of the ladder (and its exhaustion task) is never enqueued.
    expect(h.queue.send).not.toHaveBeenCalled();
  });

  it('single-process topology: the live session flag alone resolves the ladder', async () => {
    const h = await harness();
    await h.answered({});
    const isResolved = createEmergencyPageResolvedCheck({ store: h.store });
    expect(await isResolved(TENANT, h.session.id)).toBe(true);
  });

  it('a ringing/initiated progress event does not count as answered', async () => {
    const h = await harness();
    await h.answered({ CallStatus: 'ringing' });
    await h.runLadderStep(1);
    expect(h.sendSms).toHaveBeenCalledTimes(1);
  });

  it("a callback for another call (ParentCallSid mismatch) does not resolve this call's ladder", async () => {
    const h = await harness();
    await h.answered({ ParentCallSid: 'CA-some-other-call' });
    await h.runLadderStep(1);
    expect(h.sendSms).toHaveBeenCalledTimes(1);
  });

  it("another tenant's credential cannot mark this tenant's call answered (#1072)", async () => {
    const h = await harness();
    const res = await h.answered({ AccountSid: 'AC_other' }, OTHER_TOKEN);
    expect(res.status).toBe(403);
    await h.runLadderStep(1);
    expect(h.sendSms).toHaveBeenCalledTimes(1);
  });
});
