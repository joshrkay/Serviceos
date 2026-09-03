/**
 * #962 (PR-A) — behavioral anchors: the coverage table matches the CODE.
 *
 * For the highest-drift families (lookup, language_switch, P12-004
 * emergency immediate-dial, both WS18 behaviors, create_customer) each
 * anchor drives a REAL surface seam — the same seams the existing
 * characterization nets use — and asserts the observed behavior agrees with
 * the declared cell. Everything probed is observable behavior (what the
 * caller hears, which audit events fired, where the FSM is left), never
 * which internal function ran.
 *
 * Seam reuse (deliberately the same harness patterns, so these anchors and
 * the characterization nets can't diverge on how a surface is driven):
 *  - Gather: real TwilioGatherAdapter + VoiceSessionStore + stub gateway
 *    (test/telephony/gather-intent-guards-characterization.test.ts,
 *     test/telephony/lookup-dispatch-characterization.test.ts).
 *  - media_streams: the processor's speechTurn — the exact function the
 *    mediastream adapter dispatches finals into
 *    (test/ai/voice-turn/emergency-immediate-dial.test.ts).
 *  - inapp: real InAppVoiceAdapter
 *    (test/ai/agents/customer-calling/inapp-adapter-dialogue-equivalents.test.ts).
 *  - memo: code-level anchors only — a live probe needs the full
 *    voice-action-router worker rig (repos, dedup, recording rows), which is
 *    disproportionate for a membership fact; the router's own suites cover
 *    the behavior. Each code-level anchor says so inline.
 *
 * The TABLE follows the CODE: if one of these fails after a behavior
 * change, update the CELL (and say so in the PR), don't "fix" the code to
 * match the table.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';

import { TwilioGatherAdapter } from '../../../src/telephony/twilio-adapter';
import { VoiceSessionStore } from '../../../src/ai/agents/customer-calling/voice-session-store';
import { createVoiceTurnProcessor } from '../../../src/ai/voice-turn';
import { InAppVoiceAdapter } from '../../../src/ai/agents/customer-calling/inapp-adapter';
import { InMemoryAuditRepository } from '../../../src/audit/audit';
import { InMemoryProposalRepository } from '../../../src/proposals/proposal';
import { InMemoryOnCallRepository } from '../../../src/oncall/rotation';
import {
  setSupervisorPresenceLoader,
  _resetSupervisorPresenceCache,
} from '../../../src/ai/supervisor-presence';
import {
  VOICE_APPROVAL_REFUSAL,
  LANGUAGE_SWITCH_ACK,
} from '../../../src/ai/agents/customer-calling/tts-copy';
import { INTENT_TO_PROPOSAL_TYPE } from '../../../src/proposals/voice-intent-map';
import {
  isLookupIntent,
  isVoiceApprovalIntent,
  isVoiceEditIntent,
} from '../../../src/ai/orchestration/intent-classifier';
import { COVERAGE_TABLE } from '../../../src/ai/voice-turn/coverage-table';
import type { CoverageCell } from '../../../src/ai/voice-turn/coverage-table';
import type { LLMGateway, LLMResponse } from '../../../src/ai/gateway/gateway';
import type { PhoneLookupDeps } from '../../../src/ai/voice-turn/phone-lookup-surface';
import type { SideEffect, VoiceSession } from '../../../src/ai/agents/customer-calling/types';

const TENANT = 'tenant-coverage';
const CUSTOMER_ID = '11111111-1111-4111-8111-111111111111';

// ── tiny helpers ────────────────────────────────────────────────────────────

function llmResponse(content: string): LLMResponse {
  return {
    content,
    model: 'stub',
    provider: 'stub',
    tokenUsage: { input: 1, output: 1, total: 2 },
    latencyMs: 1,
  } as unknown as LLMResponse;
}

/** Every gateway.complete call returns the same content. */
function gatewayAlways(content: string): LLMGateway {
  return { complete: vi.fn(async () => llmResponse(content)) } as unknown as LLMGateway;
}

function classifyJson(intentType: string, entities: Record<string, unknown> = {}): string {
  return JSON.stringify({
    intentType,
    confidence: 0.96,
    reasoning: 'coverage anchor',
    extractedEntities: entities,
  });
}

