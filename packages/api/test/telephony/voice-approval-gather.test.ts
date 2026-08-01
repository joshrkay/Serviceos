/**
 * RV-071 — end-to-end voice approval over the Twilio Gather path.
 *
 * Owner calls in (RV-070 stamps ownerSession from caller-ID), says
 * "approve the Henderson estimate" → the agent reads back the proposal
 * FROM ITS PAYLOAD and asks for an explicit yes; the NEXT turn's "yes"
 * approves through approveProposal with channel 'voice'. A non-owner
 * caller whose transcript classifies as approve_proposal is hard-gated:
 * nothing is approved and the FSM repompts normally.
 */
import { describe, it, expect, vi } from 'vitest';
import { TwilioGatherAdapter } from '../../src/telephony/twilio-adapter';
import { VoiceSessionStore } from '../../src/ai/agents/customer-calling/voice-session-store';
import type { LLMGateway, LLMResponse } from '../../src/ai/gateway/gateway';
import {
  createProposal,
  InMemoryProposalRepository,
  type Proposal,
} from '../../src/proposals/proposal';
import { InMemoryAuditRepository } from '../../src/audit/audit';
import type { SettingsRepository } from '../../src/settings/settings';

const TENANT = 't-approval';
const OWNER_PHONE = '+15125550100';
const CUSTOMER_PHONE = '+15125559999';

function stubSettingsRepo(challenge?: string): SettingsRepository {
  return {
    findByTenant: async () => ({
      ownerPhone: OWNER_PHONE,
      escalationSettings: challenge ? { voice_approval_challenge: challenge } : {},
    }),
  } as unknown as SettingsRepository;
}

function gatewayReturning(responses: string[]): LLMGateway {
  let i = 0;
  return {
    complete: vi.fn(async () => {
      const content = responses[Math.min(i++, responses.length - 1)];
      return {
        content,
        model: 'mock',
        provider: 'mock',
        tokenUsage: { input: 5, output: 5, total: 10 },
        latencyMs: 1,
      } satisfies LLMResponse;
    }),
  } as unknown as LLMGateway;
}

const APPROVE_CLASSIFICATION = JSON.stringify({
  intentType: 'approve_proposal',
  confidence: 0.95,
  reasoning: 'caller asked to approve the Henderson estimate',
  extractedEntities: { proposalReference: 'the Henderson estimate' },
});

async function seedPending(repo: InMemoryProposalRepository): Promise<Proposal> {
  const proposal = createProposal({
    tenantId: TENANT,
    proposalType: 'draft_estimate',
    payload: {
      customerName: 'Henderson Family LLC',
      lineItems: [{ description: 'Water heater', total: 45000 }],
      totalCents: 45000,
    },
    summary: 'Estimate for Henderson — water heater replacement',
    createdBy: 'voice',
  });
  await repo.create(proposal);
  await repo.updateStatus(TENANT, proposal.id, 'ready_for_review');
  return (await repo.findById(TENANT, proposal.id))!;
}

function makeHarness(opts: { gateway: LLMGateway; challenge?: string }) {
  const store = new VoiceSessionStore({ startInterval: false });
  const proposalRepo = new InMemoryProposalRepository();
  const auditRepo = new InMemoryAuditRepository();
  const sent: { to: string; body: string }[] = [];
  const adapter = new TwilioGatherAdapter({
    store,
    gateway: opts.gateway,
    businessName: 'Acme Plumbing',
    publicBaseUrl: 'https://example.com',
    proposalRepo,
    auditRepo,
    settingsRepo: stubSettingsRepo(opts.challenge),
    voiceApprovalOneTap: {
      sendSms: async (to, body) => {
        sent.push({ to, body });
      },
      secret: 'test-secret',
      buildApproveUrl: (token) => `https://x.test/approve?token=${token}`,
      resolveOwnerPhone: async () => OWNER_PHONE,
    },
  });
  return { adapter, store, proposalRepo, auditRepo, sent };
}

async function startCall(
  h: ReturnType<typeof makeHarness>,
  from: string,
  callSid: string,
): Promise<string> {
  await h.adapter.handleInbound({ callSid, from, to: '+15125550000', tenantId: TENANT });
  const session = h.store.findByCallSid(callSid)!;
  // Without a DB pool the caller lands in ask_caller; emulate the
  // identified-caller transition so handleGather classifies (same pattern
  // as the existing twilio-adapter tests).
  session.machine.dispatch({ type: 'caller_known', customerId: 'cust-1' });
  return session.id;
}

