/**
 * WS5 / WS17 — in-call grounded quoting at handleCreateProposal.
 *
 * Drives the real FSM + voice-turn processor through a draft_estimate /
 * draft_invoice confirm flow (classify → "yes") and asserts:
 *   - the stored payload carries grounded lineItems (catalog price +
 *     pricingSource per line) alongside the raw entities;
 *   - an uncatalogued line caps confidence and forces _meta 'low';
 *   - the caller hears the grounded read-back (or the no-number line);
 *   - catalog unavailable degrades to the no-number phrasing;
 *   - WS17 I1: a spoken leading quantity ("three smoke detectors") grounds at
 *     that quantity; a size ("2 inch pipe fitting") stays quantity 1;
 *   - WS17 I3: draft_invoice is grounded too, on the unitPriceCents contract
 *     (185000 cents speaks $1850.00), while a non-extended proposal type
 *     (record_payment) keeps the fixed generic confirmation line.
 */
import { describe, it, expect, vi } from 'vitest';

import { createVoiceTurnProcessor } from '../../../src/ai/voice-turn';
import { VoiceSessionStore } from '../../../src/ai/agents/customer-calling/voice-session-store';
import { InMemoryProposalRepository } from '../../../src/proposals/proposal';
import type { LLMGateway, LLMResponse } from '../../../src/ai/gateway/gateway';
import type { CatalogItem, CatalogItemRepository } from '../../../src/catalog/catalog-item';
import type { SideEffect } from '../../../src/ai/agents/customer-calling/types';

function catalogItem(name: string, unitPriceCents: number): CatalogItem {
  const now = new Date().toISOString();
  return {
    id: `c-${name.toLowerCase().replace(/\s+/g, '-')}`,
    tenantId: 'tenant-abc',
    name,
    description: '',
    category: 'Parts',
    unit: 'each',
    unitPriceCents,
    productServiceType: 'product',
    archivedAt: null,
    createdAt: now,
    updatedAt: now,
  };
}

const CATALOG: CatalogItem[] = [
  catalogItem('Water Heater Replacement', 185000),
  catalogItem('Gasket', 450),
  // WS17 I1 fixtures — a countable item and a size-named item.
  catalogItem('Smoke Detector', 8900),
  catalogItem('2 Inch Pipe Fitting', 1200),
];

function stubCatalogRepo(
  items: CatalogItem[] = CATALOG,
  opts: { throws?: boolean } = {},
): CatalogItemRepository {
  return {
    listByTenant: async () => {
      if (opts.throws) throw new Error('catalog db down');
      return items;
    },
  } as unknown as CatalogItemRepository;
}

function gatewaySequence(contents: string[]): LLMGateway {
  const responses: LLMResponse[] = contents.map((content) => ({
    content,
    model: 'mock-model',
    provider: 'mock',
    tokenUsage: { input: 1, output: 1, total: 2 },
    latencyMs: 1,
  }));
  let i = 0;
  return {
    complete: vi.fn().mockImplementation(async () => responses[Math.min(i++, responses.length - 1)]),
  } as unknown as LLMGateway;
}

function estimateFlowGateway(lineItemDescriptions: string[]): LLMGateway {
  return gatewaySequence([
    JSON.stringify({
      intentType: 'draft_estimate',
      confidence: 0.95,
      reasoning: 'caller describing work for a quote',
      extractedEntities: { customerName: 'Acme', lineItemDescriptions },
    }),
    JSON.stringify({ answer: 'yes', reasoning: 'caller confirmed' }),
  ]);
}

function invoiceFlowGateway(lineItemDescriptions: string[]): LLMGateway {
  return gatewaySequence([
    JSON.stringify({
      intentType: 'create_invoice',
      confidence: 0.95,
      reasoning: 'caller wants an invoice for completed work',
      extractedEntities: { customerName: 'Acme', lineItemDescriptions },
    }),
    JSON.stringify({ answer: 'yes', reasoning: 'caller confirmed' }),
  ]);
}

