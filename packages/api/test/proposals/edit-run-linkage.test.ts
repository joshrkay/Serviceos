/**
 * OBS-2 — an owner's edit that a model run interpreted re-points
 * proposals.ai_run_id to that run, on both channels that share the edit
 * interpreter (the SMS EDIT reply and the voice edit dialogue).
 *
 * Before: the interpreter returned only the payload delta and passed no run
 * metadata, so after "EDIT make it $200" the proposal's payload was the edit
 * run's output merged over the draft while ai_run_id still named the DRAFT
 * run — and the edit run itself had a random correlation_id, reachable from
 * nothing. The chat correction (routes/assistant.ts, B3) already re-points:
 * the row links the run that authored its current payload, or none — never
 * a run that did not.
 *
 * After: the interpreter keys its run (the call the edit was spoken on, else
 * the proposal) and returns its id with the delta; editProposal writes it in
 * the same conditional update as the payload; no persisted run clears the
 * link; an edit that is not applied leaves the link alone.
 */
import { describe, it, expect, vi } from 'vitest';
import type { LLMRequest, LLMResponse } from '../../src/ai/gateway/gateway';
import { createLlmEditInterpreter } from '../../src/proposals/edit-interpreter';
import {
  InMemoryProposalRepository,
  createProposal,
  type Proposal,
} from '../../src/proposals/proposal';
import {
  InMemoryProposalSmsEventRepository,
  createProposalSmsEvent,
} from '../../src/proposals/sms/sms-event';
import {
  handleProposalSmsReply,
  handleProposalSmsFallback,
  type ProposalSmsReplyDeps,
} from '../../src/proposals/sms/reply-handler';
import { startVoiceEdit, type VoiceApprovalDeps } from '../../src/ai/tasks/proposal-approval-task';
import { InMemoryAuditRepository } from '../../src/audit/audit';
import type { SettingsRepository } from '../../src/settings/settings';

const TENANT = 't-edit-run';
const OWNER_PHONE = '+15125550100';
const DRAFT_RUN = 'run-draft';
const EDIT_RUN = 'run-edit';
const CUSTOMER = 'b3b8a9a2-7c1d-4e8f-9a1b-2c3d4e5f6a7b';

function editGateway(content: string, withRunId = true) {
  const requests: LLMRequest[] = [];
  const gateway = {
    complete: vi.fn(async (req: LLMRequest): Promise<LLMResponse> => {
      requests.push(req);
      return {
        content,
        model: 'mock',
        provider: 'mock',
        tokenUsage: { input: 1, output: 1, total: 2 },
        latencyMs: 1,
        ...(withRunId ? { aiRunId: EDIT_RUN } : {}),
      };
    }),
  };
  return { gateway, requests };
}

const settingsRepo = {
  findByTenant: async () => ({ ownerPhone: OWNER_PHONE, escalationSettings: {} }),
} as unknown as SettingsRepository;

/** A contract-valid, AI-drafted estimate awaiting review, linked to its draft run. */
async function seedDrafted(repo: InMemoryProposalRepository): Promise<Proposal> {
  const proposal = createProposal({
    tenantId: TENANT,
    proposalType: 'draft_estimate',
    payload: {
      customerId: CUSTOMER,
      customerName: 'Henderson Family LLC',
      lineItems: [{ description: 'Water heater replacement', quantity: 1, unitPrice: 45000 }],
      totalCents: 45000,
    },
    summary: 'Estimate for Henderson — water heater replacement',
    createdBy: 'voice',
    aiRunId: DRAFT_RUN,
  });
  await repo.create(proposal);
  await repo.updateStatus(TENANT, proposal.id, 'ready_for_review');
  return (await repo.findById(TENANT, proposal.id))!;
}

describe('createLlmEditInterpreter — the edit run is keyed and returned', () => {
  it('keys the run to the proposal and returns its id with the delta', async () => {
    const repo = new InMemoryProposalRepository();
    const proposal = await seedDrafted(repo);
    const { gateway, requests } = editGateway('{"totalCents": 20000}');
    const edit = await createLlmEditInterpreter(gateway)({ proposal, instruction: 'make it $200' });
    expect(edit).toEqual({ delta: { totalCents: 20000 }, aiRunId: EDIT_RUN });
    expect(requests[0].metadata).toEqual({ correlationId: proposal.id });
  });

  it('keys the run to the call it was spoken on when the caller gives one', async () => {
    const repo = new InMemoryProposalRepository();
    const proposal = await seedDrafted(repo);
    const { gateway, requests } = editGateway('{"totalCents": 20000}');
    await createLlmEditInterpreter(gateway)({ proposal, instruction: 'make it $200', correlationId: 'sess-1' });
    expect(requests[0].metadata).toEqual({ correlationId: 'sess-1' });
  });

  it('no persisted run → the delta alone', async () => {
    const repo = new InMemoryProposalRepository();
    const proposal = await seedDrafted(repo);
    const { gateway } = editGateway('{"totalCents": 20000}', false);
    await expect(
      createLlmEditInterpreter(gateway)({ proposal, instruction: 'make it $200' }),
    ).resolves.toEqual({ delta: { totalCents: 20000 } });
  });
});

