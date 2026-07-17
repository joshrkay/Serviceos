import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  TwilioGatherAdapter,
  buildTwiML,
  xmlEscape,
  buildTelephonyGreeting,
  injectSafetySayLines,
} from '../../src/telephony/twilio-adapter';
import { VoiceSessionStore } from '../../src/ai/agents/customer-calling/voice-session-store';
import type { LLMGateway, LLMResponse } from '../../src/ai/gateway/gateway';
import { DefaultTwilioCallControl } from '../../src/telephony/twilio-call-control';
import {
  InMemoryOnCallRepository,
  type OnCallEntry,
} from '../../src/oncall/rotation';
import { InMemoryAuditRepository } from '../../src/audit/audit';
import { InMemoryProposalRepository, createProposal } from '../../src/proposals/proposal';
import { InMemoryLeadRepository } from '../../src/leads/lead';
import { InMemoryVoiceSessionRepository } from '../../src/voice/voice-session';
import { MEDIA_STREAM_PATH } from '../../src/telephony/media-streams/twilio-mediastream-server';
import { InMemorySettingsRepository, type TenantSettings } from '../../src/settings/settings';
import { InMemoryAppointmentRepository } from '../../src/appointments/in-memory-appointment';
import type { Appointment } from '../../src/appointments/appointment';
import { InMemoryJobRepository, type Job } from '../../src/jobs/job';
import { InMemoryDailyDigestRepository } from '../../src/digest/digest-service';
import { InMemoryEstimateRepository, type Estimate } from '../../src/estimates/estimate';
import { InMemoryInvoiceRepository, type Invoice } from '../../src/invoices/invoice';
import type { DocumentTotals } from '../../src/shared/billing-engine';
import { InMemoryDroppedCallRecoveryRepository } from '../../src/sms/recovery/scheduler';
import { InMemoryConversationRepository } from '../../src/conversations/conversation-service';
import { OwnerNotificationService } from '../../src/notifications/owner-notification-service';
import { InMemoryPushDeliveryProvider } from '../../src/notifications/push-delivery-provider';
import { InMemoryDeviceTokenRepository } from '../../src/push/device-token-service';
import { setOwnerNotifications } from '../../src/notifications/owner-notifications-instance';
import type { Pool } from 'pg';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeGatewayReturning(content: string): LLMGateway {
  const response: LLMResponse = {
    content,
    model: 'mock-model',
    provider: 'mock',
    tokenUsage: { input: 1, output: 1, total: 2 },
    latencyMs: 1,
  };
  const gateway = {
    complete: vi.fn().mockResolvedValue(response),
  } as unknown as LLMGateway;
  return gateway;
}

function makeAdapter(opts: {
  gateway?: LLMGateway;
  store?: VoiceSessionStore;
  leadRepo?: InMemoryLeadRepository;
  auditRepo?: InMemoryAuditRepository;
  pool?: Pool;
  conversationRepo?: InMemoryConversationRepository;
} = {}) {
  const store = opts.store ?? new VoiceSessionStore();
  const gateway =
    opts.gateway ??
    makeGatewayReturning('{"intentType":"unknown","confidence":0,"reasoning":"x"}');
  const leadRepo = opts.leadRepo;
  const auditRepo = opts.auditRepo;
  const adapter = new TwilioGatherAdapter({
    store,
    gateway,
    businessName: 'Acme Plumbing',
    publicBaseUrl: 'https://example.com',
    ...(leadRepo ? { leadRepo } : {}),
    ...(auditRepo ? { auditRepo } : {}),
    ...(opts.pool ? { pool: opts.pool } : {}),
    ...(opts.conversationRepo ? { conversationRepo: opts.conversationRepo } : {}),
  });
  return { adapter, store, gateway, leadRepo, auditRepo };
}

/** Fake pool whose only query — identifyCaller's customers lookup — returns one
 *  matched customer, so handleInbound takes the known-caller branch. */
function matchedCallerPool(customerId: string, displayName: string): Pool {
  return {
    query: async (sql: string) =>
      typeof sql === 'string' && sql.includes('FROM customers')
        ? { rows: [{ id: customerId, display_name: displayName }] }
        : { rows: [] },
  } as unknown as Pool;
}

// ─── xmlEscape ───────────────────────────────────────────────────────────────

describe('xmlEscape', () => {
  it('escapes the five XML metacharacters', () => {
    expect(xmlEscape(`a&b<c>d"e'f`)).toBe(
      'a&amp;b&lt;c&gt;d&quot;e&apos;f'
    );
  });
});

// ─── buildTwiML ──────────────────────────────────────────────────────────────

describe('buildTwiML', () => {
  it('emits <Say> for tts_play side effects with Polly voice', () => {
    const xml = buildTwiML(
      [{ type: 'tts_play', payload: { text: 'Hello' } }],
      { gatherActionUrl: 'https://x.test/gather' },
    );
    expect(xml).toContain('<Say voice="Polly.Joanna">Hello</Say>');
    expect(xml).toContain('<Gather input="speech"');
    expect(xml).toContain('action="https://x.test/gather"');
  });

  it('escapes XML in tts_play text', () => {
    const xml = buildTwiML(
      [{ type: 'tts_play', payload: { text: 'A & B <c>' } }],
      { gatherActionUrl: '/g' },
    );
    expect(xml).toContain('A &amp; B &lt;c&gt;');
  });

  it('emits <Hangup/> on end_session and omits <Gather>', () => {
    const xml = buildTwiML(
      [
        { type: 'tts_play', payload: { text: 'Goodbye' } },
        { type: 'end_session', payload: { reason: 'normal_close' } },
      ],
      { gatherActionUrl: '/g' },
    );
    expect(xml).toContain('<Hangup/>');
    expect(xml).not.toContain('<Gather');
  });

  it('produces no <Say> for audit_log / create_proposal / notify_oncall side effects', () => {
    const xml = buildTwiML(
      [
        { type: 'audit_log', payload: {} },
        { type: 'create_proposal', payload: {} },
        { type: 'notify_oncall', payload: {} },
      ],
      { gatherActionUrl: '/g' },
    );
    expect(xml).not.toContain('<Say');
    expect(xml).toContain('<Gather');
  });

  it('always closes with <Gather> when not ended', () => {
    const xml = buildTwiML([], { gatherActionUrl: '/g' });
    expect(xml).toContain('<Gather');
    expect(xml).not.toContain('<Hangup');
  });

  it('P11-002: language=es uses the Spanish Polly voice + es-US Gather locale', () => {
    const xml = buildTwiML(
      [{ type: 'tts_play', payload: { text: 'Hola' } }],
      { gatherActionUrl: '/g', language: 'es' },
    );
    expect(xml).toContain('<Say voice="Polly.Mia-Neural">Hola</Say>');
    expect(xml).toContain('language="es-US"');
  });

  it('P11-002: voiceOverride wins over the language-derived default for <Say>', () => {
    const xml = buildTwiML(
      [{ type: 'tts_play', payload: { text: 'Hola' } }],
      { gatherActionUrl: '/g', language: 'es', voiceOverride: 'Polly.Lupe-Neural' },
    );
    expect(xml).toContain('<Say voice="Polly.Lupe-Neural">Hola</Say>');
    // STT locale still follows language, not the voice override.
    expect(xml).toContain('language="es-US"');
  });

  it('XML-escapes the voice attribute so a malformed override cannot break TwiML', () => {
    const xml = buildTwiML(
      [{ type: 'tts_play', payload: { text: 'Hi' } }],
      { gatherActionUrl: '/g', voiceOverride: 'a"><Hangup/>' },
    );
    expect(xml).not.toContain('"><Hangup/>');
    expect(xml).toContain('a&quot;&gt;&lt;Hangup/&gt;');
  });

  // ─── P8-014: recordingStatusCallback wiring ────────────────────────────────

  describe('recordingStatusCallback (P8-014 record_call)', () => {
    it('emits a <Start><Record/></Start> block when recordingStatusCallback is set', () => {
      const xml = buildTwiML(
        [{ type: 'tts_play', payload: { text: 'Hi' } }],
        {
          gatherActionUrl: '/g',
          recordingStatusCallback: 'https://api.test/api/telephony/recording',
        },
      );
      expect(xml).toContain(
        '<Start><Record recordingStatusCallback="https://api.test/api/telephony/recording" recordingStatusCallbackMethod="POST"/></Start>'
      );
    });

    it('omits the <Start><Record/></Start> block when recordingStatusCallback is unset', () => {
      const xml = buildTwiML(
        [{ type: 'tts_play', payload: { text: 'Hi' } }],
        { gatherActionUrl: '/g' },
      );
      expect(xml).not.toContain('<Record');
      expect(xml).not.toContain('<Start');
    });

    it('escapes XML metacharacters in the callback URL', () => {
      const xml = buildTwiML(
        [],
        {
          gatherActionUrl: '/g',
          recordingStatusCallback: 'https://api.test/recording?a=1&b=2',
        },
      );
      expect(xml).toContain('a=1&amp;b=2');
    });
  });
});



describe('TwilioGatherAdapter.buildStreamTwiML', () => {
  it('uses the canonical MEDIA_STREAM_PATH for the <Stream> URL', () => {
    const { adapter } = makeAdapter();
    const xml = adapter.buildStreamTwiML({ sessionId: 's-1', callSid: 'CA-1' });
    expect(xml).toContain(`wss://example.com${MEDIA_STREAM_PATH}`);
  });
});

// ─── handleInbound ───────────────────────────────────────────────────────────

