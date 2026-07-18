/**
 * P22-001 — invoice-edit-catalog integration tests.
 *
 * InvoiceEditTaskHandler (and InvoiceTaskHandler) with a tenant catalog
 * wired: catalog prices ALWAYS overwrite LLM-guessed prices for
 * resolved items; ambiguous items stay unresolved with
 * needsPricing: true; empty catalog degrades to free-text behavior.
 */
import { describe, it, expect, vi } from 'vitest';
import { InvoiceEditTaskHandler } from '../../../src/ai/tasks/invoice-edit-task';
import { InvoiceTaskHandler } from '../../../src/ai/tasks/invoice-task';
import { LLMGateway, LLMResponse } from '../../../src/ai/gateway/gateway';
import {
  InMemoryCatalogItemRepository,
  createCatalogItem,
  CatalogItem,
} from '../../../src/catalog/catalog-item';
import { updateInvoicePayloadSchema } from '../../../src/proposals/contracts';
import { UNCATALOGUED_CONFIDENCE_CAP } from '../../../src/ai/resolution/catalog-resolver';
import { InMemoryInvoiceRepository } from '../../../src/invoices/invoice';

const TENANT = 'tenant-1';
const OTHER_TENANT = 'tenant-2';

// Verify-or-gate (2026-07 review): tests that use a UUID invoiceReference to
// keep the invoiceId gate out of the picture must now wire an invoiceRepo the
// UUID actually resolves against (a bare UUID is no longer trusted blind).
async function invoiceRepoWithId(id: string): Promise<InMemoryInvoiceRepository> {
  const repo = new InMemoryInvoiceRepository();
  await repo.create({
    id,
    tenantId: TENANT,
    jobId: 'job-1',
    invoiceNumber: 'INV-0042',
    status: 'draft',
    lineItems: [],
    totals: { subtotalCents: 0, taxCents: 0, totalCents: 0, discountCents: 0 },
    amountPaidCents: 0,
    amountDueCents: 0,
    createdBy: 'u-1',
    createdAt: new Date(),
    updatedAt: new Date(),
  } as never);
  return repo;
}

function mockGateway(jsonContent: string): LLMGateway {
  return {
    complete: vi.fn(async () => ({
      content: jsonContent,
      model: 'mock',
      provider: 'mock',
      tokenUsage: { input: 100, output: 60, total: 160 },
      latencyMs: 10,
    } satisfies LLMResponse)),
  } as unknown as LLMGateway;
}

async function seedCatalog(
  repo: InMemoryCatalogItemRepository,
  tenantId: string,
  entries: Array<{ name: string; unitPriceCents: number }>,
): Promise<CatalogItem[]> {
  const created: CatalogItem[] = [];
  for (const e of entries) {
    created.push(
      await repo.create(
        createCatalogItem({
          tenantId,
          name: e.name,
          category: 'Parts',
          unit: 'each',
          unitPriceCents: e.unitPriceCents,
        }),
      ),
    );
  }
  return created;
}

function editResponse(
  actions: Array<Record<string, unknown>>,
  confidence = 0.9,
  invoiceReference = 'INV-0042',
): string {
  return JSON.stringify({
    invoiceReference,
    editActions: actions,
    confidence_score: confidence,
  });
}

