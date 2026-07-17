import { vi } from 'vitest';
import {
  InvoiceTaskHandler,
  tryParseInvoiceJson,
  buildPartialInvoicePayload,
  INVOICE_SYSTEM_PROMPT,
} from '../../../src/ai/tasks/invoice-task';
import { LLMGateway, LLMResponse } from '../../../src/ai/gateway/gateway';
import { TaskContext } from '../../../src/ai/tasks/task-handlers';
import {
  CatalogItem,
  CatalogItemRepository,
  createCatalogItem,
  InMemoryCatalogItemRepository,
} from '../../../src/catalog/catalog-item';
import { UNCATALOGUED_CONFIDENCE_CAP } from '../../../src/ai/resolution/catalog-resolver';

function createMockGateway(responseContent: string): LLMGateway {
  return {
    complete: vi.fn().mockResolvedValue({
      content: responseContent,
      model: 'test-model',
      provider: 'test-provider',
      tokenUsage: { input: 10, output: 20, total: 30 },
      latencyMs: 100,
    } as LLMResponse),
  } as unknown as LLMGateway;
}

const validAiOutput = {
  customerId: '00000000-0000-0000-0000-000000000001',
  jobId: '00000000-0000-0000-0000-000000000002',
  lineItems: [
    { description: 'AC Repair', quantity: 2, unitPrice: 7500, category: 'labor' },
    { description: 'Parts', quantity: 1, unitPrice: 3000, category: 'material' },
  ],
  discountCents: 500,
  taxRateBps: 825,
  customerMessage: 'Thank you for choosing us',
  internalNotes: 'Rush job',
  confidence_score: 0.85,
};

const baseContext: TaskContext = {
  tenantId: 'tenant-1',
  message: 'Generate invoice for AC repair job',
  conversationId: 'conv-1',
  userId: 'user-1',
};

