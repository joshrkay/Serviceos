/**
 * U2 — MMS-to-quote vision task unit tests (mocked gateway/repos).
 *
 * Covers the task in isolation: it drafts line items from photo + context,
 * grounds prices against the tenant catalog, caps uncatalogued-line
 * confidence below auto-approve, creates a draft_estimate proposal (never
 * auto-approved), and falls back safely on a vision-parse failure.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  MmsEstimateTaskHandler,
  MMS_ESTIMATE_TASK_TYPE,
  type MmsEstimateInput,
} from '../../../src/ai/tasks/mms-estimate-task';
import { LLMGateway } from '../../../src/ai/gateway/gateway';
import type {
  LLMProvider,
  LLMGatewayConfig,
  LLMResponse,
  LLMRequest,
} from '../../../src/ai/gateway/gateway';
import { StubProvider } from '../../../src/ai/gateway/providers';
import {
  createCatalogItem,
  InMemoryCatalogItemRepository,
} from '../../../src/catalog/catalog-item';
import { UNCATALOGUED_CONFIDENCE_CAP } from '../../../src/ai/resolution/catalog-resolver';

const CUSTOMER_ID = '550e8400-e29b-41d4-a716-446655440000';
const TENANT = 'tenant-1';

function makeGateway(stub: StubProvider): LLMGateway {
  const providers = new Map<string, LLMProvider>();
  providers.set('stub', stub);
  const config: LLMGatewayConfig = { defaultProvider: 'stub', defaultModel: 'test-model' };
  return new LLMGateway(config, providers);
}

/** A gateway whose single complete() call rejects — proves the safe fallback. */
function failingGateway(message = 'provider exploded'): LLMGateway {
  return {
    complete: vi.fn(async () => {
      throw new Error(message);
    }),
  } as unknown as LLMGateway;
}

function makeInput(overrides: Partial<MmsEstimateInput> = {}): MmsEstimateInput {
  return {
    tenantId: TENANT,
    customerId: CUSTOMER_ID,
    images: [{ url: 'https://files.example/presigned/photo-1.jpg', contentType: 'image/jpeg' }],
    createdBy: 'system:test',
    ...overrides,
  };
}

const validVisionJson = JSON.stringify({
  lineItems: [
    { description: 'Water heater replacement', quantity: 1, unitPrice: 120000, category: 'labor' },
    { description: 'Pressure relief valve', quantity: 1, unitPrice: 4500, category: 'material' },
  ],
  notes: 'Tank is corroded at the base; recommend full replacement.',
  confidence_score: 0.82,
});

async function catalogWith(
  items: Array<{ name: string; unitPriceCents: number; category?: 'Labor' | 'Parts' | 'Materials' }>,
): Promise<InMemoryCatalogItemRepository> {
  const repo = new InMemoryCatalogItemRepository();
  for (const it of items) {
    await repo.create(
      createCatalogItem({
        tenantId: TENANT,
        name: it.name,
        category: it.category ?? 'Labor',
        unit: 'each',
        unitPriceCents: it.unitPriceCents,
      }),
    );
  }
  return repo;
}

