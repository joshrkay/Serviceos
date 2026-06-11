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

  it('a non-affirmative second turn keeps the proposal pending', async () => {
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
    const twiml = await h.adapter.handleGather({
      sessionId,
      callSid: 'CA-appr-2',
      speechResult: 'hmm actually what does my Thursday look like',
      confidence: 0.9,
      tenantId: TENANT,
    });

    expect(twiml.toLowerCase()).toContain('later');
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
