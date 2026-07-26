/**
 * P0 voice-safety — in-app entity resolution must never silently guess.
 *
 * Invariant (CLAUDE.md): "All free-text entity references on voice paths are
 * resolved via the entity resolver; ambiguity becomes a one-tap
 * voice_clarification, never a silent guess."
 *
 * These handler-level tests drive InAppVoiceAdapter with a MOCKED
 * EntityResolver (no DB) + the in-memory session store and prove:
 *   (a) a unique match → entity_resolved and the FSM STOPS at intent_confirm
 *       (readback) — it is NOT auto-confirmed;
 *   (b) two candidates → entity_ambiguous is dispatched WITH the candidate
 *       set (a disambiguation question), NOT a silent pick + proposal;
 *   (c) zero matches on a RECORD-OPERATING intent (send_estimate,
 *       record_payment, …) → entity_not_found → escalates to on-call (Fix 1:
 *       this used to silently fall through to entity_resolved with empty refs
 *       — a not_found masquerading as a success — and is now a hard
 *       escalation, never a silent guess);
 *   (c') VOX-02 — zero matches on a CREATION intent (create_appointment,
 *       create_job, …) does NOT escalate: a caller asking to book NEW work
 *       has no record to find, so the turn proceeds to the intent_confirm
 *       readback with partial refs and the proposal carries pendingReference
 *       for operator review;
 *   (d) the auto-confirm no longer fires — the proposal is created only after
 *       a REAL caller "yes" event on a later turn;
 *   (e) a single candidate in the middle confidence band (τ_ent_confirm_low
 *       <= score < τ_ent) → entity_confirm, a one-tap voice confirmation
 *       turn, NEVER acted on silently and NEVER a hard not_found either.
 *
 * Plus direct unit tests for the pure resolution/affirmation logic.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  InAppVoiceAdapter,
  isAffirmation,
} from '../../../../src/ai/agents/customer-calling/inapp-adapter';
import {
  resolveSchedulingEntities,
  requiresExistingEntity,
} from '../../../../src/ai/agents/customer-calling/entity-resolution';
import { VoiceSessionStore } from '../../../../src/ai/agents/customer-calling/voice-session-store';
import { InMemoryProposalRepository } from '../../../../src/proposals/proposal';
import { InMemoryAuditRepository } from '../../../../src/audit/audit';
import { InMemoryOnCallRepository } from '../../../../src/oncall/rotation';
import type { LLMGateway, LLMResponse } from '../../../../src/ai/gateway/gateway';
import type {
  EntityResolver,
  EntityResolverResult,
} from '../../../../src/ai/resolution/entity-resolver';

const TENANT = 'tenant-safety';
const USER = 'user-safety';

function scriptedGateway(responses: string[]): LLMGateway {
  let i = 0;
  return {
    complete: vi.fn(async () => {
      const content = responses[Math.min(i++, responses.length - 1)];
      return {
        content,
        model: 'mock',
        provider: 'mock',
        tokenUsage: { input: 1, output: 1, total: 2 },
        latencyMs: 1,
      } satisfies LLMResponse;
    }),
  } as unknown as LLMGateway;
}

/** A resolver that returns a fixed result and records how it was called. */
function stubResolver(result: EntityResolverResult): EntityResolver & {
  calls: Array<{ tenantId: string; reference: string; kind: string }>;
} {
  const calls: Array<{ tenantId: string; reference: string; kind: string }> = [];
  return {
    calls,
    resolve: vi.fn(async (input) => {
      calls.push(input);
      return result;
    }),
  };
}

const SCHEDULING_CLASSIFIER = JSON.stringify({
  intentType: 'create_appointment',
  confidence: 0.93,
  extractedEntities: { customerName: 'Bob Smith', dateTimeDescription: 'tomorrow at 2pm' },
});

/**
 * VOX-02 — record-OPERATING intents (they act on a document that must already
 * exist), used to prove the not_found escalation narrowing did not weaken
 * 46a954e1's fix for the cases it was actually written for.
 */
const SEND_ESTIMATE_CLASSIFIER = JSON.stringify({
  intentType: 'send_estimate',
  confidence: 0.93,
  extractedEntities: { customerName: 'Bob Smith' },
});

