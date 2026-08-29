/**
 * #846 — the three intents that silently degraded on the Gather path
 * (complaint / confirm / language_switch), pinned at the same seam as the
 * lookup characterization net: a real TwilioGatherAdapter + VoiceSessionStore
 * with a stub LLM gateway. Everything here is observable behaviour — what the
 * caller hears (TwiML), where the FSM is left, what proposals were minted,
 * what the session bus saw. Nothing asserts which internal function ran.
 *
 * Before the fix each of these fell through `intentToProposalType`'s default
 * and became a `voice_clarification` card: "let me check that", silently.
 */
import { describe, it, expect, vi } from 'vitest';
import { TwilioGatherAdapter } from '../../src/telephony/twilio-adapter';
import { VoiceSessionStore } from '../../src/ai/agents/customer-calling/voice-session-store';
import type { LLMGateway, LLMResponse } from '../../src/ai/gateway/gateway';
import {
  COMPLAINT_ESCALATION_LINE,
  CONFIRM_NOTHING_PENDING_LINE,
} from '../../src/ai/agents/customer-calling/transitions';
import { COMPLAINT_HIGH_SEVERITY_REASON } from '../../src/ai/tasks/complaint-task';

const tenantId = 'tenant-guards';
const CUSTOMER_ID = '11111111-1111-4111-8111-111111111111';

function gatewayReturning(intentType: string, extractedEntities?: Record<string, unknown>): LLMGateway {
  const response: LLMResponse = {
    content: JSON.stringify({ intentType, confidence: 0.96, ...(extractedEntities ? { extractedEntities } : {}) }),
    model: 'stub',
    provider: 'stub',
    latencyMs: 1,
    usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
  } as unknown as LLMResponse;
  return { complete: vi.fn(async () => response) } as unknown as LLMGateway;
}

function makeAdapter(opts: {
  intentType: string;
  entities?: Record<string, unknown>;
  language?: 'en' | 'es';
  supportedLanguages?: ('en' | 'es')[];
  deps?: Record<string, unknown>;
}) {
  const store = new VoiceSessionStore({ startInterval: false });
  const proposalRepo = {
    create: vi.fn(async (p: Record<string, unknown>) => p),
    findByTenant: vi.fn(async () => []),
  };
  const adapter = new TwilioGatherAdapter({
    store,
    gateway: gatewayReturning(opts.intentType, opts.entities),
    businessName: 'Acme Plumbing',
    publicBaseUrl: 'https://example.com',
    proposalRepo,
    ...(opts.deps ?? {}),
  } as never);
  const callSid = `CA-${opts.intentType}-${Math.random().toString(36).slice(2, 8)}`;
  const session = store.create(tenantId, 'telephony', { callSid });
  session.machine.dispatch({
    type: 'incoming_call',
    tenantId,
    callSid,
    from: '+15125550111',
    to: '+15125550000',
  });
  session.machine.dispatch({ type: 'greeted_ok' });
  session.machine.dispatch({ type: 'caller_known', customerId: CUSTOMER_ID });
  session.customerId = CUSTOMER_ID;
  if (opts.language) session.language = opts.language;
  if (opts.supportedLanguages) session.supportedLanguages = opts.supportedLanguages;
  const events: Array<{ type?: string; to?: string; proposalId?: string }> = [];
  session.events.on('voice-event', (e: { type?: string }) => events.push(e));
  return { adapter, session, callSid, events, proposalRepo };
}

const ask = (h: ReturnType<typeof makeAdapter>, speech: string) =>
  h.adapter.handleGather({
    sessionId: h.session.id,
    callSid: h.callSid,
    speechResult: speech,
    confidence: 0.95,
    tenantId,
  });

