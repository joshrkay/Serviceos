import {
  createProposal,
  InMemoryProposalRepository,
  CreateProposalInput,
  Proposal,
} from '../../src/proposals/proposal';
import {
  approveProposal,
  approveChainSet,
  rejectProposal,
  editProposal,
  undoProposal,
} from '../../src/proposals/actions';
import { UNDO_WINDOW_MS } from '../../src/proposals/lifecycle';
import { AppError, ForbiddenError, ValidationError, NotFoundError } from '../../src/shared/errors';

describe('P2-005 — Approve / reject / edit interactions', () => {
  const tenantId = 'tenant-1';
  const actorId = 'user-1';

  const baseInput: CreateProposalInput = {
    tenantId,
    proposalType: 'create_customer',
    payload: { name: 'John Doe' },
    summary: 'Create customer from voice call',
    createdBy: actorId,
  };

  function makeRepo() {
    return new InMemoryProposalRepository();
  }

  async function createReadyProposal(repo: InMemoryProposalRepository, overrides?: Partial<CreateProposalInput>): Promise<Proposal> {
    const proposal = createProposal({ ...baseInput, ...overrides });
    await repo.create(proposal);
    await repo.updateStatus(tenantId, proposal.id, 'ready_for_review');
    return (await repo.findById(tenantId, proposal.id))!;
  }

  it('happy path — owner approves proposal', async () => {
    const repo = makeRepo();
    const proposal = await createReadyProposal(repo);

    const result = await approveProposal(repo, tenantId, proposal.id, actorId, 'owner');
    expect(result.status).toBe('approved');
  });

  it('happy path — dispatcher approves proposal', async () => {
    const repo = makeRepo();
    const proposal = await createReadyProposal(repo);

    const result = await approveProposal(repo, tenantId, proposal.id, actorId, 'dispatcher');
    expect(result.status).toBe('approved');
  });

  it('approves a draft directly (inbox surfaces drafts)', async () => {
    const repo = makeRepo();
    const proposal = createProposal(baseInput); // lands in 'draft'
    await repo.create(proposal);

    const result = await approveProposal(repo, tenantId, proposal.id, actorId, 'owner');
    expect(result.status).toBe('approved');
  });

  it('refuses to approve a proposal with unfilled missingFields', async () => {
    const repo = makeRepo();
    const proposal = createProposal({ ...baseInput, missingFields: ['phone'] });
    await repo.create(proposal);

    await expect(
      approveProposal(repo, tenantId, proposal.id, actorId, 'owner')
    ).rejects.toThrow(ValidationError);
    // Untouched — still draft.
    expect((await repo.findById(tenantId, proposal.id))!.status).toBe('draft');
  });

  it('validation — technician cannot approve', async () => {
    const repo = makeRepo();
    const proposal = await createReadyProposal(repo);

    await expect(
      approveProposal(repo, tenantId, proposal.id, actorId, 'technician')
    ).rejects.toThrow(ForbiddenError);
  });

  it('security — technician cannot reject proposal', async () => {
    const repo = makeRepo();
    const proposal = await createReadyProposal(repo);

    await expect(
      rejectProposal(repo, tenantId, proposal.id, actorId, 'technician', 'reason')
    ).rejects.toThrow(ForbiddenError);
  });

  it('happy path — reject with reason stored', async () => {
    const repo = makeRepo();
    const proposal = await createReadyProposal(repo);

    const result = await rejectProposal(
      repo, tenantId, proposal.id, actorId, 'owner',
      'Incorrect customer name', 'Name should be Jane Doe'
    );
    expect(result.status).toBe('rejected');
    expect(result.rejectionReason).toBe('Incorrect customer name');
    expect(result.rejectionDetails).toBe('Name should be Jane Doe');
  });

  it('happy path — edit updates payload and tracks changes', async () => {
    const repo = makeRepo();
    const proposal = await createReadyProposal(repo);

    const { proposal: updated, editedFields } = await editProposal(
      repo, tenantId, proposal.id, actorId, 'owner',
      { name: 'Jane Doe', phone: '555-9999' }
    );

    expect(updated.payload.name).toBe('Jane Doe');
    expect(updated.payload.phone).toBe('555-9999');
    expect(editedFields).toContain('name');
    expect(editedFields).toContain('phone');
  });

  it('validation — edit validates against typed contract', async () => {
    const repo = makeRepo();
    const estimateInput: CreateProposalInput = {
      tenantId,
      proposalType: 'draft_estimate',
      payload: {
        customerId: '550e8400-e29b-41d4-a716-446655440000',
        lineItems: [{ description: 'Repair', quantity: 1, unitPrice: 100 }],
      },
      summary: 'Estimate for repair',
      createdBy: actorId,
    };
    const proposal = createProposal(estimateInput);
    await repo.create(proposal);

    // Edit with invalid payload (lineItems must be array with min 1)
    await expect(
      editProposal(repo, tenantId, proposal.id, actorId, 'owner', { lineItems: [] })
    ).rejects.toThrow(ValidationError);
  });

  it('validation — cannot edit executed proposal', async () => {
    const repo = makeRepo();
    const proposal = await createReadyProposal(repo);
    await repo.updateStatus(tenantId, proposal.id, 'approved');
    await repo.updateStatus(tenantId, proposal.id, 'executed');

    await expect(
      editProposal(repo, tenantId, proposal.id, actorId, 'owner', { name: 'New Name' })
    ).rejects.toThrow(ValidationError);
  });

  it('validation — proposal not found returns error', async () => {
    const repo = makeRepo();

    await expect(
      approveProposal(repo, tenantId, 'nonexistent-id', actorId, 'owner')
    ).rejects.toThrow(NotFoundError);

    await expect(
      rejectProposal(repo, tenantId, 'nonexistent-id', actorId, 'owner', 'reason')
    ).rejects.toThrow(NotFoundError);

    await expect(
      editProposal(repo, tenantId, 'nonexistent-id', actorId, 'owner', { name: 'Test' })
    ).rejects.toThrow(NotFoundError);
  });

  // ── Decision 9: undoProposal ────────────────────────────────────────

  describe('undoProposal — 5-second undo window', () => {
    it('happy path — owner undoes freshly-approved proposal within window', async () => {
      const repo = makeRepo();
      const proposal = await createReadyProposal(repo);
      const approved = await approveProposal(repo, tenantId, proposal.id, actorId, 'owner');
      expect(approved.status).toBe('approved');
      expect(approved.approvedAt).toBeInstanceOf(Date);

      const undone = await undoProposal(repo, tenantId, proposal.id, actorId, 'owner');
      expect(undone.status).toBe('undone');
      expect(undone.undoneAt).toBeInstanceOf(Date);
      expect(undone.undoneBy).toBe(actorId);
    });

    it('undoProposal fails after the window closes (UNDO_WINDOW_CLOSED)', async () => {
      const repo = makeRepo();
      const proposal = await createReadyProposal(repo);
      await approveProposal(repo, tenantId, proposal.id, actorId, 'owner');

      // Simulate the window having closed by backdating approvedAt.
      await repo.updateStatus(tenantId, proposal.id, 'approved', {
        approvedAt: new Date(Date.now() - UNDO_WINDOW_MS - 100),
      });

      await expect(
        undoProposal(repo, tenantId, proposal.id, actorId, 'owner')
      ).rejects.toMatchObject({ code: 'UNDO_WINDOW_CLOSED' });
    });

    it('undoProposal rejects technicians (permission gate)', async () => {
      const repo = makeRepo();
      const proposal = await createReadyProposal(repo);
      await approveProposal(repo, tenantId, proposal.id, actorId, 'owner');

      await expect(
        undoProposal(repo, tenantId, proposal.id, actorId, 'technician')
      ).rejects.toThrow(ForbiddenError);
    });

    it('undoProposal rejects non-approved proposals (e.g., still draft)', async () => {
      const repo = makeRepo();
      const proposal = createProposal(baseInput);
      await repo.create(proposal);
      // Leave in 'draft' — undoProposal must refuse.
      await expect(
        undoProposal(repo, tenantId, proposal.id, actorId, 'owner')
      ).rejects.toThrow(ValidationError);
    });

    it('undoProposal returns NotFoundError for unknown ids', async () => {
      const repo = makeRepo();
      await expect(
        undoProposal(repo, tenantId, 'nonexistent-id', actorId, 'owner')
      ).rejects.toThrow(NotFoundError);
    });
  });
});