function makeEstimateCtx(opts: {
  gateway: LLMGateway;
  catalogRepo?: CatalogItemRepository;
  /** Owner (surface S2) session — required for operator-only intents such as
   *  draft_invoice/record_payment, which the P4 S1 allowlist reserves for S2. */
  ownerSession?: boolean;
}) {
  const store = new VoiceSessionStore({ startInterval: false });
  const proposalRepo = new InMemoryProposalRepository();
  const session = store.create('tenant-abc', 'telephony', {
    callSid: 'CA-est',
    ...(opts.ownerSession ? { ownerSession: true } : {}),
  });
  session.machine.dispatch({
    type: 'incoming_call',
    callSid: 'CA-est',
    from: '+15125550100',
    to: '+15125550999',
    tenantId: 'tenant-abc',
  });
  session.machine.dispatch({ type: 'greeted_ok' });
  session.machine.dispatch({ type: 'caller_known', customerId: 'cust-1' });
  session.customerId = 'cust-1';

  const processor = createVoiceTurnProcessor({
    store,
    gateway: opts.gateway,
    businessName: 'Acme Plumbing',
    systemActorId: 'test-actor',
    proposalRepo,
    ...(opts.catalogRepo ? { catalogRepo: opts.catalogRepo } : {}),
  });
  return { processor, store, proposalRepo, session };
}

async function runConfirmFlow(ctx: ReturnType<typeof makeEstimateCtx>): Promise<SideEffect[]> {
  await ctx.processor.speechTurn({
    session: ctx.session,
    speechResult: 'I need a quote to replace my water heater',
    callSid: 'CA-est',
    tenantId: 'tenant-abc',
  });
  expect(ctx.session.machine.currentState).toBe('intent_confirm');
  return ctx.processor.speechTurn({
    session: ctx.session,
    speechResult: 'yes that is right',
    callSid: 'CA-est',
    tenantId: 'tenant-abc',
  });
}

function lastTts(sideEffects: SideEffect[]): string | undefined {
  const fx = [...sideEffects].reverse().find((e) => e.type === 'tts_play');
  return fx?.payload.text as string | undefined;
}