describe('TwilioGatherAdapter.handleInbound', () => {
  it('creates a session, plays a greeting, and emits a Gather TwiML response', async () => {
    const { adapter, store } = makeAdapter();
    const xml = await adapter.handleInbound({
      callSid: 'CA-test',
      from: '+15125550100',
      to: '+15125550999',
      tenantId: 'tenant-abc',
    });

    // Session was created.
    const sessions = await Promise.all(
      Array.from((store as unknown as { sessions: Map<string, unknown> }).sessions.keys())
        .map((id) => store.snapshot(id))
    );
    expect(sessions.length).toBe(1);
    expect(sessions[0]?.tenantId).toBe('tenant-abc');
    expect(sessions[0]?.callSid).toBe('CA-test');

    // TwiML contains greeting + recording disclosure.
    expect(xml).toContain('<Say voice="Polly.Joanna">');
    expect(xml).toMatch(/Acme Plumbing/);
    expect(xml).toMatch(/recorded/i);
    expect(xml).toContain('<Gather input="speech"');
    expect(xml).toContain('action="https://example.com/api/telephony/gather?sid=');
  });

  it('logs an identified inbound caller on their conversation timeline', async () => {
    const conversationRepo = new InMemoryConversationRepository();
    const { adapter } = makeAdapter({
      pool: matchedCallerPool('cust-known', 'Jane Smith'),
      conversationRepo,
    });

    await adapter.handleInbound({
      callSid: 'CA-known',
      from: '+15125550100',
      to: '+15125550999',
      tenantId: 'tenant-abc',
    });

    const threads = await conversationRepo.findByEntity('tenant-abc', 'customer', 'cust-known');
    expect(threads).toHaveLength(1);
    const msgs = await conversationRepo.getMessages('tenant-abc', threads[0].id);
    const callLog = msgs.find((m) => m.source === 'inbound_call');
    expect(callLog).toBeTruthy();
    expect(callLog!.metadata).toMatchObject({ direction: 'inbound', channel: 'call', callSid: 'CA-known' });
    expect(callLog!.content).toMatch(/^Inbound call from/);
  });

  it('does not log a call timeline for an unknown caller', async () => {
    const conversationRepo = new InMemoryConversationRepository();
    const { adapter } = makeAdapter({ conversationRepo }); // no pool → caller unknown
    await adapter.handleInbound({
      callSid: 'CA-unknown',
      from: '+15125550100',
      to: '+15125550999',
      tenantId: 'tenant-abc',
    });
    const threads = await conversationRepo.findByEntity('tenant-abc', 'customer', 'cust-known');
    expect(threads).toHaveLength(0);
  });

  it('P8-014: handleInbound emits <Start><Record/></Start> when recordingCallbackPath is set', async () => {
    const store = new VoiceSessionStore();
    const gateway = makeGatewayReturning('{"intentType":"unknown","confidence":0,"reasoning":"x"}');
    const adapter = new TwilioGatherAdapter({
      store,
      gateway,
      businessName: 'Acme Plumbing',
      publicBaseUrl: 'https://example.com',
      recordingCallbackPath: '/api/telephony/recording',
    });
    const xml = await adapter.handleInbound({
      callSid: 'CA-rec',
      from: '+15125550100',
      to: '+15125550999',
      tenantId: 'tenant-abc',
    });
    expect(xml).toContain(
      '<Start><Record recordingStatusCallback="https://example.com/api/telephony/recording"',
    );
    // The replay path (second handleInbound for the same CallSid) must
    // NOT emit a second <Record/> block — Twilio is already recording.
    const replay = await adapter.handleInbound({
      callSid: 'CA-rec',
      from: '+15125550100',
      to: '+15125550999',
      tenantId: 'tenant-abc',
    });
    expect(replay).not.toContain('<Record');
  });

  it('P11-002: a Spanish-default tenant gets a Spanish greeting + voice override, and the replay path keeps them', async () => {
    const store = new VoiceSessionStore();
    const settingsRepo = new InMemorySettingsRepository();
    const now = new Date();
    const settings: TenantSettings = {
      id: 's-1',
      tenantId: 'tenant-es',
      businessName: 'Acme Plumbing',
      timezone: 'America/Chicago',
      estimatePrefix: 'EST-',
      invoicePrefix: 'INV-',
      nextEstimateNumber: 1,
      nextInvoiceNumber: 1,
      defaultPaymentTermDays: 30,
      defaultLanguage: 'es',
      autoDetectLanguage: true,
      ttsVoiceEs: 'Polly.Lupe-Neural',
      createdAt: now,
      updatedAt: now,
    };
    await settingsRepo.create(settings);
    const adapter = new TwilioGatherAdapter({
      store,
      gateway: makeGatewayReturning('{"intentType":"unknown","confidence":0,"reasoning":"x"}'),
      businessName: 'Acme Plumbing',
      publicBaseUrl: 'https://example.com',
      settingsRepo,
    });

    const first = await adapter.handleInbound({
      callSid: 'CA-es',
      from: '+15125550100',
      to: '+15125550999',
      tenantId: 'tenant-es',
    });
    expect(first).toContain('Gracias por llamar a Acme Plumbing');
    expect(first).toContain('language="es-US"');
    expect(first).toContain('<Say voice="Polly.Lupe-Neural">');

    // Twilio retries the /voice webhook → replay branch. It must keep the
    // session's Spanish language + voice, not fall back to English.
    const replay = await adapter.handleInbound({
      callSid: 'CA-es',
      from: '+15125550100',
      to: '+15125550999',
      tenantId: 'tenant-es',
    });
    expect(replay).toContain('Un momento, por favor.');
    expect(replay).toContain('language="es-US"');
    expect(replay).toContain('<Say voice="Polly.Lupe-Neural">');
    expect(replay).not.toContain('One moment, please.');
  });

  it('P8-014: handleInbound omits <Record/> when recordingCallbackPath is unset', async () => {
    const { adapter } = makeAdapter();
    const xml = await adapter.handleInbound({
      callSid: 'CA-no-rec',
      from: '+15125550100',
      to: '+15125550999',
      tenantId: 'tenant-abc',
    });
    expect(xml).not.toContain('<Record');
  });

  it('drives the FSM into intent_capture (or ask_caller) after inbound', async () => {
    const { adapter, store } = makeAdapter();
    await adapter.handleInbound({
      callSid: 'CA-test-2',
      from: '+15125550100',
      to: '+15125550999',
      tenantId: 'tenant-abc',
    });

    const ids = Array.from(
      (store as unknown as { sessions: Map<string, unknown> }).sessions.keys()
    );
    const snap = await store.snapshot(ids[0] as string);
    // Without a Pool, the caller is unknown → ask_caller.
    expect(['ask_caller', 'intent_capture']).toContain(snap?.state);
  });

  // ─── P9 inbound-call → CRM lead ────────────────────────────────────────────
  // The receptionist must auto-create a `phone_call` lead for unknown
  // callers and stash the leadId on the session so subsequent gather
  // turns can attach intent / notes to the right kanban card.

  it('creates a phone_call lead for an unknown caller and stashes leadId on the session', async () => {
    const leadRepo = new InMemoryLeadRepository();
    const auditRepo = new InMemoryAuditRepository();
    const { adapter, store } = makeAdapter({ leadRepo, auditRepo });

    await adapter.handleInbound({
      callSid: 'CA-lead-1',
      from: '+15125550100',
      to: '+15125550999',
      tenantId: 'tenant-abc',
    });

    expect(leadRepo.getAll()).toHaveLength(1);
    const [created] = leadRepo.getAll();
    expect(created.source).toBe('phone_call');
    expect(created.primaryPhone).toBe('+15125550100');
    expect(created.createdBy).toBe('system:inbound-call');
    expect(created.stage).toBe('new');

    const ids = Array.from(
      (store as unknown as { sessions: Map<string, unknown> }).sessions.keys()
    );
    const snap = store.snapshot(ids[0] as string);
    expect(snap?.leadId).toBe(created.id);

    // Audit event was emitted.
    const audits = auditRepo.getAll();
    expect(audits.find((a) => a.eventType === 'lead.created')).toBeTruthy();
  });

  it('does NOT create a duplicate lead on Twilio CallSid retry', async () => {
    const leadRepo = new InMemoryLeadRepository();
    const { adapter } = makeAdapter({ leadRepo });

    await adapter.handleInbound({
      callSid: 'CA-retry',
      from: '+15125550100',
      to: '+15125550999',
      tenantId: 'tenant-abc',
    });
    await adapter.handleInbound({
      callSid: 'CA-retry',
      from: '+15125550100',
      to: '+15125550999',
      tenantId: 'tenant-abc',
    });

    expect(leadRepo.getAll()).toHaveLength(1);
  });

  it('reuses an existing lead on a second call from the same number', async () => {
    const leadRepo = new InMemoryLeadRepository();
    const { adapter, store } = makeAdapter({ leadRepo });

    await adapter.handleInbound({
      callSid: 'CA-first',
      from: '+15125550100',
      to: '+15125550999',
      tenantId: 'tenant-abc',
    });
    const firstLeadId = leadRepo.getAll()[0].id;

    await adapter.handleInbound({
      callSid: 'CA-second',
      from: '+1 (512) 555-0100',
      to: '+15125550999',
      tenantId: 'tenant-abc',
    });

    expect(leadRepo.getAll()).toHaveLength(1);
    const sessionIds = Array.from(
      (store as unknown as { sessions: Map<string, unknown> }).sessions.keys()
    );
    // Latest session reuses the same lead.
    const latest = store.snapshot(sessionIds[sessionIds.length - 1] as string);
    expect(latest?.leadId).toBe(firstLeadId);
  });

  it('answers the call without throwing when leadRepo is not wired', async () => {
    const { adapter, store } = makeAdapter(); // no leadRepo
    const xml = await adapter.handleInbound({
      callSid: 'CA-no-repo',
      from: '+15125550100',
      to: '+15125550999',
      tenantId: 'tenant-abc',
    });

    expect(xml).toContain('<Gather input="speech"');
    const ids = Array.from(
      (store as unknown as { sessions: Map<string, unknown> }).sessions.keys()
    );
    const snap = store.snapshot(ids[0] as string);
    expect(snap?.leadId).toBeUndefined();
  });
});

