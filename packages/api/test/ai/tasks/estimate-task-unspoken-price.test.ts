/**
 * #1399 N1/N2 (QA 2026-09-26 §17) — "Draft an estimate for <customer>:
 * 1 blower motor replacement" matched exactly one catalog item (Blower Motor
 * Replacement, $425.00) yet the draft came back "matched multiple catalog
 * items" with a synthetic "Keep spoken price $3.50" candidate. The operator
 * never spoke a price: the 350 was the drafting model's own (dollar-scaled)
 * guess. An LLM-invented price is not a "did you mean" conflict — it must be
 * grounded by the catalog (CLAUDE.md: never trust an LLM-emitted price
 * without resolution), so a single strong match auto-fills.
 *
 * Seam: EstimateTaskHandler.handle (the draft_estimate task service), with
 * the gateway stubbed and an in-memory catalog shaped like a real HVAC shop's.
 */
import { EstimateTaskHandler } from '../../../src/ai/tasks/estimate-task';
import { InvoiceTaskHandler } from '../../../src/ai/tasks/invoice-task';
import { LLMGateway } from '../../../src/ai/gateway/gateway';
import type { LLMProvider } from '../../../src/ai/gateway/gateway';
import { StubProvider } from '../../../src/ai/gateway/providers';
import {
  createCatalogItem,
  InMemoryCatalogItemRepository,
  type CatalogItem,
} from '../../../src/catalog/catalog-item';

const CUSTOMER_ID = '550e8400-e29b-41d4-a716-446655440000';

function gatewayReturning(content: string): { gateway: LLMGateway; stub: StubProvider } {
  const stub = new StubProvider('stub');
  stub.setResponse({ content });
  const providers = new Map<string, LLMProvider>([['stub', stub]]);
  return {
    gateway: new LLMGateway({ defaultProvider: 'stub', defaultModel: 'test-model' }, providers),
    stub,
  };
}

/** A realistic small HVAC price book, including near-neighbours of "blower motor". */
async function hvacCatalog(): Promise<{ repo: InMemoryCatalogItemRepository; blower: CatalogItem }> {
  const repo = new InMemoryCatalogItemRepository();
  const rows: Array<[string, 'Labor' | 'Parts', number]> = [
    ['Diagnostic Visit', 'Labor', 8_900],
    ['Blower Motor Replacement', 'Labor', 42_500],
    ['Blower Wheel Cleaning', 'Labor', 14_900],
    ['Condenser Fan Motor Replacement', 'Labor', 38_500],
    ['Capacitor Replacement', 'Parts', 17_500],
  ];
  let blower: CatalogItem | undefined;
  for (const [name, category, unitPriceCents] of rows) {
    const item = await repo.create(
      createCatalogItem({ tenantId: 'tenant-1', name, category, unit: 'each', unitPriceCents }),
    );
    if (name === 'Blower Motor Replacement') blower = item;
  }
  return { repo, blower: blower! };
}

function draftWith(unitPrice: number): string {
  return JSON.stringify({
    lineItems: [
      { description: 'Blower Motor Replacement', quantity: 1, unitPrice, category: 'HVAC' },
    ],
    confidence_score: 0.8,
  });
}

