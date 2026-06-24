import { describe, it, expect } from 'vitest';
import {
  isPricedDraftType,
  recomputePricedProposalOnEdit,
} from '../../src/ai/tasks/recompute-priced-proposal';
import { InMemoryCatalogItemRepository } from '../../src/catalog/catalog-item';
import { editProposal } from '../../src/proposals/actions';
import { InMemoryProposalRepository, createProposal } from '../../src/proposals/proposal';
import { InMemoryAuditRepository } from '../../src/audit/audit';
import { UNCATALOGUED_CONFIDENCE_CAP } from '../../src/ai/resolution/catalog-resolver';

import { describe, it, expect } from 'vitest';
import { randomUUID } from 'crypto';
import {
  isPricedDraftType,
  recomputePricedProposalOnEdit,
} from '../../src/ai/tasks/recompute-priced-proposal';
import { InMemoryCatalogItemRepository } from '../../src/catalog/catalog-item';
import { editProposal } from '../../src/proposals/actions';
import { InMemoryProposalRepository, createProposal } from '../../src/proposals/proposal';
import { InMemoryAuditRepository } from '../../src/audit/audit';
import { UNCATALOGUED_CONFIDENCE_CAP } from '../../src/ai/resolution/catalog-resolver';

describe('editProposal recompute — priced drafts', () => {
  it('drops confidence below auto-approve floor when a line becomes uncatalogued', async () => {
    const tenantId = 'tenant-1';
    const catalogRepo = new InMemoryCatalogItemRepository();
    const now = new Date().toISOString();
    await catalogRepo.create({
      id: randomUUID(),
      tenantId,
      name: 'Standard Service Call',
      description: 'Service call',
      category: 'Labor',
      unit: 'each',
      unitPriceCents: 12_500,
      productServiceType: 'service',
      archivedAt: null,
      createdAt: now,
      updatedAt: now,
    });

    const proposalRepo = new InMemoryProposalItemRepositoryFix();
    const created = createProposal({
      tenantId,
      proposalType: 'draft_estimate',
      payload: {
        customerId: '00000000-0000-4000-8000-000000000001',
        lineItems: [
          {
            description: 'Standard Service Call',
            quantity: 1,
            unitPrice: 12_500,
            pricingSource: 'catalog',
          },
        ],
        _meta: { overallConfidence: 'high' },
      },
      summary: 'Estimate',
      confidenceScore: 0.95,
      createdBy: 'u1',
    });
    await proposalRepo.create(created);

    const { proposal: updated } = await editProposal(
      proposalRepo,
      tenantId,
      created.id,
      'owner-1',
      'owner',
      {
        lineItems: [
          {
            description: 'Totally custom one-off widget',
            quantity: 1,
            unitPrice: 99_999,
          },
        ],
      },
      new InMemoryAuditRepository(),
      undefined,
      catalogRepo,
    );

    expect(updated.confidenceScore).toBeLessThanOrEqual(UNCATALOGUED_CONFIDENCE_CAP);
    expect(updated.confidenceScore).toBeLessThan(0.9);
  });

  it('is a no-op for non-priced proposal types', async () => {
    expect(isPricedDraftType('add_note')).toBe(false);
    const result = await recomputePricedProposalOnEdit(undefined, {
      tenantId: 't1',
      proposalType: 'add_note',
      payload: { message: 'hi' },
      confidenceScore: 0.8,
    });
    expect(result.confidenceScore).toBe(0.8);
  });
});

/** Thin alias — InMemoryProposalRepository under another name for clarity. */
class InMemoryProposalItemRepositoryFix extends InMemoryProposalRepository {}
