import { EstimateTaskHandler } from '../../src/ai/tasks/estimate-task';
import { LLMGateway } from '../../src/ai/gateway/gateway';
import type { LLMProvider, LLMGatewayConfig } from '../../src/ai/gateway/gateway';
import { StubProvider } from '../../src/ai/gateway/providers';
import { TaskContext } from '../../src/ai/tasks/task-handlers';
import {
  CatalogItem,
  createCatalogItem,
  InMemoryCatalogItemRepository,
} from '../../src/catalog/catalog-item';

function makeGateway(stub: StubProvider): LLMGateway {
  const providers = new Map<string, LLMProvider>();
  providers.set('stub', stub);
  const config: LLMGatewayConfig = {
    defaultProvider: 'stub',
    defaultModel: 'test-model',
  };
  return new LLMGateway(config, providers);
}

function makeContext(overrides: Partial<TaskContext> = {}): TaskContext {
  return {
    tenantId: 'tenant-1',
    message: 'Generate an estimate for plumbing repair',
    userId: 'user-1',
    ...overrides,
  };
}

const validEstimateJson = JSON.stringify({
  customerId: '550e8400-e29b-41d4-a716-446655440000',
  jobId: '660e8400-e29b-41d4-a716-446655440000',
  lineItems: [
    { description: 'Pipe repair', quantity: 2, unitPrice: 75.0, category: 'plumbing' },
    { description: 'Labor', quantity: 3, unitPrice: 50.0 },
  ],
  notes: 'Estimate for kitchen plumbing',
  validUntil: '2026-04-15',
  confidence_score: 0.85,
});

