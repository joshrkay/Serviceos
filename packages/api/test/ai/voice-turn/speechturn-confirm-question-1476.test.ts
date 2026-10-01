/**
 * #1476 item 3 — the phone turn engine (createVoiceTurnProcessor().speechTurn,
 * behind media streams): a QUESTION asked at the yes/no readback is answered,
 * the pending request is KEPT and the readback is re-asked — instead of the
 * confirm_intent skill reading "not a yes" as a correction ("My apologies —
 * let me try again") and throwing the request away.
 *
 * The callback-number answer respects the surface:
 *   - S1 (an untrusted inbound caller) hears only what THEY gave on this
 *     call, or their own caller-ID masked — never a number off a customer
 *     record;
 *   - the owner line may hear the customer's number on file.
 *
 * Seam: speechTurn with a scripted gateway (classifier + confirm_intent) and
 * in-memory repos — the #1416/#1485 speechTurn harness.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';

import { createVoiceTurnProcessor } from '../../../src/ai/voice-turn';
import { VoiceSessionStore } from '../../../src/ai/agents/customer-calling/voice-session-store';
import { InMemoryAuditRepository } from '../../../src/audit/audit';
import { InMemoryProposalRepository } from '../../../src/proposals/proposal';
import { InMemoryCustomerRepository, createCustomer } from '../../../src/customers/customer';
import type { LLMGateway, LLMRequest } from '../../../src/ai/gateway/gateway';
import type { SideEffect } from '../../../src/ai/agents/customer-calling/types';
import type { PhoneLookupDeps } from '../../../src/ai/voice-turn/phone-lookup-surface';

const TENANT = 'tenant-1476-phone';
const CALL_SID = 'CA-1476';
const CALLER_ID = '+15125550100';

const BOOKING = JSON.stringify({
  intentType: 'create_appointment',
  confidence: 0.92,
  extractedEntities: {
    jobReference: 'furnace not heating',
    dateTimeDescription: 'Tuesday at 2pm',
  },
});

/**
 * Classifier replies with `classifier`; the confirm_intent skill answers
 * "yes" only to the scripted "Yes, go ahead." turn — a question is not a yes, which is exactly why
 * it used to become a correction.
 */
function phoneGateway(classifiers: string[], opts: { hugeUsageFrom?: number } = {}): LLMGateway {
  let classifyCalls = 0;
  let calls = 0;
  return {
    complete: vi.fn(async (req: LLMRequest) => {
      const isConfirm =
        (req.metadata as { skill?: string } | undefined)?.skill === 'confirm_intent';
      const saidYes = JSON.stringify(req.messages ?? '').includes('Yes, go ahead');
      return {
        content: isConfirm
          ? JSON.stringify({ answer: saidYes ? 'yes' : 'no', reasoning: 'scripted' })
          : classifiers[Math.min(classifyCalls++, classifiers.length - 1)],
        model: 'mock',
        provider: 'mock',
        tokenUsage:
          opts.hugeUsageFrom !== undefined && ++calls >= opts.hugeUsageFrom
            ? { input: 1_000_000, output: 1_000_000, total: 2_000_000 }
            : { input: 1, output: 1, total: 2 },
        latencyMs: 1,
      };
    }),
  } as unknown as LLMGateway;
}

const stores: VoiceSessionStore[] = [];
afterEach(() => {
  for (const s of stores.splice(0)) s.dispose();
});

async function makeCall(opts: {
  ownerSession: boolean;
  classifier?: string;
  /** What the classifier makes of the confirm-step question (turn 2). */
  questionClassifier?: string;
  lookups?: PhoneLookupDeps;
  actorUserId?: string;
  /** From this gateway call on, every call reports usage past every session cap. */
  hugeUsageFrom?: number;
}) {
  const store = new VoiceSessionStore({ startInterval: false });
  stores.push(store);
  const proposalRepo = new InMemoryProposalRepository();
  const customerRepo = new InMemoryCustomerRepository();
  const customer = await createCustomer(
    {
      tenantId: TENANT,
      firstName: 'Dana',
      lastName: 'Reyes',
      primaryPhone: '+14805550199',
      createdBy: 'test',
    },
    customerRepo,
  );
  const session = store.create(TENANT, 'telephony', {
    callSid: CALL_SID,
    ...(opts.ownerSession ? { ownerSession: true } : {}),
  });
  session.machine.dispatch({
    type: 'incoming_call',
    callSid: CALL_SID,
    from: CALLER_ID,
    to: '+15125550999',
    tenantId: TENANT,
  });
  session.machine.dispatch({ type: 'greeted_ok' });
  session.machine.dispatch({ type: 'caller_known', customerId: customer.id });
  session.customerId = customer.id;
  session.callerPhone = CALLER_ID;
  if (opts.actorUserId) session.actorUserId = opts.actorUserId;
  const processor = createVoiceTurnProcessor({
    store,
    gateway: phoneGateway(
      [opts.classifier ?? BOOKING, ...(opts.questionClassifier ? [opts.questionClassifier] : [])],
      { hugeUsageFrom: opts.hugeUsageFrom },
    ),
    ...(opts.lookups ? { lookups: opts.lookups } : {}),
    businessName: 'Acme Plumbing',
    systemActorId: 'test-actor',
    auditRepo: new InMemoryAuditRepository(),
    proposalRepo,
    customerRepo,
  });
  const turn = (speechResult: string) =>
    processor.speechTurn({ session, speechResult, callSid: CALL_SID, tenantId: TENANT });
  return { session, proposalRepo, turn };
}

