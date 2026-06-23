import { describe, it, expect } from 'vitest';
import { randomUUID } from 'crypto';
import {
  createProposal,
  InMemoryProposalRepository,
} from '../../src/proposals/proposal';
import { editProposal } from '../../src/proposals/actions';
import {
  InMemoryCatalogItemRepository,
  createCatalogItem,
  type CatalogItem,
} from '../../src/catalog/catalog-item';
import {
  recomputePricedProposalOnEdit,
  isPricedDraftType,
} from '../../src/ai/tasks/recompute-priced-proposal';
import { getConfidenceLevel } from '../../src/ai/guardrails/confidence';

// U3 — editing a priced draft must re-ground line items against the catalog
// and recompute confidence/`_meta` so a human edit can never leave stale
// auto-approve eligibility on an un-grounded price.

const TENANT = 'tenant-1';

function catalog(name: string, unitPriceCents: number): CatalogItem {
  return createCatalogItem({
    tenantId: TENANT,
    name,
    category: 'Labor',
    unit: 'each',
    unitPriceCents,
  });
}

describe('recomputePricedProposalOnEdit (pure helper)', () => {
  it('caps confidence at 0.85 when an edit introduces an uncatalogued line', () => {
    const result = recomputePricedProposalOnEdit({
      proposalType: 'draft_estimate',
      payload: {
        customerId: randomUUID(),
        lineItems: [{ description: 'Custom unicorn service', quantity: 1, unitPrice: 50000 }],
      },
      catalogItems: [catalog('Diagnostic Fee', 9900)],
      currentConfidenceScore: 0.95,
      currentConfidenceFactors: ['catalog_priced'],
    });

    expect(result.confidenceScore).toBeLessThanOrEqual(0.85);
    expect(result.confidenceFactors).toContain('uncatalogued_line_item');
    expect(result.confidenceFactors).not.toContain('catalog_priced');
    const li = (result.payload.lineItems as Array<Record<string, unknown>>)[0];
    expect(li.pricingSource).toBe('uncatalogued');
    expect((result.payload._meta as { overallConfidence: string }).overallConfidence).toBe(
      getConfidenceLevel(result.confidenceScore),
    );
  });

  it('keeps confidence and grounds price when an edit matches the catalog', () => {
    const result = recomputePricedProposalOnEdit({
      proposalType: 'draft_estimate',
      payload: {
        customerId: randomUUID(),
        lineItems: [{ description: 'Diagnostic Fee', quantity: 2, unitPrice: 100 }],
      },
      catalogItems: [catalog('Diagnostic Fee', 9900)],
      currentConfidenceScore: 0.95,
      currentConfidenceFactors: [],
    });

    expect(result.confidenceScore).toBe(0.95); // never raised, not lowered
    const li = (result.payload.lineItems as Array<Record<string, unknown>>)[0];
    expect(li.pricingSource).toBe('catalog');
    expect(li.unitPrice).toBe(9900); // catalog price is authoritative
    expect(result.confidenceFactors).toContain('catalog_priced');
  });

  it('is a no-op (score unchanged) for a non-priced proposal type', () => {
    expect(isPricedDraftType('add_note')).toBe(false);
    const result = recomputePricedProposalOnEdit({
      proposalType: 'add_note',
      payload: { body: 'hello' },
      catalogItems: [catalog('Diagnostic Fee', 9900)],
      currentConfidenceScore: 0.91,
    });
    expect(result.confidenceScore).toBe(0.91);
    expect(result.payload).toEqual({ body: 'hello' });
  });
});