describe('P2-016 — Estimate draft proposal generation', () => {
  it('happy path — generates estimate proposal from context', async () => {
    const stub = new StubProvider('stub');
    stub.setResponse({ content: validEstimateJson });
    const gateway = makeGateway(stub);
    const handler = new EstimateTaskHandler(gateway);

    const result = await handler.handle(makeContext());

    expect(result.taskType).toBe('draft_estimate');
    expect(result.proposal.proposalType).toBe('draft_estimate');
    expect(result.proposal.status).toBe('draft');
    expect(result.proposal.tenantId).toBe('tenant-1');
    expect(result.proposal.createdBy).toBe('user-1');

    const payload = result.proposal.payload;
    expect(payload.customerId).toBe('550e8400-e29b-41d4-a716-446655440000');
    expect(payload.jobId).toBe('660e8400-e29b-41d4-a716-446655440000');
    expect(Array.isArray(payload.lineItems)).toBe(true);
    expect((payload.lineItems as unknown[]).length).toBe(2);
    expect(payload.notes).toBe('Estimate for kitchen plumbing');
  });

  it('happy path — sets confidence from AI response', async () => {
    const stub = new StubProvider('stub');
    stub.setResponse({ content: validEstimateJson });
    const gateway = makeGateway(stub);
    const handler = new EstimateTaskHandler(gateway);

    const result = await handler.handle(makeContext());

    expect(result.proposal.confidenceScore).toBe(0.85);
    expect(result.proposal.confidenceFactors).toBeDefined();
    expect(result.proposal.confidenceFactors!.length).toBeGreaterThan(0);
    expect(result.proposal.confidenceFactors).toContain('model_provided_confidence');
  });

  it('validation — handles missing context gracefully', async () => {
    const stub = new StubProvider('stub');
    stub.setResponse({
      content: JSON.stringify({
        customerId: '550e8400-e29b-41d4-a716-446655440000',
        lineItems: [{ description: 'Basic service', quantity: 1, unitPrice: 100 }],
      }),
    });
    const gateway = makeGateway(stub);
    const handler = new EstimateTaskHandler(gateway);

    const context = makeContext({ existingEntities: undefined, conversationId: undefined });
    const result = await handler.handle(context);

    expect(result.proposal.proposalType).toBe('draft_estimate');
    expect(result.proposal.sourceContext).toBeUndefined();

    const lastRequest = stub.getLastRequest();
    expect(lastRequest).toBeDefined();
    expect(lastRequest!.taskType).toBe('draft_estimate');
  });

  it('mock provider test — stub provider returns estimate JSON', async () => {
    const stub = new StubProvider('stub');
    stub.setResponse({ content: validEstimateJson });
    const gateway = makeGateway(stub);
    const handler = new EstimateTaskHandler(gateway);

    const context = makeContext({
      conversationId: 'conv-123',
      existingEntities: { customerName: 'Acme Corp' },
    });
    const result = await handler.handle(context);

    const lastRequest = stub.getLastRequest();
    expect(lastRequest).toBeDefined();
    expect(lastRequest!.taskType).toBe('draft_estimate');
    expect(lastRequest!.responseFormat).toBe('json');
    expect(lastRequest!.messages.length).toBe(2);
    expect(lastRequest!.messages[0].role).toBe('system');
    expect(lastRequest!.messages[1].role).toBe('user');
    expect(lastRequest!.messages[1].content).toContain('Acme Corp');

    expect(result.proposal.sourceContext).toEqual({ conversationId: 'conv-123' });
  });

  it('malformed AI output handled gracefully — invalid JSON creates partial proposal', async () => {
    const stub = new StubProvider('stub');
    stub.setResponse({ content: 'This is not valid JSON at all' });
    const gateway = makeGateway(stub);
    const handler = new EstimateTaskHandler(gateway);

    const result = await handler.handle(makeContext());

    expect(result.proposal.proposalType).toBe('draft_estimate');
    expect(result.proposal.status).toBe('draft');
    expect(result.proposal.payload.lineItems).toEqual([]);
    expect(result.proposal.payload.notes).toBe('AI output could not be parsed');
  });

  it('malformed AI output handled gracefully — missing required fields handled', async () => {
    const stub = new StubProvider('stub');
    stub.setResponse({
      content: JSON.stringify({ notes: 'Some notes but no lineItems or customerId' }),
    });
    const gateway = makeGateway(stub);
    const handler = new EstimateTaskHandler(gateway);

    const result = await handler.handle(makeContext());

    expect(result.proposal.proposalType).toBe('draft_estimate');
    expect(result.proposal.payload.lineItems).toEqual([]);
    expect(result.proposal.payload.customerId).toBeUndefined();
    expect(result.proposal.payload.notes).toBe('Some notes but no lineItems or customerId');
  });

  // ── D3 trust-tier adoption ─────────────────────────────────────────
  //
  // EstimateTaskHandler is called from the CaptureAgent pipeline.
  // draft_estimate is capture-class. The handler passes
  // sourceTrustTier='autonomous', so proposals at confidence ≥ 0.9
  // land in 'approved' status without human review. Confidence < 0.9
  // still goes through the human gate. This proves the D3 wiring from
  // step 5b fires on the production AI path.

  it('D3: high-confidence draft_estimate auto-approves (capture + autonomous + ≥0.9)', async () => {
    const stub = new StubProvider('stub');
    stub.setResponse({
      content: JSON.stringify({
        customerId: '550e8400-e29b-41d4-a716-446655440000',
        jobId: '660e8400-e29b-41d4-a716-446655440000',
        lineItems: [
          { description: 'Pipe repair', quantity: 1, unitPrice: 75.0 },
        ],
        confidence_score: 0.95,
      }),
    });
    const gateway = makeGateway(stub);
    const handler = new EstimateTaskHandler(gateway);

    const result = await handler.handle(makeContext());

    expect(result.proposal.proposalType).toBe('draft_estimate');
    expect(result.proposal.confidenceScore).toBe(0.95);
    expect(result.proposal.status).toBe('approved');
  });

  it('D3: low-confidence draft_estimate still lands in draft for review', async () => {
    // 0.5 is below the 0.9 threshold even with autonomous tier.
    const stub = new StubProvider('stub');
    stub.setResponse({
      content: JSON.stringify({
        customerId: '550e8400-e29b-41d4-a716-446655440000',
        lineItems: [{ description: 'Maybe something', quantity: 1, unitPrice: 50.0 }],
        confidence_score: 0.5,
      }),
    });
    const gateway = makeGateway(stub);
    const handler = new EstimateTaskHandler(gateway);

    const result = await handler.handle(makeContext());

    expect(result.proposal.confidenceScore).toBe(0.5);
    expect(result.proposal.status).toBe('draft');
  });
});

