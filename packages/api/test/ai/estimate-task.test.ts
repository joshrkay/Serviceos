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
    // Prices stay within PRICE_CONFLICT_MIN_ABS_CENTS (100¢) of the
    // groundedCatalog() price (7500) so these lines snap cleanly to the
    // catalog instead of tripping the "did you mean" price-conflict path —
    // several tests reusing this fixture assert clean grounding.
    { description: 'Pipe repair', quantity: 2, unitPrice: 7460, category: 'plumbing' },
    { description: 'Labor', quantity: 3, unitPrice: 7540 },
  ],
  notes: 'Estimate for kitchen plumbing',
  validUntil: '2026-04-15',
  confidence_score: 0.85,
});

/**
 * A catalog that grounds the line descriptions used in these tests. Grounding
 * is now REQUIRED for an estimate to flow at full confidence / auto-approve:
 * an LLM-invented price with no catalog to check against is treated as
 * uncatalogued (confidence capped + clarification), so the "happy path" and
 * "auto-approve" cases must supply a real catalog to be genuinely grounded.
 */
async function groundedCatalog(): Promise<InMemoryCatalogItemRepository> {
  const repo = new InMemoryCatalogItemRepository();
  for (const name of ['Pipe repair', 'Labor', 'AC repair']) {
    await repo.create(
      createCatalogItem({
        tenantId: 'tenant-1',
        name,
        category: name === 'Labor' ? 'Labor' : 'Parts',
        unit: 'each',
        unitPriceCents: 7500,
      }),
    );
  }
  return repo;
}

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

  it('happy path — sets confidence from AI response (catalog-grounded)', async () => {
    const stub = new StubProvider('stub');
    stub.setResponse({ content: validEstimateJson });
    const gateway = makeGateway(stub);
    // Grounded against a catalog so the LLM price is trusted and the model's
    // confidence flows through uncapped.
    const handler = new EstimateTaskHandler(gateway, await groundedCatalog());

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
          // Within PRICE_CONFLICT tolerance (< 100¢) of groundedCatalog()'s
          // 7500 so the line snaps to the catalog instead of conflicting.
          { description: 'Pipe repair', quantity: 1, unitPrice: 7460 },
        ],
        confidence_score: 0.95,
      }),
    });
    const gateway = makeGateway(stub);
    // Auto-approve now REQUIRES catalog-grounded pricing — an all-LLM-priced
    // estimate is uncatalogued and capped, so it could never reach 'approved'.
    const handler = new EstimateTaskHandler(gateway, await groundedCatalog());

    const result = await handler.handle(makeContext());

    expect(result.proposal.proposalType).toBe('draft_estimate');
    expect(result.proposal.confidenceScore).toBe(0.95);
    expect(result.proposal.status).toBe('approved');
  });

  it('D3: no-catalog estimate is capped + clarified, cannot auto-approve (money-safety)', async () => {
    // Regression: an empty/unwired catalog previously skipped the uncatalogued
    // cap entirely, letting a fully LLM-priced estimate auto-approve at ≥0.9.
    const stub = new StubProvider('stub');
    stub.setResponse({
      content: JSON.stringify({
        customerId: '550e8400-e29b-41d4-a716-446655440000',
        jobId: '660e8400-e29b-41d4-a716-446655440000',
        lineItems: [{ description: 'Pipe repair', quantity: 1, unitPrice: 75.0 }],
        confidence_score: 0.95,
      }),
    });
    const handler = new EstimateTaskHandler(makeGateway(stub)); // no catalog

    const result = await handler.handle(makeContext());

    const line = (result.proposal.payload.lineItems as Array<Record<string, unknown>>)[0];
    expect(line.pricingSource).toBe('uncatalogued');
    expect(result.proposal.confidenceFactors).toContain('uncatalogued_line_item');
    // Escalated to clarification and well below the 0.9 auto-approve threshold.
    expect(result.proposal.confidenceScore).toBeLessThan(0.9);
    expect(result.proposal.status).not.toBe('approved');
    const clar = result.proposal.payload.clarification as { needed: boolean };
    expect(clar.needed).toBe(true);
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

// ─── 7.2: Clarifying questions (max 3 loops) ─────────────────────────────
describe('7.2 — EstimateTaskHandler clarification policy', () => {
  // No customerId + a zero-quantity line → genuinely ambiguous.
  const ambiguousJson = JSON.stringify({
    lineItems: [{ description: 'AC repair', quantity: 0, unitPrice: 12000 }],
    confidence_score: 0.95,
  });

  it('a grounded estimate needs no clarification', async () => {
    const stub = new StubProvider('stub');
    stub.setResponse({ content: validEstimateJson });
    // Genuinely grounded: catalog matches every line, so no uncatalogued_price
    // clarification is raised.
    const handler = new EstimateTaskHandler(makeGateway(stub), await groundedCatalog());

    const { proposal } = await handler.handle(makeContext());

    const clar = proposal.payload.clarification as {
      needed: boolean; flaggedForReview: boolean; questions: string[];
    };
    expect(clar.needed).toBe(false);
    expect(clar.flaggedForReview).toBe(false);
    expect(clar.questions).toEqual([]);
  });

  it('an ambiguous draft asks targeted questions and cannot auto-approve', async () => {
    const stub = new StubProvider('stub');
    stub.setResponse({ content: ambiguousJson });
    const handler = new EstimateTaskHandler(makeGateway(stub));

    const { proposal } = await handler.handle(
      makeContext({ message: 'AC repair for the upstairs unit' }),
    );

    const clar = proposal.payload.clarification as {
      needed: boolean; questions: string[]; flaggedForReview: boolean; capped: boolean;
    };
    expect(clar.needed).toBe(true);
    expect(clar.capped).toBe(false);
    expect(clar.flaggedForReview).toBe(false);
    expect(clar.questions.length).toBeGreaterThan(0);
    // Despite the model's 0.95, an open-questions draft is held for review.
    expect(proposal.status).not.toBe('approved');
    expect(proposal.confidenceFactors).toContain('clarification_pending');
  });

  it('after the 3-loop cap, proposes a best-effort estimate flagged for review', async () => {
    const stub = new StubProvider('stub');
    stub.setResponse({ content: ambiguousJson });
    const handler = new EstimateTaskHandler(makeGateway(stub));

    const { proposal } = await handler.handle(
      makeContext({ message: 'AC repair for the upstairs unit', clarificationCount: 3 }),
    );

    const clar = proposal.payload.clarification as {
      needed: boolean; flaggedForReview: boolean; capped: boolean;
    };
    expect(clar.capped).toBe(true);
    expect(clar.flaggedForReview).toBe(true);
    expect(clar.needed).toBe(false); // stops asking — drafts instead
    expect(proposal.status).not.toBe('approved');
    expect(proposal.confidenceFactors).toContain('flagged_for_review');
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
      // 183_000 is within PRICE_CONFLICT tolerance (~1.1% deviation) of the
      // catalog's 185_000 — close enough that this is a snap/overwrite, not
      // a "did you mean" price conflict.
      content: estimateJson([{ description: 'Water Heater Install', quantity: 1, unitPrice: 183_000 }]),
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

  it('a drafted price that conflicts with an exact catalog match keeps the spoken price and forces review', async () => {
    const { repo, heater } = seededCatalog();
    const stub = new StubProvider('stub');
    stub.setResponse({
      // 99_900 vs the catalog's 185_000 is a "did you mean" price conflict
      // (well past both PRICE_CONFLICT thresholds), not a mishear — the
      // operator may have deliberately quoted a custom price.
      content: estimateJson(
        [{ description: 'Water Heater Install', quantity: 1, unitPrice: 99_900 }],
        0.95,
      ),
    });
    const handler = new EstimateTaskHandler(makeGateway(stub), repo);

    const { proposal } = await handler.handle(makeContext());

    const line = (proposal.payload.lineItems as Array<Record<string, unknown>>)[0];
    // Spoken price kept verbatim — never silently overwritten.
    expect(line.unitPrice).toBe(99_900);
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

    // The conflict gates via missingFields (cleared by one-tap resolution),
    // NOT a persisted 'low' stamp — that stamp is never lifted by resolution
    // and would keep blocking chain-set/SMS approval after the pick. The
    // estimate handler's clarification cap maps the ambiguous draft to
    // 'medium' — score-derived, NOT the sticky 'low'.
    const meta = proposal.payload._meta as Record<string, unknown>;
    expect(meta.overallConfidence).toBe('medium');
  });

  it('ambiguous match forces draft with missingFields + candidates', async () => {
    const { repo } = seededCatalog();
    const stub = new StubProvider('stub');
    stub.setResponse({
      // confidence 0.95 — high enough that, pre-`requiresReview`, the hand-rolled
      // `anyUncatalogued` ternary would have left overallConfidence at 'high'
      // for a purely-ambiguous (not uncatalogued) line.
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
    // Ambiguous-only lines keep their score-derived confidence: the gate is
    // missingFields (cleared by one-tap resolution), NOT a persisted 'low'
    // stamp, which resolution never lifts and would keep blocking
    // chain-set/SMS approval after the operator picks.
    expect(proposal.confidenceFactors).not.toContain('uncatalogued_line_item');
    // Score-derived via the estimate handler's clarification cap ('medium'),
    // NOT the sticky 'low' that resolution could never lift.
    const meta = proposal.payload._meta as Record<string, unknown>;
    expect(meta.overallConfidence).toBe('medium');
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

  it('without a catalog repo, LLM price is kept but flagged uncatalogued + capped', async () => {
    const stub = new StubProvider('stub');
    stub.setResponse({
      content: estimateJson([{ description: 'Water Heater Install', quantity: 1, unitPrice: 999 }]),
    });
    const handler = new EstimateTaskHandler(makeGateway(stub)); // no repo

    const { proposal } = await handler.handle(makeContext());

    const line = (proposal.payload.lineItems as Array<Record<string, unknown>>)[0];
    // LLM price is kept (nothing to override it)…
    expect(line.unitPrice).toBe(999);
    // …but with no catalog to ground against it is uncatalogued + capped,
    // never silently auto-approvable (previously left unflagged).
    expect(line.pricingSource).toBe('uncatalogued');
    expect(proposal.confidenceScore).toBeLessThanOrEqual(0.85);
    expect(proposal.confidenceFactors).toContain('uncatalogued_line_item');
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
    // Grounded so no line carries a low-certainty pricing source — the whole
    // point of this case is "overall-only, no per-field signals".
    const handler = new EstimateTaskHandler(makeGateway(stub), await groundedCatalog());

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
        // Catalog-grounded (see groundedCatalog) so the score→level mapping is
        // what's under test — an uncatalogued line would force 'low'. Kept
        // within PRICE_CONFLICT tolerance (< 100¢) of the catalog's 7500 so
        // the line snaps cleanly instead of conflicting.
        lineItems: [{ description: 'Labor', quantity: 1, unitPrice: 7460 }],
        confidence_score: 0.6,
      }),
    });
    const handler = new EstimateTaskHandler(makeGateway(stub), await groundedCatalog());

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
          // 183_000 is within PRICE_CONFLICT tolerance of the catalog's
          // 185_000 — this line must ground cleanly so only the flux
          // capacitor line (uncatalogued) carries a low-confidence signal.
          { description: 'Water Heater Install', quantity: 1, unitPrice: 183_000 },
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