const RECORD_PAYMENT_CLASSIFIER = JSON.stringify({
  intentType: 'record_payment',
  confidence: 0.93,
  extractedEntities: { customerName: 'Bob Smith', amount: '250' },
});

describe('InAppVoiceAdapter — entity-resolution voice safety', () => {
  let store: VoiceSessionStore;
  let proposalRepo: InMemoryProposalRepository;
  let auditRepo: InMemoryAuditRepository;
  let onCallRepo: InMemoryOnCallRepository;

  beforeEach(() => {
    store = new VoiceSessionStore({ startInterval: false });
    proposalRepo = new InMemoryProposalRepository();
    auditRepo = new InMemoryAuditRepository();
    onCallRepo = new InMemoryOnCallRepository(
      new Map([[TENANT, [{ id: 'r1', userId: 'dispatcher-1', orderIndex: 0 }]]]),
    );
  });

  afterEach(() => store.dispose());

  function makeAdapter(
    entityResolver: EntityResolver,
    classifier: string = SCHEDULING_CLASSIFIER,
  ): InAppVoiceAdapter {
    return new InAppVoiceAdapter({
      store,
      gateway: scriptedGateway([classifier]),
      proposalRepo,
      auditRepo,
      onCallRepo,
      entityResolver,
    });
  }

  // ── (a) + (d) unique match → intent_confirm readback, NOT auto-confirmed ──
  it('unique match resolves to a single id, STOPS at intent_confirm, and does not auto-confirm', async () => {
    const resolver = stubResolver({
      kind: 'resolved',
      candidate: { id: 'cust-1', kind: 'customer', label: 'Bob Smith', score: 0.95 },
    });
    const adapter = makeAdapter(resolver);
    const { sessionId } = await adapter.startSession(TENANT, USER);

    const turn1 = await adapter.handleInput(sessionId, 'book Bob Smith for tomorrow at 2pm');

    // Resolver WAS consulted (no hand-rolled lookup) and the FSM parked at the
    // readback — no proposal yet (auto-confirm removed).
    expect((resolver.resolve as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: TENANT, reference: 'Bob Smith', kind: 'customer' }),
    );
    expect(turn1.state).toBe('intent_confirm');
    expect(turn1.proposalIds.length).toBe(0);
    expect(await proposalRepo.findByTenant(TENANT)).toHaveLength(0);

    const audits = auditRepo.getAll().map((e) => e.eventType);
    expect(audits).toContain('agent.calling.entity_resolution.entity_resolved');
    // The readback fired, and NO synthetic confirmed was dispatched this turn.
    expect(audits).not.toContain('agent.calling.intent_confirm.confirmed');

    // (d) Only a REAL caller "yes" produces the proposal.
    const turn2 = await adapter.handleInput(sessionId, 'yes');
    expect(turn2.state).toBe('closing');
    expect(turn2.proposalIds.length).toBe(1);
    const proposals = await proposalRepo.findByTenant(TENANT);
    expect(proposals).toHaveLength(1);
    expect(proposals[0].proposalType).toBe('create_appointment');
    // The resolved id was threaded into the proposal payload's entities.
    expect((proposals[0].payload.entities as Record<string, unknown>).customerId).toBe('cust-1');
    expect(auditRepo.getAll().map((e) => e.eventType)).toContain(
      'agent.calling.intent_confirm.confirmed',
    );
  });

  // ── (b) two candidates → entity_ambiguous WITH candidates, no silent pick ──
  it('two candidates → entity_ambiguous with the candidate set, NEVER a silent newest-match pick', async () => {
    const resolver = stubResolver({
      kind: 'ambiguous',
      candidates: [
        {
          id: 'bob-old',
          kind: 'customer',
          label: 'Bob Smith',
          hint: '555-0001 · 104 QA Cedar Avenue',
          score: 0.91,
        },
        {
          id: 'bob-new',
          kind: 'customer',
          label: 'Bob Smith',
          hint: '555-0002 · 105 QA Cedar Avenue',
          score: 0.9,
        },
      ],
    });
    const adapter = makeAdapter(resolver);
    const { sessionId } = await adapter.startSession(TENANT, USER);

    const turn1 = await adapter.handleInput(sessionId, 'book Bob Smith for tomorrow at 2pm');

    // Stays in entity_resolution to ask the disambiguation question — no
    // proposal, no auto-pick.
    expect(turn1.state).toBe('entity_resolution');
    expect(turn1.proposalIds.length).toBe(0);
    expect(await proposalRepo.findByTenant(TENANT)).toHaveLength(0);

    // The disambiguation TTS carries BOTH candidates (id/name/score shape).
    const disambig = turn1.sideEffects.find(
      (e) => e.type === 'tts_play' && e.payload.template === 'disambiguate',
    );
    expect(disambig).toBeDefined();
    const candidates = disambig?.payload.candidates as Array<{ id: string; name: string }>;
    expect(candidates).toHaveLength(2);
    expect(candidates.map((c) => c.id).sort()).toEqual(['bob-new', 'bob-old']);
    // label → name mapping for the FSM's readback.
    expect(candidates.every((c) => c.name === 'Bob Smith')).toBe(true);

    const audits = auditRepo.getAll();
    const ambiguous = audits.find(
      (e) => e.eventType === 'agent.calling.entity_resolution.entity_ambiguous',
    );
    expect(ambiguous).toBeDefined();
    expect(ambiguous?.metadata?.candidateCount).toBe(2);
  });

  it('address follow-up resolves ambiguity, then confirmation drafts the proposal', async () => {
    const resolver = stubResolver({
      kind: 'ambiguous',
      candidates: [
        {
          id: 'bob-old',
          kind: 'customer',
          label: 'Bob Smith',
          hint: '555-0001 · 104 QA Cedar Avenue',
          score: 0.91,
        },
        {
          id: 'bob-new',
          kind: 'customer',
          label: 'Bob Smith',
          hint: '555-0002 · 105 QA Cedar Avenue',
          score: 0.9,
        },
      ],
    });
    const adapter = makeAdapter(resolver);
    const { sessionId } = await adapter.startSession(TENANT, USER);

    const turn1 = await adapter.handleInput(sessionId, 'book Bob Smith for tomorrow at 2pm');
    expect(turn1.state).toBe('entity_resolution');

    const turn2 = await adapter.handleInput(sessionId, '104 Cedar');
    expect(turn2.state).toBe('intent_confirm');
    expect(turn2.proposalIds.length).toBe(0);

    const turn3 = await adapter.handleInput(sessionId, 'yes');
    expect(turn3.state).toBe('closing');
    expect(turn3.proposalIds.length).toBe(1);
    const proposals = await proposalRepo.findByTenant(TENANT);
    expect(proposals).toHaveLength(1);
    expect((proposals[0].payload.entities as Record<string, unknown>).customerId).toBe('bob-old');
    expect(auditRepo.getAll().map((e) => e.eventType)).toContain(
      'agent.calling.entity_resolution.entity_resolved',
    );
  });

  it('does not call the classifier again on an entity_resolution disambiguation follow-up', async () => {
    const gateway = scriptedGateway([SCHEDULING_CLASSIFIER]);
    const resolver = stubResolver({
      kind: 'ambiguous',
      candidates: [
        {
          id: 'bob-old',
          kind: 'customer',
          label: 'Bob Smith',
          hint: '555-0001 · 104 QA Cedar Avenue',
          score: 0.91,
        },
        {
          id: 'bob-new',
          kind: 'customer',
          label: 'Bob Smith',
          hint: '555-0002 · 105 QA Cedar Avenue',
          score: 0.9,
        },
      ],
    });
    const adapter = new InAppVoiceAdapter({
      store,
      gateway,
      proposalRepo,
      auditRepo,
      onCallRepo,
      entityResolver: resolver,
    });
    const { sessionId } = await adapter.startSession(TENANT, USER);

    await adapter.handleInput(sessionId, 'book Bob Smith for tomorrow at 2pm');
    await adapter.handleInput(sessionId, '104 Cedar');

    expect(gateway.complete).toHaveBeenCalledTimes(1);
  });

  // ── (c) zero matches on a RECORD-OPERATING intent → escalates (Fix 1) ─────
  // VOX-02 narrowed the escalation to intents that genuinely need a
  // pre-existing record; this is the guard that keeps 46a954e1's original bug
  // (not_found silently masquerading as entity_resolved) fixed for them.
  it('zero matches on a record-operating intent (send_estimate) → entity_not_found → escalates to on-call, never a silent entity_resolved', async () => {
    const resolver = stubResolver({ kind: 'not_found', reference: 'Bob Smith' });
    const adapter = makeAdapter(resolver, SEND_ESTIMATE_CLASSIFIER);
    const { sessionId } = await adapter.startSession(TENANT, USER);

    const turn1 = await adapter.handleInput(sessionId, 'send the estimate to Bob Smith');

    expect(turn1.state).toBe('escalating');
    expect(turn1.proposalIds.length).toBe(0);
    expect(await proposalRepo.findByTenant(TENANT)).toHaveLength(0);
    expect(turn1.sideEffects.some((e) => e.type === 'notify_oncall')).toBe(true);
    expect(auditRepo.getAll().map((e) => e.eventType)).toContain(
      'agent.calling.entity_resolution.entity_not_found',
    );
    expect(auditRepo.getAll().map((e) => e.eventType)).not.toContain(
      'agent.calling.entity_resolution.entity_resolved',
    );
  });

  it('zero matches on record_payment also escalates (record-operating family, not just estimates)', async () => {
    const resolver = stubResolver({ kind: 'not_found', reference: 'Bob Smith' });
    const adapter = makeAdapter(resolver, RECORD_PAYMENT_CLASSIFIER);
    const { sessionId } = await adapter.startSession(TENANT, USER);

    const turn1 = await adapter.handleInput(sessionId, 'record a payment from Bob Smith');

    expect(turn1.state).toBe('escalating');
    expect(turn1.sideEffects.some((e) => e.type === 'notify_oncall')).toBe(true);
    expect(auditRepo.getAll().map((e) => e.eventType)).toContain(
      'agent.calling.entity_resolution.entity_not_found',
    );
  });

  // ── (c') VOX-02: zero matches on a CREATION intent must NOT escalate ──────
  it('zero matches on a creation intent (create_appointment) falls through to entity_resolved — a caller booking NEW work is never escalated', async () => {
    const resolver = stubResolver({ kind: 'not_found', reference: 'Bob Smith' });
    const adapter = makeAdapter(resolver);
    const { sessionId } = await adapter.startSession(TENANT, USER);

    const turn1 = await adapter.handleInput(sessionId, 'book Bob Smith for tomorrow at 2pm');

    // intent_confirm readback, NOT on-call escalation.
    expect(turn1.state).toBe('intent_confirm');
    expect(turn1.sideEffects.some((e) => e.type === 'notify_oncall')).toBe(false);
    const audits = auditRepo.getAll().map((e) => e.eventType);
    expect(audits).toContain('agent.calling.entity_resolution.entity_resolved');
    expect(audits).not.toContain('agent.calling.entity_resolution.entity_not_found');
    // Still NEVER a guessed id — the unresolved reference stays pending.
    expect(turn1.proposalIds.length).toBe(0);

    // And a real caller "yes" still produces the proposal with no customerId.
    const turn2 = await adapter.handleInput(sessionId, 'yes');
    expect(turn2.state).toBe('closing');
    const proposals = await proposalRepo.findByTenant(TENANT);
    expect(proposals).toHaveLength(1);
    expect((proposals[0].payload.entities as Record<string, unknown>).customerId).toBeUndefined();
  });

  // ── (e) middle confidence band → entity_confirm, then affirm/decline ──────
  it('a middle-confidence candidate → entity_confirm; an affirmative reply merges it in and proceeds to the proposal', async () => {
    const resolver = stubResolver({
      kind: 'low_confidence',
      candidate: { id: 'cust-7', kind: 'customer', label: 'Bob Smith', score: 0.7 },
    });
    const adapter = makeAdapter(resolver);
    const { sessionId } = await adapter.startSession(TENANT, USER);

    const turn1 = await adapter.handleInput(sessionId, 'book Bob Smith for tomorrow at 2pm');
    expect(turn1.state).toBe('entity_confirm');
    expect(turn1.proposalIds.length).toBe(0);
    expect(await proposalRepo.findByTenant(TENANT)).toHaveLength(0);
    expect(turn1.sideEffects.some((e) => e.type === 'notify_oncall')).toBe(false);
    const confirmTts = turn1.sideEffects.find(
      (e) => e.type === 'tts_play' && e.payload.template === 'confirm_entity',
    );
    expect(confirmTts).toBeDefined();
    expect(confirmTts?.payload.summary).toBe('Bob Smith');

    const turn2 = await adapter.handleInput(sessionId, 'yes, that one');
    expect(turn2.state).toBe('intent_confirm');
    expect(turn2.proposalIds.length).toBe(0);

    const turn3 = await adapter.handleInput(sessionId, 'yes');
    expect(turn3.state).toBe('closing');
    expect(turn3.proposalIds.length).toBe(1);
    const proposals = await proposalRepo.findByTenant(TENANT);
    expect((proposals[0].payload.entities as Record<string, unknown>).customerId).toBe('cust-7');
  });

  it('a middle-confidence candidate → entity_confirm; a decline escalates like entity_not_found', async () => {
    const resolver = stubResolver({
      kind: 'low_confidence',
      candidate: { id: 'cust-7', kind: 'customer', label: 'Bob Smith', score: 0.7 },
    });
    const adapter = makeAdapter(resolver);
    const { sessionId } = await adapter.startSession(TENANT, USER);

    await adapter.handleInput(sessionId, 'book Bob Smith for tomorrow at 2pm');
    const turn2 = await adapter.handleInput(sessionId, 'no, not them');

    expect(turn2.state).toBe('escalating');
    expect(turn2.proposalIds.length).toBe(0);
    expect(await proposalRepo.findByTenant(TENANT)).toHaveLength(0);
    expect(turn2.sideEffects.some((e) => e.type === 'notify_oncall')).toBe(true);
    expect(auditRepo.getAll().map((e) => e.eventType)).toContain(
      'agent.calling.entity_confirm.entity_confirm_declined',
    );
  });

  // ── correction path: a non-affirmative readback answer re-captures intent ──
  it('a non-affirmative answer at intent_confirm is a correction (no proposal queued)', async () => {
    const resolver = stubResolver({
      kind: 'resolved',
      candidate: { id: 'cust-1', kind: 'customer', label: 'Bob Smith', score: 0.95 },
    });
    const adapter = makeAdapter(resolver);
    const { sessionId } = await adapter.startSession(TENANT, USER);

    await adapter.handleInput(sessionId, 'book Bob Smith for tomorrow at 2pm');
    const correction = await adapter.handleInput(sessionId, "no that's not right");

    expect(correction.state).toBe('intent_capture');
    expect(await proposalRepo.findByTenant(TENANT)).toHaveLength(0);
    expect(auditRepo.getAll().map((e) => e.eventType)).toContain(
      'agent.calling.intent_confirm.correction',
    );
  });
});