// ─── RV-073 — approval-channel audit tagging ────────────────────────────────
//
// approveProposal/rejectProposal accept an optional `channel`
// ('ui' | 'sms' | 'one_tap' | 'voice') recorded on the audit-event
// metadata. When the call site does not declare one, the key is OMITTED
// (legacy behavior) rather than defaulted.

import { InMemoryAuditRepository } from '../../src/audit/audit';
import { approveProposalsBatch } from '../../src/proposals/actions';
import { applyChainMetadata } from '../../src/proposals/chain';

describe('RV-073 — approval channel audit tagging', () => {
  const tenantId = 'tenant-1';
  const actorId = 'user-1';

  const baseInput: CreateProposalInput = {
    tenantId,
    proposalType: 'create_customer',
    payload: { name: 'John Doe' },
    summary: 'Create customer from voice call',
    createdBy: actorId,
  };

  async function createReady(repo: InMemoryProposalRepository): Promise<Proposal> {
    const proposal = createProposal(baseInput);
    await repo.create(proposal);
    await repo.updateStatus(tenantId, proposal.id, 'ready_for_review');
    return (await repo.findById(tenantId, proposal.id))!;
  }

  it('approveProposal records channel on the proposal.approved audit metadata', async () => {
    const repo = new InMemoryProposalRepository();
    const auditRepo = new InMemoryAuditRepository();
    const proposal = await createReady(repo);

    await approveProposal(repo, tenantId, proposal.id, actorId, 'owner', auditRepo, 'voice');

    const event = auditRepo.getAll().find((e) => e.eventType === 'proposal.approved');
    expect(event).toBeDefined();
    expect(event!.metadata).toMatchObject({
      proposalType: 'create_customer',
      status: 'approved',
      channel: 'voice',
    });
  });

  it('approveProposal omits the channel key entirely when no channel is passed (legacy)', async () => {
    const repo = new InMemoryProposalRepository();
    const auditRepo = new InMemoryAuditRepository();
    const proposal = await createReady(repo);

    await approveProposal(repo, tenantId, proposal.id, actorId, 'owner', auditRepo);

    const event = auditRepo.getAll().find((e) => e.eventType === 'proposal.approved');
    expect(event).toBeDefined();
    expect(event!.metadata).not.toHaveProperty('channel');
  });

  it('rejectProposal records channel on the proposal.rejected audit metadata', async () => {
    const repo = new InMemoryProposalRepository();
    const auditRepo = new InMemoryAuditRepository();
    const proposal = await createReady(repo);

    await rejectProposal(
      repo,
      tenantId,
      proposal.id,
      actorId,
      'owner',
      'not needed',
      undefined,
      undefined,
      auditRepo,
      'sms',
    );

    const event = auditRepo.getAll().find((e) => e.eventType === 'proposal.rejected');
    expect(event).toBeDefined();
    expect(event!.metadata).toMatchObject({
      rejectionReason: 'not needed',
      channel: 'sms',
    });
  });

  it('rejectProposal omits the channel key when no channel is passed (legacy)', async () => {
    const repo = new InMemoryProposalRepository();
    const auditRepo = new InMemoryAuditRepository();
    const proposal = await createReady(repo);

    await rejectProposal(
      repo,
      tenantId,
      proposal.id,
      actorId,
      'owner',
      'not needed',
      undefined,
      undefined,
      auditRepo,
    );

    const event = auditRepo.getAll().find((e) => e.eventType === 'proposal.rejected');
    expect(event).toBeDefined();
    expect(event!.metadata).not.toHaveProperty('channel');
  });

  it('approveProposalsBatch threads the channel onto each member approval', async () => {
    const repo = new InMemoryProposalRepository();
    const auditRepo = new InMemoryAuditRepository();
    const a = await createReady(repo);
    const b = await createReady(repo);

    const result = await approveProposalsBatch(
      repo,
      tenantId,
      [a.id, b.id],
      actorId,
      'owner',
      auditRepo,
      'ui',
    );

    expect(result.approved).toEqual([a.id, b.id]);
    const approvedEvents = auditRepo
      .getAll()
      .filter((e) => e.eventType === 'proposal.approved');
    expect(approvedEvents).toHaveLength(2);
    for (const event of approvedEvents) {
      expect(event.metadata).toMatchObject({ channel: 'ui' });
    }
  });
});