function warmToIntentCapture(session: VoiceSession, callSid: string): void {
  session.machine.dispatch({
    type: 'incoming_call',
    tenantId: TENANT,
    callSid,
    from: '+15125550111',
    to: '+15125550000',
  });
  session.machine.dispatch({ type: 'greeted_ok' });
  session.machine.dispatch({ type: 'caller_known', customerId: CUSTOMER_ID });
  session.customerId = CUSTOMER_ID;
}

/**
 * Drive the shared FSM to `closing` with a live pendingQuote — the exact
 * dispatch sequence the processor's handleCreateProposal performs after a
 * grounded draft_estimate (proposal_queued WITH groundedLines).
 */
function armPendingQuote(session: VoiceSession): void {
  session.machine.dispatch({
    type: 'intent_classified',
    intentType: 'draft_estimate',
    entities: {},
    confidence: 0.97,
    utterance: 'quote me a water heater replacement',
  });
  session.machine.dispatch({ type: 'entity_resolved', refs: {} });
  session.machine.dispatch({ type: 'confirmed' });
  session.machine.dispatch({
    type: 'proposal_queued',
    proposalId: 'prop-quote-1',
    utterance: 'That comes to eighteen fifty.',
    groundedLines: [
      { description: 'Water heater replacement', quantity: 1, unitPrice: 185000, pricingSource: 'catalog' },
    ],
    groundedClean: true,
    totalCents: 185000,
  });
  expect(session.machine.currentState).toBe('closing');
  expect(session.machine.currentContext.pendingQuote).toBeDefined();
}

interface GatherHarness {
  adapter: TwilioGatherAdapter;
  store: VoiceSessionStore;
  session: VoiceSession;
  callSid: string;
  auditRepo: InMemoryAuditRepository;
  proposalRepo: { create: ReturnType<typeof vi.fn>; findByTenant: ReturnType<typeof vi.fn> };
  events: Array<{ type?: string }>;
  ask: (speech: string) => Promise<string>;
}

function makeGatherHarness(opts: {
  gateway: LLMGateway;
  lookups?: PhoneLookupDeps;
  actorUserId?: string;
  supportedLanguages?: ('en' | 'es')[];
  deps?: Record<string, unknown>;
}): GatherHarness {
  const store = new VoiceSessionStore({ startInterval: false });
  const auditRepo = new InMemoryAuditRepository();
  const proposalRepo = {
    create: vi.fn(async (p: Record<string, unknown>) => p),
    findByTenant: vi.fn(async () => []),
  };
  const adapter = new TwilioGatherAdapter({
    store,
    gateway: opts.gateway,
    businessName: 'Acme Plumbing',
    publicBaseUrl: 'https://example.com',
    proposalRepo,
    auditRepo,
    ...(opts.lookups ? { lookups: opts.lookups } : {}),
    ...(opts.deps ?? {}),
  } as never);
  const callSid = `CA-coverage-${Math.random().toString(36).slice(2, 8)}`;
  const session = store.create(TENANT, 'telephony', { callSid });
  if (opts.actorUserId) session.actorUserId = opts.actorUserId;
  if (opts.supportedLanguages) session.supportedLanguages = opts.supportedLanguages;
  warmToIntentCapture(session, callSid);
  const events: Array<{ type?: string }> = [];
  session.events.on('voice-event', (e: { type?: string }) => events.push(e));
  return {
    adapter,
    store,
    session,
    callSid,
    auditRepo,
    proposalRepo,
    events,
    ask: (speech: string) =>
      adapter.handleGather({
        sessionId: session.id,
        callSid,
        speechResult: speech,
        confidence: 0.95,
        tenantId: TENANT,
      }),
  };
}