// ── Pure logic: resolveSchedulingEntities ────────────────────────────────────
describe('resolveSchedulingEntities (pure resolver folding)', () => {
  const TID = 'tenant-1';

  function resolverReturning(result: EntityResolverResult): EntityResolver {
    return { resolve: vi.fn(async () => result) };
  }

  it('unique customer match → status resolved, id threaded into refs', async () => {
    const r = await resolveSchedulingEntities(
      resolverReturning({
        kind: 'resolved',
        candidate: { id: 'c1', kind: 'customer', label: 'Bob', score: 0.9 },
      }),
      TID,
      'create_appointment',
      { customerName: 'Bob' },
    );
    expect(r.status).toBe('resolved');
    expect(r.refs.customerId).toBe('c1');
  });

  it('ambiguous customer → status ambiguous with candidates, no id guessed', async () => {
    const r = await resolveSchedulingEntities(
      resolverReturning({
        kind: 'ambiguous',
        candidates: [
          { id: 'a', kind: 'customer', label: 'Bob', score: 0.9 },
          { id: 'b', kind: 'customer', label: 'Bob', score: 0.85 },
        ],
      }),
      TID,
      'create_appointment',
      { customerName: 'Bob' },
    );
    expect(r.status).toBe('ambiguous');
    expect(r.ambiguous?.entityKind).toBe('customer');
    expect(r.ambiguous?.candidates).toHaveLength(2);
    expect(r.refs.customerId).toBeUndefined();
  });

  it('no customer match → status not_found (never a silent pick)', async () => {
    const r = await resolveSchedulingEntities(
      resolverReturning({ kind: 'not_found', reference: 'Ghost' }),
      TID,
      'create_appointment',
      { customerName: 'Ghost' },
    );
    expect(r.status).toBe('not_found');
    expect(r.notFound?.reference).toBe('Ghost');
    expect(r.refs.customerId).toBeUndefined();
  });

  it('explicit customer uuid bypasses the resolver', async () => {
    const resolve = vi.fn();
    const r = await resolveSchedulingEntities(
      { resolve } as EntityResolver,
      TID,
      'create_appointment',
      { customerId: '11111111-1111-1111-1111-111111111111' },
    );
    expect(resolve).not.toHaveBeenCalled();
    expect(r.status).toBe('resolved');
    expect(r.refs.customerId).toBe('11111111-1111-1111-1111-111111111111');
  });

  it('generic references ("our customer") are never resolved', async () => {
    const resolve = vi.fn();
    const r = await resolveSchedulingEntities(
      { resolve } as EntityResolver,
      TID,
      'create_appointment',
      { customerName: 'our customer' },
    );
    expect(resolve).not.toHaveBeenCalled();
    expect(r.status).toBe('resolved');
    expect(r.refs.customerId).toBeUndefined();
  });

  it('no resolver configured → resolution skipped, refs pass through unresolved (no guess)', async () => {
    const r = await resolveSchedulingEntities(
      undefined,
      TID,
      'create_appointment',
      { customerName: 'Bob', dateTimeDescription: 'tomorrow at 2pm' },
    );
    expect(r.status).toBe('resolved');
    expect(r.refs.customerId).toBeUndefined();
    // Deterministic datetime parse still runs (it's a parse, not a guess).
    expect(typeof r.refs.scheduledStart).toBe('string');
  });

  it('cancel_appointment with no appointmentReference does NOT guess an appointment', async () => {
    const resolve = vi.fn();
    const r = await resolveSchedulingEntities(
      { resolve } as EntityResolver,
      TID,
      'cancel_appointment',
      {},
    );
    expect(resolve).not.toHaveBeenCalled();
    expect(r.status).toBe('resolved');
    expect(r.refs.appointmentId).toBeUndefined();
    // The cancellation reason default is still applied (not an identity guess).
    expect(r.refs.reason).toBe('Requested by caller via voice session');
  });
});

