/**
 * #1015 row 3.10 — the media-streams transport (`speechTurn`) asks WHICH
 * appointment when a move/cancel names none, and resolves the answer through
 * the entity resolver. The Gather transport is proven at real Postgres in
 * test/integration/phone-appointment-change-reference-3-10.test.ts; this is
 * the handler-level twin (mocked gateway/resolver) plus the S1 guard: a
 * customer caller is never offered other customers' appointments to pick
 * from, so the question is owner/operator-only.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';

import { createVoiceTurnProcessor } from '../../../src/ai/voice-turn';
import { VoiceSessionStore } from '../../../src/ai/agents/customer-calling/voice-session-store';
import { InMemoryAuditRepository } from '../../../src/audit/audit';
import { InMemoryProposalRepository } from '../../../src/proposals/proposal';
import type { LLMGateway, LLMRequest } from '../../../src/ai/gateway/gateway';
import type { SideEffect } from '../../../src/ai/agents/customer-calling/types';
import type { EntityResolver, EntityResolverResult } from '../../../src/ai/resolution/entity-resolver';

const TENANT = 'tenant-1015-310';
const APPT = '5b0c4a0e-7f7e-4d8e-9a39-8f1d3c2b1a00';

const GARCIA: EntityResolverResult = {
  kind: 'resolved',
  candidate: { id: APPT, kind: 'appointment', label: 'Tue 10:00 AM', score: 0.95 },
};

/** confirm_intent answers yes; any classify call answers a reschedule. */
function gateway(): LLMGateway {
  return {
    complete: vi.fn(async (req: LLMRequest) => ({
      content:
        (req.metadata as { skill?: string } | undefined)?.skill === 'confirm_intent'
          ? JSON.stringify({ answer: 'yes', reasoning: 'affirmative' })
          : JSON.stringify({ intentType: 'reschedule_appointment', confidence: 0.94, extractedEntities: {} }),
      model: 'mock',
      provider: 'mock',
      tokenUsage: { input: 1, output: 1, total: 2 },
      latencyMs: 1,
    })),
  } as unknown as LLMGateway;
}

const stores: VoiceSessionStore[] = [];
afterEach(() => {
  for (const s of stores.splice(0)) s.dispose();
});

function makePhone(opts: { ownerSession: boolean }) {
  const store = new VoiceSessionStore({ startInterval: false });
  stores.push(store);
  const proposalRepo = new InMemoryProposalRepository();
  const resolver: EntityResolver = { resolve: vi.fn(async () => GARCIA) };
  const session = store.create(TENANT, 'telephony', {
    callSid: 'CA-1015-310',
    ...(opts.ownerSession ? { ownerSession: true } : {}),
  });
  session.machine.dispatch({
    type: 'incoming_call',
    callSid: 'CA-1015-310',
    from: '+15125550100',
    to: '+15125550999',
    tenantId: TENANT,
  });
  session.machine.dispatch({ type: 'greeted_ok' });
  session.machine.dispatch({ type: 'caller_known', customerId: 'cust-1' });
  const processor = createVoiceTurnProcessor({
    store,
    gateway: gateway(),
    businessName: 'Acme Plumbing',
    systemActorId: 'test-actor',
    auditRepo: new InMemoryAuditRepository(),
    proposalRepo,
    entityResolver: resolver,
  });
  const turn = (speechResult: string) =>
    processor.speechTurn({ session, speechResult, callSid: 'CA-1015-310', tenantId: TENANT });
  return { session, proposalRepo, resolver, turn };
}

function spoken(sideEffects: SideEffect[]): string {
  return sideEffects
    .filter((fx) => fx.type === 'tts_play')
    .map((fx) => String(fx.payload.text))
    .join(' ');
}

describe('#1015 row 3.10 — speechTurn asks which appointment a move/cancel is about', () => {
  it('owner line: "I need to cancel my appointment" asks which one; the answer is resolved as an appointment reference and read back', async () => {
    const { session, resolver, turn } = makePhone({ ownerSession: true });

    const ask = await turn('I need to cancel my appointment');
    expect(spoken(ask)).toContain('Which appointment would you like to cancel?');
    expect(spoken(ask)).not.toMatch(/Is that right\?/);
    expect(session.machine.currentState).toBe('entity_resolution');

    const answer = await turn('The Garcia appointment');
    expect(resolver.resolve).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: TENANT, kind: 'appointment', reference: 'The Garcia appointment' }),
    );
    expect(spoken(answer)).toContain('cancel appointment. Is that right?');
    expect(session.machine.currentState).toBe('intent_confirm');
    expect(session.machine.currentContext.extractedEntities?.appointmentId).toBe(APPT);
  });

  it('asks once: an answer that resolves nothing reads the request back with no appointmentId — it never asks again and never guesses', async () => {
    const unmatched = makePhone({ ownerSession: true });
    (unmatched.resolver.resolve as ReturnType<typeof vi.fn>).mockResolvedValue({ kind: 'not_found' });

    await unmatched.turn('I need to reschedule my appointment');
    const answer = await unmatched.turn('The Zzyzx appointment');

    expect(spoken(answer)).not.toContain('Which appointment');
    expect(spoken(answer)).toContain('reschedule appointment. Is that right?');
    expect(unmatched.session.machine.currentContext.extractedEntities?.appointmentId).toBeUndefined();
  });

  it('S1 customer caller: never asked "which appointment" (no other customers\' appointments are offered)', async () => {
    const { session, turn } = makePhone({ ownerSession: false });

    const fx = await turn('I need to reschedule my appointment');

    // The request is understood and read back as before this change.
    expect(spoken(fx)).toContain('reschedule appointment. Is that right?');
    expect(spoken(fx)).not.toContain('Which appointment');
    expect(session.machine.currentContext.pendingEntityRequest).toBeUndefined();
  });
});
