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

  it('stamps the chosen candidate’s category onto the line when the candidate carries one', async () => {
    await repo.create(
      ambiguousProposal({
        payload: {
          lineItems: [
            {
              id: 'l1',
              description: 'flush valve',
              quantity: 1,
              unitPrice: 0,
              category: 'labor', // wrong default the LLM/draft stamped
              pricingSource: 'ambiguous',
              needsPricing: true,
            },
          ],
        },
        sourceContext: {
          missingFields: ['lineItems[0].catalogItemId'],
          catalogResolution: {
            0: [
              {
                id: 'cat-a',
                name: 'Flush valve (standard)',
                unitPriceCents: 4500,
                score: 0.7,
                category: 'material',
              },
              {
                id: 'cat-b',
                name: 'Flush valve (premium)',
                unitPriceCents: 8200,
                score: 0.6,
                category: 'material',
              },
            ],
          },
        },
      }),
    );

    const result = await call('cat-b');

    const line = (result.payload.lineItems as Array<Record<string, unknown>>)[0];
    expect(line.category).toBe('material');
  });

  it('leaves line.category untouched when the chosen candidate is a legacy record with no category (pre-fix proposals)', async () => {
    await repo.create(
      ambiguousProposal({
        payload: {
          lineItems: [
            {
              id: 'l1',
              description: 'flush valve',
              quantity: 1,
              unitPrice: 0,
              category: 'material', // set before this fix shipped
              pricingSource: 'ambiguous',
              needsPricing: true,
            },
          ],
        },
        // No `category` field on the candidates — mirrors a proposal
        // persisted before this fix, which recorded candidates without it.
      }),
    );

    const result = await call('cat-b');

    const line = (result.payload.lineItems as Array<Record<string, unknown>>)[0];
    expect(line.category).toBe('material'); // untouched, not clobbered to undefined
    expect(line.pricingSource).toBe('catalog'); // resolution still proceeds normally
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

function conflictProposal(overrides: Partial<Proposal> = {}): Proposal {
  return {
    id: PROPOSAL,
    tenantId: TENANT,
    proposalType: 'draft_invoice',
    status: 'draft',
    summary: 'Invoice with a "did you mean" price conflict line',
    createdBy: 'voice',
    createdAt: new Date(),
    updatedAt: new Date(),
    payload: {
      lineItems: [
        {
          id: 'l1',
          description: 'Water Heater Install',
          quantity: 1,
          unitPriceCents: 7_500,
          totalCents: 7_500,
          pricingSource: 'ambiguous',
          needsPricing: true,
        },
      ],
      _meta: {
        overallConfidence: 'low',
        markers: [{ path: 'lineItems[0].unitPriceCents', reason: 'price conflict' }],
      },
    },
    sourceContext: {
      missingFields: ['lineItems[0].catalogItemId'],
      catalogResolution: {
        0: [
          { id: 'cat-heater', name: 'Water Heater Install', unitPriceCents: 15_000, score: 1 },
          { id: 'spoken:0', name: 'Keep spoken price', unitPriceCents: 7_500, score: 0 },
        ],
      },
    },
    ...overrides,
  } as Proposal;
}

describe('U2 — resolveProposalLine — price-conflict "did you mean"', () => {
  let repo: InMemoryProposalRepository;
  let auditRepo: InMemoryAuditRepository;

  beforeEach(() => {
    repo = new InMemoryProposalRepository();
    auditRepo = new InMemoryAuditRepository();
  });

  const call = (catalogItemId: string) =>
    resolveProposalLine(
      { tenantId: TENANT, proposalId: PROPOSAL, lineIndex: 0, catalogItemId, actorId: OWNER, actorRole: 'owner' },
      { proposalRepo: repo, auditRepo },
    );

  it('picking the real catalog candidate on a conflict line behaves exactly like ordinary ambiguous resolution', async () => {
    await repo.create(conflictProposal());

    const result = await call('cat-heater');

    expect(result.status).toBe('ready_for_review');
    const line = (result.payload.lineItems as Array<Record<string, unknown>>)[0];
    expect(line.unitPriceCents).toBe(15_000);
    expect(line.catalogItemId).toBe('cat-heater');
    expect(line.pricingSource).toBe('catalog');
    expect(line.description).toBe('Water Heater Install');
    expect(line.totalCents).toBe(15_000); // qty 1
  });

  it('picking spoken:0 stamps the spoken price as pricingSource "manual" with NO catalogItemId, keeps the description, recomputes totalCents, and audits priceOverride', async () => {
    await repo.create(conflictProposal());

    const result = await call('spoken:0');

    expect(result.status).toBe('ready_for_review'); // it was the last missing field
    const line = (result.payload.lineItems as Array<Record<string, unknown>>)[0];
    expect(line.unitPriceCents).toBe(7_500); // spoken price, NOT the catalog's 15,000
    expect(line.pricingSource).toBe('manual');
    expect(line.catalogItemId).toBeUndefined(); // must not claim catalog grounding
    expect(line.description).toBe('Water Heater Install'); // original description preserved
    expect(line.needsPricing).toBe(false);
    expect(line.totalCents).toBe(7_500); // recomputed from qty 1

    const ctx = result.sourceContext as Record<string, unknown>;
    expect(ctx.missingFields).toEqual([]);

    const audits = await auditRepo.findByEntity(TENANT, 'proposal', PROPOSAL);
    const resolved = audits.find((a) => a.eventType === 'proposal.line_resolved');
    expect(resolved).toBeDefined();
    expect(resolved?.metadata?.priceOverride).toBe(true);
  });

  it('picking a spoken: id NOT among this line’s recorded candidates is rejected (grounding invariant)', async () => {
    await repo.create(conflictProposal());
    await expect(call('spoken:99')).rejects.toBeInstanceOf(ValidationError);
    const after = await repo.findById(TENANT, PROPOSAL);
    expect(after?.status).toBe('draft'); // untouched
  });

  it('picking spoken:0 does NOT alter the line’s category, even when the real catalog candidate carries one', async () => {
    await repo.create(
      conflictProposal({
        payload: {
          lineItems: [
            {
              id: 'l1',
              description: 'Water Heater Install',
              quantity: 1,
              unitPriceCents: 7_500,
              totalCents: 7_500,
              category: 'labor', // the line's own (pre-resolution) category
              pricingSource: 'ambiguous',
              needsPricing: true,
            },
          ],
          _meta: { overallConfidence: 'low' },
        },
        sourceContext: {
          missingFields: ['lineItems[0].catalogItemId'],
          catalogResolution: {
            0: [
              {
                id: 'cat-heater',
                name: 'Water Heater Install',
                unitPriceCents: 15_000,
                score: 1,
                category: 'material', // the catalog item's category — must NOT leak in
              },
              { id: 'spoken:0', name: 'Keep spoken price', unitPriceCents: 7_500, score: 0 },
            ],
          },
        },
      }),
    );

    const result = await call('spoken:0');

    const line = (result.payload.lineItems as Array<Record<string, unknown>>)[0];
    expect(line.pricingSource).toBe('manual');
    expect(line.category).toBe('labor'); // unchanged — the spoken carve-out has no catalog identity
  });

  it('the ordinary catalog resolution path does NOT stamp priceOverride in the audit', async () => {
    await repo.create(conflictProposal());
    await call('cat-heater');
    const audits = await auditRepo.findByEntity(TENANT, 'proposal', PROPOSAL);
    const resolved = audits.find((a) => a.eventType === 'proposal.line_resolved');
    expect(resolved?.metadata?.priceOverride).toBeUndefined();
  });
});

// B3 — the editActions counterpart. update_invoice / update_estimate
// proposals carry `payload.editActions`, not `payload.lineItems`; the
// grounding module (ai/resolution/edit-action-grounding.ts) records
// candidates under the SAME sourceContext.catalogResolution map and a
// `editActions[i].lineItem.catalogItemId` missingFields entry. Same route,
// same request body {lineIndex, catalogItemId} — resolveProposalLine
// branches on Array.isArray(payload.editActions).
function editActionProposal(overrides: Partial<Proposal> = {}): Proposal {
  return {
    id: PROPOSAL,
    tenantId: TENANT,
    proposalType: 'update_invoice',
    status: 'draft',
    summary: 'Edit invoice INV-0042 — add a water heater install',
    createdBy: 'voice',
    createdAt: new Date(),
    updatedAt: new Date(),
    payload: {
      invoiceId: '00000000-0000-4000-8000-000000000042',
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
        markers: [{ path: 'editActions[0].lineItem.unitPrice', reason: 'price conflict' }],
      },
    },
    sourceContext: {
      missingFields: ['editActions[0].lineItem.catalogItemId'],
      catalogResolution: {
        0: [
          {
            id: 'cat-heater',
            name: 'Water Heater Install',
            unitPriceCents: 15_000,
            score: 1,
            category: 'labor',
          },
          { id: 'spoken:0', name: 'Keep spoken price', unitPriceCents: 7_500, score: 0 },
        ],
      },
    },
    ...overrides,
  } as Proposal;
}

describe('B3 — resolveProposalLine — editActions branch', () => {
  let repo: InMemoryProposalRepository;
  let auditRepo: InMemoryAuditRepository;

  beforeEach(() => {
    repo = new InMemoryProposalRepository();
    auditRepo = new InMemoryAuditRepository();
  });

  const call = (catalogItemId: string, lineIndex = 0) =>
    resolveProposalLine(
      { tenantId: TENANT, proposalId: PROPOSAL, lineIndex, catalogItemId, actorId: OWNER, actorRole: 'owner' },
      { proposalRepo: repo, auditRepo },
    );

  it('picks the catalog candidate: stamps unitPrice + unitPriceCents (BOTH) + catalogItemId, clears the gate, moves to ready_for_review', async () => {
    await repo.create(editActionProposal());

    const result = await call('cat-heater');

    expect(result.status).toBe('ready_for_review'); // NOT 'approved' — D-004
    const line = (result.payload.editActions as Array<Record<string, unknown>>)[0]
      .lineItem as Record<string, unknown>;
    // Edit-action lines carry BOTH price fields simultaneously (unlike
    // draft lineItems, where only one is the executable field).
    expect(line.unitPrice).toBe(15_000);
    expect(line.unitPriceCents).toBe(15_000);
    expect(line.catalogItemId).toBe('cat-heater');
    expect(line.pricingSource).toBe('catalog');
    expect(line.needsPricing).toBe(false);
    expect(line.quantity).toBe(1);

    const ctx = result.sourceContext as Record<string, unknown>;
    expect(ctx.missingFields).toEqual([]);
    expect((ctx.catalogResolution as Record<string, unknown>)['0']).toBeUndefined();
    // The resolved line's confidence marker is dropped.
    const meta = result.payload._meta as Record<string, unknown>;
    expect(meta.markers).toEqual([]);

    const audits = await auditRepo.findByEntity(TENANT, 'proposal', PROPOSAL);
    const resolved = audits.find((a) => a.eventType === 'proposal.line_resolved');
    expect(resolved).toBeDefined();
    // B3 — editAction resolutions are distinguished from lineItem ones in
    // the audit trail.
    expect(resolved?.metadata?.target).toBe('editAction');
  });

  it('picking spoken:0 keeps the spoken price on BOTH price fields with pricingSource "manual", no catalogItemId, and audits priceOverride', async () => {
    await repo.create(editActionProposal());

    const result = await call('spoken:0');

    expect(result.status).toBe('ready_for_review');
    const line = (result.payload.editActions as Array<Record<string, unknown>>)[0]
      .lineItem as Record<string, unknown>;
    expect(line.unitPrice).toBe(7_500);
    expect(line.unitPriceCents).toBe(7_500); // spoken price, NOT the catalog's 15,000
    expect(line.pricingSource).toBe('manual');
    expect(line.catalogItemId).toBeUndefined();
    expect(line.description).toBe('water heater install'); // original description preserved
    expect(line.needsPricing).toBe(false);

    const ctx = result.sourceContext as Record<string, unknown>;
    expect(ctx.missingFields).toEqual([]);

    const audits = await auditRepo.findByEntity(TENANT, 'proposal', PROPOSAL);
    const resolved = audits.find((a) => a.eventType === 'proposal.line_resolved');
    expect(resolved).toBeDefined();
    expect(resolved?.metadata?.priceOverride).toBe(true);
    expect(resolved?.metadata?.target).toBe('editAction');
  });

  it('rejects a catalogItemId not among this editAction line’s candidates (grounding invariant)', async () => {
    await repo.create(editActionProposal());
    await expect(call('cat-not-a-candidate')).rejects.toBeInstanceOf(ValidationError);
    const after = await repo.findById(TENANT, PROPOSAL);
    expect(after?.status).toBe('draft'); // untouched
  });

  it('the invoiceId gate (B2) is independent: resolving the editAction line leaves it, and the proposal stays draft until both clear', async () => {
    await repo.create(
      editActionProposal({
        sourceContext: {
          missingFields: ['invoiceId', 'editActions[0].lineItem.catalogItemId'],
          catalogResolution: {
            0: [
              {
                id: 'cat-heater',
                name: 'Water Heater Install',
                unitPriceCents: 15_000,
                score: 1,
                category: 'labor',
              },
              { id: 'spoken:0', name: 'Keep spoken price', unitPriceCents: 7_500, score: 0 },
            ],
          },
        },
      }),
    );

    const result = await call('cat-heater');

    // The editAction gate cleared, but invoiceId (a disjoint entry, owned
    // by resolve-entity.ts) did not — the proposal stays in draft.
    expect(result.status).toBe('draft');
    const ctx = result.sourceContext as Record<string, unknown>;
    expect(ctx.missingFields).toEqual(['invoiceId']);
    const line = (result.payload.editActions as Array<Record<string, unknown>>)[0]
      .lineItem as Record<string, unknown>;
    expect(line.pricingSource).toBe('catalog'); // the editAction itself IS resolved
  });

  it('defaults an omitted/invalid quantity to 1 on resolution', async () => {
    await repo.create(
      editActionProposal({
        payload: {
          invoiceId: '00000000-0000-4000-8000-000000000042',
          editActions: [
            {
              type: 'add_line_item',
              lineItem: {
                description: 'water heater install',
                unitPrice: 7_500,
                unitPriceCents: null,
                pricingSource: 'ambiguous',
                needsPricing: true,
                // no quantity field — mirrors an LLM-omitted "add a trip fee".
              },
            },
          ],
        },
      }),
    );

    const result = await call('cat-heater');

    const line = (result.payload.editActions as Array<Record<string, unknown>>)[0]
      .lineItem as Record<string, unknown>;
    expect(line.quantity).toBe(1);
  });

  it('404s a missing proposal and 400s an out-of-range editAction index', async () => {
    await expect(call('cat-heater')).rejects.toBeInstanceOf(NotFoundError);
    await repo.create(editActionProposal());
    await expect(call('cat-heater', 5)).rejects.toBeInstanceOf(ValidationError);
  });

  it('forbids a role without proposals:approve', async () => {
    await repo.create(editActionProposal());
    await expect(
      resolveProposalLine(
        {
          tenantId: TENANT,
          proposalId: PROPOSAL,
          lineIndex: 0,
          catalogItemId: 'cat-heater',
          actorId: OWNER,
          actorRole: 'technician',
        },
        { proposalRepo: repo, auditRepo },
      ),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });
});
