import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { getSharedTestDb, createTestTenant, closeSharedTestDb } from './shared';
import { PgProposalRepository } from '../../src/proposals/pg-proposal';
import { PgAuditRepository } from '../../src/audit/pg-audit';
import { createProposal } from '../../src/proposals/proposal';
import { resolveProposalLine } from '../../src/proposals/resolve-line';

/**
 * U2 integration — pins resolveProposalLine against real Postgres: the jsonb
 * payload + sourceContext round-trip and the draft → ready_for_review
 * transition (never approved). A mocked Pool can't prove the jsonb merge
 * survives the column.
 */
describe('Postgres integration — resolve ambiguous catalog line (U2)', () => {
  let pool: Pool;
  let tenant: { tenantId: string; userId: string };
  let proposalRepo: PgProposalRepository;
  let auditRepo: PgAuditRepository;
  const proposalId = crypto.randomUUID();

  beforeAll(async () => {
    pool = await getSharedTestDb();
    tenant = await createTestTenant(pool);
    proposalRepo = new PgProposalRepository(pool);
    auditRepo = new PgAuditRepository(pool);

    const draft = createProposal({
      tenantId: tenant.tenantId,
      proposalType: 'draft_estimate',
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
      summary: 'Estimate with an ambiguous line',
      createdBy: tenant.userId,
      missingFields: ['lineItems[0].catalogItemId'],
      sourceContext: {
        catalogResolution: {
          0: [
            { id: 'cat-a', name: 'Flush valve (standard)', unitPriceCents: 4500, score: 0.7 },
            { id: 'cat-b', name: 'Flush valve (premium)', unitPriceCents: 8200, score: 0.6 },
          ],
        },
      },
    });
    await proposalRepo.create({ ...draft, id: proposalId, status: 'draft' });
  });

  afterAll(async () => {
    await closeSharedTestDb();
  });

  it('stamps the catalog price into jsonb, clears missingFields, and moves to ready_for_review', async () => {
    const result = await resolveProposalLine(
      {
        tenantId: tenant.tenantId,
        proposalId,
        lineIndex: 0,
        catalogItemId: 'cat-b',
        actorId: tenant.userId,
        actorRole: 'owner',
      },
      { proposalRepo, auditRepo },
    );

    expect(result.status).toBe('ready_for_review'); // never 'approved'

    // Re-read from Postgres to prove the jsonb merge persisted.
    const stored = await proposalRepo.findById(tenant.tenantId, proposalId);
    expect(stored?.status).toBe('ready_for_review');
    const line = (stored!.payload.lineItems as Array<Record<string, unknown>>)[0];
    expect(line.unitPrice).toBe(8200);
    expect(line.pricingSource).toBe('catalog');
    expect(line.catalogItemId).toBe('cat-b');
    const ctx = stored!.sourceContext as Record<string, unknown>;
    expect(ctx.missingFields).toEqual([]);
    expect((ctx.catalogResolution as Record<string, unknown>)['0']).toBeUndefined();

    const audits = await auditRepo.findByEntity(tenant.tenantId, 'proposal', proposalId);
    expect(audits.some((a) => a.eventType === 'proposal.line_resolved')).toBe(true);
  });
});

/**
 * B3 integration — the editActions counterpart: an update_invoice proposal
 * (editActions, not lineItems) round-trips through real Postgres jsonb the
 * same way. Pins that `sourceContext.catalogResolution` + `missingFields`
 * (both keyed by edit-action index / path) and the stamped `unitPrice` +
 * `unitPriceCents` (both fields, per the edit-action price-field doctrine)
 * survive the jsonb column, and the proposal moves draft → ready_for_review
 * (never approved) once the editAction gate clears.
 */
describe('Postgres integration — resolve ambiguous editAction line (B3)', () => {
  let pool: Pool;
  let tenant: { tenantId: string; userId: string };
  let proposalRepo: PgProposalRepository;
  let auditRepo: PgAuditRepository;
  const proposalId = crypto.randomUUID();

  beforeAll(async () => {
    pool = await getSharedTestDb();
    tenant = await createTestTenant(pool);
    proposalRepo = new PgProposalRepository(pool);
    auditRepo = new PgAuditRepository(pool);

    const draft = createProposal({
      tenantId: tenant.tenantId,
      proposalType: 'update_invoice',
      payload: {
        invoiceId: crypto.randomUUID(),
        editActions: [
          {
            type: 'add_line_item',
            lineItem: {
              description: 'water heater install',
              quantity: 1,
              unitPrice: 7_500,
              unitPriceCents: null,
              pricingSource: 'ambiguous',
              needsPricing: true,
            },
          },
        ],
        _meta: {
          overallConfidence: 'high',
          markers: [
            {
              path: 'editActions[0].lineItem.unitPrice',
              reason: 'price differs from the catalog price for "Water Heater Install"',
            },
          ],
        },
      },
      summary: 'Edit invoice — add a water heater install',
      createdBy: tenant.userId,
      missingFields: ['editActions[0].lineItem.catalogItemId'],
      sourceContext: {
        catalogResolution: {
          0: [
            { id: 'cat-heater', name: 'Water Heater Install', unitPriceCents: 15_000, score: 1, category: 'labor' },
            { id: 'spoken:0', name: 'Keep spoken price', unitPriceCents: 7_500, score: 0 },
          ],
        },
      },
    });
    await proposalRepo.create({ ...draft, id: proposalId, status: 'draft' });
  });

  afterAll(async () => {
    await closeSharedTestDb();
  });

  it('stamps BOTH price fields + catalogItemId into jsonb, clears the editAction gate, and moves to ready_for_review', async () => {
    const result = await resolveProposalLine(
      {
        tenantId: tenant.tenantId,
        proposalId,
        lineIndex: 0,
        catalogItemId: 'cat-heater',
        actorId: tenant.userId,
        actorRole: 'owner',
      },
      { proposalRepo, auditRepo },
    );

    expect(result.status).toBe('ready_for_review'); // never 'approved'

    // Re-read from Postgres to prove the jsonb merge persisted.
    const stored = await proposalRepo.findById(tenant.tenantId, proposalId);
    expect(stored?.status).toBe('ready_for_review');
    const line = (stored!.payload.editActions as Array<Record<string, unknown>>)[0]
      .lineItem as Record<string, unknown>;
    expect(line.unitPrice).toBe(15_000);
    expect(line.unitPriceCents).toBe(15_000);
    expect(line.pricingSource).toBe('catalog');
    expect(line.catalogItemId).toBe('cat-heater');
    const ctx = stored!.sourceContext as Record<string, unknown>;
    expect(ctx.missingFields).toEqual([]);
    expect((ctx.catalogResolution as Record<string, unknown>)['0']).toBeUndefined();

    const audits = await auditRepo.findByEntity(tenant.tenantId, 'proposal', proposalId);
    const resolved = audits.find((a) => a.eventType === 'proposal.line_resolved');
    expect(resolved).toBeDefined();
    expect(resolved?.metadata?.target).toBe('editAction');
  });
});
