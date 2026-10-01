/**
 * #1331 — characterization pinned for the Layer 2 owner-line persona (owner
 * decision 2026-10-01): on the OWNER line a money write (apply credit) is
 * read back, drafted on the owner's yes, and lands as a pending proposal —
 * never approved or executed in-call, and never behind a PIN prompt (the
 * voice PIN gates owner APPROVAL of money movement, not drafting). The Layer 2
 * harness therefore needs no seeded PIN for the drafting scripts.
 *
 * Harness copied from #1476 item 3 — the phone turn engine (createVoiceTurnProcessor().speechTurn,
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


describe('#1331 — owner line: money write is read back, drafted on yes, left pending', () => {
  it('apply_credit: readback → yes → one pending apply_credit proposal, no PIN prompt', async () => {
    const c = await makeCall({
      ownerSession: true,
      actorUserId: 'vq-owner:tenant-1476-phone',
      classifier: JSON.stringify({
        intentType: 'apply_credit',
        confidence: 0.95,
        extractedEntities: { amountCents: 5000, customerName: 'Dana Reyes' },
      }),
    });

    const readback = spoken(await c.turn("Give Dana Reyes a fifty dollar credit."));
    // #1539 — names the customer. (`amountCents` is not a classifier entity key —
    // the dictionary's money field is `amount` — so no amount reaches the readback.)
    expect(readback).toBe("Just to confirm — you'd like to apply a credit for Dana Reyes. Is that right?");
    expect(await c.proposalRepo.findByTenant(TENANT)).toEqual([]);

    const reply = spoken(await c.turn('Yes, go ahead.'));
    const proposals = await c.proposalRepo.findByTenant(TENANT);
    expect(proposals.map((p) => p.proposalType)).toEqual(['apply_credit']);
    expect(proposals[0]!.status).not.toBe('approved');
    expect(proposals[0]!.status).not.toBe('executed');
    expect(reply.toLowerCase()).not.toContain('pin');
  });

  it('a draft still missing details tells the OWNER it is on their card — not "someone from our team will follow up with you"', async () => {
    // Run 36895893912: apply-credit / record-refund / change-order /
    // service-agreement were drafted with an unfilled gate on the owner line,
    // and the owner heard the S1 caller line promising a team follow-up — the
    // owner IS the team. (#1497's operator posture, for an incomplete card.)
    const c = await makeCall({
      ownerSession: true,
      actorUserId: 'vq-owner:tenant-1476-phone',
      classifier: JSON.stringify({
        intentType: 'apply_credit',
        confidence: 0.95,
        extractedEntities: { amount: 5000, customerName: 'Dana Reyes' },
      }),
    });
    await c.turn('Give Dana Reyes a fifty dollar credit.');
    const reply = spoken(await c.turn('Yes, go ahead.'));

    const [proposal] = await c.proposalRepo.findByTenant(TENANT);
    expect(proposal!.sourceContext?.missingFields).toEqual(['invoiceId']);
    expect(reply).toBe(
      "I've drafted that, but it still needs a few details before it can be approved — open the card to fill them in. Is there anything else I can help you with?",
    );
  });

  it('an S1 caller with the same incomplete request still hears the honest team follow-up line', async () => {
    const c = await makeCall({
      ownerSession: false,
      classifier: JSON.stringify({
        intentType: 'create_appointment',
        confidence: 0.95,
        extractedEntities: { jobReference: 'furnace not heating' },
      }),
    });
    await c.turn('I need someone to look at my furnace.');
    const reply = spoken(await c.turn('Yes, go ahead.'));
    expect(reply).not.toContain('open the card');
  });
});
