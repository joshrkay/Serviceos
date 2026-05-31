import {
  createProposal,
  InMemoryProposalRepository,
  CreateProposalInput,
  Proposal,
} from '../../src/proposals/proposal';
import {
  approveProposal,
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

  it('allows editing a chained dependent whose customerId still holds a $ref token', async () => {
    const repo = makeRepo();
    // A draft_estimate dependent whose customerId is an unresolved chain
    // ref (resolved at execution). The token would fail z.string().uuid()
    // if naively re-validated; editProposal must validate around it.
    const proposal = createProposal({
      tenantId,
      proposalType: 'draft_estimate',
      payload: {
        customerId: '$ref:chain[0].customerId',
        lineItems: [{ description: 'Repair', quantity: 1, unitPrice: 100 }],
      },
      summary: 'Estimate for new customer',
      createdBy: actorId,
    });
    await repo.create(proposal);

    const { proposal: updated } = await editProposal(
      repo, tenantId, proposal.id, actorId, 'owner',
      { lineItems: [{ description: 'Repair', quantity: 2, unitPrice: 100 }] },
    );
    // Edit succeeds and the ref token is preserved (not clobbered).
    expect(updated.payload.customerId).toBe('$ref:chain[0].customerId');
    expect((updated.payload.lineItems as unknown[]).length).toBe(1);
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
