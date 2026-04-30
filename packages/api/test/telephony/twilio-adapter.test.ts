import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  TwilioGatherAdapter,
  buildTwiML,
  xmlEscape,
} from '../../src/telephony/twilio-adapter';
import { InMemoryVoiceSessionStore } from '../../src/telephony/voice-session-store';
import type { LLMGateway, LLMResponse } from '../../src/ai/gateway/gateway';

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
  store?: InMemoryVoiceSessionStore;
} = {}) {
  const store = opts.store ?? new InMemoryVoiceSessionStore();
  const gateway =
    opts.gateway ??
    makeGatewayReturning('{"intentType":"unknown","confidence":0,"reasoning":"x"}');
  const adapter = new TwilioGatherAdapter({
    store,
    gateway,
    businessName: 'Acme Plumbing',
    publicBaseUrl: 'https://example.com',
  });
  return { adapter, store, gateway };
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
});

// ─── handleGather ────────────────────────────────────────────────────────────

describe('TwilioGatherAdapter.handleGather', () => {
  let gateway: LLMGateway;
  let adapter: TwilioGatherAdapter;
  let store: InMemoryVoiceSessionStore;
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

    // Caller transcript was appended.
    expect(snap?.transcript[0]).toMatchObject({
      speaker: 'caller',
      text: 'Create an invoice for Acme for 450 dollars',
    });
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