// ─── WS16c — transport convergence (stream gains Gather-parity features) ──────

describe('WS16c — inbound establishment convergence (Media Streams ↔ Gather)', () => {
  it('owner "incoming call" push fires on stream establishment (divergence #5 converged)', async () => {
    const repo = new InMemoryDeviceTokenRepository();
    const provider = new InMemoryPushDeliveryProvider();
    await repo.register({
      tenantId: 'tenant-abc',
      userId: 'owner-1',
      expoPushToken: 'ExponentPushToken[a]',
      platform: 'ios',
    });
    setOwnerNotifications(new OwnerNotificationService({ deviceTokenRepo: repo, provider }));
    try {
      const { adapter } = makeAdapter({ pool: matchedCallerPool('cust-known', 'Jane Smith') });
      // Phase A (webhook) then Phase B (post-WS-start bootstrap).
      await adapter.handleInboundForStream({
        callSid: 'CA-stream-push',
        from: '+15125550100',
        tenantId: 'tenant-abc',
      });
      await adapter.initializeStreamSession({ callSid: 'CA-stream-push', tenantId: 'tenant-abc' });

      // Exactly one owner push — realtime callers used to get NONE.
      expect(provider.sent).toHaveLength(1);
      expect(provider.sent[0].data?.type).toBe('incoming_call');
      expect(provider.sent[0].data?.screen).toBe('/customers/cust-known');
      expect(provider.sent[0].body).toContain('Jane Smith');
    } finally {
      setOwnerNotifications(undefined);
    }
  });

  it('inbound call is logged on the customer timeline on stream establishment (divergence #4 converged)', async () => {
    const conversationRepo = new InMemoryConversationRepository();
    const { adapter } = makeAdapter({
      pool: matchedCallerPool('cust-known', 'Jane Smith'),
      conversationRepo,
    });
    await adapter.handleInboundForStream({
      callSid: 'CA-stream-log',
      from: '+15125550100',
      tenantId: 'tenant-abc',
    });
    await adapter.initializeStreamSession({ callSid: 'CA-stream-log', tenantId: 'tenant-abc' });

    const threads = await conversationRepo.findByEntity('tenant-abc', 'customer', 'cust-known');
    expect(threads).toHaveLength(1);
    const msgs = await conversationRepo.getMessages('tenant-abc', threads[0].id);
    const callLog = msgs.find((m) => m.source === 'inbound_call');
    expect(callLog).toBeTruthy();
    expect(callLog!.metadata).toMatchObject({
      direction: 'inbound',
      channel: 'call',
      callSid: 'CA-stream-log',
    });
  });

  it('identify-guard parity: a blocked/empty caller-id skips identifyCaller on BOTH transports (divergence #3 converged)', async () => {
    // Count identifyCaller's customers lookup on a shared spy pool.
    let customersQueries = 0;
    const pool = {
      query: async (sql: string) => {
        if (typeof sql === 'string' && sql.includes('FROM customers')) customersQueries += 1;
        return { rows: [] };
      },
    } as unknown as Pool;

    // Gather, blocked From ('') — previously ran identifyCaller('') anyway.
    const gather = makeAdapter({ pool });
    await gather.adapter.handleInbound({
      callSid: 'CA-blk-g',
      from: '',
      to: '+15125550999',
      tenantId: 'tenant-abc',
    });

    // Stream, blocked From ('') — already required `from`; stays skipped.
    const stream = makeAdapter({ pool });
    await stream.adapter.handleInboundForStream({
      callSid: 'CA-blk-s',
      from: '',
      tenantId: 'tenant-abc',
    });
    await stream.adapter.initializeStreamSession({ callSid: 'CA-blk-s', tenantId: 'tenant-abc' });

    // Neither transport hits the DB for a caller with no phone to key on.
    expect(customersQueries).toBe(0);
  });

  it('identify-guard parity: a present caller-id DOES identify on the stream transport', async () => {
    // Positive control so the parity assertion above can't pass by identify
    // being dead-wired off. A matched pool + real From → known caller push.
    const { adapter, store } = makeAdapter({ pool: matchedCallerPool('cust-known', 'Jane Smith') });
    await adapter.handleInboundForStream({
      callSid: 'CA-stream-known',
      from: '+15125550100',
      tenantId: 'tenant-abc',
    });
    await adapter.initializeStreamSession({ callSid: 'CA-stream-known', tenantId: 'tenant-abc' });

    const session = store.findByCallSid('CA-stream-known');
    expect(session?.customerId).toBe('cust-known');
    // WS16c #2 — callerPhone is now pinned on the stream session too.
    expect(session?.callerPhone).toBe('+15125550100');
  });
});

// ─── handleGather ────────────────────────────────────────────────────────────

// ─── P8-013 escalate-to-human telephony branch ───────────────────────────────

describe('P8-013 escalateToHuman telephony branch', () => {
  it('returns a transfer descriptor for the first dispatcher when callControl + resolver are wired', async () => {
    const { escalateToHuman } = await import(
      '../../src/ai/skills/escalate-to-human'
    );
    const onCallRepo = new InMemoryOnCallRepository(
      new Map([
        [
          'tenant-abc',
          [
            { id: 'r1', userId: 'u1', orderIndex: 0 },
            { id: 'r2', userId: 'u2', orderIndex: 1 },
          ] as OnCallEntry[],
        ],
      ]),
    );
    const auditRepo = new InMemoryAuditRepository();
    const callControl = new DefaultTwilioCallControl();
    const resolver = vi.fn(async (_t: string, userId: string) => {
      if (userId === 'u1') return '+15125550101';
      return '+15125550102';
    });

    const result = await escalateToHuman({
      tenantId: 'tenant-abc',
      sessionId: 's-x',
      reason: 'caller_requested',
      channel: 'telephony',
      onCallRepo,
      auditRepo,
      callControl,
      dispatcherPhoneResolver: resolver,
      callSid: 'CA-1',
      dialActionUrl: 'https://api.test/api/telephony/dial-result?sid=s-x',
    });

    expect(result.escalated).toBe(true);
    expect(result.assignedUserId).toBe('u1');
    expect(result.transfer).toBeDefined();
    expect(result.transfer?.dispatcherPhone).toBe('+15125550101');
    expect(result.transfer?.rotationIndex).toBe(0);
    expect(result.transfer?.fallbackTwiml).toContain('<Dial');
    expect(result.transfer?.fallbackTwiml).toContain('+15125550101');
    expect(result.transfer?.fallbackTwiml).toContain('dial-result?sid=s-x');

    // Audit emitted with transfer_initiated outcome.
    const events = auditRepo.getAll();
    expect(events).toHaveLength(1);
    expect(events[0].metadata?.outcome).toBe('transfer_initiated');
    expect(events[0].metadata?.assignedUserId).toBe('u1');
  });

  it('walks the cursor: subsequent calls dial the next entry', async () => {
    const { escalateToHuman } = await import(
      '../../src/ai/skills/escalate-to-human'
    );
    const onCallRepo = new InMemoryOnCallRepository(
      new Map([
        [
          'tenant-abc',
          [
            { id: 'r1', userId: 'u1', orderIndex: 0 },
            { id: 'r2', userId: 'u2', orderIndex: 1 },
          ] as OnCallEntry[],
        ],
      ]),
    );
    const callControl = new DefaultTwilioCallControl();
    const resolver = async (_t: string, userId: string) =>
      userId === 'u1' ? '+15125550101' : '+15125550102';

    // First dial: u1.
    const r1 = await escalateToHuman({
      tenantId: 'tenant-abc',
      sessionId: 's-y',
      reason: 'caller_requested',
      channel: 'telephony',
      onCallRepo,
      callControl,
      dispatcherPhoneResolver: resolver,
      callSid: 'CA-y',
      dialActionUrl: '/dr',
    });
    expect(r1.transfer?.dispatcherUserId).toBe('u1');

    // escalateToHuman already called setCursorAfter(0) when picking u1,
    // so the second invocation walks from index 1 and lands on u2 with
    // no further cursor manipulation needed. (Pre-fix, this test had a
    // stray `advanceCursor` call to compensate for the cursor lag bug
    // Codex flagged on PR #220.)
    const r2 = await escalateToHuman({
      tenantId: 'tenant-abc',
      sessionId: 's-y',
      reason: 'caller_requested',
      channel: 'telephony',
      onCallRepo,
      callControl,
      dispatcherPhoneResolver: resolver,
      callSid: 'CA-y',
      dialActionUrl: '/dr',
    });
    expect(r2.transfer?.dispatcherUserId).toBe('u2');
    expect(r2.transfer?.rotationIndex).toBe(1);
  });

  it('returns escalated:false when rotation cursor is past the end', async () => {
    const { escalateToHuman } = await import(
      '../../src/ai/skills/escalate-to-human'
    );
    const onCallRepo = new InMemoryOnCallRepository(
      new Map([
        ['tenant-abc', [{ id: 'r1', userId: 'u1', orderIndex: 0 }] as OnCallEntry[]],
      ]),
    );
    const auditRepo = new InMemoryAuditRepository();
    const callControl = new DefaultTwilioCallControl();
    callControl.advanceCursor('s-z'); // index = 1, past the only entry
    const resolver = async () => '+15125550101';

    const result = await escalateToHuman({
      tenantId: 'tenant-abc',
      sessionId: 's-z',
      reason: 'caller_requested',
      channel: 'telephony',
      onCallRepo,
      auditRepo,
      callControl,
      dispatcherPhoneResolver: resolver,
      callSid: 'CA-z',
      dialActionUrl: '/dr',
    });

    expect(result.escalated).toBe(false);
    expect(result.transfer).toBeUndefined();
    expect(auditRepo.getAll()[0]?.metadata?.outcome).toBe('no_dispatcher_available');
  });

  it('skips entries whose phone resolver returns null', async () => {
    const { escalateToHuman } = await import(
      '../../src/ai/skills/escalate-to-human'
    );
    const onCallRepo = new InMemoryOnCallRepository(
      new Map([
        [
          'tenant-abc',
          [
            { id: 'r1', userId: 'u1', orderIndex: 0 },
            { id: 'r2', userId: 'u2', orderIndex: 1 },
          ] as OnCallEntry[],
        ],
      ]),
    );
    const callControl = new DefaultTwilioCallControl();
    const resolver = async (_t: string, userId: string) =>
      userId === 'u1' ? null : '+15125550102';

    const result = await escalateToHuman({
      tenantId: 'tenant-abc',
      sessionId: 's-skip',
      reason: 'caller_requested',
      channel: 'telephony',
      onCallRepo,
      callControl,
      dispatcherPhoneResolver: resolver,
      callSid: 'CA-skip',
      dialActionUrl: '/dr',
    });

    expect(result.transfer?.dispatcherUserId).toBe('u2');
  });
});