describe('RV-071 — owner approval over Gather (end to end)', () => {
  it('readback turn then explicit yes approves with channel voice', async () => {
    const gateway = gatewayReturning([APPROVE_CLASSIFICATION]);
    const h = makeHarness({ gateway });
    const proposal = await seedPending(h.proposalRepo);
    const sessionId = await startCall(h, OWNER_PHONE, 'CA-appr-1');

    // Turn 1 — the readback comes from the PAYLOAD and nothing mutates.
    const twiml1 = await h.adapter.handleGather({
      sessionId,
      callSid: 'CA-appr-1',
      speechResult: 'approve the Henderson estimate',
      confidence: 0.9,
      tenantId: TENANT,
    });
    expect(twiml1).toContain('Henderson Family LLC');
    expect(twiml1).toContain('$450.00');
    expect(twiml1).toContain('<Gather'); // the call continues
    expect((await h.proposalRepo.findById(TENANT, proposal.id))?.status).toBe(
      'ready_for_review',
    );
    const session = h.store.get(sessionId)!;
    expect(session.pendingVoiceApproval).toMatchObject({ action: 'approve', stage: 'confirm' });

    // Turn 2 — the explicit affirmative executes the approval.
    const twiml2 = await h.adapter.handleGather({
      sessionId,
      callSid: 'CA-appr-1',
      speechResult: 'yes',
      confidence: 0.9,
      tenantId: TENANT,
    });
    expect(twiml2).toContain('Approved');
    const stored = await h.proposalRepo.findById(TENANT, proposal.id);
    expect(stored?.status).toBe('approved');
    const approvedEvent = h.auditRepo
      .getAll()
      .find((e) => e.eventType === 'proposal.approved' && e.entityId === proposal.id);
    expect(approvedEvent!.metadata).toMatchObject({ channel: 'voice' });
    expect(session.pendingVoiceApproval).toBeUndefined();
  });

  it('a non-strict second turn triggers re-ask; second non-strict clears dialogue', async () => {
    const gateway = gatewayReturning([APPROVE_CLASSIFICATION]);
    const h = makeHarness({ gateway });
    const proposal = await seedPending(h.proposalRepo);
    const sessionId = await startCall(h, OWNER_PHONE, 'CA-appr-2');

    await h.adapter.handleGather({
      sessionId,
      callSid: 'CA-appr-2',
      speechResult: 'approve the Henderson estimate',
      confidence: 0.9,
      tenantId: TENANT,
    });
    // First non-strict → re-ask
    const twiml1 = await h.adapter.handleGather({
      sessionId,
      callSid: 'CA-appr-2',
      speechResult: 'hmm actually what does my Thursday look like',
      confidence: 0.9,
      tenantId: TENANT,
    });
    expect(twiml1.toLowerCase()).toContain('just to be safe');
    // Dialogue still active
    expect(h.store.get(sessionId)!.pendingVoiceApproval).toBeDefined();

    // Second non-strict → kept_for_later, dialogue cleared
    const twiml2 = await h.adapter.handleGather({
      sessionId,
      callSid: 'CA-appr-2',
      speechResult: 'hmm actually what does my Thursday look like',
      confidence: 0.9,
      tenantId: TENANT,
    });
    expect(twiml2.toLowerCase()).toContain('later');
    expect((await h.proposalRepo.findById(TENANT, proposal.id))?.status).toBe(
      'ready_for_review',
    );
    expect(h.store.get(sessionId)!.pendingVoiceApproval).toBeUndefined();
  });

  it('NON-owner caller classified as approve_proposal is hard-gated — no approval flow starts', async () => {
    // The classifier prompt never offers the intent to non-owners, but a
    // model misfire / prompt injection could still return it — the
    // routing gate (not the prompt) is what protects the proposal.
    const gateway = gatewayReturning([APPROVE_CLASSIFICATION]);
    const h = makeHarness({ gateway });
    const proposal = await seedPending(h.proposalRepo);
    const sessionId = await startCall(h, CUSTOMER_PHONE, 'CA-cust-1');

    const twiml = await h.adapter.handleGather({
      sessionId,
      callSid: 'CA-cust-1',
      speechResult: 'approve the Henderson estimate',
      confidence: 0.9,
      tenantId: TENANT,
    });

    // No readback, no dialogue, no mutation — the FSM reprompts.
    expect(twiml).not.toContain('Henderson Family LLC');
    expect(h.store.get(sessionId)!.pendingVoiceApproval).toBeUndefined();
    expect((await h.proposalRepo.findById(TENANT, proposal.id))?.status).toBe(
      'ready_for_review',
    );
    const denied = h.auditRepo
      .getAll()
      .find((e) => e.eventType === 'agent.calling.voice_approval_denied');
    expect(denied).toBeDefined();
    expect(denied!.metadata).toMatchObject({ reason: 'not_owner_session' });
  });

  it('3 wrong codes across RESTARTED dialogues → session lockout; capture-class still approvable (C1/I1/I2)', async () => {
    const approvePayment = (reference: string) =>
      JSON.stringify({
        intentType: 'approve_proposal',
        confidence: 0.95,
        extractedEntities: { proposalReference: reference },
      });
    // One classifier response per turn that reaches classifyIntent —
    // in-flight approval dialogues consume turns WITHOUT the classifier.
    const gateway = gatewayReturning([
      approvePayment('the Acme payment'), // turn 1 — start dialogue 1
      approvePayment('the Acme payment'), // restart after cancel — dialogue 2
      approvePayment('the payment'), // fresh approve in locked session
      APPROVE_CLASSIFICATION, // capture-class Henderson estimate
    ]);
    const h = makeHarness({ gateway, challenge: '4271' });
    const estimate = await seedPending(h.proposalRepo); // capture-class
    const payment = createProposal({
      tenantId: TENANT,
      proposalType: 'record_payment',
      payload: { customerName: 'Acme Corp', amountCents: 20000 },
      summary: 'Record $200 payment from Acme',
      createdBy: 'voice',
    });
    await h.proposalRepo.create(payment);
    await h.proposalRepo.updateStatus(TENANT, payment.id, 'ready_for_review');
    const sessionId = await startCall(h, OWNER_PHONE, 'CA-lock-1');
    const turn = (speechResult: string) =>
      h.adapter.handleGather({
        sessionId,
        callSid: 'CA-lock-1',
        speechResult,
        confidence: 0.9,
        tenantId: TENANT,
      });

    // Dialogue 1: readback → yes → challenge → two wrong codes.
    expect(await turn('approve the Acme payment')).toContain('Acme Corp');
    expect(await turn('yes')).toContain('approval code');
    expect(await turn('0 0 0 0')).toContain('didn’t match');
    expect(await turn('1 1 1 1')).toContain('didn’t match');
    const session = h.store.get(sessionId)!;
    expect(session.voiceApprovalState).toMatchObject({ challengeFailCount: 2 });

    // Cancel — exits the dialogue without burning an attempt…
    expect((await turn('cancel')).toLowerCase()).toContain('later');
    expect(session.pendingVoiceApproval).toBeUndefined();
    // …and the SESSION-level counter survives the cancel/restart.
    expect(session.voiceApprovalState).toMatchObject({ challengeFailCount: 2 });

    // Dialogue 2 (restarted): readback → yes → 3rd wrong code → LOCKOUT.
    expect(await turn('approve the Acme payment')).toContain('Acme Corp');
    expect(await turn('yes')).toContain('approval code');
    const lockoutTwiml = await turn('2 2 2 2');
    expect(lockoutTwiml).toContain('Too many incorrect codes');
    expect(session.voiceApprovalState).toMatchObject({
      challengeLockedOut: true,
      challengeFailCount: 3,
    });
    const lockoutEvent = h.auditRepo
      .getAll()
      .find((e) => e.eventType === 'proposal.voice_challenge_lockout');
    expect(lockoutEvent).toBeDefined();
    expect(lockoutEvent!.metadata).toMatchObject({ attemptCount: 3, oneTapSmsSent: true });
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0].to).toBe(OWNER_PHONE);
    expect((await h.proposalRepo.findById(TENANT, payment.id))?.status).toBe(
      'ready_for_review',
    );

    // A fresh money approval in the same session is refused IMMEDIATELY —
    // no readback, no new challenge prompt.
    const refusedTwiml = await turn('approve the payment');
    expect(refusedTwiml.toLowerCase()).toContain('security');
    expect(refusedTwiml).not.toContain('approval code');
    expect(session.pendingVoiceApproval).toBeUndefined();
    const refusedEvent = h.auditRepo
      .getAll()
      .find((e) => e.eventType === 'proposal.voice_approve_refused_challenge_lockout');
    expect(refusedEvent).toBeDefined();
    expect((await h.proposalRepo.findById(TENANT, payment.id))?.status).toBe(
      'ready_for_review',
    );

    // Capture-class approval in the SAME locked session still works.
    expect(await turn('approve the Henderson estimate')).toContain('Henderson Family LLC');
    expect(await turn('yes')).toContain('Approved');
    expect((await h.proposalRepo.findById(TENANT, estimate.id))?.status).toBe('approved');
  });

  it('WS19 — "what\'s waiting" walks the whole queue over Gather (batch)', async () => {
    // "what's waiting" classifies as approve_proposal on an owner line; the
    // deterministic batch trigger (reference/utterance) starts a batch walk.
    // Only turn 1 classifies — the yes turns are consumed by the in-flight
    // batch dialogue before the classifier, so one gateway response suffices.
    const gateway = gatewayReturning([
      JSON.stringify({
        intentType: 'approve_proposal',
        confidence: 0.95,
        extractedEntities: { proposalReference: "what's waiting" },
      }),
    ]);
    const h = makeHarness({ gateway });
    const first = await seedPending(h.proposalRepo);
    const second = createProposal({
      tenantId: TENANT,
      proposalType: 'draft_estimate',
      payload: {
        customerName: 'Ramirez Roofing',
        lineItems: [{ description: 'Roof patch', total: 30000 }],
        totalCents: 30000,
      },
      summary: 'Estimate for Ramirez — roof patch',
      createdBy: 'voice',
    });
    await h.proposalRepo.create(second);
    await h.proposalRepo.updateStatus(TENANT, second.id, 'ready_for_review');
    const sessionId = await startCall(h, OWNER_PHONE, 'CA-batch-1');

    // Turn 1 — the opener announces the queue size and reads the first item.
    const twiml1 = await h.adapter.handleGather({
      sessionId,
      callSid: 'CA-batch-1',
      speechResult: "what's waiting",
      confidence: 0.9,
      tenantId: TENANT,
    });
    expect(twiml1).toContain('You have 2 waiting.');
    expect(twiml1).toContain('First:');
    expect(twiml1).toContain('<Gather'); // the call continues
    const session = h.store.get(sessionId)!;
    expect(session.voiceApprovalState?.batchQueue).toHaveLength(2);

    // Turn 2 — approve the first item; the agent advances to the next.
    const twiml2 = await h.adapter.handleGather({
      sessionId,
      callSid: 'CA-batch-1',
      speechResult: 'yes',
      confidence: 0.9,
      tenantId: TENANT,
    });
    expect(twiml2).toContain('Approved');
    expect(twiml2).toContain('Next:');

    // Turn 3 — approve the last item; the batch summarizes and closes.
    const twiml3 = await h.adapter.handleGather({
      sessionId,
      callSid: 'CA-batch-1',
      speechResult: 'yes',
      confidence: 0.9,
      tenantId: TENANT,
    });
    // (TwiML XML-escapes the apostrophe → assert the apostrophe-free portion.)
    expect(twiml3).toContain('all of them — 2 approved, 0 skipped.');

    expect((await h.proposalRepo.findById(TENANT, first.id))?.status).toBe('approved');
    expect((await h.proposalRepo.findById(TENANT, second.id))?.status).toBe('approved');
    expect(session.voiceApprovalState?.batchQueue).toBeUndefined();
    expect(session.pendingVoiceApproval).toBeUndefined();
    // The classifier ran exactly once — the yes turns bypassed it.
    expect((gateway.complete as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(1);
  });

  it('money-class with no challenge configured → refusal + one-tap SMS, never an approval', async () => {
    const gateway = gatewayReturning([
      JSON.stringify({
        intentType: 'approve_proposal',
        confidence: 0.95,
        extractedEntities: { proposalReference: 'the Acme payment' },
      }),
    ]);
    const h = makeHarness({ gateway }); // no challenge configured
    const payment = createProposal({
      tenantId: TENANT,
      proposalType: 'record_payment',
      payload: { customerName: 'Acme Corp', amountCents: 20000 },
      summary: 'Record $200 payment from Acme',
      createdBy: 'voice',
    });
    await h.proposalRepo.create(payment);
    await h.proposalRepo.updateStatus(TENANT, payment.id, 'ready_for_review');
    const sessionId = await startCall(h, OWNER_PHONE, 'CA-money-1');

    const twiml = await h.adapter.handleGather({
      sessionId,
      callSid: 'CA-money-1',
      speechResult: 'approve the Acme payment',
      confidence: 0.9,
      tenantId: TENANT,
    });

    expect(twiml).toContain('text link');
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0].to).toBe(OWNER_PHONE);
    expect((await h.proposalRepo.findById(TENANT, payment.id))?.status).toBe(
      'ready_for_review',
    );
  });
});
