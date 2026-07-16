/**
 * Voice-parity (Feature 7) — live human transfer with context preservation.
 *
 * Part 1 (skill): escalateToHuman dials the single tenant.transfer_number
 *   instead of walking the rotation, and builds a dispatcher context summary
 *   (caller name + intent + suggested next action).
 * Part 2 (route): on a failed transfer the /dial-result route returns to the
 *   caller, gathers a callback message, and POST /callback-message schedules a
 *   call_me_back task and acknowledges the caller — with no rotation cascade.
 */
import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import twilio from 'twilio';
import { createTelephonyRouter } from '../../src/routes/telephony';
import { TwilioGatherAdapter } from '../../src/telephony/twilio-adapter';
import { VoiceSessionStore } from '../../src/ai/agents/customer-calling/voice-session-store';
import { DefaultTwilioCallControl } from '../../src/telephony/twilio-call-control';
import { InMemoryOnCallRepository } from '../../src/oncall/rotation';
import { InMemoryAuditRepository } from '../../src/audit/audit';
import { escalateToHuman } from '../../src/ai/skills/escalate-to-human';
import { buildEscalationSummary } from '../../src/ai/agents/customer-calling/escalation-summary-builder';
import { InMemoryCallMeBackRepository } from '../../src/voice/call-me-back/call-me-back';
import { createVoiceTurnProcessor } from '../../src/ai/voice-turn/create-voice-turn-processor';
import type { SideEffect } from '../../src/ai/agents/customer-calling/types';
import type { LLMGateway, LLMResponse } from '../../src/ai/gateway/gateway';
import type { SettingsRepository, TenantSettings } from '../../src/settings/settings';

const AUTH_TOKEN = 'test-tw-token-xyz';
const PUBLIC_BASE_URL = 'https://api.test';
// A real UUID — /callback-message validates the resolved tenant id before any
// tenant-scoped work (see isValidTenantId), so a placeholder string is rejected.
const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const TRANSFER_NUMBER = '+15125557000';

function makeGateway(content: string): LLMGateway {
  const response: LLMResponse = {
    content,
    model: 'mock',
    provider: 'mock',
    tokenUsage: { input: 1, output: 1, total: 2 },
    latencyMs: 1,
  };
  return { complete: vi.fn().mockResolvedValue(response) } as unknown as LLMGateway;
}

// ── Part 1 — single-line warm transfer ───────────────────────────────────────
describe('Feature 7 — escalateToHuman dials tenant.transfer_number', () => {
  it('targets the transfer number (not the rotation) and builds a context summary', async () => {
    const callControl = new DefaultTwilioCallControl();
    // These MUST NOT be consulted when transferNumber is set.
    const listRotation = vi.fn(async () => [{ id: 'r1', userId: 'u1', orderIndex: 0 }]);
    const dispatcherPhoneResolver = vi.fn(async () => '+15129999999');
    const auditRepo = new InMemoryAuditRepository();

    const result = await escalateToHuman({
      tenantId: TENANT_ID,
      sessionId: 'sess-xfer',
      reason: 'caller_requested',
      channel: 'telephony',
      callSid: 'CA-xfer',
      onCallRepo: { listRotation } as never,
      dispatcherPhoneResolver,
      transferNumber: TRANSFER_NUMBER,
      callControl,
      auditRepo,
      dialActionUrl: `${PUBLIC_BASE_URL}/api/telephony/dial-result?sid=sess-xfer`,
      buildSummary: buildEscalationSummary,
      shopName: "Joe's HVAC",
      callerContext: {
        caller: { name: 'María López', phone: '+15125550142' },
        intent: { type: 'create_appointment', entities: { service: 'AC repair' }, confidence: 0.4 },
        transcriptSnapshot: [{ role: 'caller', text: 'necesito una cita', ts: 1 }],
      },
    });

    expect(result.escalated).toBe(true);
    expect(result.transfer?.dispatcherPhone).toBe(TRANSFER_NUMBER);
    // The <Dial> TwiML bridges to the transfer number.
    expect(result.transfer?.fallbackTwiml).toContain(TRANSFER_NUMBER);
    // Rotation was NOT walked — transfer_number replaces it.
    expect(listRotation).not.toHaveBeenCalled();
    expect(dispatcherPhoneResolver).not.toHaveBeenCalled();
    // Spec spoken copy.
    expect(result.message).toMatch(/someone on the line/i);
    // Context summary: caller name (SMS) + suggested next action (whisper).
    expect(result.transfer?.summary?.sms).toContain('María López');
    expect(result.transfer?.summary?.whisper).toContain('book the visit');
    expect(result.transfer?.escalationId).toBeDefined();
  });
});

