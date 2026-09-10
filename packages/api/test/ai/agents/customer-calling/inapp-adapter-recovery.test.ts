/**
 * R2 — confirmations & recovery on the in-app operator voice turn.
 *
 * The six cases here are the `confirmations` cluster of the 50-case register
 * (`fixtures/voice/inapp-50-cases.json` — conf-01…conf-04, noise-01,
 * noise-02). Each one is a shape a real operator produces on a real mic and
 * that the turn loop used to answer with either a lost readback, a second
 * proposal, or a march towards an on-call page:
 *
 *   conf-01  a noisy but unmistakable yes commits the readback
 *   conf-02  a duplicated yes after the proposal was queued mints nothing
 *   conf-03  the same sentence sent twice keeps the readback pending
 *   conf-04  a rejected readback plus a correction yields ONE proposal
 *   noise-01 filler gets one free reprompt, then the real request proceeds
 *   noise-02 a bare yes with nothing pending is answered, not classified
 *
 * Every assertion that matters is about what did NOT happen: no second
 * proposal, no classifier round-trip, no escalation, no wiped slots.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  InAppVoiceAdapter,
} from '../../../../src/ai/agents/customer-calling/inapp-adapter';
import { VoiceSessionStore } from '../../../../src/ai/agents/customer-calling/voice-session-store';
import { CONFIRM_NOTHING_PENDING_LINE } from '../../../../src/ai/agents/customer-calling/transitions';
import { InMemoryProposalRepository } from '../../../../src/proposals/proposal';
import { InMemoryAuditRepository } from '../../../../src/audit/audit';
import { InMemoryOnCallRepository } from '../../../../src/oncall/rotation';
import type { LLMGateway, LLMResponse } from '../../../../src/ai/gateway/gateway';
import type { EntityResolver } from '../../../../src/ai/resolution/entity-resolver';

const TENANT = 'tenant-recovery';
const USER = 'user-recovery';
const GARCIA_ID = 'customer-garcia';

const TUESDAY = 'Tuesday at 2 pm';
const THURSDAY = 'Thursday at 10 am';

const BOOK_TUESDAY = 'Book Garcia for Tuesday at 2 pm for the HVAC install';
const BOOK_THURSDAY = 'Book Garcia for Thursday at 10 am for the HVAC install';

/**
 * The register's conf-01…conf-04 classifier script, verbatim
 * (`fixtures/voice/inapp-50-cases.json`). `dateTimeDescription` is the raw
 * natural-language slot the classifier actually emits — turning it into an
 * ISO `scheduledStart` belongs to the scheduling cluster, not to this one, so
 * these tests assert the slot SURVIVES the recovery paths rather than
 * asserting how it is later parsed.
 */
function bookingClassification(when: string): string {
  return JSON.stringify({
    intentType: 'create_appointment',
    confidence: 0.94,
    extractedEntities: {
      customerName: 'Garcia',
      dateTimeDescription: when,
      jobTitle: 'HVAC install',
    },
  });
}

/** Counts calls so a test can prove a turn cost NO classifier round-trip. */
function scriptedGateway(responses: string[]): LLMGateway & { calls: () => number } {
  let i = 0;
  const complete = vi.fn(async () => {
    const content = responses[Math.min(i++, responses.length - 1)];
    return {
      content,
      model: 'mock',
      provider: 'mock',
      tokenUsage: { input: 1, output: 1, total: 2 },
      latencyMs: 1,
    } satisfies LLMResponse;
  });
  return {
    complete,
    calls: () => complete.mock.calls.length,
  } as unknown as LLMGateway & { calls: () => number };
}

function resolvesToGarcia(): EntityResolver {
  return {
    resolve: vi.fn(async ({ kind }: { kind: string }) => ({
      kind: 'resolved' as const,
      candidate: { id: GARCIA_ID, kind: kind as never, label: 'Garcia', score: 0.97 },
    })),
  } as unknown as EntityResolver;
}

