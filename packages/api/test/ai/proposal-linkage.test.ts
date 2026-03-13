import {
  linkProposalToAiRun,
  getProposalsByAiRun,
  getAiRunForProposal,
} from '../../src/ai/proposal-linkage';
import { createProposal, InMemoryProposalRepository } from '../../src/proposals/proposal';
import { createAiRun, InMemoryAiRunRepository } from '../../src/ai/ai-run';

function makeProposal(overrides: Record<string, unknown> = {}) {
  return createProposal({
    tenantId: 'tenant-1',
    proposalType: 'draft_estimate',
    payload: { lineItems: [] },
    summary: 'Draft estimate for plumbing',
    createdBy: 'user-1',
    ...overrides,
  });
}

function makeAiRun(overrides: Record<string, unknown> = {}) {
  return createAiRun({
    tenantId: 'tenant-1',
    taskType: 'estimate_generation',
    model: 'claude-sonnet-4-6',
    inputSnapshot: { jobDescription: 'Fix plumbing' },
    createdBy: 'user-1',
    ...overrides,
  });
}

describe('P2-009 — AI run to proposal linkage', () => {
  it('happy path — links proposal to AI run', () => {
    const proposal = makeProposal();
    const aiRun = makeAiRun();

    const linked = linkProposalToAiRun(proposal, aiRun.id, 'prompt-v1');

    expect(linked.aiRunId).toBe(aiRun.id);
    expect(linked.promptVersionId).toBe('prompt-v1');
    expect(linked.id).toBe(proposal.id);
    expect(linked.tenantId).toBe(proposal.tenantId);
    expect(linked.updatedAt.getTime()).toBeGreaterThanOrEqual(proposal.updatedAt.getTime());
  });

  it('happy path — retrieves proposals by AI run', async () => {
    const proposalRepo = new InMemoryProposalRepository();
    const aiRun = makeAiRun();

    const proposal1 = linkProposalToAiRun(makeProposal(), aiRun.id);
    const proposal2 = linkProposalToAiRun(makeProposal(), aiRun.id);
    const unlinked = makeProposal();

    await proposalRepo.create(proposal1);
    await proposalRepo.create(proposal2);
    await proposalRepo.create(unlinked);

    const results = await getProposalsByAiRun(proposalRepo, 'tenant-1', aiRun.id);

    expect(results).toHaveLength(2);
    expect(results.map((p) => p.id).sort()).toEqual([proposal1.id, proposal2.id].sort());
  });

  it('happy path — retrieves AI run for proposal', async () => {
    const aiRunRepo = new InMemoryAiRunRepository();
    const aiRun = makeAiRun();
    await aiRunRepo.create(aiRun);

    const proposal = linkProposalToAiRun(makeProposal(), aiRun.id);

    const found = await getAiRunForProposal(aiRunRepo, 'tenant-1', proposal);

    expect(found).not.toBeNull();
    expect(found!.id).toBe(aiRun.id);
    expect(found!.taskType).toBe('estimate_generation');
  });

  it('validation — returns null when proposal has no aiRunId', async () => {
    const aiRunRepo = new InMemoryAiRunRepository();
    const proposal = makeProposal();

    const result = await getAiRunForProposal(aiRunRepo, 'tenant-1', proposal);

    expect(result).toBeNull();
  });

  it('mock provider test — stores and retrieves linked proposals', async () => {
    const proposalRepo = new InMemoryProposalRepository();
    const aiRunRepo = new InMemoryAiRunRepository();

    const aiRun = makeAiRun();
    await aiRunRepo.create(aiRun);

    const proposal = linkProposalToAiRun(makeProposal(), aiRun.id, 'prompt-v2');
    await proposalRepo.create(proposal);

    const proposals = await getProposalsByAiRun(proposalRepo, 'tenant-1', aiRun.id);
    expect(proposals).toHaveLength(1);
    expect(proposals[0].aiRunId).toBe(aiRun.id);
    expect(proposals[0].promptVersionId).toBe('prompt-v2');

    const run = await getAiRunForProposal(aiRunRepo, 'tenant-1', proposals[0]);
    expect(run).not.toBeNull();
    expect(run!.id).toBe(aiRun.id);
  });

  it('malformed AI output handled gracefully — handles missing AI run', async () => {
    const aiRunRepo = new InMemoryAiRunRepository();
    const proposal = linkProposalToAiRun(makeProposal(), 'nonexistent-run-id');

    const result = await getAiRunForProposal(aiRunRepo, 'tenant-1', proposal);

    expect(result).toBeNull();
  });
});