// ── Part 1b — context SMS goes to transfer_number BEFORE the bridge ──────────
describe('Feature 7 — context SMS to transfer_number before the bridge', () => {
  it('SMSes the receiving CSR (transfer_number) and queues the Dial TwiML', async () => {
    const store = new VoiceSessionStore({ startInterval: false });
    const auditRepo = new InMemoryAuditRepository();
    const onCallRepo = new InMemoryOnCallRepository();
    const callControl = new DefaultTwilioCallControl();
    const pendingTransferTwiml = new Map<string, string>();
    const sent: { to: string; body: string }[] = [];
    const deliveryProvider = {
      sendSms: vi.fn(async (a: { to: string; body: string }) => {
        sent.push(a);
      }),
    };
    const settingsRepo = {
      findByTenant: vi.fn(
        async () =>
          ({ transferNumber: TRANSFER_NUMBER, businessName: 'Acme Plumbing' } as unknown as TenantSettings),
      ),
    } as unknown as SettingsRepository;

    const processor = createVoiceTurnProcessor({
      store,
      gateway: makeGateway('{}'),
      businessName: 'Acme Plumbing',
      systemActorId: 'test-actor',
      auditRepo,
      onCallRepo,
      callControl,
      settingsRepo,
      deliveryProvider,
      pendingTransferTwiml,
      publicBaseUrl: PUBLIC_BASE_URL,
    });

    const session = store.create(TENANT_ID, 'telephony', { callSid: 'CA-notify' });
    session.transcript.push('caller: necesito agendar una cita para mi aire acondicionado');

    const notify: SideEffect = {
      type: 'notify_oncall',
      payload: { reason: 'operator_request', callerPhone: '+15125550142' },
    };
    await processor.executeSideEffects(session, [notify], TENANT_ID);

    // Context SMS went to the single transfer line (the receiving CSR).
    expect(deliveryProvider.sendSms).toHaveBeenCalledTimes(1);
    expect(sent[0].to).toBe(TRANSFER_NUMBER);
    expect(sent[0].body).toContain('Acme Plumbing');
    // The bridge TwiML is queued and dials the transfer number.
    const twiml = pendingTransferTwiml.get(session.id);
    expect(twiml).toBeDefined();
    expect(twiml).toContain(TRANSFER_NUMBER);
  });

  it('hydrates CRM into the context SMS / whisper when customer repos are wired', async () => {
    const store = new VoiceSessionStore({ startInterval: false });
    const auditRepo = new InMemoryAuditRepository();
    const onCallRepo = new InMemoryOnCallRepository();
    const callControl = new DefaultTwilioCallControl();
    const pendingTransferTwiml = new Map<string, string>();
    const { WhisperCache } = await import('../../src/telephony/whisper-cache');
    const whisperCache = new WhisperCache();
    const sent: { to: string; body: string }[] = [];
    const deliveryProvider = {
      sendSms: vi.fn(async (a: { to: string; body: string }) => {
        sent.push(a);
      }),
    };
    const settingsRepo = {
      findByTenant: vi.fn(
        async () =>
          ({ transferNumber: TRANSFER_NUMBER, businessName: 'Acme Plumbing' } as unknown as TenantSettings),
      ),
    } as unknown as SettingsRepository;

    const { InMemoryCustomerRepository } = await import('../../src/customers/customer');
    const { InMemoryTagRepository } = await import('../../src/customers/tag');
    const { InMemoryJobRepository } = await import('../../src/jobs/job');
    const { InMemoryAgreementRepository } = await import('../../src/agreements/agreement');

    const customerRepo = new InMemoryCustomerRepository();
    const tagRepo = new InMemoryTagRepository();
    const jobRepo = new InMemoryJobRepository();
    const agreementRepo = new InMemoryAgreementRepository();
    const customerId = '22222222-2222-4222-8222-222222222222';
    await customerRepo.create({
      id: customerId,
      tenantId: TENANT_ID,
      firstName: 'María',
      lastName: 'López',
      displayName: 'María López',
      preferredChannel: 'phone',
      smsConsent: true,
      isArchived: false,
      createdBy: 'test',
      createdAt: new Date(),
      updatedAt: new Date(),
      primaryPhone: '+15125550142',
      communicationNotes: 'Prefers mornings.',
    });
    await tagRepo.addTag(TENANT_ID, customerId, 'vip');
    await jobRepo.create({
      id: 'job-1',
      tenantId: TENANT_ID,
      customerId,
      locationId: 'loc-1',
      jobNumber: 'J-1',
      summary: 'AC tune-up',
      status: 'completed',
      priority: 'normal',
      createdBy: 'test',
      createdAt: new Date('2026-01-10T12:00:00Z'),
      updatedAt: new Date('2026-01-10T12:00:00Z'),
      completedAt: new Date('2026-01-10T15:00:00Z'),
    });
    await agreementRepo.create({
      id: 'agr-1',
      tenantId: TENANT_ID,
      customerId,
      name: 'Gold Plan',
      recurrenceRule: 'FREQ=YEARLY',
      priceCents: 29900,
      autoGenerateInvoice: false,
      autoGenerateJob: false,
      nextRunAt: new Date(),
      status: 'active',
      startsOn: '2025-01-01',
      endsOn: '2027-01-01',
      memberDiscountBps: 1000,
      createdBy: 'test',
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const processor = createVoiceTurnProcessor({
      store,
      gateway: makeGateway('{}'),
      businessName: 'Acme Plumbing',
      systemActorId: 'test-actor',
      auditRepo,
      onCallRepo,
      callControl,
      settingsRepo,
      deliveryProvider,
      pendingTransferTwiml,
      publicBaseUrl: PUBLIC_BASE_URL,
      whisperCache,
      customerRepo,
      tagRepo,
      jobRepo,
      agreementRepo,
    });

    const session = store.create(TENANT_ID, 'telephony', { callSid: 'CA-crm' });
    session.transcript.push('caller: necesito una cita');

    await processor.executeSideEffects(
      session,
      [
        {
          type: 'notify_oncall',
          payload: { reason: 'operator_request', callerPhone: '+15125550142' },
        },
      ],
      TENANT_ID,
    );

    expect(sent[0]?.body).toMatch(/Gold Plan member|Member/i);
    const escMatch = sent[0]?.body.match(/\/c\/(esc_[A-Za-z0-9-]+)/);
    expect(escMatch).toBeTruthy();
    const whisperText = whisperCache.get(escMatch![1]);
    expect(whisperText).toMatch(/Gold Plan member|Member/i);
  });

  it('does not expose the bridge TwiML until the context SMS resolves', async () => {
    const store = new VoiceSessionStore({ startInterval: false });
    const auditRepo = new InMemoryAuditRepository();
    const onCallRepo = new InMemoryOnCallRepository();
    const callControl = new DefaultTwilioCallControl();
    const pendingTransferTwiml = new Map<string, string>();
    // Gate the SMS so we can observe ordering: the Dial TwiML must not be
    // exposed until provider acceptance resolves.
    let releaseSms: () => void = () => {};
    const smsGate = new Promise<void>((resolve) => {
      releaseSms = resolve;
    });
    const deliveryProvider = { sendSms: vi.fn(async () => smsGate) };
    const settingsRepo = {
      findByTenant: vi.fn(
        async () =>
          ({ transferNumber: TRANSFER_NUMBER, businessName: 'Acme Plumbing' } as unknown as TenantSettings),
      ),
    } as unknown as SettingsRepository;

    const processor = createVoiceTurnProcessor({
      store,
      gateway: makeGateway('{}'),
      businessName: 'Acme Plumbing',
      systemActorId: 'test-actor',
      auditRepo,
      onCallRepo,
      callControl,
      settingsRepo,
      deliveryProvider,
      pendingTransferTwiml,
      publicBaseUrl: PUBLIC_BASE_URL,
    });

    const session = store.create(TENANT_ID, 'telephony', { callSid: 'CA-order' });
    session.transcript.push('caller: necesito una cita');

    const notify: SideEffect = {
      type: 'notify_oncall',
      payload: { reason: 'operator_request', callerPhone: '+15125550142' },
    };
    const pending = processor.executeSideEffects(session, [notify], TENANT_ID);

    // SMS is in flight but not yet accepted → the bridge must NOT be exposed.
    await new Promise((r) => setTimeout(r, 0));
    expect(deliveryProvider.sendSms).toHaveBeenCalledTimes(1);
    expect(pendingTransferTwiml.get(session.id)).toBeUndefined();

    // Provider accepts the SMS → the handler proceeds to expose the bridge.
    releaseSms();
    await pending;
    expect(pendingTransferTwiml.get(session.id)).toContain(TRANSFER_NUMBER);

    store.dispose();
  });
});

// ── Part 2 — failed transfer → call_me_back ──────────────────────────────────
interface TransferHarness {
  app: express.Application;
  store: VoiceSessionStore;
  callMeBackRepo: InMemoryCallMeBackRepository;
  auditRepo: InMemoryAuditRepository;
}

function buildTransferHarness(): TransferHarness {
  const store = new VoiceSessionStore({ startInterval: false });
  const callControl = new DefaultTwilioCallControl();
  const auditRepo = new InMemoryAuditRepository();
  const callMeBackRepo = new InMemoryCallMeBackRepository();
  const settingsRepo = {
    findByTenant: vi.fn(
      async () =>
        ({ transferNumber: TRANSFER_NUMBER, businessName: 'Acme Plumbing' } as unknown as TenantSettings),
    ),
  } as unknown as SettingsRepository;

  const adapter = new TwilioGatherAdapter({
    store,
    gateway: makeGateway('{"intentType":"unknown","confidence":0}'),
    businessName: 'Acme Plumbing',
    publicBaseUrl: PUBLIC_BASE_URL,
    callControl,
    onCallRepo: new InMemoryOnCallRepository(),
    auditRepo,
    // NB: no dispatcherPhoneResolver — the transfer_number model is in play.
  });

  const app = express();
  app.use(
    '/api/telephony',
    createTelephonyRouter({
      adapter,
      authTokenGetter: () => AUTH_TOKEN,
      publicBaseUrl: PUBLIC_BASE_URL,
      resolveTenantId: () => TENANT_ID,
      businessName: 'Acme Plumbing',
      settingsRepo,
      callMeBackRepo,
      auditRepo,
    }),
  );
  return { app, store, callMeBackRepo, auditRepo };
}

function signedPost(
  app: express.Application,
  path: string,
  params: Record<string, string>,
) {
  const url = `${PUBLIC_BASE_URL}${path}`;
  const sig = twilio.getExpectedTwilioSignature(AUTH_TOKEN, url, params);
  return request(app).post(path).set('X-Twilio-Signature', sig).type('form').send(params);
}

describe('Feature 7 — failed transfer schedules a call_me_back task', () => {
  it('on no-answer prompts for a callback message (no rotation cascade)', async () => {
    const { app, store } = buildTransferHarness();
    const session = store.create(TENANT_ID, 'telephony', { callSid: 'CA-fail' });

    const res = await signedPost(app, `/api/telephony/dial-result?sid=${session.id}`, {
      CallSid: 'CA-fail',
      DialCallStatus: 'no-answer',
      From: '+15125550142',
      To: '+15125550999',
    });

    expect(res.status).toBe(200);
    // Returns to the caller and gathers a callback message — not a second <Dial>.
    expect(res.text).toContain('<Gather');
    expect(res.text).toContain('/api/telephony/callback-message');
    expect(res.text).not.toContain('<Dial');
    expect(res.text).toMatch(/call you right back/i);
  });

  it('callback-message captures the message, schedules the task, and acknowledges', async () => {
    const { app, store, callMeBackRepo, auditRepo } = buildTransferHarness();
    const session = store.create(TENANT_ID, 'telephony', { callSid: 'CA-fail-2' });

    const res = await signedPost(
      app,
      `/api/telephony/callback-message?sid=${session.id}`,
      {
        CallSid: 'CA-fail-2',
        From: '+15125550142',
        To: '+15125550999',
        SpeechResult: 'My water heater is leaking, please call me back this afternoon.',
      },
    );

    expect(res.status).toBe(200);
    expect(res.text).toContain('<Hangup');
    expect(res.text).toMatch(/call you back/i);

    // A pending call_me_back task was scheduled with the caller's message.
    const pending = await callMeBackRepo.listPending(TENANT_ID);
    expect(pending).toHaveLength(1);
    expect(pending[0].callerPhone).toBe('+15125550142');
    expect(pending[0].callbackMessage).toContain('water heater is leaking');
    expect(pending[0].reason).toBe('transfer_failed');

    // The scheduling was audited.
    const scheduled = auditRepo
      .getAll()
      .filter((e) => e.eventType === 'call_me_back.scheduled');
    expect(scheduled).toHaveLength(1);
  });

  it('schedules a task even when the caller leaves no message (silent timeout)', async () => {
    const { app, store, callMeBackRepo } = buildTransferHarness();
    const session = store.create(TENANT_ID, 'telephony', { callSid: 'CA-silent' });

    const res = await signedPost(
      app,
      `/api/telephony/callback-message?sid=${session.id}`,
      { CallSid: 'CA-silent', From: '+15125550143', To: '+15125550999' },
    );

    expect(res.status).toBe(200);
    const pending = await callMeBackRepo.listPending(TENANT_ID);
    expect(pending).toHaveLength(1);
    expect(pending[0].callbackMessage).toBeUndefined();
  });
});
