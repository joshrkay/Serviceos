import {
  createProposal,
  InMemoryProposalRepository,
  CreateProposalInput,
} from '../../src/proposals/proposal';
import {
  createInvoiceProvenance,
  InMemoryInvoiceProvenanceRepository,
  CreateInvoiceProvenanceInput,
} from '../../src/invoices/invoice-provenance';

describe('P5-003C — Persist invoice proposal with AI provenance', () => {
  let proposalRepo: InMemoryProposalRepository;
  let provenanceRepo: InMemoryInvoiceProvenanceRepository;

  const tenantId = 'tenant-1';

  const baseProposalInput: CreateProposalInput = {
    tenantId,
    proposalType: 'draft_invoice',
    payload: {
      customerId: '00000000-0000-0000-0000-000000000001',
      jobId: '00000000-0000-0000-0000-000000000002',
      lineItems: [{ description: 'AC Repair', quantity: 1, unitPrice: 7500 }],
    },
    summary: 'Invoice for AC repair job',
    createdBy: 'user-1',
    aiRunId: 'ai-run-001',
    promptVersionId: 'prompt-v2',
    sourceContext: { conversationId: 'conv-1' },
  };

  beforeEach(() => {
    proposalRepo = new InMemoryProposalRepository();
    provenanceRepo = new InMemoryInvoiceProvenanceRepository();
  });

  it('happy path — proposal stored with aiRunId, promptVersionId, sourceContext', async () => {
    const proposal = createProposal(baseProposalInput);
    const stored = await proposalRepo.create(proposal);

    expect(stored.aiRunId).toBe('ai-run-001');
    expect(stored.promptVersionId).toBe('prompt-v2');
    expect(stored.sourceContext).toEqual({ conversationId: 'conv-1' });
    expect(stored.proposalType).toBe('draft_invoice');
    expect(stored.status).toBe('draft');
  });

  it('happy path — proposal can be retrieved by id', async () => {
    const proposal = createProposal(baseProposalInput);
    await proposalRepo.create(proposal);

    const found = await proposalRepo.findById(tenantId, proposal.id);
    expect(found).not.toBeNull();
    expect(found!.aiRunId).toBe('ai-run-001');
    expect(found!.promptVersionId).toBe('prompt-v2');
    expect(found!.sourceContext).toEqual({ conversationId: 'conv-1' });
  });

  it('happy path — proposal can be retrieved by aiRunId', async () => {
    const proposal = createProposal(baseProposalInput);
    await proposalRepo.create(proposal);

    const found = await proposalRepo.findByAiRun(tenantId, 'ai-run-001');
    expect(found).toHaveLength(1);
    expect(found[0].id).toBe(proposal.id);
  });

  it('validation — proposal without aiRunId still works', async () => {
    const { aiRunId, ...inputNoAiRun } = baseProposalInput;
    const proposal = createProposal(inputNoAiRun as CreateProposalInput);
    const stored = await proposalRepo.create(proposal);

    expect(stored.aiRunId).toBeUndefined();
    expect(stored.proposalType).toBe('draft_invoice');
    expect(stored.status).toBe('draft');
    expect(stored.id).toBeDefined();
  });

  it('validation — proposal without promptVersionId still works', async () => {
    const { promptVersionId, ...inputNoPrompt } = baseProposalInput;
    const proposal = createProposal(inputNoPrompt as CreateProposalInput);
    const stored = await proposalRepo.create(proposal);

    expect(stored.promptVersionId).toBeUndefined();
    expect(stored.proposalType).toBe('draft_invoice');
  });

  it('validation — proposal without sourceContext still works', async () => {
    const { sourceContext, ...inputNoContext } = baseProposalInput;
    const proposal = createProposal(inputNoContext as CreateProposalInput);
    const stored = await proposalRepo.create(proposal);

    expect(stored.sourceContext).toBeUndefined();
    expect(stored.proposalType).toBe('draft_invoice');
  });

  it('tenant isolation — stored proposals isolated by tenantId', async () => {
    const proposalA = createProposal({ ...baseProposalInput, tenantId: 'tenant-A' });
    const proposalB = createProposal({ ...baseProposalInput, tenantId: 'tenant-B' });
    await proposalRepo.create(proposalA);
    await proposalRepo.create(proposalB);

    const foundA = await proposalRepo.findByTenant('tenant-A');
    const foundB = await proposalRepo.findByTenant('tenant-B');
    expect(foundA).toHaveLength(1);
    expect(foundB).toHaveLength(1);
    expect(foundA[0].tenantId).toBe('tenant-A');
    expect(foundB[0].tenantId).toBe('tenant-B');

    // Cross-tenant lookup by id returns null
    const crossLookup = await proposalRepo.findById('tenant-A', proposalB.id);
    expect(crossLookup).toBeNull();
  });

  it('tenant isolation — aiRunId lookup isolated by tenant', async () => {
    const proposalA = createProposal({ ...baseProposalInput, tenantId: 'tenant-A', aiRunId: 'shared-run' });
    const proposalB = createProposal({ ...baseProposalInput, tenantId: 'tenant-B', aiRunId: 'shared-run' });
    await proposalRepo.create(proposalA);
    await proposalRepo.create(proposalB);

    const foundA = await proposalRepo.findByAiRun('tenant-A', 'shared-run');
    expect(foundA).toHaveLength(1);
    expect(foundA[0].tenantId).toBe('tenant-A');
  });

  it('provenance linkage — InvoiceProvenance created alongside proposal', async () => {
    const proposal = createProposal(baseProposalInput);
    await proposalRepo.create(proposal);

    const provenanceInput: CreateInvoiceProvenanceInput = {
      tenantId,
      proposalId: proposal.id,
      aiRunId: 'ai-run-001',
      promptVersionId: 'prompt-v2',
      sourceContext: { conversationId: 'conv-1' },
    };

    const provenance = createInvoiceProvenance(provenanceInput);
    const stored = await provenanceRepo.create(provenance);

    expect(stored.id).toBeDefined();
    expect(stored.tenantId).toBe(tenantId);
    expect(stored.proposalId).toBe(proposal.id);
    expect(stored.aiRunId).toBe('ai-run-001');
    expect(stored.promptVersionId).toBe('prompt-v2');
    expect(stored.sourceContext).toEqual({ conversationId: 'conv-1' });
    expect(stored.createdAt).toBeInstanceOf(Date);
  });

  it('provenance linkage — provenance can be found by proposalId', async () => {
    const proposal = createProposal(baseProposalInput);
    await proposalRepo.create(proposal);

    const provenance = createInvoiceProvenance({
      tenantId,
      proposalId: proposal.id,
      aiRunId: 'ai-run-001',
    });
    await provenanceRepo.create(provenance);

    const found = await provenanceRepo.findByProposalId(tenantId, proposal.id);
    expect(found).not.toBeNull();
    expect(found!.proposalId).toBe(proposal.id);
    expect(found!.aiRunId).toBe('ai-run-001');
  });

  it('provenance linkage — provenance can be found by aiRunId', async () => {
    const proposal = createProposal(baseProposalInput);
    await proposalRepo.create(proposal);

    const provenance = createInvoiceProvenance({
      tenantId,
      proposalId: proposal.id,
      aiRunId: 'ai-run-001',
    });
    await provenanceRepo.create(provenance);

    const found = await provenanceRepo.findByAiRunId(tenantId, 'ai-run-001');
    expect(found).toHaveLength(1);
    expect(found[0].proposalId).toBe(proposal.id);
  });

  it('provenance linkage — cross-tenant provenance lookup returns null', async () => {
    const proposal = createProposal(baseProposalInput);
    await proposalRepo.create(proposal);

    const provenance = createInvoiceProvenance({
      tenantId,
      proposalId: proposal.id,
      aiRunId: 'ai-run-001',
    });
    await provenanceRepo.create(provenance);

    const crossTenant = await provenanceRepo.findByProposalId('tenant-other', proposal.id);
    expect(crossTenant).toBeNull();
  });

  it('mock provider — uses InMemory repos correctly', async () => {
    const proposal = createProposal(baseProposalInput);
    await proposalRepo.create(proposal);

    const provenance = createInvoiceProvenance({
      tenantId,
      proposalId: proposal.id,
      aiRunId: 'ai-run-001',
      promptVersionId: 'prompt-v2',
    });
    await provenanceRepo.create(provenance);

    // Verify both repos work independently
    const foundProposal = await proposalRepo.findById(tenantId, proposal.id);
    const foundProvenance = await provenanceRepo.findByProposalId(tenantId, proposal.id);

    expect(foundProposal).not.toBeNull();
    expect(foundProvenance).not.toBeNull();
    expect(foundProposal!.id).toBe(foundProvenance!.proposalId);
  });
});
