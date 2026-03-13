import {
  createProposal,
  InMemoryProposalRepository,
  CreateProposalInput,
} from '../../src/proposals/proposal';
import { listProposals, getProposalDetail } from '../../src/proposals/routes';
import { proposalFilterSchema } from '../../src/proposals/proposal-contracts';
import { validate } from '../../src/shared/validation';
import { ForbiddenError, NotFoundError, ValidationError } from '../../src/shared/errors';

describe('P2-004 — Proposal list and detail views', () => {
  const tenantId = 'tenant-1';

  const baseInput: CreateProposalInput = {
    tenantId,
    proposalType: 'create_customer',
    payload: { name: 'John Doe' },
    summary: 'Create customer from voice call',
    createdBy: 'user-1',
  };

  function makeRepo() {
    return new InMemoryProposalRepository();
  }

  it('happy path — lists proposals for tenant', async () => {
    const repo = makeRepo();
    const p1 = createProposal(baseInput);
    const p2 = createProposal({ ...baseInput, summary: 'Second proposal' });
    await repo.create(p1);
    await repo.create(p2);

    const result = await listProposals(repo, tenantId, { limit: 20, offset: 0 }, 'owner');
    expect(result.data).toHaveLength(2);
    expect(result.total).toBe(2);
  });

  it('happy path — filters by status', async () => {
    const repo = makeRepo();
    const draft = createProposal(baseInput);
    const approved = createProposal({ ...baseInput, summary: 'Approved one' });
    await repo.create(draft);
    await repo.create(approved);
    await repo.updateStatus(tenantId, approved.id, 'ready_for_review');
    await repo.updateStatus(tenantId, approved.id, 'approved');

    const result = await listProposals(repo, tenantId, { status: 'approved', limit: 20, offset: 0 }, 'owner');
    expect(result.data).toHaveLength(1);
    expect(result.data[0].id).toBe(approved.id);
    expect(result.total).toBe(1);
  });

  it('happy path — paginates results', async () => {
    const repo = makeRepo();
    for (let i = 0; i < 5; i++) {
      await repo.create(createProposal({ ...baseInput, summary: `Proposal ${i}` }));
    }

    const page1 = await listProposals(repo, tenantId, { limit: 2, offset: 0 }, 'owner');
    expect(page1.data).toHaveLength(2);
    expect(page1.total).toBe(5);

    const page2 = await listProposals(repo, tenantId, { limit: 2, offset: 2 }, 'owner');
    expect(page2.data).toHaveLength(2);
    expect(page2.total).toBe(5);

    const page3 = await listProposals(repo, tenantId, { limit: 2, offset: 4 }, 'owner');
    expect(page3.data).toHaveLength(1);
    expect(page3.total).toBe(5);
  });

  it('happy path — returns proposal detail', async () => {
    const repo = makeRepo();
    const proposal = createProposal(baseInput);
    await repo.create(proposal);

    const result = await getProposalDetail(repo, tenantId, proposal.id, 'technician');
    expect(result.id).toBe(proposal.id);
    expect(result.summary).toBe(baseInput.summary);
    expect(result.proposalType).toBe('create_customer');
  });

  it('validation — rejects invalid filter', () => {
    expect(() => validate(proposalFilterSchema, { status: 'invalid_status' })).toThrow(ValidationError);
    expect(() => validate(proposalFilterSchema, { limit: -1 })).toThrow(ValidationError);
    expect(() => validate(proposalFilterSchema, { limit: 999 })).toThrow(ValidationError);
    expect(() => validate(proposalFilterSchema, { offset: -5 })).toThrow(ValidationError);
  });

  it('validation — returns 404 for missing proposal', async () => {
    const repo = makeRepo();
    await expect(
      getProposalDetail(repo, tenantId, '550e8400-e29b-41d4-a716-446655440000', 'owner')
    ).rejects.toThrow(NotFoundError);
  });

  it('security — rejects invalid UUID format for proposal ID', async () => {
    const repo = makeRepo();
    await expect(
      getProposalDetail(repo, tenantId, 'not-a-valid-uuid', 'owner')
    ).rejects.toThrow(ValidationError);
  });
});
