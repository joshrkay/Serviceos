/**
 * #1204 — the per-session token cap must end a live call even when a
 * classifier consumed the tracker's one-shot `cost_cap_exceeded` event.
 *
 * `recordCompletionUsage` (sentiment classifier + vulnerability grader)
 * records classifier spend on the SAME session tracker and discards the
 * returned events, and `SessionCostTracker` emits `cost_cap_exceeded` once
 * per dimension. Before the fix the hang-up only happened when the TURN's own
 * `recordUsage` returned that event, so a grader that crossed the output-token
 * cap between turns left the call running until the cost or duration cap.
 *
 * Both phone transports are driven through their real adapter entry points:
 *   - Gather/PSTN: `TwilioGatherAdapter.handleGather` (TwiML out)
 *   - Media Streams: `TwilioGatherAdapter.processCallerUtterance`, the exact
 *     `speechTurn` app.ts hands the media-streams adapter (side effects out)
 * The between-turns spend is the real `gradeVulnerability` with a stubbed
 * completion, the ticket's scenario: 1,450 of 1,500 output tokens, then a
 * 60-token grade.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { TwilioGatherAdapter } from '../../src/telephony/twilio-adapter';
import { VoiceSessionStore } from '../../src/ai/agents/customer-calling/voice-session-store';
import { InMemoryAuditRepository } from '../../src/audit/audit';
import { gradeVulnerability } from '../../src/ai/agents/customer-calling/vulnerability-grader';
import { InMemoryOnCallRepository } from '../../src/oncall/rotation';
import {
  setSupervisorPresenceLoader,
  _resetSupervisorPresenceCache,
} from '../../src/ai/supervisor-presence';
import { classifyCallerSafety } from '../../src/ai/agents/customer-calling/emergency-tier';
import { detectFrustration } from '../../src/ai/agents/customer-calling/frustration-detector';
import { EMERGENCY_SAFETY_LINE } from '../../src/ai/agents/customer-calling/emergency-detector';
import type { LLMGateway, LLMResponse } from '../../src/ai/gateway/gateway';
import type { SideEffect } from '../../src/ai/agents/customer-calling/types';

const TENANT = 'tenant-token-cap';
const LOW_CONFIDENCE_UNKNOWN = JSON.stringify({
  intentType: 'unknown',
  confidence: 0.1,
  reasoning: 'unclear',
  extractedEntities: {},
});
const DRAFT_ESTIMATE = JSON.stringify({
  intentType: 'draft_estimate',
  confidence: 0.95,
  reasoning: 'wants a quote',
  extractedEntities: { customerName: 'Acme' },
});
const CONFIRM_YES = JSON.stringify({ answer: 'yes', reasoning: 'caller said yes' });
const CAP_WRAP_UP = "I'm connecting you with a team member who can assist you further.";

function makeGatewayScript(steps: Array<{ content: string; output: number }>): LLMGateway {
  let i = 0;
  return {
    complete: vi.fn().mockImplementation(async () => {
      const step = steps[Math.min(i, steps.length - 1)]!;
      i += 1;
      const response: LLMResponse = {
        content: step.content,
        model: 'mock-model',
        provider: 'mock',
        tokenUsage: { input: 500, output: step.output, total: 500 + step.output },
        latencyMs: 1,
      };
      return response;
    }),
  } as unknown as LLMGateway;
}

async function startCall(
  gateway: LLMGateway,
  callSid: string,
  /** #1212 — on-call rotation + dispatcher phone for the P12-004 immediate Dial. */
  onCall?: { onCallRepo: InMemoryOnCallRepository; dispatcherPhoneResolver: () => Promise<string> },
) {
  const store = new VoiceSessionStore({ startInterval: false });
  const auditRepo = new InMemoryAuditRepository();
  const adapter = new TwilioGatherAdapter({
    store,
    gateway,
    auditRepo,
    businessName: 'Acme Plumbing',
    publicBaseUrl: 'https://example.com',
    ...(onCall ?? {}),
  });
  await adapter.handleInbound({
    callSid,
    from: '+15125550100',
    to: '+15125550999',
    tenantId: TENANT,
  });
  const session = store.findByCallSid(callSid)!;
  // Past greeting/caller resolution so the turn classifies normally.
  if (session.machine.currentState === 'ask_caller') {
    session.machine.dispatch({ type: 'caller_known', customerId: 'cust-1' });
  }
  let capTerminations = 0;
  session.events.on('voice-event', (ev: { type: string; cause?: string }) => {
    if (ev.type === 'session_terminated' && ev.cause === 'cap_exceeded') capTerminations += 1;
  });
  const capAudits = () =>
    auditRepo
      .getAll()
      .filter((a) => a.eventType.endsWith('.cost_cap_exceeded'))
      .map((a) => a.eventType);
  return {
    adapter,
    store,
    session,
    auditRepo,
    capAudits,
    capTerminations: () => capTerminations,
  };
}

