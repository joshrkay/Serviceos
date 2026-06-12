/**
 * RV-225 — end-to-end voice edit over the Twilio Gather path.
 *
 * Owner calls in (RV-070 stamps ownerSession from caller-ID), says
 * "change the Henderson estimate to 200 dollars" → the classifier returns
 * `edit_proposal`, the shared edit interpreter produces the delta, the
 * EXISTING editProposal path applies it, and the agent reads back the
 * EDITED values. The proposal stays pending — an edit never approves.
 * A non-owner caller whose transcript classifies as edit_proposal is
 * hard-gated: nothing changes and the FSM reprompts normally.
 *
 * RV-226 — the same call can then approve: the readback speaks the
 * EDITED amount and the approved payload equals the edited payload.
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
import { InMemoryProposalSmsEventRepository } from '../../src/proposals/sms/sms-event';
import { PROPOSAL_SMS_EDIT_TASK_TYPE } from '../../src/proposals/edit-interpreter';
import type { SettingsRepository } from '../../src/settings/settings';

const TENANT = 't-voice-edit';
const OWNER_PHONE = '+15125550100';
const CUSTOMER_PHONE = '+15125559999';
const CUSTOMER_UUID = 'b3b8a9a2-7c1d-4e8f-9a1b-2c3d4e5f6a7b';

function stubSettingsRepo(): SettingsRepository {
  return {
    findByTenant: async () => ({
      ownerPhone: OWNER_PHONE,
      escalationSettings: {},
    }),
  } as unknown as SettingsRepository;
}

const EDIT_CLASSIFICATION = JSON.stringify({
  intentType: 'edit_proposal',
  confidence: 0.93,
  reasoning: 'owner asked to change the Henderson estimate',
  extractedEntities: {
    proposalReference: 'the Henderson estimate',
    editInstruction: 'change the total to 200 dollars',
  },
});

const APPROVE_CLASSIFICATION = JSON.stringify({
  intentType: 'approve_proposal',
  confidence: 0.95,
  extractedEntities: { proposalReference: 'the Henderson estimate' },
});

/**
 * Task-type-dispatched gateway: classify_intent responses are positional,
 * the shared edit interpreter (taskType proposal_sms_edit) gets `delta`.
 */