function makeProcessorHarness(opts: {
  gateway: LLMGateway;
  actorUserId?: string;
  deps?: Record<string, unknown>;
}) {
  const store = new VoiceSessionStore({ startInterval: false });
  const auditRepo = new InMemoryAuditRepository();
  const proposalRepo = new InMemoryProposalRepository();
  const processor = createVoiceTurnProcessor({
    store,
    gateway: opts.gateway,
    businessName: 'Acme Plumbing',
    systemActorId: 'test-actor',
    auditRepo,
    proposalRepo,
    ...(opts.deps ?? {}),
  } as never);
  const callSid = `CA-ws-${Math.random().toString(36).slice(2, 8)}`;
  const session = store.create(TENANT, 'telephony', { callSid });
  if (opts.actorUserId) session.actorUserId = opts.actorUserId;
  warmToIntentCapture(session, callSid);
  const events: Array<{ type?: string }> = [];
  session.events.on('voice-event', (e: { type?: string }) => events.push(e));
  const turn = (speech: string) =>
    processor.speechTurn({ session, speechResult: speech, callSid, tenantId: TENANT });
  return { processor, store, session, callSid, auditRepo, proposalRepo, events, turn };
}

const ttsWithSource = (fx: SideEffect[], source: string) =>
  fx.filter(
    (f) =>
      f.type === 'tts_play' &&
      (f.payload as { source?: string }).source === source,
  );

function expectRefuseHole(cell: CoverageCell): void {
  expect(cell.status).toBe('refuse');
  expect(cell.status === 'refuse' && cell.hole).toBe(true);
}

afterEach(() => {
  _resetSupervisorPresenceCache();
  setSupervisorPresenceLoader(null);
});

// ── lookup ──────────────────────────────────────────────────────────────────