describe('P5-003A — Invoice draft generation from work context', () => {
  describe('InvoiceTaskHandler', () => {
    it('happy path — handler returns proposal with draft_invoice type and parsed payload', async () => {
      const gateway = createMockGateway(JSON.stringify(validAiOutput));
      const handler = new InvoiceTaskHandler(gateway);

      const result = await handler.handle(baseContext);

      expect(result.taskType).toBe('draft_invoice');
      expect(result.proposal.proposalType).toBe('draft_invoice');
      expect(result.proposal.status).toBe('draft');
      expect(result.proposal.tenantId).toBe('tenant-1');
      expect(result.proposal.payload.customerId).toBe('00000000-0000-0000-0000-000000000001');
      expect(result.proposal.payload.jobId).toBe('00000000-0000-0000-0000-000000000002');
      expect(Array.isArray(result.proposal.payload.lineItems)).toBe(true);
      expect((result.proposal.payload.lineItems as unknown[]).length).toBe(2);
      expect(result.proposal.payload.discountCents).toBe(500);
      expect(result.proposal.payload.taxRateBps).toBe(825);
      expect(result.proposal.payload.customerMessage).toBe('Thank you for choosing us');
      expect(result.proposal.payload.internalNotes).toBe('Rush job');
    });

    it('happy path — gateway called with correct system prompt and params', async () => {
      const gateway = createMockGateway(JSON.stringify(validAiOutput));
      const handler = new InvoiceTaskHandler(gateway);

      await handler.handle(baseContext);

      expect(gateway.complete).toHaveBeenCalledTimes(1);
      const call = (gateway.complete as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(call.taskType).toBe('draft_invoice');
      expect(call.responseFormat).toBe('json');
      expect(call.messages[0].role).toBe('system');
      expect(call.messages[0].content).toBe(INVOICE_SYSTEM_PROMPT);
      expect(call.messages[1].role).toBe('user');
      expect(call.messages[1].content).toContain('Generate invoice for AC repair job');
    });

    it('validation — empty message still produces proposal', async () => {
      const gateway = createMockGateway(JSON.stringify(validAiOutput));
      const handler = new InvoiceTaskHandler(gateway);

      const result = await handler.handle({
        tenantId: 'tenant-1',
        message: '',
        userId: 'user-1',
      });

      expect(result.proposal).toBeDefined();
      expect(result.taskType).toBe('draft_invoice');
    });

    it('tenant isolation — proposal has correct tenantId', async () => {
      const gateway = createMockGateway(JSON.stringify(validAiOutput));
      const handler = new InvoiceTaskHandler(gateway);

      const r1 = await handler.handle({ tenantId: 'tenant-A', message: 'Test', userId: 'u1' });
      const r2 = await handler.handle({ tenantId: 'tenant-B', message: 'Test', userId: 'u2' });

      expect(r1.proposal.tenantId).toBe('tenant-A');
      expect(r2.proposal.tenantId).toBe('tenant-B');
      expect(r1.proposal.id).not.toBe(r2.proposal.id);
    });

    it('mock provider — gateway.complete called with correct params', async () => {
      const gateway = createMockGateway(JSON.stringify(validAiOutput));
      const handler = new InvoiceTaskHandler(gateway);

      await handler.handle(baseContext);

      expect(gateway.complete).toHaveBeenCalledWith(
        expect.objectContaining({
          taskType: 'draft_invoice',
          responseFormat: 'json',
        }),
      );
    });

    it('malformed AI output — non-JSON response handled gracefully', async () => {
      const gateway = createMockGateway('This is not JSON at all');
      const handler = new InvoiceTaskHandler(gateway);

      const result = await handler.handle(baseContext);

      expect(result.proposal).toBeDefined();
      expect(result.taskType).toBe('draft_invoice');
      expect(result.proposal.payload.lineItems).toEqual([]);
      expect(result.proposal.payload.notes).toBe('AI output could not be parsed');
    });

    it('malformed AI output — partial JSON handled with empty lineItems', async () => {
      const gateway = createMockGateway(JSON.stringify({ customerId: 'cust-1' }));
      const handler = new InvoiceTaskHandler(gateway);

      const result = await handler.handle(baseContext);

      expect(result.proposal.payload.customerId).toBe('cust-1');
      expect(result.proposal.payload.lineItems).toEqual([]);
    });

    it('confidence scoring — uses confidence_score from AI output', async () => {
      const gateway = createMockGateway(JSON.stringify(validAiOutput));
      const handler = new InvoiceTaskHandler(gateway);

      const result = await handler.handle(baseContext);

      expect(result.proposal.confidenceScore).toBe(0.85);
      expect(result.proposal.confidenceFactors).toBeDefined();
      expect(result.proposal.confidenceFactors!.length).toBeGreaterThan(0);
    });

    it('confidence scoring — defaults to 0.5 when no confidence_score in AI output', async () => {
      const noConfidence = { ...validAiOutput };
      delete (noConfidence as Record<string, unknown>).confidence_score;
      const gateway = createMockGateway(JSON.stringify(noConfidence));
      const handler = new InvoiceTaskHandler(gateway);

      const result = await handler.handle(baseContext);

      expect(result.proposal.confidenceScore).toBe(0.5);
    });

    it('context — includes existingEntities in user message when present', async () => {
      const gateway = createMockGateway(JSON.stringify(validAiOutput));
      const handler = new InvoiceTaskHandler(gateway);

      const context: TaskContext = {
        ...baseContext,
        existingEntities: { customer: { name: 'John Doe' } },
      };

      await handler.handle(context);

      const call = (gateway.complete as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(call.messages[1].content).toContain('Context entities');
      expect(call.messages[1].content).toContain('John Doe');
    });

    it('sourceContext — includes conversationId when provided', async () => {
      const gateway = createMockGateway(JSON.stringify(validAiOutput));
      const handler = new InvoiceTaskHandler(gateway);

      const result = await handler.handle(baseContext);

      expect(result.proposal.sourceContext).toEqual({ conversationId: 'conv-1' });
    });

    it('sourceContext — omitted when no conversationId', async () => {
      const gateway = createMockGateway(JSON.stringify(validAiOutput));
      const handler = new InvoiceTaskHandler(gateway);

      const result = await handler.handle({
        tenantId: 'tenant-1',
        message: 'Invoice',
        userId: 'user-1',
      });

      expect(result.proposal.sourceContext).toBeUndefined();
    });
  });

  describe('tryParseInvoiceJson', () => {
    it('parses valid JSON object', () => {
      expect(tryParseInvoiceJson('{"a": 1}')).toEqual({ a: 1 });
    });

    it('returns null for invalid JSON', () => {
      expect(tryParseInvoiceJson('not json')).toBeNull();
    });

    it('returns null for JSON string primitive', () => {
      expect(tryParseInvoiceJson('"just a string"')).toBeNull();
    });

    it('returns null for JSON number', () => {
      expect(tryParseInvoiceJson('42')).toBeNull();
    });
  });

  describe('buildPartialInvoicePayload', () => {
    it('builds payload from parsed AI output', () => {
      const result = buildPartialInvoicePayload(validAiOutput as unknown as Record<string, unknown>);
      expect(result.customerId).toBe('00000000-0000-0000-0000-000000000001');
      expect(result.jobId).toBe('00000000-0000-0000-0000-000000000002');
      expect(result.lineItems).toHaveLength(2);
      expect(result.discountCents).toBe(500);
    });

    it('returns fallback for null input', () => {
      const result = buildPartialInvoicePayload(null);
      expect(result.lineItems).toEqual([]);
      expect(result.notes).toBe('AI output could not be parsed');
    });

    it('defaults lineItems to empty array when missing', () => {
      const result = buildPartialInvoicePayload({ customerId: 'cust-1' });
      expect(result.lineItems).toEqual([]);
    });

    it('ignores non-string customerId', () => {
      const result = buildPartialInvoicePayload({ customerId: 123, lineItems: [] });
      expect(result.customerId).toBeUndefined();
    });
  });
});

// ─── P22: catalog grounding ──────────────────────────────────────────────
// Money comes from the tenant's price book, not the LLM. These cases pin
// the four resolution outcomes (catalog override, ambiguous → draft,
// uncatalogued → confidence cap, price-less rescue) plus failure/absence
// degradation.
describe('P22 — InvoiceTaskHandler catalog grounding', () => {
  function seededCatalog(): {
    repo: InMemoryCatalogItemRepository;
    heater: CatalogItem;
    airFilter: CatalogItem;
    waterFilter: CatalogItem;
  } {
    const repo = new InMemoryCatalogItemRepository();
    const heater = createCatalogItem({
      tenantId: 'tenant-1',
      name: 'Water Heater Install',
      category: 'Labor',
      unit: 'each',
      unitPriceCents: 185_000,
    });
    const airFilter = createCatalogItem({
      tenantId: 'tenant-1',
      name: 'Air Filter',
      category: 'Parts',
      unit: 'each',
      unitPriceCents: 2_000,
    });
    const waterFilter = createCatalogItem({
      tenantId: 'tenant-1',
      name: 'Water Filter',
      category: 'Parts',
      unit: 'each',
      unitPriceCents: 3_500,
    });
    void repo.create(heater);
    void repo.create(airFilter);
    void repo.create(waterFilter);
    return { repo, heater, airFilter, waterFilter };
  }

  function aiOutput(lineItems: unknown[], confidence = 0.95): string {
    return JSON.stringify({
      customerId: '00000000-0000-0000-0000-000000000001',
      jobId: '00000000-0000-0000-0000-000000000002',
      lineItems,
      confidence_score: confidence,
    });
  }

  it('catalog match OVERRIDES the LLM-invented price and recomputes totalCents', async () => {
    const { repo, heater } = seededCatalog();
    const gateway = createMockGateway(
      // 183_000 is within PRICE_CONFLICT tolerance (~1.1% deviation) of the
      // catalog's 185_000 — close enough that this is a snap/overwrite, not
      // a "did you mean" price conflict.
      aiOutput([{ description: 'Water Heater Install', quantity: 2, unitPrice: 183_000 }]),
    );
    const handler = new InvoiceTaskHandler(gateway, repo);

    const { proposal } = await handler.handle(baseContext);

    const line = (proposal.payload.lineItems as Array<Record<string, unknown>>)[0];
    expect(line.unitPriceCents).toBe(185_000);
    expect(line.totalCents).toBe(370_000);
    expect(line.catalogItemId).toBe(heater.id);
    expect(line.pricingSource).toBe('catalog');
    expect(line.category).toBe('labor');
    expect(proposal.confidenceFactors).toContain('catalog_priced');
    // Catalog-grounded, unambiguous, 0.95 confidence → still auto-approves.
    expect(proposal.status).toBe('approved');
  });

  it('a drafted price that conflicts with an exact catalog match keeps the spoken price and forces review', async () => {
    const { repo, heater } = seededCatalog();
    const gateway = createMockGateway(
      // 99_900 vs the catalog's 185_000 is a "did you mean" price conflict
      // (well past both PRICE_CONFLICT thresholds), not a mishear — the
      // operator may have deliberately quoted a custom price.
      aiOutput([{ description: 'Water Heater Install', quantity: 1, unitPrice: 99_900 }]),
    );
    const handler = new InvoiceTaskHandler(gateway, repo);

    const { proposal } = await handler.handle(baseContext);

    const line = (proposal.payload.lineItems as Array<Record<string, unknown>>)[0];
    // Spoken price kept verbatim — never silently overwritten.
    expect(line.unitPriceCents).toBe(99_900);
    expect(line.pricingSource).toBe('ambiguous');
    expect(line.needsPricing).toBe(true);
    // Never approved, even at model confidence 0.95.
    expect(proposal.status).toBe('draft');

    const ctx = proposal.sourceContext as Record<string, unknown>;
    expect(ctx.missingFields).toEqual(['lineItems[0].catalogItemId']);
    const candidates = (
      ctx.catalogResolution as Record<
        number,
        Array<{ id: string; name: string; unitPriceCents: number; score: number }>
      >
    )[0];
    const ids = candidates.map((c) => c.id).sort();
    expect(ids).toEqual([heater.id, 'spoken:0'].sort());
    const catalogCandidate = candidates.find((c) => c.id === heater.id);
    expect(catalogCandidate?.unitPriceCents).toBe(185_000);
    expect(catalogCandidate?.score).toBe(1);
    const spokenCandidate = candidates.find((c) => c.id === 'spoken:0');
    expect(spokenCandidate?.unitPriceCents).toBe(99_900);
    expect(spokenCandidate?.score).toBe(0);

    const meta = proposal.payload._meta as Record<string, unknown>;
    expect(meta.overallConfidence).toBe('low');
  });

  it('ambiguous match keeps the LLM price, forces draft, and surfaces candidates', async () => {
    const { repo, airFilter, waterFilter } = seededCatalog();
    const gateway = createMockGateway(
      aiOutput([{ description: 'filter', quantity: 1, unitPrice: 2_500 }]),
    );
    const handler = new InvoiceTaskHandler(gateway, repo);

    const { proposal } = await handler.handle(baseContext);

    const line = (proposal.payload.lineItems as Array<Record<string, unknown>>)[0];
    expect(line.unitPriceCents).toBe(2_500); // LLM price preserved, never silently replaced
    expect(line.pricingSource).toBe('ambiguous');
    expect(proposal.status).toBe('draft'); // missingFields gate
    const ctx = proposal.sourceContext as Record<string, unknown>;
    expect(ctx.missingFields).toEqual(['lineItems[0].catalogItemId']);
    const candidates = (ctx.catalogResolution as Record<number, Array<{ id: string }>>)[0];
    expect(candidates.map((c) => c.id).sort()).toEqual([airFilter.id, waterFilter.id].sort());
  });

  it('uncatalogued line caps confidence below auto-approve even at 0.95', async () => {
    const { repo } = seededCatalog();
    const gateway = createMockGateway(
      aiOutput([{ description: 'mystery flux capacitor', quantity: 1, unitPrice: 42_000 }]),
    );
    const handler = new InvoiceTaskHandler(gateway, repo);

    const { proposal } = await handler.handle(baseContext);

    const line = (proposal.payload.lineItems as Array<Record<string, unknown>>)[0];
    expect(line.unitPriceCents).toBe(42_000); // LLM price kept (user-confirmed policy)
    expect(line.pricingSource).toBe('uncatalogued');
    expect(proposal.confidenceScore).toBeLessThanOrEqual(0.85);
    expect(proposal.status).not.toBe('approved');
    expect(proposal.confidenceFactors).toContain('uncatalogued_line_item');
  });

  it('rescues a price-less LLM line when the catalog can price it', async () => {
    const { repo, heater } = seededCatalog();
    const gateway = createMockGateway(
      aiOutput([{ description: 'Water Heater Install', quantity: 1 }]), // no unitPrice at all
    );
    const handler = new InvoiceTaskHandler(gateway, repo);

    const { proposal } = await handler.handle(baseContext);

    const lines = proposal.payload.lineItems as Array<Record<string, unknown>>;
    expect(lines).toHaveLength(1); // pre-P22 behavior dropped this line entirely
    expect(lines[0].unitPriceCents).toBe(185_000);
    expect(lines[0].totalCents).toBe(185_000);
    expect(lines[0].catalogItemId).toBe(heater.id);
  });

  it('still drops price-less lines the catalog cannot rescue', async () => {
    const { repo } = seededCatalog();
    const gateway = createMockGateway(
      aiOutput([
        { description: 'mystery widget', quantity: 1 }, // no price, no match
        { description: 'Water Heater Install', quantity: 1, unitPrice: 1 },
      ]),
    );
    const handler = new InvoiceTaskHandler(gateway, repo);

    const { proposal } = await handler.handle(baseContext);

    const lines = proposal.payload.lineItems as Array<Record<string, unknown>>;
    expect(lines).toHaveLength(1);
    expect(lines[0].description).toBe('Water Heater Install');
  });

  it('degrades to LLM pricing but flags uncatalogued + caps when the catalog read throws', async () => {
    const failingRepo = {
      listByTenant: vi.fn().mockRejectedValue(new Error('db down')),
    } as unknown as CatalogItemRepository;
    const gateway = createMockGateway(
      aiOutput([{ description: 'Water Heater Install', quantity: 1, unitPrice: 99_900 }]),
    );
    const handler = new InvoiceTaskHandler(gateway, failingRepo);

    const { proposal } = await handler.handle(baseContext);

    const line = (proposal.payload.lineItems as Array<Record<string, unknown>>)[0];
    // A read failure must not block drafting — the LLM price is kept…
    expect(line.unitPriceCents).toBe(99_900);
    // …but an ungrounded price must still be flagged + capped, never silently
    // auto-approvable (money-safety regression).
    expect(line.pricingSource).toBe('uncatalogued');
    expect(proposal.confidenceFactors).toContain('uncatalogued_line_item');
    expect(proposal.confidenceScore).toBeLessThanOrEqual(UNCATALOGUED_CONFIDENCE_CAP);
  });

  it('without a catalog repo, LLM price is kept but flagged uncatalogued + capped', async () => {
    const gateway = createMockGateway(
      aiOutput([{ description: 'Water Heater Install', quantity: 1, unitPrice: 99_900 }]),
    );
    const handler = new InvoiceTaskHandler(gateway); // no repo

    const { proposal } = await handler.handle(baseContext);

    const line = (proposal.payload.lineItems as Array<Record<string, unknown>>)[0];
    expect(line.unitPriceCents).toBe(99_900);
    // No catalog to ground against → uncatalogued, capped, human-reviewed.
    // (Previously the outcome was left undefined and the cap was skipped.)
    expect(line.pricingSource).toBe('uncatalogued');
    expect(line).not.toHaveProperty('catalogItemId');
    expect(proposal.confidenceScore).toBeLessThanOrEqual(UNCATALOGUED_CONFIDENCE_CAP);
  });
});

// ─── RV-007 (F-4): Confidence Marker `_meta` ─────────────────────────────
describe('RV-007 — InvoiceTaskHandler populates payload._meta', () => {
  it('with no catalog wired, every priced line is flagged uncatalogued in _meta', async () => {
    const gateway = createMockGateway(JSON.stringify(validAiOutput)); // 0.85, 2 lines
    const handler = new InvoiceTaskHandler(gateway);

    const { proposal } = await handler.handle(baseContext);

    const meta = proposal.payload._meta as {
      overallConfidence: string;
      fieldConfidence?: Record<string, string>;
      markers?: Array<{ path: string; reason: string }>;
    };
    expect(meta).toBeDefined();
    // Any uncatalogued line forces overall 'low' so the RV-007 marker guard
    // hard-blocks auto-approval regardless of the numeric score or a tenant
    // threshold override (not just the 0.85 numeric cap).
    expect(meta.overallConfidence).toBe('low');
    // No catalog to ground against → both LLM-priced lines flagged low.
    expect(meta.fieldConfidence).toEqual({
      'lineItems[0].unitPriceCents': 'low',
      'lineItems[1].unitPriceCents': 'low',
    });
    expect(meta.markers).toHaveLength(2);
  });

  it('uncatalogued line → fieldConfidence low on its unitPriceCents + a marker with reason', async () => {
    const repo = new InMemoryCatalogItemRepository();
    void repo.create(
      createCatalogItem({
        tenantId: 'tenant-1',
        name: 'Water Heater Install',
        category: 'Labor',
        unit: 'each',
        unitPriceCents: 185_000,
      }),
    );
    const gateway = createMockGateway(
      JSON.stringify({
        ...validAiOutput,
        lineItems: [
          // 183_000 is within PRICE_CONFLICT tolerance of the catalog's
          // 185_000 — this line must ground cleanly so only the flux
          // capacitor line (uncatalogued) carries a low-confidence signal.
          { description: 'Water Heater Install', quantity: 1, unitPrice: 183_000 },
          { description: 'mystery flux capacitor', quantity: 1, unitPrice: 42_000 },
        ],
        confidence_score: 0.95,
      }),
    );
    const handler = new InvoiceTaskHandler(gateway, repo);

    const { proposal } = await handler.handle(baseContext);

    const meta = proposal.payload._meta as {
      overallConfidence: string;
      fieldConfidence?: Record<string, string>;
      markers?: Array<{ path: string; reason: string }>;
    };
    expect(meta.fieldConfidence).toEqual({ 'lineItems[1].unitPriceCents': 'low' });
    expect(meta.markers).toHaveLength(1);
    expect(meta.markers![0].path).toBe('lineItems[1].unitPriceCents');
    expect(meta.markers![0].reason).toContain('mystery flux capacitor');
    expect(meta.markers![0].reason).toContain('catalog');
  });

  it('field paths index the FINAL line items (after the drop-unpriced filter)', async () => {
    const repo = new InMemoryCatalogItemRepository(); // empty catalog → no resolution pass
    const gateway = createMockGateway(
      JSON.stringify({
        ...validAiOutput,
        lineItems: [
          { description: 'priceless garbage', quantity: 1 }, // dropped (no price)
          { description: 'real work', quantity: 1, unitPrice: 5_000 },
        ],
        confidence_score: 0.95,
      }),
    );
    const handler = new InvoiceTaskHandler(gateway, repo);

    const { proposal } = await handler.handle(baseContext);

    const lines = proposal.payload.lineItems as Array<Record<string, unknown>>;
    expect(lines).toHaveLength(1); // unpriced line dropped
    const meta = proposal.payload._meta as {
      overallConfidence: string;
      fieldConfidence?: Record<string, string>;
      markers?: Array<{ path: string; reason: string }>;
    };
    // Surviving line is uncatalogued → overall 'low' hard-blocks auto-approve.
    expect(meta.overallConfidence).toBe('low');
    // Empty catalog → the surviving priced line is uncatalogued, and its
    // marker path indexes the FINAL array (index 0), NOT the pre-drop index 1.
    expect(meta.fieldConfidence).toEqual({ 'lineItems[0].unitPriceCents': 'low' });
    expect(meta.markers).toHaveLength(1);
    expect(meta.markers![0].path).toBe('lineItems[0].unitPriceCents');
  });
});
