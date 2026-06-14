import { describe, it, expect, beforeEach } from 'vitest';
import {
  InMemoryProposalRepository,
  Proposal,
} from '../../../src/proposals/proposal';
import { stampSmsApprovalCode } from '../../../src/sms/proposal-approval/compose';
import { smsApprovalCodeOf } from '../../../src/sms/proposal-approval/render';

const TENANT = '11111111-1111-1111-1111-111111111111';
const OWNER_ID = '33333333-3333-3333-3333-333333333333';

function makeProposal(overrides: Partial<Proposal> = {}): Proposal {
  return {
    id: 'p-1',
    tenantId: TENANT,
    proposalType: 'draft_invoice',
    status: 'ready_for_review',
    payload: { lineItems: [{ description: 'Water Heater', quantity: 1, unitPriceCents: 185_000 }] },
    summary: 'invoice Acme for the water heater',
    createdBy: 'system',
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

describe('stampSmsApprovalCode', () => {
  let proposalRepo: InMemoryProposalRepository;

  beforeEach(() => {
    proposalRepo = new InMemoryProposalRepository();
  });

  it('mints + persists a reply code on sourceContext and returns it', async () => {
    const proposal = makeProposal();
    await proposalRepo.create(proposal);

    const code = await stampSmsApprovalCode(proposalRepo, proposal, {
      recipientUserId: OWNER_ID,
      generateCode: () => 'A7KQ',
    });

    expect(code).toBe('A7KQ');
    const stored = await proposalRepo.findById(TENANT, 'p-1');
    expect(smsApprovalCodeOf(stored!)).toBe('A7KQ');
    expect((stored!.sourceContext!.smsApproval as { recipientUserId: string }).recipientUserId).toBe(
      OWNER_ID,
    );
  });

  it('preserves existing sourceContext when stamping', async () => {
    const proposal = makeProposal({ sourceContext: { conversationId: 'conv-9' } });
    await proposalRepo.create(proposal);

    await stampSmsApprovalCode(proposalRepo, proposal, { generateCode: () => 'A7KQ' });

    const stored = await proposalRepo.findById(TENANT, 'p-1');
    expect(stored!.sourceContext!.conversationId).toBe('conv-9');
    expect(smsApprovalCodeOf(stored!)).toBe('A7KQ');
  });

  it('is idempotent — returns the existing code without re-stamping', async () => {
    const proposal = makeProposal({ sourceContext: { smsApproval: { code: 'OLD1' } } });
    await proposalRepo.create(proposal);

    const code = await stampSmsApprovalCode(proposalRepo, proposal, { generateCode: () => 'NEW2' });

    expect(code).toBe('OLD1');
    expect(smsApprovalCodeOf((await proposalRepo.findById(TENANT, 'p-1'))!)).toBe('OLD1');
  });
});