describe('lookup — answered on Gather, silently degraded on media-streams (D-026)', () => {
  const materialsLookups = (listPending: ReturnType<typeof vi.fn>): PhoneLookupDeps =>
    ({
      answers: {
        resolveMemberRole: async () => 'technician',
        materialItemRepo: { listPending },
      } as unknown as PhoneLookupDeps['answers'],
      shared: {
        proposalRepo: { findByTenant: vi.fn(async () => []) },
      } as unknown as PhoneLookupDeps['shared'],
    }) as PhoneLookupDeps;

  it('gather: lookup_materials is answered out-of-FSM (cell: reachable)', async () => {
    expect(COVERAGE_TABLE.lookup.gather.status).toBe('reachable');
    const listPending = vi.fn(async () => [
      {
        id: 'm1',
        tenantId: TENANT,
        description: '3/4 inch copper elbows',
        quantity: 6,
        status: 'pending',
        createdBy: 'u1',
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ]);
    const h = makeGatherHarness({
      gateway: gatewayAlways(classifyJson('lookup_materials')),
      actorUserId: 'clerk-tech',
      lookups: materialsLookups(listPending),
    });

    const xml = await h.ask('what materials do I need');

    expect(listPending).toHaveBeenCalled();
    expect(xml).toContain('copper elbows');
    // Out-of-FSM: the state is untouched, ready for the next request.
    expect(h.session.machine.currentState).toBe('intent_capture');
  });

  it('media_streams: the SAME turn gets no answer — speechTurn has no lookup branch (cell: refuse + hole)', async () => {
    expectRefuseHole(COVERAGE_TABLE.lookup.media_streams);
    const listPending = vi.fn(async () => []);
    const h = makeProcessorHarness({
      gateway: gatewayAlways(classifyJson('lookup_materials')),
      actorUserId: 'clerk-tech',
      // Even with the SAME lookup deps shape available at composition time,
      // speechTurn never consults them — there is no branch to receive them.
      deps: { lookups: materialsLookups(listPending) },
    });

    const fx = await h.turn('what materials do I need');

    // No lookup answer was spoken and the shared dispatch never ran.
    expect(listPending).not.toHaveBeenCalled();
    expect(ttsWithSource(fx, 'lookup_skill')).toHaveLength(0);
    expect(h.events.some((e) => e.type === 'lookup_executed')).toBe(false);
    // Instead the turn fell into the drafting funnel (the degradation the
    // cell declares): the FSM advanced out of intent_capture.
    expect(h.session.machine.currentState).not.toBe('intent_capture');
  });
});

// ── language_switch ─────────────────────────────────────────────────────────

describe('language_switch — served per-transport by the ADAPTERS', () => {
  it('gather: handleLanguageSwitchGather flips the session language (cell: reachable)', async () => {
    expect(COVERAGE_TABLE.language_switch.gather.status).toBe('reachable');
    const h = makeGatherHarness({
      gateway: gatewayAlways(classifyJson('language_switch')),
      supportedLanguages: ['en', 'es'],
    });
    h.session.language = 'en';

    await h.ask('can we talk in Spanish?');

    expect(h.session.language).toBe('es');
    expect(h.session.languageSwitchCount).toBe(1);
    expect(h.session.machine.currentState).toBe('intent_capture');
  });

  it('media_streams: speechTurn does NOT switch — it surfaces the intent on audit_log for the mediastream adapter branch (cell: reachable via adapter)', async () => {
    const cell = COVERAGE_TABLE.language_switch.media_streams;
    expect(cell.status).toBe('reachable');
    expect(cell.status === 'reachable' && cell.module).toContain('mediastream-adapter');
    const h = makeProcessorHarness({
      gateway: gatewayAlways(classifyJson('language_switch')),
    });
    h.session.language = 'en';
    h.session.supportedLanguages = ['en', 'es'];

    const fx = await h.turn('can we talk in Spanish?');

    // The processor itself never mutates session.language (the pure FSM
    // cannot; the switch lives in the adapter)…
    expect(h.session.language).toBe('en');
    // …but the classified intent rides the turn's audit_log side effect —
    // the exact channel mediastream-adapter's classifier-fallback branch
    // reads before calling switchLanguage (UB-C1 trigger b).
    const auditIntents = fx
      .filter((f) => f.type === 'audit_log')
      .map((f) => (f.payload as { intentType?: string }).intentType);
    expect(auditIntents).toContain('language_switch');
  });

  it('inapp: switchSessionLanguage flips and acks in the target language (cell: reachable)', async () => {
    expect(COVERAGE_TABLE.language_switch.inapp.status).toBe('reachable');
    const store = new VoiceSessionStore({ startInterval: false });
    const adapter = new InAppVoiceAdapter({
      store,
      gateway: gatewayAlways(classifyJson('language_switch')),
      proposalRepo: new InMemoryProposalRepository(),
      auditRepo: new InMemoryAuditRepository(),
      onCallRepo: new InMemoryOnCallRepository(),
    });
    const { sessionId } = await adapter.startSession(TENANT, 'user-x');

    const result = await adapter.handleInput(sessionId, 'can we talk in Spanish?');

    expect(result.ttsText).toBe(LANGUAGE_SWITCH_ACK.es);
    expect(store.get(sessionId)?.language).toBe('es');
    store.dispose();
  });

  it('memo: refused on purpose — language_switch has no proposal mapping (a dedicated clarification branch answers it)', () => {
    // Code-level anchor: a live probe needs the full voice-action-router
    // worker rig; the membership fact below is what routes the intent into
    // the router's dedicated Task-13 emitClarification branch (see
    // workers/voice-action-router.ts), whose behavior the router's own
    // suites cover.
    expect(COVERAGE_TABLE.language_switch.memo.status).toBe('refuse');
    expect(Object.prototype.hasOwnProperty.call(INTENT_TO_PROPOSAL_TYPE, 'language_switch')).toBe(false);
  });
});

// ── voice approval / edit on the in-app surface ─────────────────────────────

describe('voice approval & edit — spoken dialogue on the phone, deliberate refusal in-app', () => {
  it.each([
    { family: 'voice_approval' as const, intent: 'approve_proposal', utterance: 'Approve it' },
    { family: 'voice_edit' as const, intent: 'edit_proposal', utterance: 'Change the amount to 300' },
  ])('inapp $intent: refused with the declared copy, nothing minted (cell: refuse, deliberate)', async ({ family, intent, utterance }) => {
    const cell = COVERAGE_TABLE[family].inapp;
    expect(cell.status).toBe('refuse');
    // Deliberate refusal — NOT a hole.
    expect(cell.status === 'refuse' && cell.hole).toBeUndefined();
    // The declared copy IS the shipped constant — the table cannot drift
    // from the sentence the operator actually hears.
    expect(cell.status === 'refuse' && cell.copy).toBe(VOICE_APPROVAL_REFUSAL);

    const store = new VoiceSessionStore({ startInterval: false });
    const proposalRepo = new InMemoryProposalRepository();
    const adapter = new InAppVoiceAdapter({
      store,
      gateway: gatewayAlways(classifyJson(intent)),
      proposalRepo,
      auditRepo: new InMemoryAuditRepository(),
      onCallRepo: new InMemoryOnCallRepository(),
    });
    const { sessionId } = await adapter.startSession(TENANT, 'user-x');

    const result = await adapter.handleInput(sessionId, utterance);

    expect(result.ttsText).toBe(VOICE_APPROVAL_REFUSAL);
    expect(await proposalRepo.findByTenant(TENANT)).toHaveLength(0);
    expect(result.state).toBe('intent_capture');
    store.dispose();
  });

  it('memo: refused on purpose — the approval/edit intents are absent from the map AND guarded explicitly', () => {
    // Code-level anchor (see the memo note at the top of this file): the
    // router's RV-071 belt-and-braces guard returns {kind:'skipped'} for
    // these; here we pin the two facts that make that guard structural.
    expect(COVERAGE_TABLE.voice_approval.memo.status).toBe('refuse');
    expect(COVERAGE_TABLE.voice_edit.memo.status).toBe('refuse');
    for (const intent of ['approve_proposal', 'reject_proposal', 'edit_proposal']) {
      expect(isVoiceApprovalIntent(intent) || isVoiceEditIntent(intent), intent).toBe(true);
      expect(Object.prototype.hasOwnProperty.call(INTENT_TO_PROPOSAL_TYPE, intent), intent).toBe(false);
    }
  });
});

// ── create_customer ─────────────────────────────────────────────────────────

describe('create_customer — dedicated one-turn handler on Gather, generic FSM round-trip on media-streams', () => {
  it('gather: the P18-001 branch consumes the turn (already-matched caller variant) (cell: reachable)', async () => {
    expect(COVERAGE_TABLE.create_customer.gather.status).toBe('reachable');
    const h = makeGatherHarness({
      gateway: gatewayAlways(classifyJson('create_customer', { displayName: 'Maria Alvarez' })),
    });

    const xml = await h.ask('new customer, Maria Alvarez');

    // The dedicated handler's observable: an already-matched caller is told
    // so, in one turn, with no FSM advance and no proposal.
    expect(xml).toContain('in our system already');
    expect(h.session.machine.currentState).toBe('intent_capture');
    expect(h.proposalRepo.create).not.toHaveBeenCalled();
  });

  it('media_streams: the SAME turn takes the generic drafting round-trip instead (cell: reachable + hole — declared drift)', async () => {
    const cell = COVERAGE_TABLE.create_customer.media_streams;
    expect(cell.status).toBe('reachable');
    expect(cell.status === 'reachable' && cell.hole).toBe(true);
    const h = makeProcessorHarness({
      gateway: gatewayAlways(classifyJson('create_customer', { displayName: 'Maria Alvarez' })),
    });

    const fx = await h.turn('new customer, Maria Alvarez');

    // No P18-001 one-turn consume: the FSM advanced into the multi-turn
    // confirm funnel (entity_resolution → intent_confirm readback).
    const spoken = fx
      .filter((f) => f.type === 'tts_play')
      .map((f) => String((f.payload as { text?: string }).text ?? ''))
      .join(' | ');
    expect(spoken).not.toContain('in our system already');
    expect(h.session.machine.currentState).not.toBe('intent_capture');
  });
});

// ── P12-004 emergency immediate-dial ────────────────────────────────────────

describe('P12-004 emergency immediate-dial — media-streams only; Gather still escalates the slow way', () => {
  const emergencyDeps = () => ({
    onCallRepo: new InMemoryOnCallRepository(
      new Map([[TENANT, [{ id: 'rot-1', userId: 'u-dispatcher', orderIndex: 0 }]]]),
    ),
    dispatcherPhoneResolver: async () => '+15125550111',
  });

  it('media_streams: unsupervised emergency dials immediately and audits emergency_immediate_dial (cell: reachable)', async () => {
    expect(COVERAGE_TABLE.emergency_immediate_dial.media_streams.status).toBe('reachable');
    setSupervisorPresenceLoader(async () => false);
    const h = makeProcessorHarness({
      gateway: gatewayAlways(classifyJson('emergency_dispatch', { description: 'burst pipe' })),
      deps: emergencyDeps(),
    });

    await h.turn('there is a burst pipe flooding my basement right now');

    expect(
      h.auditRepo.getAll().find((e) => e.eventType === 'emergency_immediate_dial'),
    ).toBeDefined();
  });

  it('gather: the SAME unsupervised emergency NEVER emits emergency_immediate_dial — the FSM fast-path escalates instead (cell: refuse + hole)', async () => {
    expectRefuseHole(COVERAGE_TABLE.emergency_immediate_dial.gather);
    setSupervisorPresenceLoader(async () => false);
    const h = makeGatherHarness({
      gateway: gatewayAlways(classifyJson('emergency_dispatch', { description: 'burst pipe' })),
      deps: emergencyDeps(),
    });

    await h.ask('there is a burst pipe flooding my basement right now');

    // The caller is not stranded — the FSM's own emergency fast-path runs
    // (notify_oncall walks the rotation and initiates the transfer; the FSM
    // has already moved through escalating by the time the turn returns)…
    expect(h.auditRepo.getAll().find((e) => e.eventType === 'escalation.requested')).toBeDefined();
    // …but the P12-004 immediate <Dial> never happens on this transport.
    expect(
      h.auditRepo.getAll().find((e) => e.eventType === 'emergency_immediate_dial'),
    ).toBeUndefined();
  });
});

// ── WS18 consent capture on normal turns ────────────────────────────────────

describe('WS18 consent capture — consumed by speechTurn, dropped by the Gather turn loop', () => {
  it("media_streams: a pending capture consumes the caller's yes/no (cell: reachable)", async () => {
    expect(COVERAGE_TABLE.ws18_consent_capture.media_streams.status).toBe('reachable');
    const h = makeProcessorHarness({
      // The consent turn runs strict confirmIntent, not the classifier.
      gateway: gatewayAlways(JSON.stringify({ answer: 'yes', reasoning: 'affirmative' })),
    });
    h.session.pendingConsentCapture = { customerId: CUSTOMER_ID, phone: '+15125550100' };

    const fx = await h.turn('yes please');

    // Turn consumed: capture cleared, outcome audited, the consent line spoken.
    expect(h.session.pendingConsentCapture).toBeUndefined();
    const captured = fx.find(
      (f) =>
        f.type === 'audit_log' &&
        (f.payload as { eventType?: string }).eventType === 'agent.calling.sms_consent_captured',
    );
    expect(captured).toBeDefined();
    expect(ttsWithSource(fx, 'sms_consent_capture').length).toBeGreaterThan(0);
  });

  it('gather: the SAME pending capture is NOT consumed — the yes goes to the classifier and the capture stays pending (cell: refuse + hole)', async () => {
    expectRefuseHole(COVERAGE_TABLE.ws18_consent_capture.gather);
    const h = makeGatherHarness({
      gateway: gatewayAlways(classifyJson('unknown')),
    });
    h.session.pendingConsentCapture = { customerId: CUSTOMER_ID, phone: '+15125550100' };

    await h.ask('yes please');

    // The hole, observed: the capture survives the turn un-consumed and no
    // consent outcome was audited.
    expect(h.session.pendingConsentCapture).toBeDefined();
    expect(
      h.auditRepo.getAll().find((e) => e.eventType === 'agent.calling.sms_consent_captured'),
    ).toBeUndefined();
  });
});

// ── WS18 post-quote refinement / close ──────────────────────────────────────

describe('WS18 post-quote — deterministic pre-check on speechTurn, silent quote-drop on Gather', () => {
  it('media_streams: "yes, book it" in closing runs the close flow BEFORE the classifier (cell: reachable)', async () => {
    expect(COVERAGE_TABLE.ws18_post_quote_refinement.media_streams.status).toBe('reachable');
    const h = makeProcessorHarness({
      // Only the strict confirm runs — classifyJson here would prove the
      // classifier ran, which is exactly what must NOT happen.
      gateway: gatewayAlways(JSON.stringify({ answer: 'yes', reasoning: 'affirmative' })),
    });
    armPendingQuote(h.session);

    const fx = await h.turn('yes, book it');

    // The close flow engaged (here it stops at the first failing pre-gate —
    // no autonomous-close wiring in this rig — which is itself audited).
    const preGate = fx.find(
      (f) =>
        f.type === 'audit_log' &&
        (f.payload as { eventType?: string }).eventType === 'agent.calling.close_pre_gate_failed',
    );
    expect(preGate).toBeDefined();
    expect(ttsWithSource(fx, 'post_quote_close').length).toBeGreaterThan(0);
  });

  it('gather: the SAME "yes, book it" goes to the classifier and no close flow engages (cell: refuse + hole)', async () => {
    expectRefuseHole(COVERAGE_TABLE.ws18_post_quote_refinement.gather);
    const gateway = gatewayAlways(classifyJson('confirm'));
    const h = makeGatherHarness({ gateway });
    armPendingQuote(h.session);

    await h.ask('yes, book it');

    // The classifier consumed the turn (the discard bug, observed)…
    expect((gateway.complete as ReturnType<typeof vi.fn>)).toHaveBeenCalled();
    // …and nothing of the WS18 close flow ran.
    const audits = h.auditRepo.getAll();
    expect(audits.find((e) => e.eventType === 'agent.calling.close_pre_gate_failed')).toBeUndefined();
    expect(audits.find((e) => e.eventType === 'agent.calling.sms_consent_captured')).toBeUndefined();
    expect(h.session.pendingConsentCapture).toBeUndefined();
  });
});

// ── memo + map membership (code-level anchors) ──────────────────────────────

describe('memo surface — map-membership anchors for the declared cells', () => {
  // A live memo probe needs the full worker rig (recording rows, dedup,
  // repos); these membership facts are what route each family into the
  // branch its cell names, and the router's own suites pin those branches.
  it('create_customer memo cell (reachable) is backed by a real mapping', () => {
    expect(COVERAGE_TABLE.create_customer.memo.status).toBe('reachable');
    expect(INTENT_TO_PROPOSAL_TYPE.create_customer).toBe('create_customer');
  });

  it('lookup memo cell (reachable, U3 path) — lookup_* stays out of the proposal map by design', () => {
    expect(COVERAGE_TABLE.lookup.memo.status).toBe('reachable');
    for (const intent of Object.keys(INTENT_TO_PROPOSAL_TYPE)) {
      expect(isLookupIntent(intent as never), intent).toBe(false);
    }
  });

  it('en_route memo cell (reachable, direct act) — deliberately absent from the proposal map', () => {
    expect(COVERAGE_TABLE.en_route.memo.status).toBe('reachable');
    expect(Object.prototype.hasOwnProperty.call(INTENT_TO_PROPOSAL_TYPE, 'en_route')).toBe(false);
  });
});

// ── en_route on the in-app voice surface (declared hole) ────────────────────

describe('en_route — direct act on phone + memo, degradation on the in-app voice surface', () => {
  it('inapp: no en-route act fires; the intent falls into the drafting funnel (cell: refuse + hole)', async () => {
    expectRefuseHole(COVERAGE_TABLE.en_route.inapp);
    const store = new VoiceSessionStore({ startInterval: false });
    const auditRepo = new InMemoryAuditRepository();
    const adapter = new InAppVoiceAdapter({
      store,
      gateway: gatewayAlways(classifyJson('en_route', { jobReference: 'the Miller job' })),
      proposalRepo: new InMemoryProposalRepository(),
      auditRepo,
      onCallRepo: new InMemoryOnCallRepository(),
    });
    const { sessionId } = await adapter.startSession(TENANT, 'user-tech', undefined, 'technician');

    await adapter.handleInput(sessionId, "I'm on my way to the Miller job");

    // The direct status act (appointment.en_route_triggered) never fires on
    // this surface — the phone transports and the memo router all audit it.
    expect(
      auditRepo.getAll().find((e) => e.eventType === 'appointment.en_route_triggered'),
    ).toBeUndefined();
    // The turn was consumed by the generic FSM funnel instead.
    expect(store.get(sessionId)?.machine.currentState).not.toBe('intent_capture');
    store.dispose();
  });
});