describe('P22-001 invoice-edit-catalog', () => {
  it('snaps a sub-tolerance mishear to the exact catalog price (both price fields)', async () => {
    const repo = new InMemoryCatalogItemRepository();
    const [gasket] = await seedCatalog(repo, TENANT, [{ name: 'Gasket', unitPriceCents: 450 }]);

    const gateway = mockGateway(
      editResponse([
        {
          type: 'add_line_item',
          // 470¢ is within PRICE_CONFLICT_MIN_ABS_CENTS (100¢) of the catalog's
          // 450 — a mishear that SNAPS to the catalog price, not a "did you
          // mean" conflict.
          lineItem: { description: 'gasket', quantity: 3, unitPrice: 470 },
        },
      ]),
    );

    const handler = new InvoiceEditTaskHandler(gateway, { catalogRepo: repo });
    const result = await handler.handle({
      tenantId: TENANT,
      userId: 'u-1',
      message: 'Add three gaskets to INV-0042',
    });

    const payload = result.proposal.payload as { editActions: Array<Record<string, unknown>> };
    const lineItem = payload.editActions[0].lineItem as Record<string, unknown>;
    // Invoice edits execute against `unitPrice` (invoice-editor.ts reads it);
    // `unitPriceCents` is the review mirror. BOTH carry the catalog price.
    expect(lineItem.unitPrice).toBe(450);
    expect(lineItem.unitPriceCents).toBe(450);
    expect(lineItem.catalogItemId).toBe(gasket.id);
    expect(lineItem.pricingSource).toBe('catalog');
    expect(lineItem.needsPricing).toBe(false);
    expect(lineItem.quantity).toBe(3);
    expect(lineItem.description).toBe('Gasket');
  });

  it('surfaces a price conflict (large deviation) instead of silently snapping — keeps the spoken price, flags for review (B3: resolvable, not the sticky low stamp)', async () => {
    const repo = new InMemoryCatalogItemRepository();
    await seedCatalog(repo, TENANT, [{ name: 'Gasket', unitPriceCents: 450 }]);

    const gateway = mockGateway(
      editResponse(
        [
          {
            type: 'add_line_item',
            // $99.99 deviates from the catalog's $4.50 by ≥10% AND ≥$1 — a
            // "did you mean" conflict (maybe a deliberate custom price), not a
            // mishear. The spoken price must NOT be silently overwritten.
            lineItem: { description: 'gasket', quantity: 3, unitPrice: 9999 },
          },
        ],
        0.98,
        // A repo-verified UUID invoiceReference keeps the invoiceId gate (B2)
        // out of the picture — this test is about the editAction gate.
        '00000000-0000-4000-8000-000000000042',
      ),
    );

    const invoiceRepo = await invoiceRepoWithId('00000000-0000-4000-8000-000000000042');
    const handler = new InvoiceEditTaskHandler(gateway, { catalogRepo: repo, invoiceRepo });
    const result = await handler.handle({
      tenantId: TENANT,
      userId: 'u-1',
      message: 'Add three gaskets at $99.99 to INV-0042',
      supervisorPresent: true,
      supervisorMode: 'supervisor',
      tenantThresholdOverride: { supervisor: 0.5 },
    });

    const payload = result.proposal.payload as {
      editActions: Array<Record<string, unknown>>;
      _meta?: { overallConfidence?: string };
    };
    const lineItem = payload.editActions[0].lineItem as Record<string, unknown>;
    // Spoken price KEPT on the executable field; not overwritten to 450.
    expect(lineItem.unitPrice).toBe(9999);
    expect(lineItem.unitPriceCents).toBeNull();
    expect(lineItem.pricingSource).toBe('ambiguous');
    expect(lineItem.needsPricing).toBe(true);
    expect(lineItem.catalogItemId).toBeUndefined();
    // B3 split signal: a price conflict is RESOLVABLE (candidates recorded,
    // missingFields gate) — it must NOT stamp the sticky
    // `_meta.overallConfidence:'low'` (that stamp is never lifted by
    // resolveProposalLine, so it would keep blocking approval even after
    // the operator resolves the line). The LLM's own 0.98 confidence maps
    // to 'high'.
    expect(payload._meta?.overallConfidence).toBe('high');
    expect(result.proposal.confidenceScore).toBe(0.98); // not capped
    // Still gated — missingFields (editAction gate) alone blocks approval.
    expect(result.proposal.status).not.toBe('approved');
    expect(result.proposal.sourceContext).toMatchObject({
      missingFields: ['editActions[0].lineItem.catalogItemId'],
    });
    const sc = result.proposal.sourceContext as Record<string, unknown>;
    expect((sc.catalogResolution as Record<string, unknown>)?.[0]).toBeDefined();
  });

  it('resolves "service call + three gaskets" with catalog prices on both items', async () => {
    const repo = new InMemoryCatalogItemRepository();
    await seedCatalog(repo, TENANT, [
      { name: 'Service Call', unitPriceCents: 12500 },
      { name: 'Gasket', unitPriceCents: 450 },
    ]);

    const gateway = mockGateway(
      editResponse([
        // Both drafted prices are within 100¢ of their catalog match → snap.
        { type: 'add_line_item', lineItem: { description: 'service call', quantity: 1, unitPrice: 12450 } },
        { type: 'add_line_item', lineItem: { description: 'gaskets', quantity: 3, unitPrice: 500 } },
      ]),
    );

    const handler = new InvoiceEditTaskHandler(gateway, { catalogRepo: repo });
    const result = await handler.handle({
      tenantId: TENANT,
      userId: 'u-1',
      message: 'Add a service call and three gaskets to INV-0042',
    });

    const payload = result.proposal.payload as { editActions: Array<Record<string, unknown>> };
    const [a, b] = payload.editActions.map((x) => x.lineItem as Record<string, unknown>);
    expect(a.unitPrice).toBe(12500);
    expect(a.needsPricing).toBe(false);
    expect(b.unitPrice).toBe(450);
    expect(b.quantity).toBe(3);
    expect(b.needsPricing).toBe(false);
  });

  it('flags an ambiguous item ("valve" with 3 valve SKUs) as unresolved with needsPricing: true and unitPriceCents: null', async () => {
    const repo = new InMemoryCatalogItemRepository();
    await seedCatalog(repo, TENANT, [
      { name: 'Ball Valve', unitPriceCents: 3200 },
      { name: 'Gate Valve', unitPriceCents: 4100 },
      { name: 'Check Valve', unitPriceCents: 3900 },
    ]);

    const gateway = mockGateway(
      editResponse([
        { type: 'add_line_item', lineItem: { description: 'valve', quantity: 1, unitPrice: 3500 } },
      ]),
    );

    const handler = new InvoiceEditTaskHandler(gateway, { catalogRepo: repo });
    const result = await handler.handle({
      tenantId: TENANT,
      userId: 'u-1',
      message: 'Add a valve to INV-0042',
    });

    const payload = result.proposal.payload as { editActions: Array<Record<string, unknown>> };
    const lineItem = payload.editActions[0].lineItem as Record<string, unknown>;
    expect(lineItem.needsPricing).toBe(true);
    expect(lineItem.unitPriceCents).toBeNull();
    expect(lineItem.catalogItemId).toBeUndefined();
    // LLM text kept verbatim — never replaced by a guessed catalog name.
    expect(lineItem.description).toBe('valve');
  });

  it('keeps the update_invoice Zod contract valid for resolved and unresolved items', async () => {
    const repo = new InMemoryCatalogItemRepository();
    await seedCatalog(repo, TENANT, [
      { name: 'Gasket', unitPriceCents: 450 },
      { name: 'Ball Valve', unitPriceCents: 3200 },
      { name: 'Gate Valve', unitPriceCents: 4100 },
    ]);

    const gateway = mockGateway(
      editResponse([
        { type: 'add_line_item', lineItem: { description: 'gasket', quantity: 1, unitPrice: 1 } },
        { type: 'add_line_item', lineItem: { description: 'valve', quantity: 1, unitPrice: 3500 } },
      ]),
    );

    const handler = new InvoiceEditTaskHandler(gateway, { catalogRepo: repo });
    const result = await handler.handle({ tenantId: TENANT, userId: 'u-1', message: 'edit' });

    const payload = result.proposal.payload as Record<string, unknown>;
    const parsed = updateInvoicePayloadSchema.safeParse({
      // invoiceReference → invoiceId resolution happens at review time;
      // validate the editActions shape the contract owns.
      invoiceId: '00000000-0000-4000-8000-000000000001',
      editActions: payload.editActions,
    });
    expect(parsed.success).toBe(true);
  });

  it('P1 fix — a description-based remove/update action survives grounding untouched and is contract-valid', async () => {
    const repo = new InMemoryCatalogItemRepository();
    await seedCatalog(repo, TENANT, [{ name: 'Gasket', unitPriceCents: 450 }]);

    const gateway = mockGateway(
      editResponse([
        { type: 'remove_line_item', description: 'plumbing repair' },
        {
          type: 'update_line_item',
          description: 'diagnostic',
          lineItem: { description: 'gasket', quantity: 1, unitPrice: 470 },
        },
      ]),
    );

    const handler = new InvoiceEditTaskHandler(gateway, { catalogRepo: repo });
    const result = await handler.handle({
      tenantId: TENANT,
      userId: 'u-1',
      message: 'Remove the plumbing repair and change the diagnostic to a gasket on INV-0042',
    });

    const payload = result.proposal.payload as { editActions: Array<Record<string, unknown>> };

    // remove_line_item is untouched by grounding (no lineItem to price) —
    // the description passes straight through, no index fabricated.
    expect(payload.editActions[0]).toEqual({ type: 'remove_line_item', description: 'plumbing repair' });

    // update_line_item keeps its description target AND gets its price
    // grounded exactly like an add_line_item would.
    const updateAction = payload.editActions[1] as Record<string, unknown>;
    expect(updateAction.description).toBe('diagnostic');
    expect(updateAction.index).toBeUndefined();
    const updatedLine = updateAction.lineItem as Record<string, unknown>;
    expect(updatedLine.unitPrice).toBe(450); // catalog-snapped
    expect(updatedLine.pricingSource).toBe('catalog');

    // The whole payload validates against the update_invoice Zod contract
    // now that index-or-description is allowed.
    const parsed = updateInvoicePayloadSchema.safeParse({
      invoiceId: '00000000-0000-4000-8000-000000000001',
      editActions: payload.editActions,
    });
    expect(parsed.success).toBe(true);
  });

  it('flags an empty catalog as uncatalogued and hard-blocks auto-approve (VOX-51)', async () => {
    const repo = new InMemoryCatalogItemRepository();
    const gateway = mockGateway(
      editResponse(
        [{ type: 'add_line_item', lineItem: { description: 'trip fee', quantity: 1, unitPrice: 7500 } }],
        0.98,
      ),
    );

    const handler = new InvoiceEditTaskHandler(gateway, { catalogRepo: repo });
    const result = await handler.handle({ tenantId: TENANT, userId: 'u-1', message: 'add a trip fee' });

    const payload = result.proposal.payload as {
      editActions: Array<Record<string, unknown>>;
      _meta?: { overallConfidence?: string };
    };
    const lineItem = payload.editActions[0].lineItem as Record<string, unknown>;
    // Empty catalog is no longer a free-text short-circuit: with nothing to
    // ground against, the LLM price is untrusted.
    expect(lineItem.pricingSource).toBe('uncatalogued');
    expect(lineItem.needsPricing).toBe(true);
    expect(lineItem.unitPriceCents).toBeNull();
    // Executable `unitPrice` stays numeric (update_invoice Zod contract)…
    expect(lineItem.unitPrice).toBe(7500);
    // …but the LLM's 0.98 self-report can never auto-approve.
    expect(payload._meta?.overallConfidence).toBe('low');
    expect(result.proposal.confidenceScore).toBeLessThanOrEqual(UNCATALOGUED_CONFIDENCE_CAP);
    expect(result.proposal.status).not.toBe('approved');

    // No catalog section injected into the prompt (empty catalog).
    const call = (gateway.complete as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.messages[1].content).not.toContain('Service catalog');
  });

  it('is backward compatible when constructed without catalog deps', async () => {
    const gateway = mockGateway(
      editResponse([
        { type: 'add_line_item', lineItem: { description: 'gasket', quantity: 1, unitPrice: 9999 } },
      ]),
    );
    const handler = new InvoiceEditTaskHandler(gateway);
    const result = await handler.handle({ tenantId: TENANT, userId: 'u-1', message: 'edit' });
    const payload = result.proposal.payload as { editActions: Array<Record<string, unknown>> };
    expect((payload.editActions[0].lineItem as Record<string, unknown>).unitPrice).toBe(9999);
  });

  it('enforces tenant isolation — another tenant catalog never prices this tenant items', async () => {
    const repo = new InMemoryCatalogItemRepository();
    await seedCatalog(repo, OTHER_TENANT, [{ name: 'Gasket', unitPriceCents: 450 }]);

    const gateway = mockGateway(
      editResponse([
        { type: 'add_line_item', lineItem: { description: 'gasket', quantity: 1, unitPrice: 9999 } },
      ]),
    );

    const handler = new InvoiceEditTaskHandler(gateway, { catalogRepo: repo });
    const result = await handler.handle({ tenantId: TENANT, userId: 'u-1', message: 'edit' });

    const payload = result.proposal.payload as { editActions: Array<Record<string, unknown>> };
    const lineItem = payload.editActions[0].lineItem as Record<string, unknown>;
    // TENANT's catalog is empty → free-text behavior, no cross-tenant pricing.
    expect(lineItem.unitPrice).toBe(9999);
    expect(lineItem.catalogItemId).toBeUndefined();
    const call = (gateway.complete as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.messages[1].content).not.toContain('Gasket');
  });

  it('injects a compact catalog table into the LLM prompt, capped at 150 items with a truncation note', async () => {
    const repo = new InMemoryCatalogItemRepository();
    await seedCatalog(
      repo,
      TENANT,
      Array.from({ length: 180 }, (_, i) => ({
        name: `Part ${String(i).padStart(3, '0')}`,
        unitPriceCents: 100 + i,
      })),
    );

    // "Part 120" (i=120) has unitPriceCents = 100 + 120 = 220. Drafting it at
    // 220 is a clean, in-tolerance snap (no price conflict).
    const part120 = (await repo.listByTenant(TENANT)).find((i) => i.name === 'Part 120')!;
    const gateway = mockGateway(editResponse([
      // NUMBERED-SKU EXACTNESS PIN (regression restored). The branch's earlier
      // assertion here (commit 6cc376a) claimed "part 001" normalizes to just
      // "part" and collides across all 180 "Part NNN" items → ambiguous. That
      // WAS the regression: the resolver's digit-dropping normalizer treated
      // the SKU number as a quantity, so the item the operator actually named
      // was unreachable from the picker. The resolver now runs a digit-aware
      // EXACT pass first — "part 120" keeps its SKU token and full-string-
      // matches exactly one catalog item → exact tier, catalog-priced, no
      // review needed. Resolution runs against the FULL catalog (all 180), not
      // just the 150 shown in the prompt.
      { type: 'add_line_item', lineItem: { description: 'part 120', quantity: 1, unitPrice: 220 } },
    ]));
    const handler = new InvoiceEditTaskHandler(gateway, { catalogRepo: repo });
    const result = await handler.handle({ tenantId: TENANT, userId: 'u-1', message: 'edit' });

    const call = (gateway.complete as ReturnType<typeof vi.fn>).mock.calls[0][0];
    const userContent: string = call.messages[1].content;
    expect(userContent).toContain('Service catalog');
    expect(userContent.split('\n').filter((l: string) => l.startsWith('- '))).toHaveLength(150);
    expect(userContent).toContain('catalog truncated');

    // The digit-aware exact pass reaches the exact SKU and prices it from the
    // catalog — not the LLM guess — with no review gate.
    const payload = result.proposal.payload as { editActions: Array<Record<string, unknown>> };
    const lineItem = payload.editActions[0].lineItem as Record<string, unknown>;
    expect(lineItem.pricingSource).toBe('catalog');
    expect(lineItem.needsPricing).toBe(false);
    expect(lineItem.unitPrice).toBe(220); // executable field, catalog price
    expect(lineItem.unitPriceCents).toBe(220); // review mirror
    expect(lineItem.catalogItemId).toBe(part120.id);
    expect(lineItem.description).toBe('Part 120');
  });

  it('ignores archived catalog items', async () => {
    const repo = new InMemoryCatalogItemRepository();
    const [gasket] = await seedCatalog(repo, TENANT, [{ name: 'Gasket', unitPriceCents: 450 }]);
    await repo.archive(TENANT, gasket.id);

    const gateway = mockGateway(
      editResponse([
        { type: 'add_line_item', lineItem: { description: 'gasket', quantity: 1, unitPrice: 9999 } },
      ]),
    );
    const handler = new InvoiceEditTaskHandler(gateway, { catalogRepo: repo });
    const result = await handler.handle({ tenantId: TENANT, userId: 'u-1', message: 'edit' });
    const payload = result.proposal.payload as { editActions: Array<Record<string, unknown>> };
    expect((payload.editActions[0].lineItem as Record<string, unknown>).catalogItemId).toBeUndefined();
  });

  describe('draft_invoice catalog pricing (P22-001)', () => {
    function draftResponse(lineItems: Array<Record<string, unknown>>): string {
      return JSON.stringify({
        customerId: '00000000-0000-4000-8000-0000000000aa',
        jobId: '00000000-0000-4000-8000-0000000000bb',
        lineItems,
        confidence_score: 0.9,
      });
    }

    it('overwrites the LLM price with the catalog price and recomputes the total', async () => {
      const repo = new InMemoryCatalogItemRepository();
      const [gasket] = await seedCatalog(repo, TENANT, [{ name: 'Gasket', unitPriceCents: 450 }]);

      const gateway = mockGateway(
        // 460 is within PRICE_CONFLICT_MIN_ABS_CENTS (100¢) of the catalog's
        // 450 — a snap/overwrite, not a "did you mean" price conflict.
        draftResponse([{ description: 'gaskets', quantity: 3, unitPrice: 460 }]),
      );
      const handler = new InvoiceTaskHandler(gateway, { catalogRepo: repo });
      const result = await handler.handle({ tenantId: TENANT, userId: 'u-1', message: 'invoice it' });

      const payload = result.proposal.payload as { lineItems: Array<Record<string, unknown>> };
      expect(payload.lineItems[0]).toMatchObject({
        description: 'Gasket',
        quantity: 3,
        unitPriceCents: 450,
        totalCents: 1350, // shared billing engine math: 3 × 450
        catalogItemId: gasket.id,
        needsPricing: false,
      });
    });

    it('flags unresolved items with needsPricing when a catalog exists', async () => {
      const repo = new InMemoryCatalogItemRepository();
      await seedCatalog(repo, TENANT, [
        { name: 'Ball Valve', unitPriceCents: 3200 },
        { name: 'Gate Valve', unitPriceCents: 4100 },
      ]);

      const gateway = mockGateway(
        draftResponse([{ description: 'valve', quantity: 1, unitPrice: 3500 }]),
      );
      const handler = new InvoiceTaskHandler(gateway, { catalogRepo: repo });
      const result = await handler.handle({ tenantId: TENANT, userId: 'u-1', message: 'invoice it' });

      const payload = result.proposal.payload as { lineItems: Array<Record<string, unknown>> };
      expect(payload.lineItems[0].needsPricing).toBe(true);
      expect(payload.lineItems[0].catalogItemId).toBeUndefined();
    });

    // requiresReview (structural gate on CatalogPricingOutcome) is anyUncatalogued
    // OR missingFields.length > 0. An ambiguous-only line (never uncatalogued)
    // proves the gate now drives `_meta.overallConfidence`, not just proposal
    // status via missingFields — a reviewer must never see "high confidence" on
    // a line that needs an operator pick.
    it('an ambiguous-only line keeps score-derived confidence (gated by missingFields, not a sticky low stamp)', async () => {
      const repo = new InMemoryCatalogItemRepository();
      await seedCatalog(repo, TENANT, [
        { name: 'Ball Valve', unitPriceCents: 3200 },
        { name: 'Gate Valve', unitPriceCents: 4100 },
      ]);

      // draftResponse defaults confidence_score to 0.9, which maps to 'high'
      // — and must STAY 'high' for an ambiguous-only line: a persisted 'low'
      // stamp is never lifted by line resolution, so it would keep blocking
      // chain-set/SMS approval after the operator picks a candidate.
      const gateway = mockGateway(
        draftResponse([{ description: 'valve', quantity: 1, unitPrice: 3500 }]),
      );
      const handler = new InvoiceTaskHandler(gateway, { catalogRepo: repo });
      const result = await handler.handle({ tenantId: TENANT, userId: 'u-1', message: 'invoice it' });

      const payload = result.proposal.payload as {
        lineItems: Array<Record<string, unknown>>;
        _meta?: { overallConfidence?: string };
      };
      expect(payload.lineItems[0].pricingSource).toBe('ambiguous');
      // Not uncatalogued — the LLM's high self-reported confidence is NOT
      // pulled down by the UNCATALOGUED_CONFIDENCE_CAP path.
      expect(result.proposal.confidenceFactors).not.toContain('uncatalogued_line_item');
      // The stamp stays score-derived; the structural gate is missingFields.
      expect(payload._meta?.overallConfidence).toBe('high');
      expect(result.proposal.status).not.toBe('approved');
    });

    // Money-safety regression (bug: empty/unwired/erroring catalog silently
    // skipped the uncatalogued confidence cap, letting a fully LLM-priced
    // draft auto-approve at the autonomous tier). Every "no catalog to ground
    // against" path must now flag the line uncatalogued AND cap confidence
    // below the 0.9 auto-approve threshold. Unit tests mocked the catalog, so
    // an empty catalog was the common untested case for real (new) tenants.
    it('caps confidence and flags uncatalogued when the catalog is empty', async () => {
      const gateway = mockGateway(
        draftResponse([{ description: 'trip fee', quantity: 1, unitPrice: 7500 }]),
      );
      const handler = new InvoiceTaskHandler(gateway, { catalogRepo: new InMemoryCatalogItemRepository() });
      const result = await handler.handle({ tenantId: TENANT, userId: 'u-1', message: 'invoice it' });

      const payload = result.proposal.payload as {
        lineItems: Array<Record<string, unknown>>;
        _meta?: { overallConfidence?: string; markers?: unknown[] };
      };
      // LLM price is kept (there's no catalog to override it)…
      expect(payload.lineItems[0].unitPriceCents).toBe(7500);
      expect(payload.lineItems[0].catalogItemId).toBeUndefined();
      // …but flagged uncatalogued and capped so a human always reviews it.
      expect(payload.lineItems[0].pricingSource).toBe('uncatalogued');
      expect(payload.lineItems[0].needsPricing).toBe(true);
      // LLM self-reported 0.9 (≥ the 0.9 auto-approve threshold); the cap must
      // pull it below so the draft cannot auto-approve.
      expect(result.proposal.confidenceScore).toBeLessThanOrEqual(UNCATALOGUED_CONFIDENCE_CAP);
      expect(result.proposal.status).not.toBe('approved');
      expect(payload._meta?.overallConfidence).toBeDefined();
    });

    it('does not auto-approve an uncatalogued draft even when the tenant threshold is below the 0.85 cap', async () => {
      // Codex P2: the numeric cap alone left a hole — a tenant with
      // auto_approve_threshold ≤ 0.85 could still auto-approve a fully
      // LLM-priced draft. The uncatalogued line now forces _meta.overallConfidence
      // to 'low', which hard-blocks auto-approval before threshold resolution.
      const gateway = mockGateway(
        draftResponse([{ description: 'trip fee', quantity: 1, unitPrice: 7500 }]),
      );
      const handler = new InvoiceTaskHandler(gateway, {
        catalogRepo: new InMemoryCatalogItemRepository(),
      });
      const result = await handler.handle({
        tenantId: TENANT,
        userId: 'u-1',
        message: 'invoice it',
        supervisorPresent: true,
        supervisorMode: 'supervisor',
        tenantThresholdOverride: { supervisor: 0.5 }, // below the 0.85 cap
      });

      expect(result.proposal.status).not.toBe('approved');
      const meta = result.proposal.payload._meta as { overallConfidence?: string };
      expect(meta.overallConfidence).toBe('low');
    });

    it('caps confidence and flags uncatalogued when no catalog repo is wired', async () => {
      const gateway = mockGateway(
        draftResponse([{ description: 'trip fee', quantity: 1, unitPrice: 7500 }]),
      );
      // No catalog deps at all — the pre-fix path left the outcome undefined
      // and skipped the cap entirely.
      const handler = new InvoiceTaskHandler(gateway);
      const result = await handler.handle({ tenantId: TENANT, userId: 'u-1', message: 'invoice it' });

      const payload = result.proposal.payload as { lineItems: Array<Record<string, unknown>> };
      expect(payload.lineItems[0].unitPriceCents).toBe(7500);
      expect(payload.lineItems[0].pricingSource).toBe('uncatalogued');
      expect(result.proposal.confidenceScore).toBeLessThanOrEqual(UNCATALOGUED_CONFIDENCE_CAP);
      expect(result.proposal.status).not.toBe('approved');
    });

    it('caps confidence and flags uncatalogued when the catalog read throws', async () => {
      const throwingRepo = {
        listByTenant: vi.fn(async () => {
          throw new Error('db down');
        }),
      } as unknown as InMemoryCatalogItemRepository;
      const gateway = mockGateway(
        draftResponse([{ description: 'trip fee', quantity: 1, unitPrice: 7500 }]),
      );
      const handler = new InvoiceTaskHandler(gateway, { catalogRepo: throwingRepo });
      const result = await handler.handle({ tenantId: TENANT, userId: 'u-1', message: 'invoice it' });

      const payload = result.proposal.payload as { lineItems: Array<Record<string, unknown>> };
      // A catalog read failure must never block drafting…
      expect(payload.lineItems[0].unitPriceCents).toBe(7500);
      // …but it also must not silently let an ungrounded price auto-approve.
      expect(payload.lineItems[0].pricingSource).toBe('uncatalogued');
      expect(result.proposal.confidenceScore).toBeLessThanOrEqual(UNCATALOGUED_CONFIDENCE_CAP);
      expect(result.proposal.status).not.toBe('approved');
    });
  });

  // VOX-51 — the money-safety invariant: an AI-invented edit price must never
  // auto-execute. Gated with a supervisor present + a low tenant threshold so
  // that ONLY the `_meta.overallConfidence:'low'` marker (not a missing
  // supervisor) is what blocks the uncatalogued case.
  describe('VOX-51 confidence gating for update_invoice edits', () => {
    const supervised = {
      supervisorPresent: true,
      supervisorMode: 'supervisor' as const,
      tenantThresholdOverride: { supervisor: 0.5 }, // below the 0.85 cap
    };

    it('(a) a catalogued edit line auto-approves — catalog price wins, confidence not force-capped', async () => {
      const repo = new InMemoryCatalogItemRepository();
      const [gasket] = await seedCatalog(repo, TENANT, [{ name: 'Gasket', unitPriceCents: 450 }]);

      const gateway = mockGateway(
        editResponse(
          // Within 100¢ of the catalog's 450 → a clean snap, not a conflict.
          [{ type: 'add_line_item', lineItem: { description: 'gasket', quantity: 1, unitPrice: 460 } }],
          0.9,
          // PR review finding (2026-07): a free-text invoiceReference
          // ("INV-0042") now gates missingFields: ['invoiceId'] regardless
          // of confidence (UpdateInvoiceExecutionHandler has no reference
          // resolution of its own — see invoice-edit-task.ts). This test's
          // purpose is confidence/catalog-pricing behavior, not invoiceId
          // resolution, so it uses an already-resolved UUID reference —
          // exactly what resolveInvoiceId trusts ONCE the repo confirms it
          // (verify-or-gate) — to keep the invoiceId gate out of the picture.
          '00000000-0000-4000-8000-000000000042',
        ),
      );
      const invoiceRepo = await invoiceRepoWithId('00000000-0000-4000-8000-000000000042');
      const handler = new InvoiceEditTaskHandler(gateway, { catalogRepo: repo, invoiceRepo });
      const result = await handler.handle({ tenantId: TENANT, userId: 'u-1', message: 'edit', ...supervised });

      const payload = result.proposal.payload as {
        editActions: Array<Record<string, unknown>>;
        _meta?: { overallConfidence?: string };
      };
      const lineItem = payload.editActions[0].lineItem as Record<string, unknown>;
      expect(lineItem.unitPrice).toBe(450); // catalog snaps the LLM's 460
      expect(lineItem.catalogItemId).toBe(gasket.id);
      expect(lineItem.pricingSource).toBe('catalog');
      // Not uncatalogued → confidence untouched, marker not forced low.
      expect(result.proposal.confidenceScore).toBe(0.9);
      expect(payload._meta?.overallConfidence).not.toBe('low');
      expect(result.proposal.status).toBe('approved');
    });

    it('(b) an uncatalogued edit line with LLM confidence 0.98 carries _meta.overallConfidence low and does NOT auto-approve', async () => {
      const repo = new InMemoryCatalogItemRepository();
      await seedCatalog(repo, TENANT, [{ name: 'Gasket', unitPriceCents: 450 }]);

      const gateway = mockGateway(
        editResponse(
          // "premium widget" is not in the catalog.
          [{ type: 'add_line_item', lineItem: { description: 'premium widget', quantity: 1, unitPrice: 12345 } }],
          0.98,
        ),
      );
      const handler = new InvoiceEditTaskHandler(gateway, { catalogRepo: repo });
      const result = await handler.handle({ tenantId: TENANT, userId: 'u-1', message: 'edit', ...supervised });

      const payload = result.proposal.payload as {
        editActions: Array<Record<string, unknown>>;
        _meta?: { overallConfidence?: string };
      };
      const lineItem = payload.editActions[0].lineItem as Record<string, unknown>;
      expect(lineItem.pricingSource).toBe('uncatalogued');
      expect(lineItem.needsPricing).toBe(true);
      expect(lineItem.unitPriceCents).toBeNull();
      // The hard block: low marker + capped score → never auto-approved.
      expect(payload._meta?.overallConfidence).toBe('low');
      expect(result.proposal.confidenceScore).toBeLessThanOrEqual(UNCATALOGUED_CONFIDENCE_CAP);
      expect(result.proposal.status).not.toBe('approved');
    });
  });
});