describe('SMS EDIT — ai_run_id follows the run that authored the payload', () => {
  async function harness(content: string, withRunId = true) {
    const proposalRepo = new InMemoryProposalRepository();
    const smsEventRepo = new InMemoryProposalSmsEventRepository();
    const { gateway, requests } = editGateway(content, withRunId);
    const deps: ProposalSmsReplyDeps = {
      proposalRepo,
      smsEventRepo,
      settingsRepo,
      auditRepo: new InMemoryAuditRepository(),
      sendSms: async () => {},
      interpretEdit: createLlmEditInterpreter(gateway),
    };
    const proposal = await seedDrafted(proposalRepo);
    await smsEventRepo.create(
      createProposalSmsEvent({
        tenantId: TENANT,
        proposalId: proposal.id,
        direction: 'outbound',
        kind: 'proposal_rendered',
        body: 'Estimate for Henderson. Reply Y to approve, N to reject, EDIT to change.',
      }),
    );
    const sms = (body: string) => ({
      tenantId: TENANT,
      fromE164: OWNER_PHONE,
      body,
      messageSid: `SM-${Math.random().toString(36).slice(2)}`,
    });
    return { deps, proposalRepo, proposal, requests, sms };
  }

  it('an applied edit re-points ai_run_id from the draft run to the edit run (inline EDIT)', async () => {
    const h = await harness('{"totalCents": 20000}');
    expect(h.proposal.aiRunId).toBe(DRAFT_RUN);

    const result = await handleProposalSmsReply(h.sms('EDIT make it $200'), h.deps);

    expect(result).toMatchObject({ handled: true, reason: 'edited' });
    const stored = await h.proposalRepo.findById(TENANT, h.proposal.id);
    expect(stored?.payload.totalCents).toBe(20000);
    expect(stored?.aiRunId).toBe(EDIT_RUN);
    // A texted edit has no call or conversation: its run is keyed to the proposal.
    expect(h.requests[0].metadata?.correlationId).toBe(h.proposal.id);
  });

  it('an applied edit re-points ai_run_id (EDIT session, then the instruction)', async () => {
    const h = await harness('{"totalCents": 20000}');
    await handleProposalSmsReply(h.sms('EDIT'), h.deps);
    const result = await handleProposalSmsFallback(h.sms('make it $200'), h.deps);
    expect(result).toMatchObject({ handled: true, reason: 'edited' });
    expect((await h.proposalRepo.findById(TENANT, h.proposal.id))?.aiRunId).toBe(EDIT_RUN);
  });

  it('an edit whose run was not persisted clears the link — never left naming the draft run', async () => {
    const h = await harness('{"totalCents": 20000}', false);
    const result = await handleProposalSmsReply(h.sms('EDIT make it $200'), h.deps);
    expect(result).toMatchObject({ handled: true, reason: 'edited' });
    const stored = await h.proposalRepo.findById(TENANT, h.proposal.id);
    expect(stored?.payload.totalCents).toBe(20000);
    expect(stored?.aiRunId).toBeUndefined();
  });

  it('an edit that is not applied (invalid merged payload) leaves the draft run linked', async () => {
    // lineItems must be an array — editProposal's contract check refuses it.
    const h = await harness('{"lineItems": "lots"}');
    const result = await handleProposalSmsReply(h.sms('EDIT make it lots'), h.deps);
    expect(result).not.toMatchObject({ reason: 'edited' });
    const stored = await h.proposalRepo.findById(TENANT, h.proposal.id);
    expect(stored?.payload.lineItems).toEqual(h.proposal.payload.lineItems);
    expect(stored?.aiRunId).toBe(DRAFT_RUN);
  });
});

describe('voice edit — ai_run_id follows the run that authored the payload', () => {
  async function harness(content: string, withRunId = true) {
    const proposalRepo = new InMemoryProposalRepository();
    const { gateway, requests } = editGateway(content, withRunId);
    const deps: VoiceApprovalDeps = {
      proposalRepo,
      auditRepo: new InMemoryAuditRepository(),
      settingsRepo,
      smsEventRepo: new InMemoryProposalSmsEventRepository(),
      editInterpreter: createLlmEditInterpreter(gateway),
    };
    const proposal = await seedDrafted(proposalRepo);
    const edit = () =>
      startVoiceEdit(deps, {
        tenantId: TENANT,
        sessionId: 'voice-sess-edit',
        ownerSession: true,
        reference: 'the Henderson estimate',
        instruction: 'change the total to 200 dollars',
      });
    return { proposalRepo, proposal, requests, edit };
  }

  it('an applied edit re-points ai_run_id to the edit run, keyed to the call', async () => {
    const h = await harness('{"totalCents": 20000}');
    const result = await h.edit();
    expect(result.outcome).toBe('edited');
    const stored = await h.proposalRepo.findById(TENANT, h.proposal.id);
    expect(stored?.payload.totalCents).toBe(20000);
    expect(stored?.aiRunId).toBe(EDIT_RUN);
    expect(h.requests[0].metadata?.correlationId).toBe('voice-sess-edit');
  });

  it('an edit whose run was not persisted clears the link', async () => {
    const h = await harness('{"totalCents": 20000}', false);
    expect((await h.edit()).outcome).toBe('edited');
    expect((await h.proposalRepo.findById(TENANT, h.proposal.id))?.aiRunId).toBeUndefined();
  });

  it('an edit that is not applied leaves the draft run linked', async () => {
    const h = await harness('{"lineItems": "lots"}');
    expect((await h.edit()).outcome).not.toBe('edited');
    expect((await h.proposalRepo.findById(TENANT, h.proposal.id))?.aiRunId).toBe(DRAFT_RUN);
  });
});