describe('InAppVoiceAdapter — confirmations & recovery (register cluster `confirmations`)', () => {
  let store: VoiceSessionStore;
  let proposalRepo: InMemoryProposalRepository;
  let auditRepo: InMemoryAuditRepository;
  let onCallRepo: InMemoryOnCallRepository;

  beforeEach(() => {
    store = new VoiceSessionStore({ startInterval: false });
    proposalRepo = new InMemoryProposalRepository();
    auditRepo = new InMemoryAuditRepository();
    // A staffed rotation — so an unwanted escalation would actually PAGE
    // someone, which is what these tests are proving cannot happen.
    onCallRepo = new InMemoryOnCallRepository(
      new Map([[TENANT, [{ id: 'r1', userId: 'dispatcher-1', orderIndex: 0 }]]]),
    );
  });

  afterEach(() => store.dispose());

  function makeAdapter(gateway: LLMGateway): InAppVoiceAdapter {
    return new InAppVoiceAdapter({
      store,
      gateway,
      proposalRepo,
      auditRepo,
      onCallRepo,
      entityResolver: resolvesToGarcia(),
    });
  }

  function auditEventTypes(): string[] {
    return auditRepo.getAll().map((event) => event.eventType);
  }

  // ── conf-01 ────────────────────────────────────────────────────────────
  it('conf-01 — a noisy affirmation ("uh yeah, go ahead") commits the readback', async () => {
    const gateway = scriptedGateway([bookingClassification(TUESDAY)]);
    const adapter = makeAdapter(gateway);
    const { sessionId } = await adapter.startSession(TENANT, USER);

    const readback = await adapter.handleInput(sessionId, BOOK_TUESDAY);
    expect(readback.state).toBe('intent_confirm');
    expect(readback.trace.stage).toBe('confirmation_asked');
    expect(readback.trace.intent).toBe('create_appointment');
    expect(readback.trace.resolution).toBe('resolved');

    const callsBeforeConfirm = gateway.calls();
    const committed = await adapter.handleInput(sessionId, 'uh yeah, go ahead');

    // The confirm turn is deterministic — no classifier round-trip at all.
    expect(gateway.calls()).toBe(callsBeforeConfirm);
    expect(committed.proposalIds).toHaveLength(1);
    expect(await proposalRepo.findByTenant(TENANT)).toHaveLength(1);
    const stored = await proposalRepo.findById(TENANT, committed.proposalIds[0]);
    expect(stored?.proposalType).toBe('create_appointment');
    expect((stored?.payload as { customerId?: string }).customerId).toBe(GARCIA_ID);
    expect(committed.trace.stage).toBe('committed');
    expect(committed.trace.proposalType).toBe('create_appointment');
    expect(committed.trace.dedup).toBeUndefined();
  });

  // ── conf-02 ────────────────────────────────────────────────────────────
  it('conf-02 — a duplicated "yes" after the proposal was queued mints nothing and says so', async () => {
    const gateway = scriptedGateway([bookingClassification(TUESDAY)]);
    const adapter = makeAdapter(gateway);
    const { sessionId } = await adapter.startSession(TENANT, USER);

    await adapter.handleInput(sessionId, BOOK_TUESDAY);
    const committed = await adapter.handleInput(sessionId, 'yes');
    expect(committed.proposalIds).toHaveLength(1);
    expect(committed.state).toBe('closing');

    const callsBeforeRepeat = gateway.calls();
    const repeat = await adapter.handleInput(sessionId, 'yes');

    // Deterministic: the guard answers without paying a classify round-trip.
    expect(gateway.calls()).toBe(callsBeforeRepeat);
    expect(repeat.ttsText).toBe(CONFIRM_NOTHING_PENDING_LINE);
    expect(repeat.state).toBe('closing');
    expect(repeat.proposalIds).toHaveLength(1);
    expect(await proposalRepo.findByTenant(TENANT)).toHaveLength(1);
    expect(repeat.sideEffects.some((fx) => fx.type === 'create_proposal')).toBe(false);
    expect(repeat.sideEffects.some((fx) => fx.type === 'notify_oncall')).toBe(false);
    expect(repeat.trace.stage).toBe('guarded');
    expect(repeat.trace.fallbackReason).toBe('guard');
    expect(repeat.trace.dedup).toBe('duplicate_turn');
    expect(auditEventTypes()).toContain('agent.calling.closing.confirm_without_pending');
  });

  // ── conf-03 ────────────────────────────────────────────────────────────
  it('conf-03 — the same booking sentence twice keeps the readback pending, then commits once', async () => {
    const gateway = scriptedGateway([bookingClassification(TUESDAY)]);
    const adapter = makeAdapter(gateway);
    const { sessionId } = await adapter.startSession(TENANT, USER);

    const first = await adapter.handleInput(sessionId, BOOK_TUESDAY);
    expect(first.state).toBe('intent_confirm');
    const callsAfterFirst = gateway.calls();
    const spokenReadback = first.ttsText;

    const duplicate = await adapter.handleInput(sessionId, BOOK_TUESDAY);

    // No re-classification, no correction: the readback is still on the table
    // with its slots intact, and the operator hears the same question again.
    expect(gateway.calls()).toBe(callsAfterFirst);
    expect(duplicate.state).toBe('intent_confirm');
    expect(duplicate.ttsText).toBe(spokenReadback);
    expect(duplicate.proposalIds).toHaveLength(0);
    expect(duplicate.trace.dedup).toBe('duplicate_turn');
    expect(duplicate.trace.stage).toBe('guarded');
    expect(auditEventTypes()).toContain('agent.calling.turn_deduplicated');

    const context = store.peek(sessionId)?.machine.currentContext;
    expect(context?.currentIntent).toBe('create_appointment');
    expect(context?.extractedEntities?.dateTimeDescription).toBe(TUESDAY);

    const committed = await adapter.handleInput(sessionId, 'yes');
    expect(committed.proposalIds).toHaveLength(1);
    expect(await proposalRepo.findByTenant(TENANT)).toHaveLength(1);
    const stored = await proposalRepo.findById(TENANT, committed.proposalIds[0]);
    expect((stored?.payload as { customerId?: string }).customerId).toBe(GARCIA_ID);
    expect((stored?.payload as { dateTimeDescription?: string }).dateTimeDescription).toBe(TUESDAY);
  });

  it('conf-03 — a repeat OUTSIDE the dedup window is honoured as a fresh request', async () => {
    const gateway = scriptedGateway([bookingClassification(TUESDAY)]);
    const adapter = makeAdapter(gateway);
    const { sessionId } = await adapter.startSession(TENANT, USER);

    await adapter.handleInput(sessionId, BOOK_TUESDAY);
    const session = store.peek(sessionId);
    // 16 s ago — past the 15 s retry window.
    session!.lastOperatorTurn!.at = Date.now() - 16_000;

    const callsBefore = gateway.calls();
    const repeat = await adapter.handleInput(sessionId, BOOK_TUESDAY);

    expect(repeat.trace.dedup).toBeUndefined();
    expect(gateway.calls()).toBeGreaterThan(callsBefore);
  });

  // ── conf-04 ────────────────────────────────────────────────────────────
  it('conf-04 — "no" then a corrected request yields exactly one proposal with the corrected slot', async () => {
    const gateway = scriptedGateway([
      bookingClassification(TUESDAY),
      bookingClassification(THURSDAY),
    ]);
    const adapter = makeAdapter(gateway);
    const { sessionId } = await adapter.startSession(TENANT, USER);

    const readback = await adapter.handleInput(sessionId, BOOK_TUESDAY);
    expect(readback.state).toBe('intent_confirm');

    const rejected = await adapter.handleInput(sessionId, 'no');
    expect(rejected.proposalIds).toHaveLength(0);
    expect(rejected.state).not.toBe('intent_confirm');

    const corrected = await adapter.handleInput(sessionId, BOOK_THURSDAY);
    expect(corrected.state).toBe('intent_confirm');

    const committed = await adapter.handleInput(sessionId, 'yes');
    expect(committed.proposalIds).toHaveLength(1);
    const all = await proposalRepo.findByTenant(TENANT);
    expect(all).toHaveLength(1);
    expect((all[0].payload as { dateTimeDescription?: string }).dateTimeDescription).toBe(THURSDAY);
    expect(committed.sideEffects.some((fx) => fx.type === 'notify_oncall')).toBe(false);
  });

  // ── noise-01 ───────────────────────────────────────────────────────────
  it('noise-01 — "um... hello?" gets one gentle reprompt with no LLM call and no retry budget spent', async () => {
    const gateway = scriptedGateway([bookingClassification(TUESDAY)]);
    const adapter = makeAdapter(gateway);
    const { sessionId } = await adapter.startSession(TENANT, USER);

    const noise = await adapter.handleInput(sessionId, 'um... hello?');

    expect(gateway.calls()).toBe(0);
    expect(noise.state).toBe('intent_capture');
    expect(noise.ttsText).toBeTruthy();
    expect(noise.proposalIds).toHaveLength(0);
    expect(noise.sideEffects.some((fx) => fx.type === 'notify_oncall')).toBe(false);
    expect(noise.trace.dedup).toBe('noise');
    expect(noise.trace.fallbackReason).toBe('reprompt');
    expect(auditEventTypes()).toContain('agent.calling.intent_capture.noise_reprompt');

    // The FSM's bounded retry/reprompt budget is untouched — a mic check can
    // never walk the session towards an on-call page.
    const context = store.peek(sessionId)?.machine.currentContext;
    expect(context?.retryCount ?? 0).toBe(0);
    expect(context?.repromptCount ?? 0).toBe(0);

    // …and the real request that follows proceeds normally.
    const readback = await adapter.handleInput(sessionId, BOOK_TUESDAY);
    expect(gateway.calls()).toBe(1);
    expect(readback.state).toBe('intent_confirm');
    const committed = await adapter.handleInput(sessionId, 'yes');
    expect(committed.proposalIds).toHaveLength(1);
    expect(committed.trace.stage).toBe('committed');
  });

  it('noise-01 — the free reprompt is bounded: a fourth consecutive noise turn reaches the classifier', async () => {
    const gateway = scriptedGateway([
      JSON.stringify({ intentType: 'unknown', confidence: 0.1, extractedEntities: {} }),
    ]);
    const adapter = makeAdapter(gateway);
    const { sessionId } = await adapter.startSession(TENANT, USER);

    // Distinct filler each turn so the DUPLICATE guard is not what stops them.
    await adapter.handleInput(sessionId, 'um');
    await adapter.handleInput(sessionId, 'uh');
    await adapter.handleInput(sessionId, 'hmm');
    expect(gateway.calls()).toBe(0);

    const fourth = await adapter.handleInput(sessionId, 'hello?');
    expect(gateway.calls()).toBe(1);
    expect(fourth.trace.dedup).toBeUndefined();
  });

  // ── noise-02 ───────────────────────────────────────────────────────────
  it('noise-02 — a bare "yes" with nothing pending is answered deterministically, never classified', async () => {
    const gateway = scriptedGateway([
      JSON.stringify({ intentType: 'confirm', confidence: 0.95, extractedEntities: {} }),
    ]);
    const adapter = makeAdapter(gateway);
    const { sessionId } = await adapter.startSession(TENANT, USER);

    const result = await adapter.handleInput(sessionId, 'yes');

    expect(gateway.calls()).toBe(0);
    expect(result.ttsText).toBe(CONFIRM_NOTHING_PENDING_LINE);
    expect(result.state).toBe('intent_capture');
    expect(result.proposalIds).toHaveLength(0);
    expect(await proposalRepo.findByTenant(TENANT)).toHaveLength(0);
    expect(result.sideEffects.some((fx) => fx.type === 'notify_oncall')).toBe(false);
    expect(result.trace.stage).toBe('guarded');
    expect(result.trace.fallbackReason).toBe('guard');
    expect(result.trace.dedup).toBeUndefined();
  });

  it('a request that merely OPENS with "yes" is still classified — the guard is strict', async () => {
    const gateway = scriptedGateway([bookingClassification(TUESDAY)]);
    const adapter = makeAdapter(gateway);
    const { sessionId } = await adapter.startSession(TENANT, USER);

    const result = await adapter.handleInput(sessionId, `yes, ${BOOK_TUESDAY}`);

    expect(gateway.calls()).toBe(1);
    expect(result.state).toBe('intent_confirm');
    expect(result.ttsText).not.toBe(CONFIRM_NOTHING_PENDING_LINE);
  });

  // ── trace is always present ────────────────────────────────────────────
  it('every turn carries a trace, including the deterministic recovery turns', async () => {
    const gateway = scriptedGateway([bookingClassification(TUESDAY)]);
    const adapter = makeAdapter(gateway);
    const { sessionId } = await adapter.startSession(TENANT, USER);

    for (const turn of ['um', BOOK_TUESDAY, BOOK_TUESDAY, 'yes', 'yes']) {
      const result = await adapter.handleInput(sessionId, turn);
      expect(result.trace).toBeDefined();
      expect(typeof result.trace.stage).toBe('string');
    }
    expect(await proposalRepo.findByTenant(TENANT)).toHaveLength(1);
  });
});