describe('#1399 N1 — a single strong catalog match auto-fills when no price was spoken', () => {
  it('grounds "1 blower motor replacement" to the one catalog item at $425.00', async () => {
    const { repo, blower } = await hvacCatalog();
    const { gateway } = gatewayReturning(draftWith(350));
    const handler = new EstimateTaskHandler(gateway, repo);

    const { proposal } = await handler.handle({
      tenantId: 'tenant-1',
      userId: 'user-1',
      customerId: CUSTOMER_ID,
      message: 'Draft an estimate for Priya Whitfield: 1 blower motor replacement',
    });

    const line = (proposal.payload.lineItems as Array<Record<string, unknown>>)[0];
    expect(line.catalogItemId).toBe(blower.id);
    expect(line.unitPrice).toBe(42_500);
    expect(line.pricingSource).toBe('catalog');
    const ctx = (proposal.sourceContext ?? {}) as Record<string, unknown>;
    expect(ctx.missingFields ?? []).not.toContain('lineItems[0].catalogItemId');
    expect(ctx.catalogResolution).toBeUndefined();
  });

  it('still offers "did you mean" when the operator quoted a custom price', async () => {
    const { repo, blower } = await hvacCatalog();
    // Operator said $300; the scale guard lands 300 → 30_000 cents.
    const { gateway } = gatewayReturning(draftWith(300));
    const handler = new EstimateTaskHandler(gateway, repo);

    const { proposal } = await handler.handle({
      tenantId: 'tenant-1',
      userId: 'user-1',
      customerId: CUSTOMER_ID,
      message: 'Draft an estimate for Priya Whitfield: 1 blower motor replacement for $300',
    });

    const line = (proposal.payload.lineItems as Array<Record<string, unknown>>)[0];
    expect(line.pricingSource).toBe('ambiguous');
    expect(line.unitPrice).toBe(30_000);
    const ctx = proposal.sourceContext as Record<string, unknown>;
    const candidates = (ctx.catalogResolution as Record<number, Array<{ id: string; unitPriceCents: number }>>)[0];
    expect(candidates).toEqual([
      expect.objectContaining({ id: blower.id, unitPriceCents: 42_500 }),
      expect.objectContaining({ id: 'spoken:0', unitPriceCents: 30_000 }),
    ]);
  });
});

describe('#1399 N2 — the drafting prompts name the price unit', () => {
  // Root cause of "$3.50": the prompts asked for `"unitPrice": <number>` with
  // no unit, so the model wrote 350 meaning $350 into an integer-cents field.
  // Money is integer cents everywhere — the prompt has to say so.
  it('the estimate prompt asks for unitPrice in integer cents', async () => {
    const { repo } = await hvacCatalog();
    const { gateway, stub } = gatewayReturning(draftWith(42_500));
    await new EstimateTaskHandler(gateway, repo).handle({
      tenantId: 'tenant-1',
      userId: 'user-1',
      customerId: CUSTOMER_ID,
      message: 'Draft an estimate for Priya Whitfield: 1 blower motor replacement',
    });
    const system = stub.getLastRequest()!.messages.find((m) => m.role === 'system')!.content;
    expect(system).toContain('"unitPrice": <integer cents');
    expect(system).toContain('$350.00 is 35000');
  });

  it('the invoice prompt asks for unitPrice in integer cents', async () => {
    const { repo } = await hvacCatalog();
    const { gateway, stub } = gatewayReturning(draftWith(42_500));
    await new InvoiceTaskHandler(gateway, repo).handle({
      tenantId: 'tenant-1',
      userId: 'user-1',
      customerId: CUSTOMER_ID,
      message: 'Draft an invoice for Priya Whitfield: 1 blower motor replacement',
    });
    const system = stub.getLastRequest()!.messages.find((m) => m.role === 'system')!.content;
    expect(system).toContain('"unitPrice": <integer cents');
    expect(system).toContain('$350.00 is 35000');
  });
});

describe('#1399 N1 — the invoice draft grounds an unspoken price the same way', () => {
  it('grounds "1 blower motor replacement" on an invoice to the catalog item at $425.00', async () => {
    const { repo, blower } = await hvacCatalog();
    const { gateway } = gatewayReturning(
      JSON.stringify({
        lineItems: [{ description: 'Blower Motor Replacement', quantity: 1, unitPrice: 350 }],
        confidence_score: 0.8,
      }),
    );
    const handler = new InvoiceTaskHandler(gateway, repo);

    const { proposal } = await handler.handle({
      tenantId: 'tenant-1',
      userId: 'user-1',
      customerId: CUSTOMER_ID,
      message: 'Draft an invoice for Priya Whitfield: 1 blower motor replacement',
    });

    const line = (proposal.payload.lineItems as Array<Record<string, unknown>>)[0];
    expect(line.catalogItemId).toBe(blower.id);
    expect(line.unitPriceCents).toBe(42_500);
    expect(line.pricingSource).toBe('catalog');
  });
});
