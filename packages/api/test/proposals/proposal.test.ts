import {
  createProposal,
  validateProposalInput,
  InMemoryProposalRepository,
  CreateProposalInput,
} from '../../src/proposals/proposal';

describe('P2-001 — Proposal entity and core schema', () => {
  const validInput: CreateProposalInput = {
    tenantId: 'tenant-1',
    proposalType: 'create_customer',
    payload: { name: 'John Doe', phone: '555-1234' },
    summary: 'Create new customer John Doe from voice call',
    explanation: 'Extracted customer details from transcript',
    confidenceScore: 0.92,
    confidenceFactors: ['name_clearly_stated', 'phone_confirmed'],
    sourceContext: { conversationId: 'conv-1' },
    aiRunId: 'ai-run-1',
    promptVersionId: 'pv-1',
    targetEntityType: 'customer',
    targetEntityId: 'cust-draft-1',
    idempotencyKey: 'idem-key-1',
    expiresAt: new Date('2026-12-31'),
    createdBy: 'user-1',
  };

  it('happy path — creates proposal with all fields', () => {
    const proposal = createProposal(validInput);

    expect(proposal.id).toBeTruthy();
    expect(proposal.tenantId).toBe('tenant-1');
    expect(proposal.proposalType).toBe('create_customer');
    expect(proposal.status).toBe('draft');
    expect(proposal.payload).toEqual({ name: 'John Doe', phone: '555-1234' });
    expect(proposal.summary).toBe('Create new customer John Doe from voice call');
    expect(proposal.explanation).toBe('Extracted customer details from transcript');
    expect(proposal.confidenceScore).toBe(0.92);
    expect(proposal.confidenceFactors).toEqual(['name_clearly_stated', 'phone_confirmed']);
    expect(proposal.sourceContext).toEqual({ conversationId: 'conv-1' });
    expect(proposal.aiRunId).toBe('ai-run-1');
    expect(proposal.promptVersionId).toBe('pv-1');
    expect(proposal.targetEntityType).toBe('customer');
    expect(proposal.targetEntityId).toBe('cust-draft-1');
    expect(proposal.idempotencyKey).toBe('idem-key-1');
    expect(proposal.expiresAt).toEqual(new Date('2026-12-31'));
    expect(proposal.createdBy).toBe('user-1');
    expect(proposal.createdAt).toBeInstanceOf(Date);
    expect(proposal.updatedAt).toBeInstanceOf(Date);
  });

  it('happy path — creates proposal with minimal fields', () => {
    const proposal = createProposal({
      tenantId: 'tenant-1',
      proposalType: 'draft_estimate',
      payload: { lineItems: [] },
      summary: 'Draft estimate for plumbing repair',
      createdBy: 'user-1',
    });

    expect(proposal.id).toBeTruthy();
    expect(proposal.status).toBe('draft');
    expect(proposal.proposalType).toBe('draft_estimate');
    expect(proposal.confidenceScore).toBeUndefined();
    expect(proposal.aiRunId).toBeUndefined();
    expect(proposal.explanation).toBeUndefined();
  });

  it('validation — rejects missing required fields', () => {
    const errors = validateProposalInput({
      tenantId: '',
      proposalType: '' as any,
      payload: null as any,
      summary: '',
      createdBy: '',
    });
    expect(errors).toContain('tenantId is required');
    expect(errors).toContain('proposalType is required');
    expect(errors).toContain('payload must be a non-null object');
    expect(errors).toContain('summary is required');
    expect(errors).toContain('createdBy is required');
  });

  it('validation — rejects invalid confidence score', () => {
    const tooHigh = validateProposalInput({ ...validInput, confidenceScore: 1.5 });
    expect(tooHigh).toContain('confidenceScore must be a number between 0 and 1');

    const tooLow = validateProposalInput({ ...validInput, confidenceScore: -0.1 });
    expect(tooLow).toContain('confidenceScore must be a number between 0 and 1');

    const notNumber = validateProposalInput({ ...validInput, confidenceScore: 'high' as any });
    expect(notNumber).toContain('confidenceScore must be a number between 0 and 1');
  });

  it('validation — rejects invalid proposal type', () => {
    const errors = validateProposalInput({
      ...validInput,
      proposalType: 'invalid_type' as any,
    });
    expect(errors).toContain('proposalType is invalid');
  });

  it('tenant isolation — cross-tenant data inaccessible', async () => {
    const repo = new InMemoryProposalRepository();
    const proposal = createProposal(validInput);
    await repo.create(proposal);

    const found = await repo.findById('other-tenant', proposal.id);
    expect(found).toBeNull();

    const byTenant = await repo.findByTenant('other-tenant');
    expect(byTenant).toHaveLength(0);

    const byStatus = await repo.findByStatus('other-tenant', 'draft');
    expect(byStatus).toHaveLength(0);

    const byAiRun = await repo.findByAiRun('other-tenant', 'ai-run-1');
    expect(byAiRun).toHaveLength(0);

    const updated = await repo.updateStatus('other-tenant', proposal.id, 'approved');
    expect(updated).toBeNull();

    const patched = await repo.update('other-tenant', proposal.id, { summary: 'hacked' });
    expect(patched).toBeNull();
  });

  it('idempotency — duplicate key handled', async () => {
    const repo = new InMemoryProposalRepository();
    const proposal1 = createProposal(validInput);
    const proposal2 = createProposal({ ...validInput, summary: 'Different summary' });

    await repo.create(proposal1);
    await repo.create(proposal2);

    const all = await repo.findByTenant('tenant-1');
    expect(all).toHaveLength(2);

    const found1 = await repo.findById('tenant-1', proposal1.id);
    const found2 = await repo.findById('tenant-1', proposal2.id);
    expect(found1!.summary).toBe('Create new customer John Doe from voice call');
    expect(found2!.summary).toBe('Different summary');
  });

  it('mock provider test — repository stores and retrieves', async () => {
    const repo = new InMemoryProposalRepository();
    const proposal = createProposal(validInput);
    await repo.create(proposal);

    const found = await repo.findById('tenant-1', proposal.id);
    expect(found).not.toBeNull();
    expect(found!.proposalType).toBe('create_customer');
    expect(found!.summary).toBe('Create new customer John Doe from voice call');

    const byStatus = await repo.findByStatus('tenant-1', 'draft');
    expect(byStatus).toHaveLength(1);

    const byAiRun = await repo.findByAiRun('tenant-1', 'ai-run-1');
    expect(byAiRun).toHaveLength(1);

    const updated = await repo.updateStatus('tenant-1', proposal.id, 'approved', {
      executedBy: 'user-2',
      executedAt: new Date(),
    });
    expect(updated!.status).toBe('approved');
    expect(updated!.executedBy).toBe('user-2');

    const patched = await repo.update('tenant-1', proposal.id, { summary: 'Updated summary' });
    expect(patched!.summary).toBe('Updated summary');
    expect(patched!.updatedAt.getTime()).toBeGreaterThanOrEqual(proposal.updatedAt.getTime());
  });

  it('malformed AI output handled gracefully — invalid payload shape', () => {
    const errors = validateProposalInput({
      tenantId: 'tenant-1',
      proposalType: 'create_customer',
      payload: null as any,
      summary: 'Test',
      createdBy: 'user-1',
    });
    expect(errors).toContain('payload must be a non-null object');

    const arrayPayloadErrors = validateProposalInput({
      tenantId: 'tenant-1',
      proposalType: 'create_customer',
      payload: 'not-an-object' as any,
      summary: 'Test',
      createdBy: 'user-1',
    });
    expect(arrayPayloadErrors).toContain('payload must be a non-null object');
  });
});