type Call = Awaited<ReturnType<typeof startCall>>;

/** The real vulnerability grader, fire-and-forget between turns in production. */
async function runVulnerabilityGrader(call: Call, outputTokens: number): Promise<void> {
  await gradeVulnerability(
    { transcript: 'my mom is on oxygen', priorTurns: [], tenantId: TENANT },
    {
      llm: {
        complete: async () => ({
          text: '{"vulnerabilityScore":0.1,"urgencyTier":"none","signals":[]}',
          tokenUsage: { input: 200, output: outputTokens },
          model: 'mock-model',
        }),
      },
      costTracker: call.session.costTracker,
      sessionCostCapCents: call.session.costTracker.costCapCents,
      maxBudgetRatio: 0.8,
    },
  );
}

const gather = (call: Call, speechResult: string) =>
  call.adapter.handleGather({
    sessionId: call.session.id,
    callSid: call.session.callSid!,
    speechResult,
    confidence: 0.9,
    tenantId: TENANT,
  });

const mediaStreamsTurn = (call: Call, speechResult: string): Promise<SideEffect[]> =>
  call.adapter.processCallerUtterance({
    sessionId: call.session.id,
    callSid: call.session.callSid!,
    speechResult,
    tenantId: TENANT,
  });

/** TwiML with the per-session identifiers masked, so two calls compare equal. */
const normalizeTwiml = (xml: string, call: Call) =>
  xml.split(call.session.id).join('<SID>').split(call.session.callSid!).join('<CALLSID>');