describe('TwilioGatherAdapter.handleGather', () => {
  let gateway: LLMGateway;
  let adapter: TwilioGatherAdapter;
  let store: VoiceSessionStore;
  let sessionId: string;

  beforeEach(async () => {
    gateway = makeGatewayReturning(
      JSON.stringify({
        intentType: 'create_invoice',
        confidence: 0.92,
        reasoning: 'clear command',
        extractedEntities: { customerName: 'Acme', amount: 45000 },
      })
    );
    const built = makeAdapter({ gateway });
    adapter = built.adapter;
    store = built.store;
    await adapter.handleInbound({
      callSid: 'CA-gx',
      from: '+15125550100',
      to: '+15125550999',
      tenantId: 'tenant-abc',
    });
    const ids = Array.from(
      (store as unknown as { sessions: Map<string, unknown> }).sessions.keys()
    );
    sessionId = ids[0] as string;

    // Force the FSM forward to intent_capture so handleGather can classify.
    // Without a real customer DB we landed in ask_caller; emulate caller_known
    // so the test exercises the intent path.
    const session = await store.get(sessionId);
    if (session && session.machine.currentState === 'ask_caller') {
      session.machine.dispatch({ type: 'caller_known', customerId: 'cust-1' });
    }
  });

  describe('Phase-2 Track A owner lookup wiring', () => {
    const tenantId = 'tenant-owner';

    function advanceToIntentCapture(session: Awaited<ReturnType<VoiceSessionStore['get']>>) {
      if (!session) throw new Error('missing session');
      session.machine.dispatch({ type: 'incoming_call', tenantId, callSid: 'CA-owner', from: '+15125550111', to: '+15125550000' });
      session.machine.dispatch({ type: 'greeted_ok' });
      session.machine.dispatch({ type: 'caller_known', customerId: 'cust-temp' });
      session.customerId = undefined;
    }

    function totals(totalCents: number): DocumentTotals {
      return {
        subtotalCents: totalCents,
        discountCents: 0,
        taxRateBps: 0,
        taxableSubtotalCents: totalCents,
        taxCents: 0,
        totalCents,
      };
    }

    async function ownerAdapter(intentType: string, ownerSession = true, extendedIntents = true) {
      const store = new VoiceSessionStore();
      const gateway = makeGatewayReturning(JSON.stringify({ intentType, confidence: 0.96 }));
      const appointmentRepo = new InMemoryAppointmentRepository();
      const jobRepo = new InMemoryJobRepository();
      const proposalRepo = new InMemoryProposalRepository();
      const dailyDigestRepo = new InMemoryDailyDigestRepository();
      const estimateRepo = new InMemoryEstimateRepository();
      const invoiceRepo = new InMemoryInvoiceRepository();
      const droppedCallRecoveryRepo = new InMemoryDroppedCallRecoveryRepository();
      const adapter = new TwilioGatherAdapter({
        store,
        gateway,
        businessName: 'Acme Plumbing',
        publicBaseUrl: 'https://example.com',
        appointmentRepo,
        jobRepo,
        proposalRepo,
        dailyDigestRepo,
        estimateRepo,
        invoiceRepo,
        droppedCallRecoveryRepo,
      });
      const session = store.create(tenantId, 'telephony', {
        callSid: `CA-${intentType}`,
        ...(ownerSession ? { ownerSession: true } : {}),
        ...(extendedIntents ? { extendedIntents: true } : {}),
      });
      advanceToIntentCapture(session);
      return {
        adapter,
        session,
        appointmentRepo,
        jobRepo,
        proposalRepo,
        dailyDigestRepo,
        estimateRepo,
        invoiceRepo,
        droppedCallRecoveryRepo,
      };
    }

    it.each([
      ['lookup_day_overview', 'You have 1 appointment today'],
      ['lookup_digest', 'Owner digest: revenue was strong'],
      ['lookup_pending_items', '1 estimate is out waiting on a yes'],
    ])('owner session dispatches %s without a customerId and speaks the summary', async (intentType, expected) => {
      const deps = await ownerAdapter(intentType);
      await deps.jobRepo.create({
        id: 'job-owner-1',
        tenantId,
        customerId: 'cust-1',
        locationId: 'loc-1',
        jobNumber: 'JOB-1',
        summary: 'Main drain repair',
        status: 'scheduled',
        priority: 'normal',
        createdBy: 'u1',
        createdAt: new Date('2026-06-01T00:00:00.000Z'),
        updatedAt: new Date('2026-06-01T00:00:00.000Z'),
      } as Job);
      await deps.appointmentRepo.create({
        id: 'appt-owner-1',
        tenantId,
        jobId: 'job-owner-1',
        scheduledStart: new Date(),
        scheduledEnd: new Date(Date.now() + 60_000),
        status: 'scheduled',
        holdPendingApproval: false,
        createdBy: 'u1',
        createdAt: new Date(),
        updatedAt: new Date(),
      } as Appointment);
      await deps.proposalRepo.create(createProposal({
        tenantId,
        proposalType: 'draft_invoice',
        payload: {},
        summary: 'Needs approval',
        createdBy: 'u1',
      }));
      await deps.dailyDigestRepo.upsert(
        tenantId,
        new Date().toISOString().slice(0, 10),
        {} as Parameters<InMemoryDailyDigestRepository['upsert']>[2],
        'Owner digest: revenue was strong',
      );
      await deps.estimateRepo.create({
        id: 'est-owner-1',
        tenantId,
        jobId: 'job-owner-1',
        estimateNumber: 'EST-1',
        status: 'sent',
        lineItems: [],
        totals: totals(12300),
        sentAt: new Date(Date.now() - 86_400_000),
        version: 1,
        createdBy: 'u1',
        createdAt: new Date(),
        updatedAt: new Date(),
      } as Estimate);
      await deps.invoiceRepo.create({
        id: 'inv-owner-1',
        tenantId,
        jobId: 'job-owner-1',
        invoiceNumber: 'INV-1',
        status: 'open',
        lineItems: [],
        totals: totals(45600),
        amountPaidCents: 0,
        amountDueCents: 45600,
        createdBy: 'u1',
        createdAt: new Date(),
        updatedAt: new Date(),
      } as Invoice);

      const xml = await deps.adapter.handleGather({
        sessionId: deps.session.id,
        callSid: `CA-${intentType}`,
        speechResult: 'owner lookup please',
        confidence: 0.95,
        tenantId,
      });

      expect(xml).toContain(expected);
      expect(xml).toContain('Anything else I can help you with?');
    });

    it.each(['lookup_day_overview', 'lookup_digest', 'lookup_pending_items'])(
      'non-owner session refuses %s and speaks the existing lookup fallback',
      async (intentType) => {
        const deps = await ownerAdapter(intentType, false);
        const xml = await deps.adapter.handleGather({
          sessionId: deps.session.id,
          callSid: `CA-${intentType}-non-owner`,
          speechResult: 'owner lookup please',
          confidence: 0.95,
          tenantId,
        });

        expect(xml).toContain('I&apos;m having trouble pulling that up right now');
        expect(xml).not.toContain('Owner digest: revenue was strong');
      },
    );

    it('flag-off owner session refuses a forced lookup_digest classification without calling the skill', async () => {
      const deps = await ownerAdapter('lookup_digest', true, false);
      const findLatest = vi.spyOn(deps.dailyDigestRepo, 'findLatest');

      const xml = await deps.adapter.handleGather({
        sessionId: deps.session.id,
        callSid: 'CA-lookup_digest-flag-off-owner',
        speechResult: 'read me my day',
        confidence: 0.95,
        tenantId,
      });

      expect(xml).toContain('I&apos;m having trouble pulling that up right now');
      expect(findLatest).not.toHaveBeenCalled();
    });
  });

  it('classifies a clear utterance and advances FSM through intent_confirm', async () => {
    const xml = await adapter.handleGather({
      sessionId,
      callSid: 'CA-gx',
      speechResult: 'Create an invoice for Acme for 450 dollars',
      confidence: 0.95,
      tenantId: 'tenant-abc',
    });

    const snap = await store.snapshot(sessionId);
    expect(snap?.state).toBe('intent_confirm');
    expect(snap?.context.currentIntent).toBe('create_invoice');
    // Readback tts_play surfaced into the TwiML.
    expect(xml).toMatch(/<Say.*confirm/i);
    expect(xml).toContain('<Gather');

    // Caller transcript was appended (canonical store stores formatted strings).
    expect(snap?.transcript[0]).toBe(
      'caller: Create an invoice for Acme for 450 dollars'
    );
  });

  it('low-confidence classification triggers a reprompt (stays in intent_capture)', async () => {
    const lowGateway = makeGatewayReturning(
      JSON.stringify({
        intentType: 'unknown',
        confidence: 0.2,
        reasoning: 'mumbled',
      })
    );
    const { adapter: a2, store: s2 } = makeAdapter({ gateway: lowGateway });
    await a2.handleInbound({
      callSid: 'CA-low',
      from: '+15125550100',
      to: '+15125550999',
      tenantId: 'tenant-abc',
    });
    const ids = Array.from(
      (s2 as unknown as { sessions: Map<string, unknown> }).sessions.keys()
    );
    const sid = ids[0] as string;
    const sess = await s2.get(sid);
    if (sess && sess.machine.currentState === 'ask_caller') {
      sess.machine.dispatch({ type: 'caller_known', customerId: 'c1' });
    }

    const xml = await a2.handleGather({
      sessionId: sid,
      callSid: 'CA-low',
      speechResult: 'mmm uh',
      confidence: 0.2,
      tenantId: 'tenant-abc',
    });

    const snap = await s2.snapshot(sid);
    expect(snap?.state).toBe('intent_capture'); // reprompt, not escalated yet
    expect(xml).toContain('<Gather');
  });

  it('flag-off live calls omit extendedIntents from classifier context and resolve the flag once per call', async () => {
    const extendedIntentsEnabled = vi.fn(async () => false);
    const gateway = makeGatewayReturning('{"intentType":"unknown","confidence":0.2}');
    const store = new VoiceSessionStore();
    const adapter = new TwilioGatherAdapter({
      store,
      gateway,
      businessName: 'Acme Plumbing',
      publicBaseUrl: 'https://example.com',
      extendedIntentsEnabled,
    });
    await adapter.handleInbound({
      callSid: 'CA-flag-off',
      from: '+15125550100',
      to: '+15125550999',
      tenantId: 'tenant-abc',
    });
    const sid = Array.from((store as unknown as { sessions: Map<string, unknown> }).sessions.keys())[0] as string;
    const sess = await store.get(sid);
    if (sess && sess.machine.currentState === 'ask_caller') {
      sess.machine.dispatch({ type: 'caller_known', customerId: 'c1' });
    }

    await adapter.handleGather({
      sessionId: sid,
      callSid: 'CA-flag-off',
      speechResult: "What's my day look like?",
      confidence: 0.95,
      tenantId: 'tenant-abc',
    });

    expect(extendedIntentsEnabled).toHaveBeenCalledTimes(1);
    const call = (gateway.complete as ReturnType<typeof vi.fn>).mock.calls[0][0];
    const systemMessages = call.messages.filter((m: { role: string }) => m.role === 'system');
    expect(systemMessages).toHaveLength(1);
    expect(systemMessages[0].content).not.toContain('lookup_day_overview');
  });

  it('flag-on customer calls keep the legacy classifier prompt while flag-on owner calls append extended intents', async () => {
    const settingsRepo = new InMemorySettingsRepository();
    const now = new Date();
    await settingsRepo.create({
      id: 'settings-owner-extended',
      tenantId: 'tenant-extended',
      businessName: 'Acme Plumbing',
      timezone: 'America/Phoenix',
      estimatePrefix: 'EST-',
      invoicePrefix: 'INV-',
      nextEstimateNumber: 1,
      nextInvoiceNumber: 1,
      defaultPaymentTermDays: 30,
      ownerPhone: '+15125550100',
      createdAt: now,
      updatedAt: now,
    } as TenantSettings);
    const gateway = makeGatewayReturning('{"intentType":"unknown","confidence":0.2}');
    const store = new VoiceSessionStore();
    const adapter = new TwilioGatherAdapter({
      store,
      gateway,
      businessName: 'Acme Plumbing',
      publicBaseUrl: 'https://example.com',
      settingsRepo,
      extendedIntentsEnabled: vi.fn(async () => true),
    });

    await adapter.handleInbound({
      callSid: 'CA-flag-on-customer',
      from: '+15125559999',
      to: '+15125550000',
      tenantId: 'tenant-extended',
    });
    const customerSession = store.findByCallSid('CA-flag-on-customer')!;
    if (customerSession.machine.currentState === 'ask_caller') {
      customerSession.machine.dispatch({ type: 'caller_known', customerId: 'cust-flag-on' });
    }
    await adapter.handleGather({
      sessionId: customerSession.id,
      callSid: 'CA-flag-on-customer',
      speechResult: 'tell me what is going on',
      confidence: 0.95,
      tenantId: 'tenant-extended',
    });

    await adapter.handleInbound({
      callSid: 'CA-flag-on-owner',
      from: '+15125550100',
      to: '+15125550000',
      tenantId: 'tenant-extended',
    });
    const ownerSession = store.findByCallSid('CA-flag-on-owner')!;
    if (ownerSession.machine.currentState === 'ask_caller') {
      ownerSession.machine.dispatch({ type: 'caller_known', customerId: 'cust-temp' });
      ownerSession.customerId = undefined;
    }
    await adapter.handleGather({
      sessionId: ownerSession.id,
      callSid: 'CA-flag-on-owner',
      speechResult: 'tell me what is going on',
      confidence: 0.95,
      tenantId: 'tenant-extended',
    });

    const calls = (gateway.complete as ReturnType<typeof vi.fn>).mock.calls;
    const customerSystemMessages = calls[0][0].messages.filter((m: { role: string }) => m.role === 'system');
    const ownerSystemMessages = calls[1][0].messages.filter((m: { role: string }) => m.role === 'system');
    expect(customerSystemMessages).toHaveLength(1);
    expect(customerSystemMessages[0].content).not.toContain('lookup_day_overview');
    expect(ownerSystemMessages.some((m: { content: string }) => m.content.includes('lookup_day_overview'))).toBe(true);
  });

  it('extended-intents resolver error is non-fatal and resolves false for the session', async () => {
    const gateway = makeGatewayReturning('{"intentType":"unknown","confidence":0.2}');
    const store = new VoiceSessionStore();
    const adapter = new TwilioGatherAdapter({
      store,
      gateway,
      businessName: 'Acme Plumbing',
      publicBaseUrl: 'https://example.com',
      extendedIntentsEnabled: vi.fn(async () => {
        throw new Error('flag store down');
      }),
    });
    await adapter.handleInbound({
      callSid: 'CA-flag-error',
      from: '+15125550100',
      to: '+15125550999',
      tenantId: 'tenant-abc',
    });
    const sid = Array.from((store as unknown as { sessions: Map<string, unknown> }).sessions.keys())[0] as string;
    const sess = await store.get(sid);
    if (sess && sess.machine.currentState === 'ask_caller') {
      sess.machine.dispatch({ type: 'caller_known', customerId: 'c1' });
    }

    await adapter.handleGather({
      sessionId: sid,
      callSid: 'CA-flag-error',
      speechResult: "What's my day look like?",
      confidence: 0.95,
      tenantId: 'tenant-abc',
    });

    const call = (gateway.complete as ReturnType<typeof vi.fn>).mock.calls[0][0];
    const systemMessages = call.messages.filter((m: { role: string }) => m.role === 'system');
    expect(systemMessages).toHaveLength(1);
    expect(systemMessages[0].content).not.toContain('lookup_day_overview');
  });

  it('emergency_dispatch fast-paths to escalating and skips intent_confirm', async () => {
    const emergencyGateway = makeGatewayReturning(
      JSON.stringify({
        intentType: 'emergency_dispatch',
        confidence: 0.97,
        reasoning: 'gas smell',
      })
    );
    const { adapter: a3, store: s3 } = makeAdapter({ gateway: emergencyGateway });
    await a3.handleInbound({
      callSid: 'CA-emerg',
      from: '+15125550100',
      to: '+15125550999',
      tenantId: 'tenant-abc',
    });
    const ids = Array.from(
      (s3 as unknown as { sessions: Map<string, unknown> }).sessions.keys()
    );
    const sid = ids[0] as string;
    const sess = await s3.get(sid);
    if (sess && sess.machine.currentState === 'ask_caller') {
      sess.machine.dispatch({ type: 'caller_known', customerId: 'c1' });
    }

    const xml = await a3.handleGather({
      sessionId: sid,
      callSid: 'CA-emerg',
      speechResult: "I smell gas in my house",
      confidence: 0.97,
      tenantId: 'tenant-abc',
    });

    const snap = await s3.snapshot(sid);
    expect(snap?.state).toBe('escalating');
    expect(xml).toMatch(/emergency|on-call/i);
    // FSM does NOT call confirm_intent on emergency fast-path.
  });

  it('P8-013: notify_oncall produces a <Dial> when callControl + resolver are wired', async () => {
    const store = new VoiceSessionStore({ startInterval: false });
    const onCallRepo = new InMemoryOnCallRepository(
      new Map([[
        'tenant-abc',
        [{ id: 'r1', userId: 'u1', orderIndex: 0 }] as OnCallEntry[],
      ]]),
    );
    const auditRepo = new InMemoryAuditRepository();
    const proposalRepo = new InMemoryProposalRepository();
    const callControl = new DefaultTwilioCallControl();
    const resolver = vi.fn(async (_t: string, _u: string) => '+15125550101');
    const gw = makeGatewayReturning('{}');
    const adapter = new TwilioGatherAdapter({
      store,
      gateway: gw,
      businessName: 'Acme Plumbing',
      publicBaseUrl: 'https://example.com',
      onCallRepo,
      auditRepo,
      proposalRepo,
      callControl,
      dispatcherPhoneResolver: resolver,
    });

    // Drive an inbound call where identifyCaller has no Pool — caller
    // is unknown and we'll simulate a caller_identification_failed
    // dispatch by hand to force notify_oncall.
    await adapter.handleInbound({
      callSid: 'CA-noc',
      from: '+15125550100',
      to: '+15125550999',
      tenantId: 'tenant-abc',
    });
    const ids = Array.from(
      (store as unknown as { sessions: Map<string, unknown> }).sessions.keys(),
    );
    const sid = ids[0] as string;
    const session = store.get(sid)!;
    // Force escalation path (notify_oncall is emitted).
    const fx = session.machine.dispatch({
      type: 'caller_identification_failed',
      reason: 'manual',
    });
    // Manually drive executeSideEffects via the adapter's public seam:
    // a follow-up Gather emulates the next webhook; the simplest test
    // path is to call handleGather with a "speech" that re-dispatches
    // notify_oncall via system_failure. Easier: poke the private
    // executeSideEffects by going through a fresh handleGather turn
    // that does not classify (silence path).
    void fx;

    // Trigger handleGather with empty speech → confidence_low path
    // (does not produce notify_oncall on its own). Instead, dispatch
    // a notify_oncall side-effect directly through executeSideEffects
    // by simulating a system_failure → escalating route.
    const sideEffects = session.machine.dispatch({
      type: 'system_failure',
      reason: 'manual',
    });
    // executeSideEffects now lives on the shared VoiceTurnProcessor;
    // reach in via the private `processor` field for the test.
    const adapterAny = adapter as unknown as {
      processor: {
        executeSideEffects: (
          s: typeof session,
          fx: unknown,
          t: string,
        ) => Promise<void>;
      };
    };
    await adapterAny.processor.executeSideEffects(session, sideEffects, 'tenant-abc');

    // The transfer TwiML was queued.
    const twiml = adapter.takePendingTransferTwiml(sid);
    expect(twiml).toBeDefined();
    expect(twiml).toContain('<Dial');
    expect(twiml).toContain('+15125550101');
    expect(twiml).toContain('action="https://example.com/api/telephony/dial-result?sid=');

    // Audit row written.
    const audits = auditRepo.getAll();
    expect(audits.some((e) => e.eventType === 'escalation.requested')).toBe(true);

    // No callback proposal yet — only "dialing dispatcher" path ran.
    const proposals = await proposalRepo.findByTenant('tenant-abc');
    expect(proposals).toHaveLength(0);
  });

  it('P8-013: notify_oncall with empty rotation queues callback proposal + plays "we will call you back"', async () => {
    const store = new VoiceSessionStore({ startInterval: false });
    const onCallRepo = new InMemoryOnCallRepository(); // empty
    const auditRepo = new InMemoryAuditRepository();
    const proposalRepo = new InMemoryProposalRepository();
    const callControl = new DefaultTwilioCallControl();
    const resolver = vi.fn(async () => null);
    const gw = makeGatewayReturning('{}');
    const adapter = new TwilioGatherAdapter({
      store,
      gateway: gw,
      businessName: 'Acme Plumbing',
      publicBaseUrl: 'https://example.com',
      onCallRepo,
      auditRepo,
      proposalRepo,
      callControl,
      dispatcherPhoneResolver: resolver,
    });

    await adapter.handleInbound({
      callSid: 'CA-empty',
      from: '+15125550100',
      to: '+15125550999',
      tenantId: 'tenant-abc',
    });
    const ids = Array.from(
      (store as unknown as { sessions: Map<string, unknown> }).sessions.keys(),
    );
    const sid = ids[0] as string;
    const session = store.get(sid)!;

    const sideEffects = session.machine.dispatch({
      type: 'system_failure',
      reason: 'manual',
    });
    const adapterAny = adapter as unknown as {
      processor: {
        executeSideEffects: (
          s: typeof session,
          fx: unknown,
          t: string,
        ) => Promise<void>;
      };
    };
    await adapterAny.processor.executeSideEffects(session, sideEffects, 'tenant-abc');

    const twiml = adapter.takePendingTransferTwiml(sid);
    expect(twiml).toBeDefined();
    expect(twiml).toMatch(/call you back/i);
    expect(twiml).toMatch(/Acme Plumbing/);
    expect(twiml).toContain('<Hangup');

    const proposals = await proposalRepo.findByTenant('tenant-abc');
    const callback = proposals.find(
      (p) =>
        typeof (p.payload as Record<string, unknown>).intent === 'string' &&
        (p.payload as Record<string, unknown>).intent === 'customer_callback_required',
    );
    expect(callback).toBeDefined();

    expect(
      auditRepo.getAll().some((e) => e.eventType === 'customer_callback_required'),
    ).toBe(true);
  });

  it('returns a hangup TwiML when session is unknown', async () => {
    const { adapter: a4 } = makeAdapter();
    const xml = await a4.handleGather({
      sessionId: 'nonexistent',
      callSid: 'CA-x',
      speechResult: 'hi',
      confidence: 0.9,
      tenantId: 'tenant-abc',
    });

    expect(xml).toContain('<Hangup');
  });

  it('confirms intent when caller says yes in intent_confirm state', async () => {
    // First gather → reach intent_confirm.
    await adapter.handleGather({
      sessionId,
      callSid: 'CA-gx',
      speechResult: 'Create an invoice for Acme for 450 dollars',
      confidence: 0.95,
      tenantId: 'tenant-abc',
    });

    // Replace gateway response with yes/no classifier output.
    (gateway.complete as ReturnType<typeof vi.fn>).mockResolvedValue({
      content: '{"answer":"yes","reasoning":"clear yes"}',
      model: 'm',
      provider: 'p',
      tokenUsage: { input: 1, output: 1, total: 2 },
      latencyMs: 1,
    });

    await adapter.handleGather({
      sessionId,
      callSid: 'CA-gx',
      speechResult: 'yes that is right',
      confidence: 0.92,
      tenantId: 'tenant-abc',
    });

    const snap = await store.snapshot(sessionId);
    // After confirmed → proposal_draft → (no proposal_queued event yet) so we
    // remain in proposal_draft.
    expect(['proposal_draft', 'closing']).toContain(snap?.state);
  });
});

