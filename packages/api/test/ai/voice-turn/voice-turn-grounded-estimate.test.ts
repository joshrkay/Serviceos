/**
 * WS5 — in-call grounded quoting at handleCreateProposal.
 *
 * Drives the real FSM + voice-turn processor through a draft_estimate confirm
 * flow (classify → "yes") and asserts:
 *   - the stored payload carries grounded lineItems (catalog price +
 *     pricingSource per line) alongside the raw entities;
 *   - an uncatalogued line caps confidence and forces _meta 'low';
 *   - the caller hears the grounded read-back (or the no-number line);
 *   - catalog unavailable degrades to the no-number phrasing;
 *   - non-estimate proposals are untouched (fixed line, no lineItems).
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

function makeEstimateCtx(opts: {
  gateway: LLMGateway;
  catalogRepo?: CatalogItemRepository;
}) {
  const store = new VoiceSessionStore({ startInterval: false });
  const proposalRepo = new InMemoryProposalRepository();
  const session = store.create('tenant-abc', 'telephony', { callSid: 'CA-est' });
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

  it('non-estimate proposal (create_invoice) is untouched: fixed line, no grounding', async () => {
    const store = new VoiceSessionStore({ startInterval: false });
    const proposalRepo = new InMemoryProposalRepository();
    const session = store.create('tenant-abc', 'telephony', { callSid: 'CA-inv' });
    session.machine.dispatch({
      type: 'incoming_call',
      callSid: 'CA-inv',
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
          intentType: 'create_invoice',
          confidence: 0.95,
          reasoning: 'invoice',
          extractedEntities: { customerName: 'Acme', lineItemDescriptions: ['water heater replacement'] },
        }),
        JSON.stringify({ answer: 'yes', reasoning: 'ok' }),
      ]),
      businessName: 'Acme',
      systemActorId: 'test-actor',
      proposalRepo,
      catalogRepo: { listByTenant } as unknown as CatalogItemRepository,
    });

    await processor.speechTurn({ session, speechResult: 'invoice acme', callSid: 'CA-inv', tenantId: 'tenant-abc' });
    const sideEffects = await processor.speechTurn({
      session,
      speechResult: 'yes',
      callSid: 'CA-inv',
      tenantId: 'tenant-abc',
    });

    const p = (await proposalRepo.findByTenant('tenant-abc'))[0]!;
    expect(p.proposalType).toBe('draft_invoice');
    expect(p.payload.lineItems).toBeUndefined();
    expect(lastTts(sideEffects)).toBe(
      "Great, I've got that taken care of. You'll receive a confirmation shortly. Is there anything else I can help you with?",
    );
  });
});