describe('complaint on the Gather path (escalates, D-027)', () => {
  it('acknowledges, escalates to a human, and mints ONE S1-safe callback paper trail', async () => {
    const h = makeAdapter({
      intentType: 'complaint',
      entities: { noteBody: 'the tech left a mess in my yard last week' },
    });

    const twiml = await ask(h, 'I want to complain about the mess your tech left in my yard');

    // The caller hears the escalation acknowledgment, not "let me check
    // that" and not a deflect-and-continue.
    expect(twiml).toContain('let me get a person on the line');
    // D-027: the call is handed to a human, like operator_request.
    expect(h.session.machine.currentState).toBe('escalating');

    // Exactly one proposal: the owner `callback` paper trail (S1-allowed) —
    // never an add_note (operator-only) and never a voice_clarification.
    expect(h.proposalRepo.create).toHaveBeenCalledTimes(1);
    const stored = h.proposalRepo.create.mock.calls[0][0] as {
      proposalType: string;
      payload: Record<string, unknown>;
      summary: string;
    };
    expect(stored.proposalType).toBe('callback');
    expect(stored.payload.reason).toBe('customer_complaint_followup');
    expect(stored.summary).toContain('Complaint follow-up');
    // The session bus saw the outcome.
    expect(h.events.some((e) => e.type === 'proposal_created')).toBe(true);
  });

  it('stamps the memo-path severity markers on a high-severity complaint', async () => {
    const h = makeAdapter({
      intentType: 'complaint',
      entities: { noteBody: 'the work was sloppy and I want a refund' },
    });

    const twiml = await ask(h, 'your work was sloppy and I want a refund');

    expect(twiml).toContain('let me get a person on the line');
    const stored = h.proposalRepo.create.mock.calls[0][0] as {
      payload: { _meta?: { markers?: Array<{ reason: string }> } };
      summary: string;
    };
    expect(stored.summary).toContain('HIGH-SEVERITY');
    expect(stored.payload._meta?.markers?.[0]?.reason).toBe(COMPLAINT_HIGH_SEVERITY_REASON);
  });

  it('detects severity from the raw utterance when the classifier extracts no entities (#846 review fix)', async () => {
    // The real bug: the guard payload used to carry only classifier
    // entities, so a "refund / my lawyer" complaint with an empty
    // extraction scored `normal`. The utterance now rides the payload.
    const h = makeAdapter({ intentType: 'complaint' });

    await ask(h, "your work was sloppy, I want a refund or I'm calling my lawyer");

    expect(h.proposalRepo.create).toHaveBeenCalledTimes(1);
    const stored = h.proposalRepo.create.mock.calls[0][0] as {
      payload: { transcript?: string; _meta?: { markers?: Array<{ reason: string }> } };
      summary: string;
    };
    expect(stored.summary).toContain('HIGH-SEVERITY');
    expect(stored.payload._meta?.markers?.[0]?.reason).toBe(COMPLAINT_HIGH_SEVERITY_REASON);
    // The paper trail carries the caller's actual words, not the
    // "no details were captured" placeholder.
    expect(stored.payload.transcript).toContain('refund');
  });

  it('does not mint a second follow-up once the call is escalating', async () => {
    const h = makeAdapter({
      intentType: 'complaint',
      entities: { noteBody: 'the tech left a mess' },
    });

    await ask(h, 'I want to complain about the mess');
    expect(h.session.machine.currentState).toBe('escalating');
    await ask(h, 'and I really mean it, that mess was unacceptable');

    // The escalation is in progress — the paper trail stays one proposal.
    expect(h.proposalRepo.create).toHaveBeenCalledTimes(1);
  });
});

describe('bare confirm on the Gather path', () => {
  it('re-prompts in speech and mints NO card when nothing is pending', async () => {
    const h = makeAdapter({ intentType: 'confirm' });

    const twiml = await ask(h, 'yes');

    expect(twiml).toContain('anything waiting on a yes');
    expect(twiml).toContain('<Gather');
    expect(h.session.machine.currentState).toBe('intent_capture');
    expect(h.proposalRepo.create).not.toHaveBeenCalled();
  });

  it('speaks the exported line (the copy is the contract)', async () => {
    // Pin that the spoken text IS the constant, so copy edits stay deliberate.
    expect(CONFIRM_NOTHING_PENDING_LINE).toContain('anything waiting on a yes');
    expect(COMPLAINT_ESCALATION_LINE).toContain('let me get a person on the line');
  });
});

describe('language_switch on the Gather path', () => {
  it('flips the session to Spanish: ack in Spanish, <Gather language="es-US">, Spanish Polly voice', async () => {
    const h = makeAdapter({
      intentType: 'language_switch',
      language: 'en',
      supportedLanguages: ['en', 'es'],
    });

    const twiml = await ask(h, 'en español por favor');

    // Ack spoken in the language being switched TO.
    expect(twiml).toContain('continuemos en espa');
    // The NEXT turn listens and speaks in Spanish.
    expect(twiml).toContain('language="es-US"');
    expect(twiml).toContain('Polly.Mia-Neural');
    expect(h.session.language).toBe('es');
    // No proposal, no FSM movement — an adapter act, not a funnel event.
    expect(h.proposalRepo.create).not.toHaveBeenCalled();
    expect(h.session.machine.currentState).toBe('intent_capture');
    // Telemetry parity with media-streams.
    const switched = h.events.find((e) => e.type === 'language_switched');
    expect(switched?.to).toBe('es');
  });

  it('refuses a language the tenant has not opted into and stays in English', async () => {
    const h = makeAdapter({
      intentType: 'language_switch',
      language: 'en',
      supportedLanguages: ['en'],
    });

    const twiml = await ask(h, 'en español por favor');

    expect(twiml).toContain('only help in English');
    expect(twiml).toContain('language="en-US"');
    expect(h.session.language).toBe('en');
    expect(h.events.some((e) => e.type === 'language_switched')).toBe(false);
  });

  it('enforces the per-call flap cap shared with media-streams', async () => {
    const h = makeAdapter({
      intentType: 'language_switch',
      language: 'en',
      supportedLanguages: ['en', 'es'],
    });
    h.session.languageSwitchCount = 2; // MAX_LANGUAGE_SWITCHES_PER_CALL

    const twiml = await ask(h, 'en español por favor');

    expect(twiml).toContain('keep going in English');
    expect(h.session.language).toBe('en');
    expect(h.events.some((e) => e.type === 'language_switched')).toBe(false);
  });
});
