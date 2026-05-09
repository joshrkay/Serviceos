import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  TwilioGatherAdapter,
  buildTwiML,
  xmlEscape,
  buildTelephonyGreeting,
} from '../../src/telephony/twilio-adapter';
import { VoiceSessionStore } from '../../src/ai/agents/customer-calling/voice-session-store';
import type { LLMGateway, LLMResponse } from '../../src/ai/gateway/gateway';
import { DefaultTwilioCallControl } from '../../src/telephony/twilio-call-control';
import {
  InMemoryOnCallRepository,
  type OnCallEntry,
} from '../../src/oncall/rotation';
import { InMemoryAuditRepository } from '../../src/audit/audit';
import { InMemoryProposalRepository } from '../../src/proposals/proposal';
import { InMemoryLeadRepository } from '../../src/leads/lead';
import { InMemoryVoiceSessionRepository } from '../../src/voice/voice-session';
import { MEDIA_STREAM_PATH } from '../../src/telephony/media-streams/twilio-mediastream-server';

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
  });
  return { adapter, store, gateway, leadRepo, auditRepo };
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
    // executeSideEffects is private; access via cast for the test.
    const adapterAny = adapter as unknown as {
      executeSideEffects: (
        s: typeof session,
        fx: unknown,
        t: string,
      ) => Promise<void>;
    };
    await adapterAny.executeSideEffects(session, sideEffects, 'tenant-abc');

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
      executeSideEffects: (
        s: typeof session,
        fx: unknown,
        t: string,
      ) => Promise<void>;
    };
    await adapterAny.executeSideEffects(session, sideEffects, 'tenant-abc');

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
