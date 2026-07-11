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

const TENANT = 'tenant-1';
const OTHER_TENANT = 'tenant-2';

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
): string {
  return JSON.stringify({
    invoiceReference: 'INV-0042',
    editActions: actions,
    confidence_score: confidence,
  });
}

describe('P22-001 invoice-edit-catalog', () => {
  it('overwrites a deliberately wrong LLM-hallucinated price with the exact catalog price', async () => {
    const repo = new InMemoryCatalogItemRepository();
    const [gasket] = await seedCatalog(repo, TENANT, [{ name: 'Gasket', unitPriceCents: 450 }]);

    const gateway = mockGateway(
      editResponse([
        {
          type: 'add_line_item',
          // LLM hallucinated $99.99 — catalog says $4.50.
          lineItem: { description: 'gasket', quantity: 3, unitPrice: 9999 },
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
    expect(lineItem.unitPrice).toBe(450);
    expect(lineItem.unitPriceCents).toBe(450);
    expect(lineItem.catalogItemId).toBe(gasket.id);
    expect(lineItem.needsPricing).toBe(false);
    expect(lineItem.quantity).toBe(3);
    expect(lineItem.description).toBe('Gasket');
  });

  it('resolves "service call + three gaskets" with catalog prices on both items', async () => {
    const repo = new InMemoryCatalogItemRepository();
    await seedCatalog(repo, TENANT, [
      { name: 'Service Call', unitPriceCents: 12500 },
      { name: 'Gasket', unitPriceCents: 450 },
    ]);

    const gateway = mockGateway(
      editResponse([
        { type: 'add_line_item', lineItem: { description: 'service call', quantity: 1, unitPrice: 100 } },
        { type: 'add_line_item', lineItem: { description: 'gaskets', quantity: 3, unitPrice: 100 } },
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

    const gateway = mockGateway(editResponse([
      { type: 'add_line_item', lineItem: { description: 'part 001', quantity: 1, unitPrice: 1 } },
    ]));
    const handler = new InvoiceEditTaskHandler(gateway, { catalogRepo: repo });
    const result = await handler.handle({ tenantId: TENANT, userId: 'u-1', message: 'edit' });

    const call = (gateway.complete as ReturnType<typeof vi.fn>).mock.calls[0][0];
    const userContent: string = call.messages[1].content;
    expect(userContent).toContain('Service catalog');
    expect(userContent.split('\n').filter((l: string) => l.startsWith('- '))).toHaveLength(150);
    expect(userContent).toContain('catalog truncated');

    // Resolution still works against the FULL catalog (no crash, exact price).
    const payload = result.proposal.payload as { editActions: Array<Record<string, unknown>> };
    const lineItem = payload.editActions[0].lineItem as Record<string, unknown>;
    expect(lineItem.unitPrice).toBe(101);
    expect(lineItem.needsPricing).toBe(false);
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
        draftResponse([{ description: 'gaskets', quantity: 3, unitPrice: 9999 }]),
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
          [{ type: 'add_line_item', lineItem: { description: 'gasket', quantity: 1, unitPrice: 9999 } }],
          0.9,
        ),
      );
      const handler = new InvoiceEditTaskHandler(gateway, { catalogRepo: repo });
      const result = await handler.handle({ tenantId: TENANT, userId: 'u-1', message: 'edit', ...supervised });

      const payload = result.proposal.payload as {
        editActions: Array<Record<string, unknown>>;
        _meta?: { overallConfidence?: string };
      };
      const lineItem = payload.editActions[0].lineItem as Record<string, unknown>;
      expect(lineItem.unitPrice).toBe(450); // catalog overwrites the LLM's 9999
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