describe('B2 — voiceSessionRepo outcome stamping (Twilio adapter)', () => {
  it('inserts a voice_sessions row with channel=voice_inbound + callSid on handleInbound', async () => {
    const store = new VoiceSessionStore();
    const voiceSessionRepo = new InMemoryVoiceSessionRepository();
    const adapter = new TwilioGatherAdapter({
      store,
      gateway: makeGatewayReturning('{"intentType":"unknown","confidence":0,"reasoning":"x"}'),
      businessName: 'Acme',
      publicBaseUrl: 'https://example.com',
      voiceSessionRepo,
    });
    await adapter.handleInbound({
      callSid: 'CA-b2-1',
      from: '+15555550100',
      to: '+15555550200',
      tenantId: 'tenant-b2',
    });
    await Promise.resolve();
    const sess = store.findByCallSid('CA-b2-1');
    expect(sess).toBeDefined();
    const row = await voiceSessionRepo.findById('tenant-b2', sess!.id);
    expect(row?.channel).toBe('voice_inbound');
    expect(row?.callSid).toBe('CA-b2-1');
    expect(row?.outcome).toBeUndefined();
  });

  it('finalizeTerminatedSession derives outcome from the side-effect reason', async () => {
    const store = new VoiceSessionStore();
    const voiceSessionRepo = new InMemoryVoiceSessionRepository();
    const adapter = new TwilioGatherAdapter({
      store,
      gateway: makeGatewayReturning('{"intentType":"unknown","confidence":0,"reasoning":"x"}'),
      businessName: 'Acme',
      publicBaseUrl: 'https://example.com',
      voiceSessionRepo,
    });
    const session = store.create('tenant-b2', 'telephony', { callSid: 'CA-b2-2' });
    await voiceSessionRepo.create({
      id: session.id,
      tenantId: 'tenant-b2',
      channel: 'voice_inbound',
      callSid: 'CA-b2-2',
      state: session.machine.currentState,
    });
    session.transcript.push('agent: hi');
    adapter.finalizeTerminatedSession(
      session,
      [{ type: 'end_session', payload: { reason: 'caller_hangup' } }],
      'caller_hangup',
    );
    expect(session.terminalOutcome).toBe('dropped');
    const row = await voiceSessionRepo.findById('tenant-b2', session.id);
    expect(row?.outcome).toBe('dropped');
    expect(row?.endedReason).toBe('caller_hangup');
    expect(row?.endedAt).toBeInstanceOf(Date);
  });

  it('finalizeTerminatedSession is idempotent: a second call is a no-op', async () => {
    const store = new VoiceSessionStore();
    const voiceSessionRepo = new InMemoryVoiceSessionRepository();
    const adapter = new TwilioGatherAdapter({
      store,
      gateway: makeGatewayReturning('{"intentType":"unknown","confidence":0,"reasoning":"x"}'),
      businessName: 'Acme',
      voiceSessionRepo,
    });
    const session = store.create('tenant-b2', 'telephony', { callSid: 'CA-b2-3' });
    await voiceSessionRepo.create({
      id: session.id,
      tenantId: 'tenant-b2',
      channel: 'voice_inbound',
      callSid: 'CA-b2-3',
      state: session.machine.currentState,
    });
    session.transcript.push('agent: hi');
    adapter.finalizeTerminatedSession(
      session,
      [{ type: 'end_session', payload: { reason: 'caller_hangup' } }],
      'caller_hangup',
    );
    const firstOutcome = session.terminalOutcome;
    adapter.finalizeTerminatedSession(
      session,
      [{ type: 'end_session', payload: { reason: 'normal_close' } }],
      'normal_close',
    );
    expect(session.terminalOutcome).toBe(firstOutcome);
  });

  it('handleInbound works without voiceSessionRepo (legacy fixtures)', async () => {
    const store = new VoiceSessionStore();
    const adapter = new TwilioGatherAdapter({
      store,
      gateway: makeGatewayReturning('{"intentType":"unknown","confidence":0,"reasoning":"x"}'),
      businessName: 'Acme',
    });
    await expect(
      adapter.handleInbound({
        callSid: 'CA-b2-4',
        from: '+15555550100',
        to: '+15555550200',
        tenantId: 'tenant-b2',
      }),
    ).resolves.toBeDefined();
  });
});