// ── Pure logic: requiresExistingEntity (VOX-02) ─────────────────────────────
describe('requiresExistingEntity', () => {
  it('is FALSE for creation intents — a not_found there is the expected outcome', () => {
    for (const intent of [
      'create_appointment',
      'create_booking',
      'create_job',
      'create_customer',
      'create_invoice',
      'draft_estimate',
    ]) {
      expect(requiresExistingEntity(intent)).toBe(false);
    }
  });

  it('is TRUE for intents that operate on a record that must already exist', () => {
    for (const intent of [
      // invoice-doc family
      'update_invoice',
      'send_invoice',
      'record_payment',
      'apply_late_fee',
      'issue_invoice',
      'send_payment_reminder',
      // estimate-doc family
      'update_estimate',
      'send_estimate',
      'send_estimate_nudge',
      // appointment-ref family
      'cancel_appointment',
      'reschedule_appointment',
      'confirm_appointment',
      'reassign_appointment',
      // job-ref / technician-ref / customer-scoped families
      'update_job',
      'log_time_entry',
      'add_note',
      'notify_delay',
      'request_feedback',
      'add_crew_member',
      'remove_crew_member',
      'update_customer',
      'lookup_balance',
      'convert_lead',
    ]) {
      expect(requiresExistingEntity(intent)).toBe(true);
    }
  });

  it('is FALSE for intents outside every reference family (no reference to miss)', () => {
    for (const intent of ['unknown', 'operator_request', 'emergency_dispatch', 'language_switch']) {
      expect(requiresExistingEntity(intent)).toBe(false);
    }
  });
});

// ── Pure logic: isAffirmation ────────────────────────────────────────────────
describe('isAffirmation', () => {
  it('recognizes clear affirmatives (en + es)', () => {
    for (const t of ['yes', 'Yeah', 'yep', 'correct', "that's right", 'go ahead', 'sí', 'claro', 'yes, that one']) {
      expect(isAffirmation(t)).toBe(true);
    }
  });

  it('treats negations and ambiguous responses as NOT affirmative (safe default)', () => {
    for (const t of ['no', "that's not right", 'actually change it', 'wait', 'hmm', '', 'the blue one']) {
      expect(isAffirmation(t)).toBe(false);
    }
  });
});
