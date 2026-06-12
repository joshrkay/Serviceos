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

  it('degrades to current free-text behavior when the catalog is empty', async () => {
    const repo = new InMemoryCatalogItemRepository();
    const gateway = mockGateway(
      editResponse([
        { type: 'add_line_item', lineItem: { description: 'trip fee', quantity: 1, unitPrice: 7500 } },
      ]),
    );

    const handler = new InvoiceEditTaskHandler(gateway, { catalogRepo: repo });
    const result = await handler.handle({ tenantId: TENANT, userId: 'u-1', message: 'add a trip fee' });

    const payload = result.proposal.payload as { editActions: Array<Record<string, unknown>> };
    const lineItem = payload.editActions[0].lineItem as Record<string, unknown>;
    // Untouched: no flags, LLM price kept (operator spoke it).
    expect(lineItem).toEqual({ description: 'trip fee', quantity: 1, unitPrice: 7500 });

    // No catalog section injected into the prompt either.
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

    it('keeps current free-text behavior with an empty catalog (no flags)', async () => {
      const gateway = mockGateway(
        draftResponse([{ description: 'trip fee', quantity: 1, unitPrice: 7500 }]),
      );
      const handler = new InvoiceTaskHandler(gateway, { catalogRepo: new InMemoryCatalogItemRepository() });
      const result = await handler.handle({ tenantId: TENANT, userId: 'u-1', message: 'invoice it' });

      const payload = result.proposal.payload as { lineItems: Array<Record<string, unknown>> };
      expect(payload.lineItems[0].unitPriceCents).toBe(7500);
      expect(payload.lineItems[0]).not.toHaveProperty('needsPricing');
      expect(payload.lineItems[0]).not.toHaveProperty('catalogItemId');
    });
  });
});
