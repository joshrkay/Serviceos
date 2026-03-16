import {
  InMemoryEvaluationDatasetRepository,
  captureEvaluationSnapshot,
  EvaluationDatasetRepository,
} from '../../src/ai/evaluation/dataset-hooks';
import {
  createProposal,
  CreateProposalInput,
  Proposal,
} from '../../src/proposals/proposal';
import { createAiRun, AiRun, CreateAiRunInput } from '../../src/ai/ai-run';

function makeProposal(overrides?: Partial<Proposal>): Proposal {
  const input: CreateProposalInput = {
    tenantId: 'tenant-1',
    proposalType: 'draft_estimate',
    payload: { lineItems: [{ name: 'Item 1', price: 100 }], notes: 'test' },
    summary: 'Test proposal',
    sourceContext: { customerName: 'Acme Corp' },
    confidenceScore: 0.85,
    createdBy: 'user-1',
  };
  const proposal = createProposal(input);
  if (overrides) {
    Object.assign(proposal, overrides);
  }
  return proposal;
}

function makeAiRun(overrides?: Partial<AiRun>): AiRun {
  const input: CreateAiRunInput = {
    tenantId: 'tenant-1',
    taskType: 'draft_estimate',
    model: 'gpt-4',
    inputSnapshot: { prompt: 'Generate estimate for customer', data: {} },
    createdBy: 'system',
  };
  const run = createAiRun(input);
  if (overrides) {
    Object.assign(run, overrides);
  }
  return run;
}

describe('P2-020 — Evaluation dataset hooks for proposal tasks', () => {
  let repo: EvaluationDatasetRepository;

  beforeEach(() => {
    repo = new InMemoryEvaluationDatasetRepository();
  });

  it('happy path — captures snapshot on approval', async () => {
    const proposal = makeProposal({ status: 'approved' });
    const aiRun = makeAiRun();

    const snapshot = await captureEvaluationSnapshot(repo, proposal, aiRun);

    expect(snapshot.id).toBeDefined();
    expect(snapshot.tenantId).toBe('tenant-1');
    expect(snapshot.proposalId).toBe(proposal.id);
    expect(snapshot.aiRunId).toBe(aiRun.id);
    expect(snapshot.taskType).toBe('draft_estimate');
    expect(snapshot.input.sourceContext).toEqual({ customerName: 'Acme Corp' });
    expect(snapshot.input.prompt).toBe('Generate estimate for customer');
    expect(snapshot.output.payload).toEqual(proposal.payload);
    expect(snapshot.output.confidenceScore).toBe(0.85);
    expect(snapshot.outcome.status).toBe('approved');
    expect(snapshot.outcome.editedFields).toBeUndefined();
    expect(snapshot.capturedAt).toBeInstanceOf(Date);
  });

  it('happy path — captures snapshot on rejection', async () => {
    const proposal = makeProposal({
      status: 'rejected',
      rejectionReason: 'wrong_pricing',
    });

    const snapshot = await captureEvaluationSnapshot(repo, proposal);

    expect(snapshot.outcome.status).toBe('rejected');
    expect(snapshot.outcome.rejectionReason).toBe('wrong_pricing');
  });

  it('happy path — includes edited fields', async () => {
    const proposal = makeProposal({ status: 'approved' });
    const aiRun = makeAiRun();

    const snapshot = await captureEvaluationSnapshot(repo, proposal, aiRun, ['price', 'description']);

    expect(snapshot.outcome.editedFields).toEqual(['price', 'description']);
    expect(snapshot.outcome.status).toBe('approved');
  });

  it('happy path — finds snapshots by task type', async () => {
    const estimate = makeProposal({ proposalType: 'draft_estimate', status: 'approved' });
    const customer = makeProposal({ proposalType: 'create_customer', status: 'approved' });

    await captureEvaluationSnapshot(repo, estimate);
    await captureEvaluationSnapshot(repo, customer);

    const estimateSnapshots = await repo.findByTaskType('tenant-1', 'draft_estimate');
    expect(estimateSnapshots.length).toBe(1);
    expect(estimateSnapshots[0].taskType).toBe('draft_estimate');

    const customerSnapshots = await repo.findByTaskType('tenant-1', 'create_customer');
    expect(customerSnapshots.length).toBe(1);
    expect(customerSnapshots[0].taskType).toBe('create_customer');
  });

  it('validation — handles missing AI run gracefully', async () => {
    const proposal = makeProposal({ status: 'approved' });

    const snapshot = await captureEvaluationSnapshot(repo, proposal);

    expect(snapshot.aiRunId).toBeUndefined();
    expect(snapshot.input.prompt).toBeUndefined();
    expect(snapshot.input.sourceContext).toEqual({ customerName: 'Acme Corp' });
    expect(snapshot.output.payload).toEqual(proposal.payload);
  });

  it('happy path — tenant isolation in snapshots', async () => {
    const t1Proposal = makeProposal({ tenantId: 'tenant-1', status: 'approved' });
    const t2Proposal = makeProposal({ tenantId: 'tenant-2', status: 'rejected' });

    await captureEvaluationSnapshot(repo, t1Proposal);
    await captureEvaluationSnapshot(repo, t2Proposal);

    const t1Snapshots = await repo.getAll('tenant-1');
    expect(t1Snapshots.length).toBe(1);
    expect(t1Snapshots[0].tenantId).toBe('tenant-1');

    const t2Snapshots = await repo.getAll('tenant-2');
    expect(t2Snapshots.length).toBe(1);
    expect(t2Snapshots[0].tenantId).toBe('tenant-2');

    const t1ByProposal = await repo.findByProposal('tenant-1', t2Proposal.id);
    expect(t1ByProposal).toBeNull();
  });
});