describe('editProposal — recompute on edit', () => {
  async function seed() {
    const proposalRepo = new InMemoryProposalRepository();
    const catalogRepo = new InMemoryCatalogItemRepository();
    await catalogRepo.create(catalog('Diagnostic Fee', 9900));
    const proposal = createProposal({
      tenantId: TENANT,
      proposalType: 'draft_estimate',
      payload: {
        customerId: randomUUID(),
        lineItems: [
          { description: 'Diagnostic Fee', quantity: 1, unitPrice: 9900, pricingSource: 'catalog' },
        ],
      },
      summary: 'Estimate',
      createdBy: 'user-1',
      confidenceScore: 0.95,
      confidenceFactors: ['catalog_priced'],
    });
    await proposalRepo.create(proposal);
    return { proposalRepo, catalogRepo, proposal };
  }

  it('drops confidence below the auto-approve floor when edited to uncatalogued', async () => {
    const { proposalRepo, catalogRepo, proposal } = await seed();

    const { proposal: updated } = await editProposal(
      proposalRepo,
      TENANT,
      proposal.id,
      'user-1',
      'owner',
      { lineItems: [{ description: 'Custom unicorn service', quantity: 1, unitPrice: 50000 }] },
      undefined,
      undefined,
      catalogRepo,
    );

    expect(updated.confidenceScore).toBeLessThanOrEqual(0.85);
    const li = (updated.payload.lineItems as Array<Record<string, unknown>>)[0];
    expect(li.pricingSource).toBe('uncatalogued');
    expect((updated.payload._meta as { overallConfidence: string }).overallConfidence).toBe(
      getConfidenceLevel(updated.confidenceScore!),
    );
  });

  it('preserves prior behavior (no recompute) when no catalog repo is supplied', async () => {
    const { proposalRepo, proposal } = await seed();

    const { proposal: updated } = await editProposal(
      proposalRepo,
      TENANT,
      proposal.id,
      'user-1',
      'owner',
      { lineItems: [{ description: 'Custom unicorn service', quantity: 1, unitPrice: 50000 }] },
      // no auditRepo, no correctionRepo, no catalogRepo
    );

    // Confidence untouched (the documented gap) when the recompute is not wired.
    expect(updated.confidenceScore).toBe(0.95);
  });
});

describe('recomputePricedProposalOnEdit — invoice per-line totals (integer cents)', () => {
  it('recomputes totalCents off the catalog price when an invoice line quantity is edited', () => {
    const result = recomputePricedProposalOnEdit({
      proposalType: 'draft_invoice',
      payload: {
        customerId: randomUUID(),
        jobId: randomUUID(),
        // Quantity bumped to 4 but totalCents left at the pre-edit value — the
        // edit path has no normalization step, so the helper must resync it.
        lineItems: [
          { description: 'Diagnostic Fee', quantity: 4, unitPriceCents: 9900, totalCents: 9900 },
        ],
      },
      catalogItems: [catalog('Diagnostic Fee', 9900)],
      currentConfidenceScore: 0.95,
      currentConfidenceFactors: ['catalog_priced'],
    });

    const li = (result.payload.lineItems as Array<Record<string, unknown>>)[0];
    expect(li.unitPriceCents).toBe(9900);
    expect(li.totalCents).toBe(39_600); // 4 × 9900, integer cents
    expect(li.pricingSource).toBe('catalog');
    expect(result.confidenceScore).toBe(0.95);
  });

  it('keeps totalCents consistent for an uncatalogued line off the edited price (and caps confidence)', () => {
    const result = recomputePricedProposalOnEdit({
      proposalType: 'draft_invoice',
      payload: {
        customerId: randomUUID(),
        jobId: randomUUID(),
        lineItems: [
          { description: 'Custom fabrication', quantity: 3, unitPriceCents: 12_345, totalCents: 0 },
        ],
      },
      catalogItems: [catalog('Diagnostic Fee', 9900)],
      currentConfidenceScore: 0.95,
      currentConfidenceFactors: [],
    });

    const li = (result.payload.lineItems as Array<Record<string, unknown>>)[0];
    expect(li.pricingSource).toBe('uncatalogued');
    expect(li.totalCents).toBe(37_035); // 3 × 12345 — stale 0 corrected
    expect(result.confidenceScore).toBeLessThanOrEqual(0.85);
    expect(result.confidenceFactors).toContain('uncatalogued_line_item');
  });
});