// ─── buildTelephonyGreeting ───────────────────────────────────────────────────

describe('buildTelephonyGreeting', () => {
  it('respects custom persona greetings — does not append CTA', () => {
    // Tenant's persona ends with a question; disclosure follows.
    // Old code would append "What can I help you with today?" because the
    // assembled string ends with "." not "?". New code must leave persona alone.
    const result = buildTelephonyGreeting(
      'Joes HVAC',
      'This call may be recorded for quality.',
      { greeting: 'Hi, this is Sarah. What can I help you with today?', agentName: 'Sarah' },
    );
    // Exactly one '?' — the tenant's own.
    expect((result.match(/\?/g) ?? []).length).toBe(1);
    // Tenant's CTA is preserved verbatim
    expect(result).toContain('What can I help you with today?');
    // Default CTA "How can I help you today?" is NOT appended
    expect(result).not.toContain('How can I help you today?');
  });

  it('appends default CTA only when no persona is set', () => {
    const result = buildTelephonyGreeting(
      'Joes HVAC',
      'This call may be recorded for quality.',
      // No persona
    );
    expect(result.trim().endsWith('?')).toBe(true);
    expect(result).toContain('How can I help you today?');
  });

  it('on default branch does not double up when disclosure already ends with ?', () => {
    const result = buildTelephonyGreeting(
      'Joes HVAC',
      'This call may be recorded for quality, ok?',
    );
    // Disclosure ends with '?' so no CTA append
    expect((result.match(/\?/g) ?? []).length).toBe(1);
  });

  it('persona greeting without disclosure is returned unchanged', () => {
    const result = buildTelephonyGreeting(
      'Joes HVAC',
      '',
      { greeting: 'Hi, this is Sarah. What can I help you with today?', agentName: 'Sarah' },
    );
    expect(result).toBe('Hi, this is Sarah. What can I help you with today?');
    expect((result.match(/\?/g) ?? []).length).toBe(1);
  });
});