const escapedWrapUp = CAP_WRAP_UP.replace(/'/g, '&apos;');

describe('#1204 — Gather transport (handleGather)', () => {
  it('a grader that crosses the output-token cap between turns: the next Gather turn ends the call once', async () => {
    const call = await startCall(
      makeGatewayScript([
        { content: LOW_CONFIDENCE_UNKNOWN, output: 1450 },
        { content: DRAFT_ESTIMATE, output: 1 },
      ]),
      'CA-gather-level',
    );

    await gather(call, 'um I have a question');
    expect(call.session.machine.currentState).toBe('intent_capture');
    expect(call.session.costTracker.isExceeded).toBe(false);

    await runVulnerabilityGrader(call, 60);
    expect(call.session.costTracker.totals.outputTokens).toBe(1510);
    expect(call.session.costTracker.isExceeded).toBe(true);

    const xml = await gather(call, 'I would like a quote for a water heater');

    expect(call.session.machine.currentState).toBe('escalating');
    expect(call.session.machine.currentContext.escalationReason).toBe('cost_cap_exceeded');
    expect(xml).toContain(escapedWrapUp);
    expect(call.capAudits()).toEqual(['agent.calling.intent_capture.cost_cap_exceeded']);
    expect(call.capTerminations()).toBe(1);
  });

  it('confirm branch: the grader crosses the cap while the readback is pending — the caller\'s yes ends the call', async () => {
    const call = await startCall(
      makeGatewayScript([
        { content: DRAFT_ESTIMATE, output: 1450 },
        { content: CONFIRM_YES, output: 1 },
      ]),
      'CA-gather-confirm',
    );
    await gather(call, 'I would like a quote for a water heater');
    expect(call.session.machine.currentState).toBe('intent_confirm');
    await runVulnerabilityGrader(call, 60);

    const xml = await gather(call, 'yes that is right');

    expect(call.session.machine.currentState).toBe('escalating');
    expect(xml).toContain(escapedWrapUp);
    expect(call.capAudits()).toEqual(['agent.calling.intent_confirm.cost_cap_exceeded']);
    expect(call.capTerminations()).toBe(1);
  });

  it('the level-triggered TwiML, audit and termination event match the event path (the turn\'s own usage crossing)', async () => {
    const level = await startCall(
      makeGatewayScript([
        { content: LOW_CONFIDENCE_UNKNOWN, output: 1450 },
        { content: DRAFT_ESTIMATE, output: 1 },
      ]),
      'CA-gather-level-cmp',
    );
    await gather(level, 'um I have a question');
    await runVulnerabilityGrader(level, 60);
    const levelXml = await gather(level, 'I would like a quote for a water heater');

    const event = await startCall(
      makeGatewayScript([
        { content: LOW_CONFIDENCE_UNKNOWN, output: 1450 },
        { content: DRAFT_ESTIMATE, output: 60 },
      ]),
      'CA-gather-event-cmp',
    );
    await gather(event, 'um I have a question');
    const eventXml = await gather(event, 'I would like a quote for a water heater');

    expect(event.session.machine.currentContext.escalationReason).toBe('cost_cap_exceeded');
    expect(normalizeTwiml(levelXml, level)).toBe(normalizeTwiml(eventXml, event));
    expect(level.capAudits()).toEqual(event.capAudits());
    expect(level.capTerminations()).toBe(event.capTerminations());
  });

  it('never ends the call twice: a later classify turn does not re-escalate', async () => {
    const call = await startCall(
      makeGatewayScript([
        { content: LOW_CONFIDENCE_UNKNOWN, output: 1450 },
        { content: DRAFT_ESTIMATE, output: 1 },
        { content: DRAFT_ESTIMATE, output: 1 },
      ]),
      'CA-gather-twice',
    );
    await gather(call, 'um I have a question');
    await runVulnerabilityGrader(call, 60);
    await gather(call, 'I would like a quote for a water heater');
    expect(call.session.machine.currentState).toBe('escalating');

    call.session.machine.dispatch({ type: 'proposal_queued', proposalId: 'p-1' });
    expect(call.session.machine.currentState).toBe('closing');
    const xml = await gather(call, 'and a quote for a furnace too');

    expect(xml).not.toContain(escapedWrapUp);
    expect(call.capAudits()).toHaveLength(1);
    expect(call.capTerminations()).toBe(1);
  });

  it('a call whose grader stays under the cap is unaffected', async () => {
    const script = () =>
      makeGatewayScript([
        { content: LOW_CONFIDENCE_UNKNOWN, output: 1450 },
        { content: DRAFT_ESTIMATE, output: 1 },
      ]);
    const control = await startCall(script(), 'CA-gather-control');
    await gather(control, 'um I have a question');
    const controlXml = await gather(control, 'I would like a quote for a water heater');

    const call = await startCall(script(), 'CA-gather-under');
    await gather(call, 'um I have a question');
    await runVulnerabilityGrader(call, 10);
    expect(call.session.costTracker.isExceeded).toBe(false);
    const xml = await gather(call, 'I would like a quote for a water heater');

    expect(call.session.machine.currentState).toBe('intent_confirm');
    expect(call.capAudits()).toEqual([]);
    expect(call.capTerminations()).toBe(0);
    expect(normalizeTwiml(xml, call)).toBe(normalizeTwiml(controlXml, control));
  });
});

describe('#1204 — Media Streams transport (processCallerUtterance → speechTurn)', () => {
  it('a grader that crosses the output-token cap between turns: the next media-streams turn ends the call once', async () => {
    const call = await startCall(
      makeGatewayScript([
        { content: LOW_CONFIDENCE_UNKNOWN, output: 1450 },
        { content: DRAFT_ESTIMATE, output: 1 },
        { content: DRAFT_ESTIMATE, output: 1 },
      ]),
      'CA-ms-level',
    );

    await mediaStreamsTurn(call, 'um I have a question');
    expect(call.session.machine.currentState).toBe('intent_capture');
    await runVulnerabilityGrader(call, 60);
    expect(call.session.costTracker.isExceeded).toBe(true);

    const fx = await mediaStreamsTurn(call, 'I would like a quote for a water heater');

    expect(call.session.machine.currentState).toBe('escalating');
    expect(call.session.machine.currentContext.escalationReason).toBe('cost_cap_exceeded');
    expect(fx.filter((f) => f.type === 'tts_play').map((f) => f.payload.text)).toEqual([
      CAP_WRAP_UP,
    ]);
    expect(fx.filter((f) => f.type === 'notify_oncall').map((f) => f.payload.reason)).toEqual([
      'cost_cap_exceeded',
    ]);
    expect(call.capAudits()).toEqual(['agent.calling.intent_capture.cost_cap_exceeded']);
    expect(call.capTerminations()).toBe(1);

    // Never twice: back on a classify branch, still over the cap.
    call.session.machine.dispatch({ type: 'proposal_queued', proposalId: 'p-1' });
    const later = await mediaStreamsTurn(call, 'and a quote for a furnace too');
    expect(later.some((f) => f.type === 'notify_oncall')).toBe(false);
    expect(call.capAudits()).toHaveLength(1);
    expect(call.capTerminations()).toBe(1);
  });

  it('a call whose grader stays under the cap is unaffected', async () => {
    const call = await startCall(
      makeGatewayScript([
        { content: LOW_CONFIDENCE_UNKNOWN, output: 1450 },
        { content: DRAFT_ESTIMATE, output: 1 },
      ]),
      'CA-ms-under',
    );
    await mediaStreamsTurn(call, 'um I have a question');
    await runVulnerabilityGrader(call, 10);
    await mediaStreamsTurn(call, 'I would like a quote for a water heater');

    expect(call.session.machine.currentState).toBe('intent_confirm');
    expect(call.capAudits()).toEqual([]);
    expect(call.capTerminations()).toBe(0);
  });
});

// ─── #1212: an emergency outcome wins over the cap end ──────────────────────
//
// Both transports chose the cap end before looking at what the classifier
// said, so a keyword-free emergency on the turn that crossed the cap got the
// generic wrap-up and a cost_cap page. Each capped call below is compared
// with the SAME call made without the between-turns grader spend.

// Keyword-free: the deterministic safety scan (and the frustration scan)
// never see it, so only the classifier can call it an emergency.
const KEYWORD_FREE_EMERGENCY =
  'my water heater just split open and scalding water is pouring across the garage floor';
const EMERGENCY = JSON.stringify({
  intentType: 'emergency_dispatch',
  confidence: 0.94,
  reasoning: 'active scalding-water release, needs someone now',
  extractedEntities: {},
});
const EMERGENCY_HANDOFF_LINE =
  "This sounds like an emergency. I'm connecting you with our on-call dispatcher immediately.";
const xmlText = (s: string) => s.replace(/'/g, '&apos;');

const emergencyScript = () =>
  makeGatewayScript([
    { content: LOW_CONFIDENCE_UNKNOWN, output: 1450 },
    { content: EMERGENCY, output: 1 },
    { content: DRAFT_ESTIMATE, output: 1 },
  ]);

const onCallDeps = () => ({
  onCallRepo: new InMemoryOnCallRepository(
    new Map([[TENANT, [{ id: 'rot-1', userId: 'u-dispatcher', orderIndex: 0 }]]]),
  ),
  dispatcherPhoneResolver: async () => '+15125550111',
});

const auditTypes = (call: Call) => call.auditRepo.getAll().map((a) => a.eventType);

describe('#1212 — an emergency outcome wins over the token-cap end', () => {
  afterEach(() => {
    _resetSupervisorPresenceCache();
    setSupervisorPresenceLoader(null);
  });

  it('precondition: the utterance is keyword-free (no safety or frustration scan hit)', () => {
    expect(classifyCallerSafety(KEYWORD_FREE_EMERGENCY, {}).tier).toBe('E3');
    expect(detectFrustration(KEYWORD_FREE_EMERGENCY).matched).toBe(false);
  });

  describe('Gather transport (handleGather)', () => {
    it('the capped turn speaks the emergency path and escalates as emergency_dispatch, identical to an uncapped call', async () => {
      const control = await startCall(emergencyScript(), 'CA-1212-gather-control');
      await gather(control, 'um I have a question');
      const controlXml = await gather(control, KEYWORD_FREE_EMERGENCY);

      const call = await startCall(emergencyScript(), 'CA-1212-gather-capped');
      await gather(call, 'um I have a question');
      await runVulnerabilityGrader(call, 60);
      expect(call.session.costTracker.isExceeded).toBe(true);

      const xml = await gather(call, KEYWORD_FREE_EMERGENCY);

      expect(call.session.machine.currentState).toBe('escalating');
      expect(call.session.machine.currentContext.escalationReason).toBe('emergency_dispatch');
      expect(xml).toContain(xmlText(EMERGENCY_SAFETY_LINE));
      expect(xml).toContain(xmlText(EMERGENCY_HANDOFF_LINE));
      expect(xml).not.toContain(escapedWrapUp);
      expect(call.capAudits()).toEqual([]);
      expect(auditTypes(call)).toContain('agent.calling.intent_capture.emergency_dispatch');
      expect(normalizeTwiml(xml, call)).toBe(normalizeTwiml(controlXml, control));
      expect(auditTypes(call)).toEqual(auditTypes(control));
    });

    it('the call still ends once: after the emergency, a later classify turn adds no cost-cap end', async () => {
      const call = await startCall(emergencyScript(), 'CA-1212-gather-once');
      await gather(call, 'um I have a question');
      await runVulnerabilityGrader(call, 60);
      await gather(call, KEYWORD_FREE_EMERGENCY);
      expect(call.session.machine.currentContext.escalationReason).toBe('emergency_dispatch');
      expect(call.capTerminations()).toBe(1);

      call.session.machine.dispatch({ type: 'proposal_queued', proposalId: 'p-1' });
      expect(call.session.machine.currentState).toBe('closing');
      const xml = await gather(call, 'and a quote for a furnace too');

      expect(xml).not.toContain(escapedWrapUp);
      expect(call.capAudits()).toEqual([]);
      expect(call.capTerminations()).toBe(1);
    });
  });

  describe('Media Streams transport (processCallerUtterance → speechTurn)', () => {
    it('unsupervised tenant with an on-call rotation: the capped turn dials on-call immediately, identical to an uncapped call', async () => {
      setSupervisorPresenceLoader(async () => false);
      const control = await startCall(emergencyScript(), 'CA-1212-ms-control', onCallDeps());
      await mediaStreamsTurn(control, 'um I have a question');
      const controlFx = await mediaStreamsTurn(control, KEYWORD_FREE_EMERGENCY);

      const call = await startCall(emergencyScript(), 'CA-1212-ms-capped', onCallDeps());
      await mediaStreamsTurn(call, 'um I have a question');
      await runVulnerabilityGrader(call, 60);
      expect(call.session.costTracker.isExceeded).toBe(true);

      const fx = await mediaStreamsTurn(call, KEYWORD_FREE_EMERGENCY);

      const tts = fx.filter((f) => f.type === 'tts_play').map((f) => String(f.payload.text));
      expect(tts).toHaveLength(1);
      expect(tts[0]).toContain('Emergency escalation in progress');
      expect(fx.some((f) => f.type === 'notify_oncall')).toBe(false);
      const dial = call.auditRepo.getAll().find((a) => a.eventType === 'emergency_immediate_dial');
      expect(dial?.metadata).toMatchObject({ intent: 'emergency_dispatch', escalated: true });
      expect(call.capAudits()).toEqual([]);
      expect(fx).toEqual(controlFx);
      expect(auditTypes(call)).toEqual(auditTypes(control));
    });

    it('supervised tenant: the capped turn takes the FSM emergency path (safety line + emergency_dispatch page), identical to an uncapped call', async () => {
      setSupervisorPresenceLoader(async () => true);
      const control = await startCall(emergencyScript(), 'CA-1212-ms-sup-control', onCallDeps());
      await mediaStreamsTurn(control, 'um I have a question');
      const controlFx = await mediaStreamsTurn(control, KEYWORD_FREE_EMERGENCY);

      const call = await startCall(emergencyScript(), 'CA-1212-ms-sup-capped', onCallDeps());
      await mediaStreamsTurn(call, 'um I have a question');
      await runVulnerabilityGrader(call, 60);

      const fx = await mediaStreamsTurn(call, KEYWORD_FREE_EMERGENCY);

      expect(call.session.machine.currentState).toBe('escalating');
      expect(call.session.machine.currentContext.escalationReason).toBe('emergency_dispatch');
      expect(fx.filter((f) => f.type === 'tts_play').map((f) => f.payload.text)).toEqual([
        EMERGENCY_SAFETY_LINE,
        EMERGENCY_HANDOFF_LINE,
      ]);
      expect(fx.filter((f) => f.type === 'notify_oncall').map((f) => f.payload.reason)).toEqual([
        'emergency_dispatch',
      ]);
      expect(call.capAudits()).toEqual([]);
      expect(auditTypes(call)).not.toContain('emergency_immediate_dial');
      expect(auditTypes(call)).toEqual(auditTypes(control));
      expect(fx.map((f) => f.type)).toEqual(controlFx.map((f) => f.type));
    });

    it('the call still ends once: after the emergency, a later classify turn adds no cost-cap end', async () => {
      const call = await startCall(emergencyScript(), 'CA-1212-ms-once');
      await mediaStreamsTurn(call, 'um I have a question');
      await runVulnerabilityGrader(call, 60);
      await mediaStreamsTurn(call, KEYWORD_FREE_EMERGENCY);
      expect(call.session.machine.currentContext.escalationReason).toBe('emergency_dispatch');
      expect(call.capTerminations()).toBe(1);

      call.session.machine.dispatch({ type: 'proposal_queued', proposalId: 'p-1' });
      const later = await mediaStreamsTurn(call, 'and a quote for a furnace too');

      expect(later.some((f) => f.type === 'notify_oncall')).toBe(false);
      expect(call.capAudits()).toEqual([]);
      expect(call.capTerminations()).toBe(1);
    });
  });
});