// ─── P22: catalog grounding (mirror of the invoice handler cases; this
// contract's price field is `unitPrice`, integer cents) ─────────────────
describe('P22 — EstimateTaskHandler catalog grounding', () => {
  function seededCatalog(): { repo: InMemoryCatalogItemRepository; heater: CatalogItem } {
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
    return { repo, heater };
  }

  function estimateJson(lineItems: unknown[], confidence = 0.95): string {
    return JSON.stringify({
      customerId: '550e8400-e29b-41d4-a716-446655440000',
      lineItems,
      confidence_score: confidence,
    });
  }

  it('catalog match writes the catalog price into unitPrice', async () => {
    const { repo, heater } = seededCatalog();
    const stub = new StubProvider('stub');
    stub.setResponse({
      content: estimateJson([{ description: 'Water Heater Install', quantity: 1, unitPrice: 999 }]),
    });
    const handler = new EstimateTaskHandler(makeGateway(stub), repo);

    const { proposal } = await handler.handle(makeContext());

    const line = (proposal.payload.lineItems as Array<Record<string, unknown>>)[0];
    expect(line.unitPrice).toBe(185_000);
    expect(line.catalogItemId).toBe(heater.id);
    expect(line.pricingSource).toBe('catalog');
    expect(line).not.toHaveProperty('totalCents'); // estimate contract has no per-line totals
    expect(proposal.confidenceFactors).toContain('catalog_priced');
  });

  it('ambiguous match forces draft with missingFields + candidates', async () => {
    const { repo } = seededCatalog();
    const stub = new StubProvider('stub');
    stub.setResponse({
      content: estimateJson([{ description: 'filter', quantity: 1, unitPrice: 2_500 }]),
    });
    const handler = new EstimateTaskHandler(makeGateway(stub), repo);

    const { proposal } = await handler.handle(makeContext());

    const line = (proposal.payload.lineItems as Array<Record<string, unknown>>)[0];
    expect(line.unitPrice).toBe(2_500);
    expect(line.pricingSource).toBe('ambiguous');
    expect(proposal.status).toBe('draft');
    const ctx = proposal.sourceContext as Record<string, unknown>;
    expect(ctx.missingFields).toEqual(['lineItems[0].catalogItemId']);
    expect(ctx.catalogResolution).toBeDefined();
  });

  it('uncatalogued line caps confidence below auto-approve', async () => {
    const { repo } = seededCatalog();
    const stub = new StubProvider('stub');
    stub.setResponse({
      content: estimateJson([{ description: 'mystery flux capacitor', quantity: 1, unitPrice: 9_900 }]),
    });
    const handler = new EstimateTaskHandler(makeGateway(stub), repo);

    const { proposal } = await handler.handle(makeContext());

    expect(proposal.confidenceScore).toBeLessThanOrEqual(0.85);
    expect(proposal.status).not.toBe('approved');
    expect(proposal.confidenceFactors).toContain('uncatalogued_line_item');
  });

  it('without a catalog repo, behavior is unchanged (regression pin)', async () => {
    const stub = new StubProvider('stub');
    stub.setResponse({
      content: estimateJson([{ description: 'Water Heater Install', quantity: 1, unitPrice: 999 }]),
    });
    const handler = new EstimateTaskHandler(makeGateway(stub)); // no repo

    const { proposal } = await handler.handle(makeContext());

    const line = (proposal.payload.lineItems as Array<Record<string, unknown>>)[0];
    expect(line.unitPrice).toBe(999);
    expect(line).not.toHaveProperty('pricingSource');
  });
});

// ─── RV-007 (F-4): Confidence Marker `_meta` ─────────────────────────────
describe('RV-007 — EstimateTaskHandler populates payload._meta', () => {
  function seededCatalog(): InMemoryCatalogItemRepository {
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
    return repo;
  }

  it('sets overallConfidence from the task confidence score (no per-field signal → overall-only)', async () => {
    const stub = new StubProvider('stub');
    stub.setResponse({ content: validEstimateJson }); // confidence_score 0.85
    const handler = new EstimateTaskHandler(makeGateway(stub));

    const { proposal } = await handler.handle(makeContext());

    const meta = proposal.payload._meta as Record<string, unknown>;
    expect(meta).toBeDefined();
    expect(meta.overallConfidence).toBe('high'); // 0.85 ≥ 0.8
    expect(meta.fieldConfidence).toBeUndefined();
    expect(meta.markers).toBeUndefined();
  });

  it('maps a mid confidence score to medium', async () => {
    const stub = new StubProvider('stub');
    stub.setResponse({
      content: JSON.stringify({
        customerId: '550e8400-e29b-41d4-a716-446655440000',
        lineItems: [{ description: 'Something', quantity: 1, unitPrice: 50 }],
        confidence_score: 0.6,
      }),
    });
    const handler = new EstimateTaskHandler(makeGateway(stub));

    const { proposal } = await handler.handle(makeContext());

    expect((proposal.payload._meta as Record<string, unknown>).overallConfidence).toBe('medium');
  });

  it('uncatalogued line → fieldConfidence low on its unitPrice + a marker with reason', async () => {
    const repo = seededCatalog();
    const stub = new StubProvider('stub');
    stub.setResponse({
      content: JSON.stringify({
        customerId: '550e8400-e29b-41d4-a716-446655440000',
        lineItems: [
          { description: 'Water Heater Install', quantity: 1, unitPrice: 999 },
          { description: 'mystery flux capacitor', quantity: 1, unitPrice: 9_900 },
        ],
        confidence_score: 0.95,
      }),
    });
    const handler = new EstimateTaskHandler(makeGateway(stub), repo);

    const { proposal } = await handler.handle(makeContext());

    const meta = proposal.payload._meta as {
      overallConfidence: string;
      fieldConfidence?: Record<string, string>;
      markers?: Array<{ path: string; reason: string }>;
    };
    expect(meta.fieldConfidence).toEqual({ 'lineItems[1].unitPrice': 'low' });
    expect(meta.markers).toHaveLength(1);
    expect(meta.markers![0].path).toBe('lineItems[1].unitPrice');
    expect(meta.markers![0].reason).toContain('mystery flux capacitor');
    expect(meta.markers![0].reason).toContain('catalog');
  });
});