function makeGateway(classifications: string[], delta: string): LLMGateway {
  let classifyCall = 0;
  return {
    complete: vi.fn(async (req: { taskType?: string }) => {
      const content =
        req.taskType === PROPOSAL_SMS_EDIT_TASK_TYPE
          ? delta
          : classifications[Math.min(classifyCall++, classifications.length - 1)];
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

/** Contract-valid draft_estimate — editProposal Zod-validates the merge. */
async function seedPending(repo: InMemoryProposalRepository): Promise<Proposal> {
  const proposal = createProposal({
    tenantId: TENANT,
    proposalType: 'draft_estimate',
    payload: {
      customerId: CUSTOMER_UUID,
      customerName: 'Henderson Family LLC',
      lineItems: [{ description: 'Water heater replacement', quantity: 1, unitPrice: 45000 }],
      totalCents: 45000,
    },
    summary: 'Estimate for Henderson — water heater replacement',
    createdBy: 'voice',
  });
  await repo.create(proposal);
  await repo.updateStatus(TENANT, proposal.id, 'ready_for_review');
  return (await repo.findById(TENANT, proposal.id))!;
}

function makeHarness(gateway: LLMGateway) {
  const store = new VoiceSessionStore({ startInterval: false });
  const proposalRepo = new InMemoryProposalRepository();
  const auditRepo = new InMemoryAuditRepository();
  const smsEventRepo = new InMemoryProposalSmsEventRepository();
  const adapter = new TwilioGatherAdapter({
    store,
    gateway,
    businessName: 'Acme Plumbing',
    publicBaseUrl: 'https://example.com',
    proposalRepo,
    auditRepo,
    smsEventRepo,
    settingsRepo: stubSettingsRepo(),
  });
  return { adapter, store, proposalRepo, auditRepo, smsEventRepo };
}

async function startCall(
  h: ReturnType<typeof makeHarness>,
  from: string,
  callSid: string,
): Promise<string> {
  await h.adapter.handleInbound({ callSid, from, to: '+15125550000', tenantId: TENANT });
  const session = h.store.findByCallSid(callSid)!;
  session.machine.dispatch({ type: 'caller_known', customerId: 'cust-1' });
  return session.id;
}

describe('RV-225 — owner edit over Gather (end to end)', () => {
  it('applies the interpreted delta and reads back the EDITED values; proposal stays pending', async () => {
    const gateway = makeGateway([EDIT_CLASSIFICATION], JSON.stringify({ totalCents: 20000 }));
    const h = makeHarness(gateway);
    const proposal = await seedPending(h.proposalRepo);
    const sessionId = await startCall(h, OWNER_PHONE, 'CA-edit-1');

    const twiml = await h.adapter.handleGather({
      sessionId,
      callSid: 'CA-edit-1',
      speechResult: 'change the Henderson estimate to 200 dollars',
      confidence: 0.9,
      tenantId: TENANT,
    });

    // Readback speaks the EDITED amount, never the stale one.
    expect(twiml).toContain('$200.00');
    expect(twiml).not.toContain('$450.00');
    expect(twiml).toContain('<Gather'); // call continues

    // Applied through editProposal; STAYS pending (no auto-approve).
    const stored = await h.proposalRepo.findById(TENANT, proposal.id);
    expect(stored?.payload.totalCents).toBe(20000);
    expect(stored?.status).toBe('ready_for_review');

    // Audit trail: existing proposal.edited + the voice event.
    const events = h.auditRepo.getAll();
    expect(events.some((e) => e.eventType === 'proposal.edited')).toBe(true);
    expect(events.some((e) => e.eventType === 'proposal.voice_edited')).toBe(true);

    // Applied → the pending-edit block is clear (edit_request followed by
    // reapproval_rendered in the shared event store).
    expect(await h.smsEventRepo.hasUnappliedEditRequest(TENANT, proposal.id)).toBe(false);
  });

  it('RV-226 — edit then approve in the same call: confirm readback + executed payload are the EDITED values', async () => {
    const gateway = makeGateway(
      [EDIT_CLASSIFICATION, APPROVE_CLASSIFICATION],
      JSON.stringify({ totalCents: 20000 }),
    );
    const h = makeHarness(gateway);
    const proposal = await seedPending(h.proposalRepo);
    const sessionId = await startCall(h, OWNER_PHONE, 'CA-edit-2');
    const turn = (speechResult: string) =>
      h.adapter.handleGather({
        sessionId,
        callSid: 'CA-edit-2',
        speechResult,
        confidence: 0.9,
        tenantId: TENANT,
      });

    expect(await turn('change the Henderson estimate to 200 dollars')).toContain('$200.00');

    // Approve: the readback MUST speak the edited amount…
    const readback = await turn('approve the Henderson estimate');
    expect(readback).toContain('$200.00');
    expect(readback).not.toContain('$450.00');

    // …and the explicit yes executes against the EDITED payload.
    const confirmed = await turn('yes');
    expect(confirmed).toContain('Approved');
    const stored = await h.proposalRepo.findById(TENANT, proposal.id);
    expect(stored?.status).toBe('approved');
    expect(stored?.payload.totalCents).toBe(20000);
  });

  it('RV-226 — an UNAPPLIED voice edit blocks a voice approve later in the call', async () => {
    // Interpreter returns {} → no delta → the request is recorded, not applied.
    const gateway = makeGateway([EDIT_CLASSIFICATION, APPROVE_CLASSIFICATION], '{}');
    const h = makeHarness(gateway);
    const proposal = await seedPending(h.proposalRepo);
    const sessionId = await startCall(h, OWNER_PHONE, 'CA-edit-3');
    const turn = (speechResult: string) =>
      h.adapter.handleGather({
        sessionId,
        callSid: 'CA-edit-3',
        speechResult,
        confidence: 0.9,
        tenantId: TENANT,
      });

    const recorded = await turn('change the Henderson estimate to 200 dollars');
    expect(recorded.toLowerCase()).toContain('review queue');
    expect(await h.smsEventRepo.hasUnappliedEditRequest(TENANT, proposal.id)).toBe(true);

    // Approval over the SAME voice channel is blocked until the edit is applied.
    const blocked = await turn('approve the Henderson estimate');
    expect(blocked.toLowerCase()).toContain('your note is attached');
    const stored = await h.proposalRepo.findById(TENANT, proposal.id);
    expect(stored?.status).toBe('ready_for_review');
    expect(stored?.payload.totalCents).toBe(45000);
  });

  it('NON-owner caller classified as edit_proposal is hard-gated — nothing changes', async () => {
    const gateway = makeGateway([EDIT_CLASSIFICATION], JSON.stringify({ totalCents: 20000 }));
    const h = makeHarness(gateway);
    const proposal = await seedPending(h.proposalRepo);
    const sessionId = await startCall(h, CUSTOMER_PHONE, 'CA-cust-edit');

    const twiml = await h.adapter.handleGather({
      sessionId,
      callSid: 'CA-cust-edit',
      speechResult: 'change the Henderson estimate to 200 dollars',
      confidence: 0.9,
      tenantId: TENANT,
    });

    expect(twiml).not.toContain('$200.00');
    const stored = await h.proposalRepo.findById(TENANT, proposal.id);
    expect(stored?.payload.totalCents).toBe(45000);
    expect(stored?.status).toBe('ready_for_review');
    const denied = h.auditRepo
      .getAll()
      .find((e) => e.eventType === 'agent.calling.voice_edit_denied');
    expect(denied).toBeDefined();
    expect(denied!.metadata).toMatchObject({ reason: 'not_owner_session' });
  });
});