// ─── B3.2 — frustration detector wiring ──────────────────────────────────────

describe('TwilioGatherAdapter.processCallerUtterance — frustration detector', () => {
  it('escalates on frustration keyword without invoking intent classifier', async () => {
    const store = new VoiceSessionStore();
    const speechTurn = vi.fn();
    const machineDispatch = vi.fn(() => [
      { type: 'tts_play', payload: { text: 'connecting you' } } as const,
      { type: 'notify_oncall', payload: { escalationId: 'e1', reason: 'keyword_frustration' } } as const,
    ]);
    const adapter = new TwilioGatherAdapter({
      store,
      gateway: makeGatewayReturning('{"intentType":"unknown","confidence":0,"reasoning":"x"}'),
      businessName: 'Acme',
      publicBaseUrl: 'https://example.com',
      processor: { speechTurn } as never,
    } as never);

    // Inject a fake session with a mock machine into the store so
    // processCallerUtterance finds it without going through handleInbound.
    const session = store.create('tenant-t1', 'telephony', { callSid: 'CA-frust-1' });
    // Replace the machine's dispatch with our spy.
    (session.machine as unknown as { dispatch: typeof machineDispatch }).dispatch = machineDispatch;

    const sideEffects = await adapter.processCallerUtterance({
      sessionId: session.id,
      callSid: 'CA-frust-1',
      speechResult: 'this is ridiculous',
      tenantId: 'tenant-t1',
    });

    expect(speechTurn).not.toHaveBeenCalled();
    expect(machineDispatch).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'frustration_detected', source: 'keyword' }),
    );
    expect(sideEffects.length).toBeGreaterThan(0);
  });
});

// ─── RV-140/RV-142 — emergency keyword interrupt (shared safety scan) ────────

