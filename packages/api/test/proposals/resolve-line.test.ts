import { describe, it, expect, beforeEach } from 'vitest';
import {
  InMemoryProposalRepository,
  type Proposal,
} from '../../src/proposals/proposal';
import { InMemoryAuditRepository } from '../../src/audit/audit';
import { resolveProposalLine } from '../../src/proposals/resolve-line';
import { ForbiddenError, NotFoundError, ValidationError } from '../../src/shared/errors';

const TENANT = 't-resolve';
const PROPOSAL = 'p-resolve';
const OWNER = 'owner-1';

function ambiguousProposal(overrides: Partial<Proposal> = {}): Proposal {
  return {
    id: PROPOSAL,
    tenantId: TENANT,
    proposalType: 'draft_estimate',
    status: 'draft',
    summary: 'Estimate with an ambiguous line',
    createdBy: 'voice',
    createdAt: new Date(),
    updatedAt: new Date(),
    payload: {
      lineItems: [
        {
          id: 'l1',
          description: 'flush valve',
          quantity: 1,
          unitPrice: 0,
          pricingSource: 'ambiguous',
          needsPricing: true,
        },
      ],
      _meta: {
        overallConfidence: 'low',
        markers: [{ path: 'lineItems[0].unitPrice', reason: 'ambiguous catalog match' }],
      },
    },
    sourceContext: {
      missingFields: ['lineItems[0].catalogItemId'],
      catalogResolution: {
        0: [
          { id: 'cat-a', name: 'Flush valve (standard)', unitPriceCents: 4500, score: 0.7 },
          { id: 'cat-b', name: 'Flush valve (premium)', unitPriceCents: 8200, score: 0.6 },
        ],
      },
    },
    ...overrides,
  } as Proposal;
}

describe('U2 — resolveProposalLine', () => {
  let repo: InMemoryProposalRepository;
  let auditRepo: InMemoryAuditRepository;

  beforeEach(() => {
    repo = new InMemoryProposalRepository();
    auditRepo = new InMemoryAuditRepository();
  });

  const call = (catalogItemId: string, lineIndex = 0, actorRole: 'owner' | 'technician' = 'owner') =>
    resolveProposalLine(
      { tenantId: TENANT, proposalId: PROPOSAL, lineIndex, catalogItemId, actorId: OWNER, actorRole },
      { proposalRepo: repo, auditRepo },
    );

  it('stamps the chosen catalog price, clears missingFields, moves to ready_for_review (never approves)', async () => {
    await repo.create(ambiguousProposal());

    const result = await call('cat-b');

    expect(result.status).toBe('ready_for_review'); // NOT 'approved' — D-004
    const line = (result.payload.lineItems as Array<Record<string, unknown>>)[0];
    expect(line.unitPrice).toBe(8200);
    expect(line.pricingSource).toBe('catalog');
    expect(line.catalogItemId).toBe('cat-b');
    expect(line.needsPricing).toBe(false);
    const ctx = result.sourceContext as Record<string, unknown>;
    expect(ctx.missingFields).toEqual([]);
    expect((ctx.catalogResolution as Record<string, unknown>)['0']).toBeUndefined();
    // The resolved line's confidence marker is dropped.
    const meta = result.payload._meta as Record<string, unknown>;
    expect(meta.markers).toEqual([]);

    const audits = await auditRepo.findByEntity(TENANT, 'proposal', PROPOSAL);
    expect(audits.some((a) => a.eventType === 'proposal.line_resolved')).toBe(true);
  });

  it('rejects a catalogItemId that is not one of the line candidates (grounding invariant)', async () => {
    await repo.create(ambiguousProposal());
    await expect(call('cat-not-a-candidate')).rejects.toBeInstanceOf(ValidationError);
    // Untouched — still draft, still ambiguous.
    const after = await repo.findById(TENANT, PROPOSAL);
    expect(after?.status).toBe('draft');
  });

  it('a money proposal stops at ready_for_review after resolving its last line — never approved', async () => {
    await repo.create(
      ambiguousProposal({
        proposalType: 'draft_invoice',
        payload: {
          lineItems: [
            {
              id: 'l1',
              description: 'flush valve',
              quantity: 2,
              unitPriceCents: 0,
              totalCents: 0,
              pricingSource: 'ambiguous',
              needsPricing: true,
            },
          ],
          _meta: { overallConfidence: 'low' },
        },
      }),
    );

    const result = await call('cat-a');

    expect(result.status).toBe('ready_for_review');
    const line = (result.payload.lineItems as Array<Record<string, unknown>>)[0];
    expect(line.unitPriceCents).toBe(4500);
    expect(line.totalCents).toBe(9000); // recomputed from qty 2
  });

  it('stamps unitPriceCents (not unitPrice) for a price-less invoice ambiguous line', async () => {
    // The LLM left this invoice line price-less, so it has NEITHER price field.
    // The resolver must pick the invoice contract's field (unitPriceCents) from
    // the proposal type, not default to the estimate field — else the executor
    // never sees the price.
    await repo.create(
      ambiguousProposal({
        proposalType: 'draft_invoice',
        payload: {
          lineItems: [
            { id: 'l1', description: 'flush valve', quantity: 2, pricingSource: 'ambiguous', needsPricing: true },
          ],
          _meta: { overallConfidence: 'low' },
        },
      }),
    );

    const result = await call('cat-a');

    const line = (result.payload.lineItems as Array<Record<string, unknown>>)[0];
    expect(line.unitPriceCents).toBe(4500);
    expect(line.unitPrice).toBeUndefined();
    expect(line.totalCents).toBe(9000); // qty 2
  });

  it('leaves the proposal in draft when other ambiguous lines remain', async () => {
    await repo.create(
      ambiguousProposal({
        payload: {
          lineItems: [
            { id: 'l1', description: 'a', quantity: 1, unitPrice: 0, pricingSource: 'ambiguous' },
            { id: 'l2', description: 'b', quantity: 1, unitPrice: 0, pricingSource: 'ambiguous' },
          ],
        },
        sourceContext: {
          missingFields: ['lineItems[0].catalogItemId', 'lineItems[1].catalogItemId'],
          catalogResolution: {
            0: [{ id: 'cat-a', name: 'A', unitPriceCents: 4500, score: 0.7 }],
            1: [{ id: 'cat-c', name: 'C', unitPriceCents: 3000, score: 0.7 }],
          },
        },
      }),
    );

    const result = await call('cat-a', 0);

    expect(result.status).toBe('draft'); // line 1 still ambiguous
    const ctx = result.sourceContext as Record<string, unknown>;
    expect(ctx.missingFields).toEqual(['lineItems[1].catalogItemId']);
  });

  it('404s a missing proposal and 400s an out-of-range line index', async () => {
    await expect(call('cat-a')).rejects.toBeInstanceOf(NotFoundError);
    await repo.create(ambiguousProposal());
    await expect(call('cat-a', 5)).rejects.toBeInstanceOf(ValidationError);
  });

  it('forbids a role without proposals:approve', async () => {
    await repo.create(ambiguousProposal());
    await expect(call('cat-a', 0, 'technician')).rejects.toBeInstanceOf(ForbiddenError);
  });
});