function spoken(sideEffects: SideEffect[]): string {
  return sideEffects
    .filter((fx) => fx.type === 'tts_play')
    .map((fx) => String(fx.payload.text))
    .join(' ');
}

describe('#1476 — phone: a question during the confirm step', () => {
  it('S1 caller: the callback-number question reads back their caller-ID masked — never the record — and keeps the booking', async () => {
    const { session, proposalRepo, turn } = await makeCall({ ownerSession: false });
    await turn('Can someone come out Tuesday at 2pm? My furnace is not heating.');
    expect(session.machine.currentState).toBe('intent_confirm');

    const answer = spoken(await turn('Can you confirm the number you have for me to call back?'));
    expect(session.machine.currentState).toBe('intent_confirm');
    expect(answer).toMatch(/ending in 0100/);
    expect(answer).not.toMatch(/0199/);
    expect(answer).not.toMatch(/let me try again/i);
    expect(answer).toMatch(/Is that right\?/);
    expect(await proposalRepo.findByTenant(TENANT)).toHaveLength(0);

    await turn('Yes, go ahead.');
    expect(await proposalRepo.findByTenant(TENANT)).toHaveLength(1);
  });

  it('owner line: the callback-number question reads back the customer number on file', async () => {
    const { session, turn } = await makeCall({ ownerSession: true });
    await turn('Can someone come out Tuesday at 2pm? My furnace is not heating.');
    expect(session.machine.currentState).toBe('intent_confirm');

    const answer = spoken(await turn('What number do you have to call them back?'));
    expect(session.machine.currentState).toBe('intent_confirm');
    expect(answer).toMatch(/480-555-0199/);
    expect(answer).toMatch(/Is that right\?/);
  });

  it('S1 caller: a number they gave on this call is read back to them', async () => {
    const { session, turn } = await makeCall({
      ownerSession: false,
      classifier: JSON.stringify({
        intentType: 'create_appointment',
        confidence: 0.92,
        extractedEntities: {
          jobReference: 'furnace not heating',
          dateTimeDescription: 'Tuesday at 2pm',
          phone: '480-555-0123',
        },
      }),
    });
    await turn('Furnace is out — Tuesday at 2pm works, call me at 480-555-0123.');
    expect(session.machine.currentState).toBe('intent_confirm');

    const answer = spoken(await turn('Can you confirm the number you have for me to call back?'));
    expect(session.machine.currentState).toBe('intent_confirm');
    expect(answer).toMatch(/480-555-0123/);
    expect(answer).not.toMatch(/0199/);
  });

  it('"what time was that again?" is answered from the pending booking, which is kept', async () => {
    const { session, proposalRepo, turn } = await makeCall({ ownerSession: false });
    await turn('Can someone come out Tuesday at 2pm? My furnace is not heating.');

    const answer = spoken(await turn('What time was that again?'));
    expect(session.machine.currentState).toBe('intent_confirm');
    expect(answer).toMatch(/Tuesday at 2pm/);
    expect(answer).toMatch(/Is that right\?/);

    await turn('Yes, go ahead.');
    expect(await proposalRepo.findByTenant(TENANT)).toHaveLength(1);
  });

  const MATERIALS_QUESTION = JSON.stringify({
    intentType: 'lookup_materials',
    confidence: 0.93,
    extractedEntities: {},
  });
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
  const PENDING_ELBOWS = [
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
  ];

  it('any other question is answered through the existing lookup path, then the readback is re-asked', async () => {
    const listPending = vi.fn(async () => PENDING_ELBOWS);
    const { session, proposalRepo, turn } = await makeCall({
      ownerSession: true,
      actorUserId: 'user-tech-1476',
      questionClassifier: MATERIALS_QUESTION,
      lookups: materialsLookups(listPending),
    });
    await turn('Can someone come out Tuesday at 2pm? My furnace is not heating.');

    const answer = spoken(await turn('What materials do I need for that?'));
    expect(session.machine.currentState).toBe('intent_confirm');
    expect(answer).toContain('copper elbows');
    expect(answer).toMatch(/Is that right\?/);
    expect(await proposalRepo.findByTenant(TENANT)).toHaveLength(0);
  });

  it('S1 caller: the lookup path keeps its S1 rules — a non-public lookup is refused, no data read', async () => {
    const listPending = vi.fn(async () => PENDING_ELBOWS);
    const { session, turn } = await makeCall({
      ownerSession: false,
      questionClassifier: MATERIALS_QUESTION,
      lookups: materialsLookups(listPending),
    });
    await turn('Can someone come out Tuesday at 2pm? My furnace is not heating.');

    const answer = spoken(await turn('What materials do you need for that?'));
    expect(session.machine.currentState).toBe('intent_confirm');
    expect(listPending).not.toHaveBeenCalled();
    expect(answer).not.toContain('copper elbows');
    expect(answer).toMatch(/Is that right\?/);
  });

  it('a lookup classify that crosses the session cost cap ends the call instead of answering', async () => {
    const listPending = vi.fn(async () => PENDING_ELBOWS);
    const { session, turn } = await makeCall({
      ownerSession: true,
      actorUserId: 'user-tech-1476',
      questionClassifier: MATERIALS_QUESTION,
      lookups: materialsLookups(listPending),
      hugeUsageFrom: 2,
    });
    await turn('Can someone come out Tuesday at 2pm? My furnace is not heating.');

    const answer = spoken(await turn('What materials do I need for that?'));
    expect(session.machine.currentState).not.toBe('intent_confirm');
    expect(answer).not.toContain('copper elbows');
  });
});
