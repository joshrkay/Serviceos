import {
  createProposal,
  InMemoryProposalRepository,
  CreateProposalInput,
  Proposal,
} from '../../src/proposals/proposal';
import { resolveProposalLine } from '../../src/proposals/resolve-line';
import { InMemoryAuditRepository } from '../../src/audit/audit';
import { ForbiddenError, ValidationError, NotFoundError } from '../../src/shared/errors';

describe('P2-035 (U2) — resolveProposalLine', () => {
  const tenantId = 'tenant-1';
  const actorId = 'user-1';

  // Two resolver-surfaced candidates for the ambiguous line (the shape the
  // catalog resolver stores under sourceContext.catalogResolution[idx]).
  const candidates = [
    { id: '11111111-1111-1111-1111-111111111111', name: '50-gal Water Heater', unitPriceCents: 120000, score: 0.74 },
    { id: '22222222-2222-2222-2222-222222222222', name: '40-gal Water Heater', unitPriceCents: 95000, score: 0.71 },
  ];

  function makeRepo() {
    return new InMemoryProposalRepository();
  }

  /**
   * Build an estimate proposal with one ambiguous line (index 0) and one
   * already-priced catalog line (index 1). Lands in 'draft' because
   * missingFields is non-empty. `extraCandidates` lets the safety test add
   * a SECOND ambiguous line.
   */
  async function makeAmbiguousEstimate(
    repo: InMemoryProposalRepository,
    overrides?: Partial<CreateProposalInput>,
  ): Promise<Proposal> {
    const input: CreateProposalInput = {
      tenantId,
      proposalType: 'draft_estimate',
      summary: 'Draft estimate from voice note',
      createdBy: actorId,
      payload: {
        customerId: 'cust-1',
        lineItems: [
          { description: 'water heater', quantity: 1, unitPrice: 100000, pricingSource: 'ambiguous', needsPricing: true },
          { description: 'Service Call', quantity: 1, unitPrice: 8900, pricingSource: 'catalog', needsPricing: false },
        ],
        _meta: {
          overallConfidence: 'low',
          fieldConfidence: { 'lineItems[0].unitPrice': 'low' },
          markers: [
            { path: 'lineItems[0].unitPrice', reason: '"water heater" matched multiple catalog items — pick the right one to set the price' },
          ],
        },
      },
      sourceContext: { catalogResolution: { 0: candidates } },
      missingFields: ['lineItems[0].catalogItemId'],
      ...overrides,
    };
    const proposal = createProposal(input);
    await repo.create(proposal);
    return (await repo.findById(tenantId, proposal.id))!;
  }

  it('happy path — stamps the catalog price, clears missingFields, → ready_for_review, emits audit', async () => {
    const repo = makeRepo();
    const auditRepo = new InMemoryAuditRepository();
    const proposal = await makeAmbiguousEstimate(repo);
    expect(proposal.status).toBe('draft');

    const result = await resolveProposalLine(
      repo,
      tenantId,
      proposal.id,
      actorId,
      'owner',
      { lineIndex: 0, catalogItemId: candidates[0].id },
      auditRepo,
    );

    const line0 = (result.payload.lineItems as Array<Record<string, unknown>>)[0];
    // Price stamped from the catalog candidate (integer cents, no float).
    expect(line0.unitPrice).toBe(120000);
    expect(Number.isInteger(line0.unitPrice as number)).toBe(true);
    expect(line0.pricingSource).toBe('catalog');
    expect(line0.catalogItemId).toBe(candidates[0].id);
    expect(line0.needsPricing).toBe(false);
    expect(line0.description).toBe('50-gal Water Heater');

    // missingFields cleared and the resolved line removed from candidates.
    const ctx = result.sourceContext as Record<string, unknown>;
    expect(ctx.missingFields).toBeUndefined();
    expect(ctx.catalogResolution).toBeUndefined();

    // _meta recomputed — the resolved ambiguity marker is gone.
    const meta = result.payload._meta as { markers?: unknown[] };
    expect(meta.markers).toBeUndefined();

    // No required fields left → moved to ready_for_review (NOT approved).
    expect(result.status).toBe('ready_for_review');

    // Audit emitted.
    const events = await auditRepo.findByEntity(tenantId, 'proposal', proposal.id);
    expect(events).toHaveLength(1);
    expect(events[0].eventType).toBe('proposal.line_resolved');
    expect(events[0].metadata?.catalogItemId).toBe(candidates[0].id);
    expect(events[0].metadata?.unitPriceCents).toBe(120000);
  });

  it('guard — a catalogItemId NOT among the candidates is rejected with no mutation', async () => {
    const repo = makeRepo();
    const auditRepo = new InMemoryAuditRepository();
    const proposal = await makeAmbiguousEstimate(repo);

    await expect(
      resolveProposalLine(
        repo,
        tenantId,
        proposal.id,
        actorId,
        'owner',
        { lineIndex: 0, catalogItemId: '99999999-9999-9999-9999-999999999999' },
        auditRepo,
      ),
    ).rejects.toBeInstanceOf(ValidationError);

    // Nothing mutated: still draft, still ambiguous, still missing.
    const after = (await repo.findById(tenantId, proposal.id))!;
    expect(after.status).toBe('draft');
    const line0 = (after.payload.lineItems as Array<Record<string, unknown>>)[0];
    expect(line0.pricingSource).toBe('ambiguous');
    expect((after.sourceContext as Record<string, unknown>).missingFields).toEqual([
      'lineItems[0].catalogItemId',
    ]);
    // No audit row written on the rejected attempt.
    expect(await auditRepo.findByEntity(tenantId, 'proposal', proposal.id)).toHaveLength(0);
  });

  it('safety — resolving the LAST ambiguous line on a money proposal does NOT reach approved', async () => {
    const repo = makeRepo();
    // A draft_invoice (money-shaped, uses unitPriceCents) with a single
    // ambiguous line. Resolving it leaves no missingFields.
    const input: CreateProposalInput = {
      tenantId,
      proposalType: 'draft_invoice',
      summary: 'Draft invoice from voice note',
      createdBy: actorId,
      payload: {
        customerId: 'cust-1',
        jobId: 'job-1',
        lineItems: [
          { description: 'water heater', quantity: 2, unitPriceCents: 100000, totalCents: 200000, pricingSource: 'ambiguous', needsPricing: true },
        ],
        _meta: { overallConfidence: 'low', markers: [{ path: 'lineItems[0].unitPriceCents', reason: 'ambiguous' }] },
      },
      sourceContext: { catalogResolution: { 0: candidates } },
      missingFields: ['lineItems[0].catalogItemId'],
    };
    const proposal = createProposal(input);
    await repo.create(proposal);

    const result = await resolveProposalLine(
      repo,
      tenantId,
      proposal.id,
      actorId,
      'owner',
      { lineIndex: 0, catalogItemId: candidates[1].id },
    );

    // Invoice lines recompute totalCents from the authoritative price × qty.
    const line0 = (result.payload.lineItems as Array<Record<string, unknown>>)[0];
    expect(line0.unitPriceCents).toBe(95000);
    expect(line0.totalCents).toBe(190000); // 95000 × 2
    // The whole point: never auto-approve / execute on resolve.
    expect(result.status).toBe('ready_for_review');
    expect(result.status).not.toBe('approved');
  });

  it('keeps the proposal in draft when OTHER ambiguous lines remain', async () => {
    const repo = makeRepo();
    const secondCandidates = [
      { id: '33333333-3333-3333-3333-333333333333', name: 'Expansion Tank A', unitPriceCents: 6000, score: 0.7 },
      { id: '44444444-4444-4444-4444-444444444444', name: 'Expansion Tank B', unitPriceCents: 7500, score: 0.69 },
    ];
    const proposal = await makeAmbiguousEstimate(repo, {
      payload: {
        customerId: 'cust-1',
        lineItems: [
          { description: 'water heater', quantity: 1, unitPrice: 100000, pricingSource: 'ambiguous', needsPricing: true },
          { description: 'expansion tank', quantity: 1, unitPrice: 7000, pricingSource: 'ambiguous', needsPricing: true },
        ],
        _meta: { overallConfidence: 'low' },
      },
      sourceContext: { catalogResolution: { 0: candidates, 1: secondCandidates } },
      missingFields: ['lineItems[0].catalogItemId', 'lineItems[1].catalogItemId'],
    });

    const result = await resolveProposalLine(
      repo,
      tenantId,
      proposal.id,
      actorId,
      'owner',
      { lineIndex: 0, catalogItemId: candidates[0].id },
    );

    // Line 1 is still ambiguous → stays draft, still missing one field.
    expect(result.status).toBe('draft');
    const ctx = result.sourceContext as Record<string, unknown>;
    expect(ctx.missingFields).toEqual(['lineItems[1].catalogItemId']);
    // Only the resolved line is dropped from the candidate map.
    expect(ctx.catalogResolution).toEqual({ '1': secondCandidates });
  });

  it('not-found — unknown proposal id throws NotFoundError', async () => {
    const repo = makeRepo();
    await expect(
      resolveProposalLine(
        repo,
        tenantId,
        'no-such-proposal',
        actorId,
        'owner',
        { lineIndex: 0, catalogItemId: candidates[0].id },
      ),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it('rejects a line with no ambiguous candidates', async () => {
    const repo = makeRepo();
    const proposal = await makeAmbiguousEstimate(repo);
    // Line index 1 is the already-priced catalog line — no candidates.
    await expect(
      resolveProposalLine(
        repo,
        tenantId,
        proposal.id,
        actorId,
        'owner',
        { lineIndex: 1, catalogItemId: candidates[0].id },
      ),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('RBAC — a role lacking proposals:approve is forbidden', async () => {
    const repo = makeRepo();
    const proposal = await makeAmbiguousEstimate(repo);
    await expect(
      resolveProposalLine(
        repo,
        tenantId,
        proposal.id,
        actorId,
        'technician',
        { lineIndex: 0, catalogItemId: candidates[0].id },
      ),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('enforces tenant isolation — cannot resolve another tenant\'s proposal', async () => {
    const repo = makeRepo();
    const proposal = await makeAmbiguousEstimate(repo);
    await expect(
      resolveProposalLine(
        repo,
        'tenant-OTHER',
        proposal.id,
        actorId,
        'owner',
        { lineIndex: 0, catalogItemId: candidates[0].id },
      ),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});