describe('Track E — chain-set approval', () => {
  const tenantId = 'tenant-chain';
  const actorId = 'owner-1';

  async function seedChain(repo: InMemoryProposalRepository): Promise<{
    customer: Proposal;
    job: Proposal;
    sendEstimate: Proposal;
  }> {
    const chainId = 'chain-approve-1';
    const customer = createProposal({
      tenantId,
      proposalType: 'create_customer',
      payload: { name: 'Jane Chain' },
      summary: 'Create Jane Chain',
      createdBy: 'voice',
    });
    applyChainMetadata(customer, {
      chainId,
      chainIndex: 0,
      chainLength: 3,
      dependsOnChainIndices: [],
      chainRefs: [],
    });
    const job = createProposal({
      tenantId,
      proposalType: 'create_job',
      payload: { customerId: 'placeholder', title: 'Install' },
      summary: 'Create install job',
      createdBy: 'voice',
    });
    applyChainMetadata(job, {
      chainId,
      chainIndex: 1,
      chainLength: 3,
      dependsOnChainIndices: [0],
      chainRefs: [{ payloadPath: 'customerId', parentChainIndex: 0, entityKind: 'customerId' }],
    });
    const sendEstimate = createProposal({
      tenantId,
      proposalType: 'send_estimate',
      payload: { estimateId: '550e8400-e29b-41d4-a716-446655440001' },
      summary: 'Send estimate',
      createdBy: 'voice',
    });
    applyChainMetadata(sendEstimate, {
      chainId,
      chainIndex: 2,
      chainLength: 3,
      dependsOnChainIndices: [1],
      chainRefs: [{ payloadPath: 'estimateId', parentChainIndex: 1, entityKind: 'estimateId' }],
    });
    await repo.createMany([
      { ...customer, status: 'ready_for_review' },
      { ...job, status: 'draft' },
      { ...sendEstimate, status: 'draft' },
    ]);
    return {
      customer: (await repo.findById(tenantId, customer.id))!,
      job: (await repo.findById(tenantId, job.id))!,
      sendEstimate: (await repo.findById(tenantId, sendEstimate.id))!,
    };
  }

  it('approves the chain head plus capture siblings in chainIndex order and audits each channel', async () => {
    const repo = new InMemoryProposalRepository();
    const auditRepo = new InMemoryAuditRepository();
    const { customer, job, sendEstimate } = await seedChain(repo);

    const result = await approveChainSet(
      repo,
      tenantId,
      customer.id,
      actorId,
      'owner',
      auditRepo,
      'sms',
    );

    expect(result.approved.map((p) => p.id)).toEqual([customer.id, job.id]);
    expect(result.skipped).toEqual([{ id: sendEstimate.id, reason: 'non_capture' }]);
    expect((await repo.findById(tenantId, customer.id))?.status).toBe('approved');
    expect((await repo.findById(tenantId, job.id))?.status).toBe('approved');
    expect((await repo.findById(tenantId, sendEstimate.id))?.status).toBe('draft');
    const approvedEvents = auditRepo
      .getAll()
      .filter((e) => e.eventType === 'proposal.approved');
    expect(approvedEvents.map((e) => e.entityId)).toEqual([customer.id, job.id]);
    expect(approvedEvents.every((e) => e.metadata.channel === 'sms')).toBe(true);
  });

  it('excludes low-confidence capture siblings while approving the rest', async () => {
    const repo = new InMemoryProposalRepository();
    const auditRepo = new InMemoryAuditRepository();
    const { customer, job, sendEstimate } = await seedChain(repo);
    await repo.update(tenantId, job.id, {
      payload: {
        ...job.payload,
        _meta: { overallConfidence: 'low' },
      },
    });

    const result = await approveChainSet(
      repo,
      tenantId,
      customer.id,
      actorId,
      'owner',
      auditRepo,
      'voice',
    );

    expect(result.approved.map((p) => p.id)).toEqual([customer.id]);
    expect(result.skipped).toEqual([
      { id: job.id, reason: 'low_confidence' },
      { id: sendEstimate.id, reason: 'non_capture' },
    ]);
    expect((await repo.findById(tenantId, job.id))?.status).toBe('draft');
  });

  it('excludes pending-edit capture siblings while approving the rest', async () => {
    const repo = new InMemoryProposalRepository();
    const auditRepo = new InMemoryAuditRepository();
    const { customer, job, sendEstimate } = await seedChain(repo);

    const result = await approveChainSet(
      repo,
      tenantId,
      customer.id,
      actorId,
      'owner',
      auditRepo,
      'sms',
      async (_tenant, proposalId) => proposalId === job.id,
    );

    expect(result.approved.map((p) => p.id)).toEqual([customer.id]);
    expect(result.skipped).toEqual([
      { id: job.id, reason: 'pending_edit' },
      { id: sendEstimate.id, reason: 'non_capture' },
    ]);
    expect((await repo.findById(tenantId, job.id))?.status).toBe('draft');
  });

  it('approving a non-head chain member only approves that member', async () => {
    const repo = new InMemoryProposalRepository();
    const { customer, job, sendEstimate } = await seedChain(repo);

    const result = await approveChainSet(repo, tenantId, job.id, actorId, 'owner');

    expect(result.approved.map((p) => p.id)).toEqual([job.id]);
    expect(result.skipped).toEqual([{ id: job.id, reason: 'not_head' }]);
    expect((await repo.findById(tenantId, customer.id))?.status).toBe('ready_for_review');
    expect((await repo.findById(tenantId, sendEstimate.id))?.status).toBe('draft');
  });
});
