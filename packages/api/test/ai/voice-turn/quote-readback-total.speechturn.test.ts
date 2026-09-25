/**
 * The spoken quote total is the billing engine's number.
 *
 * `pendingQuote.totalCents` used to be recomputed inside the turn pipeline
 * with a hand-rolled `unitPrice × quantity` sum (I9′ recorded violation);
 * the readback module had a second copy. Both now derive from
 * `calculateLineItemTotal` inside `quote-readback.ts`, and the pipeline's
 * total IS the readback's total. Pinned at the speechTurn seam with an
 * independently computed literal: 185000 + 2 × 450 = 185900 cents.
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

function llm(content: unknown): LLMResponse {
  return {
    content: JSON.stringify(content),
    model: 'm', provider: 'p', tokenUsage: { input: 1, output: 1, total: 2 }, latencyMs: 1,
  };
}

function ttsTexts(fx: SideEffect[]): string[] {
  return fx.filter((e) => e.type === 'tts_play').map((e) => String(e.payload.text));
}

describe('speechTurn — spoken quote total derives from the billing engine', () => {
  it('two catalogued lines (one with quantity 2): the readback and pendingQuote carry the same engine-derived total', async () => {
    const store = new VoiceSessionStore({ startInterval: false });
    const proposalRepo = new InMemoryProposalRepository();
    const responses: LLMResponse[] = [
      llm({
        intentType: 'draft_estimate',
        confidence: 0.95,
        reasoning: 'quote',
        extractedEntities: { customerName: 'Acme', lineItemDescriptions: ['water heater replacement', '2 gaskets'] },
      }),
      llm({ answer: 'yes', reasoning: 'confirmed' }),
    ];
    let i = 0;
    const gateway = {
      complete: vi.fn().mockImplementation(async () => responses[Math.min(i++, responses.length - 1)]),
    } as unknown as LLMGateway;

    const session = store.create('tenant-abc', 'telephony', { callSid: 'CA-x' });
    session.machine.dispatch({ type: 'incoming_call', callSid: 'CA-x', from: '+15125550100', to: '+15125550999', tenantId: 'tenant-abc' });
    session.machine.dispatch({ type: 'greeted_ok' });
    session.machine.dispatch({ type: 'caller_known', customerId: 'cust-1' });
    session.customerId = 'cust-1';

    const processor = createVoiceTurnProcessor({
      store,
      gateway,
      businessName: 'Acme Plumbing',
      systemActorId: 'test-actor',
      proposalRepo,
      catalogRepo: { listByTenant: async () => CATALOG } as unknown as CatalogItemRepository,
    });

    const turn1 = await processor.speechTurn({ session, speechResult: 'I need a quote', callSid: 'CA-x', tenantId: 'tenant-abc' });
    expect(session.machine.currentState).toBe('intent_confirm');
    const turn2 = await processor.speechTurn({ session, speechResult: 'yes', callSid: 'CA-x', tenantId: 'tenant-abc' });
    // The caller hears the engine's total (formatCents prints $1859.00, no
    // thousands separator) in the grounded readback spoken with the proposal.
    const spoken = [...ttsTexts(turn1), ...ttsTexts(turn2)].join(' ');
    expect(spoken).toContain('$1859.00 all together');

    const pq = session.machine.currentContext.pendingQuote;
    expect(pq).toBeDefined();
    // Integer cents (D-003), and exactly the figure spoken above.
    expect(pq!.totalCents).toBe(185900);
    expect(Number.isInteger(pq!.totalCents)).toBe(true);
  });
});