describe('U2 — MmsEstimateTaskHandler', () => {
  it('happy path — drafts a draft_estimate proposal from photo + context', async () => {
    const stub = new StubProvider('stub');
    stub.setResponse({ content: validVisionJson });
    const handler = new MmsEstimateTaskHandler(makeGateway(stub));

    const result = await handler.handle(
      makeInput({ message: 'My water heater is leaking', context: { customerName: 'Acme' } }),
    );

    expect(result.status).toBe('drafted');
    if (result.status !== 'drafted') throw new Error('expected drafted');
    expect(result.proposal.proposalType).toBe('draft_estimate');
    expect(result.proposal.tenantId).toBe(TENANT);
    // Injected (not model-invented) customer reference.
    expect(result.proposal.payload.customerId).toBe(CUSTOMER_ID);
    const lineItems = result.proposal.payload.lineItems as Array<Record<string, unknown>>;
    expect(lineItems).toHaveLength(2);
    expect(result.proposal.payload.notes).toContain('corroded');
  });

  it('sends the photo as an image_url block on a multimodal user message', async () => {
    const stub = new StubProvider('stub');
    stub.setResponse({ content: validVisionJson });
    const handler = new MmsEstimateTaskHandler(makeGateway(stub));

    await handler.handle(
      makeInput({
        images: [
          { url: 'https://files.example/p1.jpg', contentType: 'image/jpeg' },
          { url: 'https://files.example/p2.png', contentType: 'image/png' },
        ],
      }),
    );

    const req = stub.getLastRequest() as LLMRequest;
    expect(req.taskType).toBe(MMS_ESTIMATE_TASK_TYPE);
    expect(req.responseFormat).toBe('json');
    const userMsg = req.messages[1];
    // Text context goes in `content`; one image part per photo in `parts`.
    expect(typeof userMsg.content).toBe('string');
    const imageParts = (userMsg.parts ?? []).filter((p) => p.type === 'image');
    expect(imageParts).toHaveLength(2);
    expect((imageParts[0] as { url: string }).url).toBe('https://files.example/p1.jpg');
  });

  it('catalog grounding — overrides the model price with the matched catalog price', async () => {
    const stub = new StubProvider('stub');
    stub.setResponse({ content: validVisionJson });
    // Catalog priced at 95000c; the model emitted 120000c — catalog wins.
    const catalogRepo = await catalogWith([
      { name: 'Water heater replacement', unitPriceCents: 95000, category: 'Labor' },
      { name: 'Pressure relief valve', unitPriceCents: 4000, category: 'Parts' },
    ]);
    const handler = new MmsEstimateTaskHandler(makeGateway(stub), catalogRepo);

    const result = await handler.handle(makeInput());
    if (result.status !== 'drafted') throw new Error('expected drafted');

    const lineItems = result.proposal.payload.lineItems as Array<Record<string, unknown>>;
    const heater = lineItems.find((li) => String(li.description).includes('Water heater'));
    expect(heater?.unitPrice).toBe(95000);
    expect(heater?.pricingSource).toBe('catalog');
    expect(result.proposal.confidenceFactors).toContain('catalog_priced');
  });

  it('caps uncatalogued-line confidence ≤ 0.85 and never auto-approves', async () => {
    const stub = new StubProvider('stub');
    // High model confidence so only the uncatalogued cap can hold it down.
    stub.setResponse({
      content: JSON.stringify({
        lineItems: [{ description: 'Bespoke artisan flux capacitor', quantity: 1, unitPrice: 99999 }],
        confidence_score: 0.99,
      }),
    });
    // Catalog has an unrelated item, so the drafted line is uncatalogued.
    const catalogRepo = await catalogWith([{ name: 'Drain cleaning', unitPriceCents: 15000 }]);
    const handler = new MmsEstimateTaskHandler(makeGateway(stub), catalogRepo);

    const result = await handler.handle(makeInput());
    if (result.status !== 'drafted') throw new Error('expected drafted');

    expect(result.proposal.confidenceScore).toBeLessThanOrEqual(UNCATALOGUED_CONFIDENCE_CAP);
    expect(result.proposal.confidenceFactors).toContain('uncatalogued_line_item');
    // Photo-sourced draft lands in the owner queue — never auto-approved.
    expect(result.proposal.status).not.toBe('approved');
    const lineItems = result.proposal.payload.lineItems as Array<Record<string, unknown>>;
    expect(lineItems[0].pricingSource).toBe('uncatalogued');
    // RV-007 confidence marker present for the AI-estimated price.
    const meta = result.proposal.payload._meta as { markers?: unknown[] };
    expect(meta.markers && meta.markers.length).toBeGreaterThan(0);
  });

  it('proposal is created but not auto-approved even with no catalog (capture-class draft)', async () => {
    const stub = new StubProvider('stub');
    stub.setResponse({ content: validVisionJson });
    const handler = new MmsEstimateTaskHandler(makeGateway(stub));

    const result = await handler.handle(makeInput());
    if (result.status !== 'drafted') throw new Error('expected drafted');
    expect(['draft', 'ready_for_review']).toContain(result.proposal.status);
    expect(result.proposal.confidenceFactors).toContain('mms_vision_source');
  });

  it('ambiguous catalog match forces draft via missingFields (operator picks the item)', async () => {
    const stub = new StubProvider('stub');
    stub.setResponse({
      content: JSON.stringify({
        lineItems: [{ description: 'valve', quantity: 1, unitPrice: 5000 }],
        confidence_score: 0.9,
      }),
    });
    // Two same-token, different-price catalog items → ambiguous.
    const catalogRepo = await catalogWith([
      { name: 'valve repair', unitPriceCents: 4000, category: 'Parts' },
      { name: 'valve install', unitPriceCents: 9000, category: 'Parts' },
    ]);
    const handler = new MmsEstimateTaskHandler(makeGateway(stub), catalogRepo);

    const result = await handler.handle(makeInput());
    if (result.status !== 'drafted') throw new Error('expected drafted');
    expect(result.proposal.status).toBe('draft');
    const lineItems = result.proposal.payload.lineItems as Array<Record<string, unknown>>;
    expect(lineItems[0].pricingSource).toBe('ambiguous');
  });

  it('vision parse failure — non-JSON content → safe fallback (no proposal, no crash)', async () => {
    const stub = new StubProvider('stub');
    stub.setResponse({ content: 'I cannot make out the photo, sorry!' });
    const handler = new MmsEstimateTaskHandler(makeGateway(stub));

    const result = await handler.handle(makeInput());
    expect(result.status).toBe('parse_failed');
    if (result.status !== 'parse_failed') throw new Error('expected parse_failed');
    expect(result.reason).toBe('vision_parse_empty');
  });

  it('empty line items → safe fallback (cannot draft an empty estimate)', async () => {
    const stub = new StubProvider('stub');
    stub.setResponse({ content: JSON.stringify({ lineItems: [], confidence_score: 0.4 }) });
    const handler = new MmsEstimateTaskHandler(makeGateway(stub));

    const result = await handler.handle(makeInput());
    expect(result.status).toBe('parse_failed');
  });

  it('gateway/provider error → safe fallback, never throws', async () => {
    const handler = new MmsEstimateTaskHandler(failingGateway());
    await expect(handler.handle(makeInput())).resolves.toMatchObject({ status: 'parse_failed' });
  });

  it('no images → safe fallback (defensive guard)', async () => {
    const stub = new StubProvider('stub');
    stub.setResponse({ content: validVisionJson });
    const handler = new MmsEstimateTaskHandler(makeGateway(stub));
    const result = await handler.handle(makeInput({ images: [] }));
    expect(result.status).toBe('parse_failed');
    if (result.status !== 'parse_failed') throw new Error('expected parse_failed');
    expect(result.reason).toBe('no_images');
  });

  it('malformed line item the contract rejects → safe fallback, not a crash', async () => {
    const stub = new StubProvider('stub');
    // No price field at all, and no catalog to fill it → contract rejects
    // (lineItem requires unitPrice or unitPriceCents).
    stub.setResponse({
      content: JSON.stringify({
        lineItems: [{ description: 'mystery work', quantity: 1 }],
        confidence_score: 0.5,
      }),
    });
    const handler = new MmsEstimateTaskHandler(makeGateway(stub));
    const result = await handler.handle(makeInput());
    expect(result.status).toBe('parse_failed');
    if (result.status !== 'parse_failed') throw new Error('expected parse_failed');
    expect(result.reason).toBe('invalid_payload');
  });
});