describe('WS5 — grounded estimate at handleCreateProposal', () => {
  it('grounds a catalogued line: stores catalog price + pricingSource, speaks the grounded read-back', async () => {
    const ctx = makeEstimateCtx({
      gateway: estimateFlowGateway(['water heater replacement']),
      catalogRepo: stubCatalogRepo(),
    });
    const sideEffects = await runConfirmFlow(ctx);

    const proposals = await ctx.proposalRepo.findByTenant('tenant-abc');
    expect(proposals).toHaveLength(1);
    const p = proposals[0]!;
    expect(p.proposalType).toBe('draft_estimate');

    const lineItems = p.payload.lineItems as Array<Record<string, unknown>>;
    expect(lineItems).toHaveLength(1);
    expect(lineItems[0]).toMatchObject({
      description: 'Water Heater Replacement',
      unitPrice: 185000, // catalog price, NOT an LLM number
      pricingSource: 'catalog',
    });
    // Raw entities preserved alongside the grounded lines.
    expect((p.payload.entities as Record<string, unknown>).lineItemDescriptions).toEqual([
      'water heater replacement',
    ]);

    expect(lastTts(sideEffects)).toBe(
      "For the Water Heater Replacement, that's typically $1850.00. I'll send the full quote to confirm.",
    );
  });

  it('WS17 I1 — "three smoke detectors" grounds at qty 3, spoken total = 3×unit', async () => {
    const ctx = makeEstimateCtx({
      gateway: estimateFlowGateway(['three smoke detectors']),
      catalogRepo: stubCatalogRepo(),
    });
    const sideEffects = await runConfirmFlow(ctx);

    const p = (await ctx.proposalRepo.findByTenant('tenant-abc'))[0]!;
    const lineItems = p.payload.lineItems as Array<Record<string, unknown>>;
    expect(lineItems).toHaveLength(1);
    expect(lineItems[0]).toMatchObject({
      description: 'Smoke Detector',
      unitPrice: 8900, // catalog UNIT price (not the line total)
      quantity: 3, // recovered from "three"
      pricingSource: 'catalog',
    });
    // Spoken figure is the LINE TOTAL: 3 × $89.00 = $267.00.
    expect(lastTts(sideEffects)).toBe(
      "For the Smoke Detector, that's typically $267.00. I'll send the full quote to confirm.",
    );
  });

  it('WS17 I1 — "2 inch pipe fitting" is a SIZE: qty 1, full description matched (not qty 2)', async () => {
    const ctx = makeEstimateCtx({
      gateway: estimateFlowGateway(['2 inch pipe fitting']),
      catalogRepo: stubCatalogRepo(),
    });
    const sideEffects = await runConfirmFlow(ctx);

    const p = (await ctx.proposalRepo.findByTenant('tenant-abc'))[0]!;
    const lineItems = p.payload.lineItems as Array<Record<string, unknown>>;
    expect(lineItems[0]).toMatchObject({
      description: '2 Inch Pipe Fitting',
      unitPrice: 1200,
      quantity: 1, // NOT 2 — the leading "2" sizes the pipe
      pricingSource: 'catalog',
    });
    // qty 1 → the spoken figure is the unit price ($12.00), never $24.00.
    expect(lastTts(sideEffects)).toBe(
      "For the 2 Inch Pipe Fitting, that's typically $12.00. I'll send the full quote to confirm.",
    );
  });

  it('uncatalogued line: caps confidence, forces _meta low, speaks NO number', async () => {
    const ctx = makeEstimateCtx({
      gateway: estimateFlowGateway(['custom stainless fabrication']),
      catalogRepo: stubCatalogRepo(),
    });
    const sideEffects = await runConfirmFlow(ctx);

    const p = (await ctx.proposalRepo.findByTenant('tenant-abc'))[0]!;
    const lineItems = p.payload.lineItems as Array<Record<string, unknown>>;
    expect(lineItems[0]!.pricingSource).toBe('uncatalogued');
    const meta = p.payload._meta as { overallConfidence: string };
    expect(meta.overallConfidence).toBe('low');
    // Confidence capped below the auto-approve threshold.
    expect(p.confidenceScore).toBeLessThanOrEqual(0.85);

    const said = lastTts(sideEffects)!;
    expect(said).not.toMatch(/\$/);
    expect(said).toContain('the owner will confirm pricing');
  });

  it('catalog unavailable (read error) → no number spoken, degrades safely', async () => {
    const ctx = makeEstimateCtx({
      gateway: estimateFlowGateway(['water heater replacement']),
      catalogRepo: stubCatalogRepo(CATALOG, { throws: true }),
    });
    const sideEffects = await runConfirmFlow(ctx);

    const said = lastTts(sideEffects)!;
    expect(said).not.toMatch(/\$/);
    expect(said).toContain('the owner will confirm pricing');
    // Still stored a proposal (drafting is never blocked).
    expect(await ctx.proposalRepo.findByTenant('tenant-abc')).toHaveLength(1);
  });

  it('degrades to no-number when the preload outruns the timeout budget', async () => {
    const ctx = makeEstimateCtx({
      gateway: estimateFlowGateway(['water heater replacement']),
    });
    // Pre-seat a slow preload that will lose the 300ms race at quote time.
    ctx.session.catalogPreload = new Promise((resolve) =>
      setTimeout(() => resolve(CATALOG), 600),
    );
    const sideEffects = await runConfirmFlow(ctx);
    expect(lastTts(sideEffects)).not.toMatch(/\$/);
  });

  it('estimate with no line items → generic confirmation, no lineItems in payload', async () => {
    const ctx = makeEstimateCtx({
      gateway: estimateFlowGateway([]),
      catalogRepo: stubCatalogRepo(),
    });
    const sideEffects = await runConfirmFlow(ctx);
    const p = (await ctx.proposalRepo.findByTenant('tenant-abc'))[0]!;
    expect(p.payload.lineItems).toBeUndefined();
    expect(lastTts(sideEffects)).toBe(
      "Great, I've got that taken care of. You'll receive a confirmation shortly. Is there anything else I can help you with?",
    );
  });

  it('WS17 I3 — draft_invoice grounds too: cents contract, speaks $1850.00 not $185,000', async () => {
    const ctx = makeEstimateCtx({
      gateway: invoiceFlowGateway(['water heater replacement']),
      catalogRepo: stubCatalogRepo(),
      ownerSession: true, // draft_invoice is an S2-only op (P4 allowlist)
    });
    const sideEffects = await runConfirmFlow(ctx);

    const p = (await ctx.proposalRepo.findByTenant('tenant-abc'))[0]!;
    expect(p.proposalType).toBe('draft_invoice');

    const lineItems = p.payload.lineItems as Array<Record<string, unknown>>;
    expect(lineItems).toHaveLength(1);
    // Invoice contract: unitPriceCents + recomputed totalCents (NOT unitPrice).
    expect(lineItems[0]).toMatchObject({
      description: 'Water Heater Replacement',
      unitPriceCents: 185000,
      totalCents: 185000,
      pricingSource: 'catalog',
    });
    expect(lineItems[0]!.unitPrice).toBeUndefined();

    // Cents/dollars must not get confused on the wire: 185000 cents → $1850.00.
    const said = lastTts(sideEffects)!;
    expect(said).toBe(
      "For the Water Heater Replacement, that's typically $1850.00. I'll send the full quote to confirm.",
    );
    expect(said).toContain('$1850.00');
    expect(said).not.toContain('$185000');
    expect(said).not.toContain('$185,000');
  });

  it('WS17 I3 — a NON-extended type (record_payment) keeps the fixed generic line', async () => {
    const store = new VoiceSessionStore({ startInterval: false });
    const proposalRepo = new InMemoryProposalRepository();
    // record_payment is an S2-only op (P4 allowlist) — owner session.
    const session = store.create('tenant-abc', 'telephony', {
      callSid: 'CA-pay',
      ownerSession: true,
    });
    session.machine.dispatch({
      type: 'incoming_call',
      callSid: 'CA-pay',
      from: '+15125550100',
      to: '+15125550999',
      tenantId: 'tenant-abc',
    });
    session.machine.dispatch({ type: 'greeted_ok' });
    session.machine.dispatch({ type: 'caller_known', customerId: 'cust-1' });
    session.customerId = 'cust-1';

    const listByTenant = vi.fn(async () => CATALOG);
    const processor = createVoiceTurnProcessor({
      store,
      gateway: gatewaySequence([
        JSON.stringify({
          intentType: 'record_payment',
          confidence: 0.95,
          reasoning: 'payment',
          // Even if descriptions ride along, record_payment is NOT grounded.
          extractedEntities: { customerName: 'Acme', lineItemDescriptions: ['water heater replacement'] },
        }),
        JSON.stringify({ answer: 'yes', reasoning: 'ok' }),
      ]),
      businessName: 'Acme',
      systemActorId: 'test-actor',
      proposalRepo,
      catalogRepo: { listByTenant } as unknown as CatalogItemRepository,
    });

    await processor.speechTurn({ session, speechResult: 'record a payment', callSid: 'CA-pay', tenantId: 'tenant-abc' });
    const sideEffects = await processor.speechTurn({
      session,
      speechResult: 'yes',
      callSid: 'CA-pay',
      tenantId: 'tenant-abc',
    });

    const p = (await proposalRepo.findByTenant('tenant-abc'))[0]!;
    expect(p.proposalType).toBe('record_payment');
    expect(p.payload.lineItems).toBeUndefined();
    expect(lastTts(sideEffects)).toBe(
      "Great, I've got that taken care of. You'll receive a confirmation shortly. Is there anything else I can help you with?",
    );
  });
});
