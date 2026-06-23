/**
 * U3 — pins the real `proposals.confidence_score` column after an edit.
 *
 * The unit test (test/proposals/edit-proposal-recompute.test.ts) proves the
 * recompute logic with in-memory repos. This integration test proves the
 * recomputed confidence actually PERSISTS through Postgres: editing a
 * catalog-grounded draft_estimate into an uncatalogued line must drop the
 * stored confidence below the 0.9 auto-approve floor (per CLAUDE.md, a
 * mocked-DB test is not sufficient proof a column round-trips).
 */
import { describe, it, expect, afterAll } from 'vitest';
import { randomUUID } from 'crypto';
import { getSharedTestDb, closeSharedTestDb, createTestTenant } from './shared';
import { PgProposalRepository } from '../../src/proposals/pg-proposal';
import { PgCatalogItemRepository } from '../../src/catalog/pg-catalog-item';
import { createProposal } from '../../src/proposals/proposal';
import { createCatalogItem } from '../../src/catalog/catalog-item';
import { editProposal } from '../../src/proposals/actions';

describe('U3 — edit recompute persists confidence (pg)', () => {
  afterAll(async () => {
    await closeSharedTestDb();
  });

  it('drops persisted confidence below 0.9 when edited to an uncatalogued line', async () => {
    const pool = await getSharedTestDb();
    const { tenantId, userId } = await createTestTenant(pool);
    const proposalRepo = new PgProposalRepository(pool);
    const catalogRepo = new PgCatalogItemRepository(pool);

    await catalogRepo.create(
      createCatalogItem({
        tenantId,
        name: 'Diagnostic Fee',
        category: 'Labor',
        unit: 'each',
        unitPriceCents: 9900,
      }),
    );

    const proposal = createProposal({
      tenantId,
      proposalType: 'draft_estimate',
      payload: {
        customerId: randomUUID(),
        lineItems: [
          { description: 'Diagnostic Fee', quantity: 1, unitPrice: 9900, pricingSource: 'catalog' },
        ],
      },
      summary: 'Estimate',
      createdBy: userId,
      confidenceScore: 0.95,
      confidenceFactors: ['catalog_priced'],
    });
    await proposalRepo.create(proposal);

    await editProposal(
      proposalRepo,
      tenantId,
      proposal.id,
      userId,
      'owner',
      { lineItems: [{ description: 'Custom unicorn service', quantity: 1, unitPrice: 50000 }] },
      undefined,
      undefined,
      catalogRepo,
    );

    // Re-read straight from Postgres — proves the column persisted, not memory.
    const reloaded = await proposalRepo.findById(tenantId, proposal.id);
    expect(reloaded).not.toBeNull();
    expect(reloaded!.confidenceScore).toBeLessThanOrEqual(0.85);
    const li = (reloaded!.payload.lineItems as Array<Record<string, unknown>>)[0];
    expect(li.pricingSource).toBe('uncatalogued');
  });
});