describe('RV-140 — deterministic emergency scan (both transcript entry points)', () => {
  it('processCallerUtterance (media-streams path): escalates on emergency keyword without any LLM call, 911 line first', async () => {
    const { adapter, store, gateway } = makeAdapter();
    const session = store.create('tenant-t1', 'telephony', { callSid: 'CA-em-1' });

    const sideEffects = await adapter.processCallerUtterance({
      sessionId: session.id,
      callSid: 'CA-em-1',
      speechResult: 'I think we have a gas leak in the basement',
      tenantId: 'tenant-t1',
    });

    // No LLM call of any kind happened (scan runs BEFORE the classifier).
    expect((gateway.complete as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
    expect(session.machine.currentState).toBe('escalating');
    const tts = sideEffects.filter((fx) => fx.type === 'tts_play');
    expect((tts[0]?.payload as { text: string }).text).toContain('911');
  });

  it('handleGather (PSTN path): the same shared scan fires and the TwiML speaks the 911 line', async () => {
    const { adapter, store, gateway } = makeAdapter();
    const session = store.create('tenant-t1', 'telephony', { callSid: 'CA-em-2' });

    const twiml = await adapter.handleGather({
      sessionId: session.id,
      callSid: 'CA-em-2',
      speechResult: 'the outlet is sparking and I smell electrical burning',
      confidence: 0.9,
      tenantId: 'tenant-t1',
    });

    expect((gateway.complete as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
    expect(session.machine.currentState).toBe('escalating');
    expect(twiml).toContain('call 911');
  });

  it('emergency utterance while already escalating falls through (no double-page)', async () => {
    const { adapter, store } = makeAdapter();
    const session = store.create('tenant-t1', 'telephony', { callSid: 'CA-em-3' });
    // First hit moves the FSM to escalating.
    await adapter.processCallerUtterance({
      sessionId: session.id,
      callSid: 'CA-em-3',
      speechResult: 'gas leak',
      tenantId: 'tenant-t1',
    });
    const dispatchSpy = vi.spyOn(session.machine, 'dispatch');
    await adapter.processCallerUtterance({
      sessionId: session.id,
      callSid: 'CA-em-3',
      speechResult: 'I said there is a gas leak',
      tenantId: 'tenant-t1',
    });
    // The second emergency dispatch is idempotent (empty effects) and the
    // turn falls through to the normal pipeline — no second notify_oncall.
    const emergencyCalls = dispatchSpy.mock.calls.filter(
      ([ev]) => (ev as { type: string }).type === 'emergency_detected',
    );
    expect(emergencyCalls.length).toBe(1);
    const results = dispatchSpy.mock.results.filter((_, i) =>
      (dispatchSpy.mock.calls[i][0] as { type: string }).type === 'emergency_detected');
    expect(results[0].value).toEqual([]);
  });
});

describe('RV-142 — injectSafetySayLines', () => {
  it('prepends safety-marked tts lines as <Say> before the <Dial> verb', () => {
    const dial =
      '<?xml version="1.0" encoding="UTF-8"?><Response><Dial timeout="20" action="/api/telephony/dial-result?sid=s1" method="POST"><Number>+15125550100</Number></Dial></Response>';
    const out = injectSafetySayLines(
      dial,
      [
        { type: 'tts_play', payload: { text: 'If anyone is in immediate danger, hang up and call 911.', priority: 'safety' } },
        { type: 'tts_play', payload: { text: 'Connecting you now.' } },
      ],
      {},
    );
    const sayIdx = out.indexOf('call 911');
    const dialIdx = out.indexOf('<Dial');
    expect(sayIdx).toBeGreaterThan(-1);
    expect(sayIdx).toBeLessThan(dialIdx);
    // Non-safety copy is NOT injected (preserves existing transfer behavior).
    expect(out).not.toContain('Connecting you now.');
  });

  it('returns the document unchanged when no safety lines are present', () => {
    const dial = '<?xml version="1.0" encoding="UTF-8"?><Response><Dial>x</Dial></Response>';
    expect(
      injectSafetySayLines(dial, [{ type: 'tts_play', payload: { text: 'hi' } }], {}),
    ).toBe(dial);
  });

  it('speaks the catalogued Spanish 911/transfer lines for an es session', () => {
    const dial =
      '<?xml version="1.0" encoding="UTF-8"?><Response><Dial timeout="20" action="/api/telephony/dial-result?sid=s1" method="POST"><Number>+15125550100</Number></Dial></Response>';
    const out = injectSafetySayLines(
      dial,
      [
        { type: 'tts_play', payload: { text: 'If anyone is in immediate danger, hang up and call 911.', priority: 'safety' } },
        { type: 'tts_play', payload: { text: "This sounds like an emergency. I'm connecting you with our on-call dispatcher immediately.", priority: 'safety' } },
      ],
      { language: 'es' },
    );
    // SENTENCE_CATALOG_ES entries, selected by the session language — the
    // same selector the Polly voice switch uses.
    expect(out).toContain('llame al 911');
    expect(out).toContain('despachador de guardia');
    expect(out).not.toContain('hang up and call 911');
    expect(out).toContain('Polly.Mia-Neural');
    // Still spoken before the bridge.
    expect(out.indexOf('llame al 911')).toBeLessThan(out.indexOf('<Dial'));
  });

  it('keeps the English 911 line for an en session', () => {
    const dial = '<?xml version="1.0" encoding="UTF-8"?><Response><Dial>x</Dial></Response>';
    const out = injectSafetySayLines(
      dial,
      [{ type: 'tts_play', payload: { text: 'If anyone is in immediate danger, hang up and call 911.', priority: 'safety' } }],
      { language: 'en' },
    );
    expect(out).toContain('hang up and call 911');
    expect(out).not.toContain('llame al 911');
  });
});

// ─── RV-140 (interim) — streaming interim emergency scan ────────────────────

describe('RV-140 — scanInterimForEmergency (streaming interims)', () => {
  it('an interim "gas leak" escalates immediately — before any final transcript', async () => {
    const { adapter, store, gateway } = makeAdapter();
    const session = store.create('tenant-t1', 'telephony', { callSid: 'CA-int-1' });

    const effects = await adapter.scanInterimForEmergency({
      sessionId: session.id,
      speechResult: 'there is a gas leak',
      tenantId: 'tenant-t1',
    });

    expect((gateway.complete as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
    expect(session.machine.currentState).toBe('escalating');
    expect(effects).not.toBeNull();
    const tts = (effects ?? []).filter((fx) => fx.type === 'tts_play');
    expect((tts[0]?.payload as { text: string }).text).toContain('911');
  });

  it('a non-emergency interim returns null and never touches the FSM (objection scan stays finals-only)', async () => {
    const { adapter, store } = makeAdapter();
    const session = store.create('tenant-t1', 'telephony', { callSid: 'CA-int-2' });
    const dispatchSpy = vi.spyOn(session.machine, 'dispatch');

    // Contains a recording-objection phrase — interims must NOT pause
    // recordings; only the emergency keyword table applies here.
    const effects = await adapter.scanInterimForEmergency({
      sessionId: session.id,
      speechResult: 'please stop recording me',
      tenantId: 'tenant-t1',
    });

    expect(effects).toBeNull();
    expect(dispatchSpy).not.toHaveBeenCalled();
    expect(session.machine.currentState).not.toBe('escalating');
  });

  it('the final transcript after an interim-fired emergency does not double-page (FSM idempotency)', async () => {
    const { adapter, store } = makeAdapter();
    const session = store.create('tenant-t1', 'telephony', { callSid: 'CA-int-3' });

    await adapter.scanInterimForEmergency({
      sessionId: session.id,
      speechResult: 'gas leak',
      tenantId: 'tenant-t1',
    });
    expect(session.machine.currentState).toBe('escalating');

    const dispatchSpy = vi.spyOn(session.machine, 'dispatch');
    await adapter.processCallerUtterance({
      sessionId: session.id,
      callSid: 'CA-int-3',
      speechResult: 'I said there is a gas leak in the basement',
      tenantId: 'tenant-t1',
    });

    // The final's emergency dispatch is idempotent: empty effects, no
    // second notify_oncall / page ladder.
    const emergencyResults = dispatchSpy.mock.results.filter((_, i) =>
      (dispatchSpy.mock.calls[i][0] as { type: string }).type === 'emergency_detected');
    expect(emergencyResults).toHaveLength(1);
    expect(emergencyResults[0].value).toEqual([]);
  });

  it('returns null for an unknown session', async () => {
    const { adapter } = makeAdapter();
    expect(
      await adapter.scanInterimForEmergency({
        sessionId: 'nope',
        speechResult: 'gas leak',
        tenantId: 'tenant-t1',
      }),
    ).toBeNull();
  });
});

// ─── RV-115 — durable recovery context on telephony termination ─────────────

describe('RV-115 — telephony termination persists the FSM snapshot', () => {
  it('a dropped call schedules a durable recovery row with context', async () => {
    const { InMemoryDroppedCallRecoveryRepository, DroppedCallScheduler } =
      await import('../../src/sms/recovery/scheduler');
    const recoveryRepo = new InMemoryDroppedCallRecoveryRepository();
    const noopLogger = {
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
      debug: () => undefined,
    } as never;
    const store = new VoiceSessionStore();
    const adapter = new TwilioGatherAdapter({
      store,
      gateway: makeGatewayReturning('{"intentType":"unknown","confidence":0,"reasoning":"x"}'),
      businessName: 'Acme',
      droppedCallScheduler: new DroppedCallScheduler(recoveryRepo, noopLogger),
    } as never);

    // Establish the session via the stream inbound path so the caller-id
    // map is populated (the durable row needs an E.164).
    await adapter.handleInboundForStream({
      callSid: 'CA-rv115',
      from: '+15125550144',
      tenantId: 'tenant-t1',
    });
    const session = store.findByCallSid('CA-rv115')!;
    // Caller hangs up before saying anything → outcome 'dropped'.
    session.machine.dispatch({ type: 'caller_hangup' });

    adapter.finalizeTerminatedSession(session, [], 'caller_hangup');
    // Scheduling is fire-and-forget — let the microtask settle.
    await new Promise((r) => setTimeout(r, 0));

    expect(recoveryRepo.rows).toHaveLength(1);
    const row = recoveryRepo.rows[0];
    expect(row.voiceSessionId).toBe(session.id);
    expect(row.callerE164).toBe('+15125550144');
    expect(row.context?.bucket).toBe('early');
    expect(row.context?.proposalIds).toEqual([]);
  });

  it('a transferred call does NOT schedule recovery (detection rejects it)', async () => {
    const { InMemoryDroppedCallRecoveryRepository, DroppedCallScheduler } =
      await import('../../src/sms/recovery/scheduler');
    const recoveryRepo = new InMemoryDroppedCallRecoveryRepository();
    const noopLogger = {
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
      debug: () => undefined,
    } as never;
    const store = new VoiceSessionStore();
    const adapter = new TwilioGatherAdapter({
      store,
      gateway: makeGatewayReturning('{}'),
      businessName: 'Acme',
      droppedCallScheduler: new DroppedCallScheduler(recoveryRepo, noopLogger),
    } as never);
    await adapter.handleInboundForStream({
      callSid: 'CA-rv115b',
      from: '+15125550145',
      tenantId: 'tenant-t1',
    });
    const session = store.findByCallSid('CA-rv115b')!;
    // Mirror the dial-result success branch: synthetic proposal_queued +
    // explicit 'transferred' reason → outcome 'completed'.
    session.machine.dispatch({ type: 'proposal_queued', proposalId: 'transfer:CA-rv115b' });
    adapter.finalizeTerminatedSession(session, [], 'transferred');
    await new Promise((r) => setTimeout(r, 0));
    expect(recoveryRepo.rows).toHaveLength(0);
  });
});

// ─── RV-130 — recording objection path (shared safety scan) ──────────────────

describe('RV-130 — "stop recording" objection in the shared safety scan', () => {
  async function makeObjectionFixture() {
    const { InMemoryConsentEventRepository } = await import(
      '../../src/compliance/consent-events'
    );
    const consentEvents = new InMemoryConsentEventRepository();
    const pauseRecording = vi.fn(async () => undefined);
    const auditRepo = new InMemoryAuditRepository();
    const store = new VoiceSessionStore();
    const gateway = makeGatewayReturning('{"intentType":"unknown","confidence":0,"reasoning":"x"}');
    const adapter = new TwilioGatherAdapter({
      store,
      gateway,
      businessName: 'Acme',
      auditRepo,
      consentEvents,
      recordingControl: { pauseRecording },
    } as never);
    await adapter.handleInboundForStream({
      callSid: 'CA-obj-1',
      from: '+15125550133',
      tenantId: 'tenant-t1',
    });
    const session = store.findByCallSid('CA-obj-1')!;
    return { adapter, session, consentEvents, pauseRecording, auditRepo, gateway };
  }

  it('pauses the recording, ledgers the revocation, and acks — no LLM call', async () => {
    const { adapter, session, consentEvents, pauseRecording, auditRepo, gateway } =
      await makeObjectionFixture();
    const stateBefore = session.machine.currentState;

    const effects = await adapter.processCallerUtterance({
      sessionId: session.id,
      callSid: 'CA-obj-1',
      speechResult: 'please stop recording this call',
      tenantId: 'tenant-t1',
    });

    expect((gateway.complete as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
    expect(pauseRecording).toHaveBeenCalledWith('CA-obj-1');
    expect(consentEvents.rows).toHaveLength(1);
    expect(consentEvents.rows[0]).toMatchObject({
      kind: 'recording',
      state: 'revoked',
      source: 'voice',
      voiceSessionId: session.id,
    });
    // The turn is consumed with the ack; FSM state is untouched.
    expect(effects).toHaveLength(1);
    expect((effects[0].payload as { text: string }).text).toContain('paused the recording');
    expect(session.machine.currentState).toBe(stateBefore);
    expect(
      auditRepo.getAll().some((e) => e.eventType === 'recording_consent.revoked'),
    ).toBe(true);
  });

  it('emergency keywords win the turn over an objection in the same chunk', async () => {
    const { adapter, session, pauseRecording } = await makeObjectionFixture();
    const effects = await adapter.processCallerUtterance({
      sessionId: session.id,
      callSid: 'CA-obj-1',
      speechResult: 'stop recording — there is a gas leak in here',
      tenantId: 'tenant-t1',
    });
    // Emergency consumed the turn (911 line first); objection deferred.
    expect((effects.find((e) => e.type === 'tts_play')?.payload as { text: string }).text).toContain('911');
    expect(pauseRecording).not.toHaveBeenCalled();
    expect(session.machine.currentState).toBe('escalating');
  });
});
