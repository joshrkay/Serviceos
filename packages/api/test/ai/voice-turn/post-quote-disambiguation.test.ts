/**
 * WS18a — post-quote disambiguation matrix (real FSM + voice-turn processor,
 * mocked gateway/repos).
 *
 * Drives a draft_estimate confirm flow to reach `closing` with a live
 * `pendingQuote`, then feeds the caller's next utterance through the
 * deterministic pre-check. Asserts the discard bug is gone ("yes, book it"
 * never reaches the classifier / never drops the quote) and that refinements,
 * affirmatives, second intents, and low-confidence replies each route correctly.
 */
import { describe, it, expect, vi } from 'vitest';

import { createVoiceTurnProcessor } from '../../../src/ai/voice-turn';
import { VoiceSessionStore } from '../../../src/ai/agents/customer-calling/voice-session-store';
import { InMemoryProposalRepository } from '../../../src/proposals/proposal';
import { POST_QUOTE_REPROMPT_LINE } from '../../../src/ai/agents/customer-calling/transitions';
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

function stubCatalogRepo(): CatalogItemRepository {
  return { listByTenant: async () => CATALOG } as unknown as CatalogItemRepository;
}

/**
 * Gateway that replays: draft_estimate classification → confirm "yes" → then a
 * create_appointment classification for any further classifier call (the
 * passthrough / second-intent case). Refinement + affirmative turns never call
 * the classifier, so the 3rd response only fires for a genuine second intent.
 */
function makeGateway(lineItemDescriptions: string[]): { gateway: LLMGateway; complete: ReturnType<typeof vi.fn> } {
  const responses: LLMResponse[] = [
    {
      content: JSON.stringify({
        intentType: 'draft_estimate',
        confidence: 0.95,
        reasoning: 'quote',
        extractedEntities: { customerName: 'Acme', lineItemDescriptions },
      }),
      model: 'm', provider: 'p', tokenUsage: { input: 1, output: 1, total: 2 }, latencyMs: 1,
    },
    {
      content: JSON.stringify({ answer: 'yes', reasoning: 'confirmed' }),
      model: 'm', provider: 'p', tokenUsage: { input: 1, output: 1, total: 2 }, latencyMs: 1,
    },
    {
      content: JSON.stringify({
        intentType: 'create_appointment',
        confidence: 0.92,
        reasoning: 'new request',
        extractedEntities: {},
      }),
      model: 'm', provider: 'p', tokenUsage: { input: 1, output: 1, total: 2 }, latencyMs: 1,
    },
  ];
  let i = 0;
  const complete = vi.fn().mockImplementation(async () => responses[Math.min(i++, responses.length - 1)]);
  return { gateway: { complete } as unknown as LLMGateway, complete };
}

async function reachClosing(lineItemDescriptions: string[]) {
  const store = new VoiceSessionStore({ startInterval: false });
  const proposalRepo = new InMemoryProposalRepository();
  const { gateway, complete } = makeGateway(lineItemDescriptions);
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
    catalogRepo: stubCatalogRepo(),
  });

  await processor.speechTurn({ session, speechResult: 'I need a quote', callSid: 'CA-x', tenantId: 'tenant-abc' });
  expect(session.machine.currentState).toBe('intent_confirm');
  await processor.speechTurn({ session, speechResult: 'yes', callSid: 'CA-x', tenantId: 'tenant-abc' });
  expect(session.machine.currentState).toBe('closing');
  expect(session.machine.currentContext.pendingQuote).toBeDefined();
  return { store, proposalRepo, processor, session, complete };
}

function lastTts(fx: SideEffect[]): string | undefined {
  return [...fx].reverse().find((e) => e.type === 'tts_play')?.payload.text as string | undefined;
}

async function turn(ctx: Awaited<ReturnType<typeof reachClosing>>, speechResult: string): Promise<SideEffect[]> {
  return ctx.processor.speechTurn({ session: ctx.session, speechResult, callSid: 'CA-x', tenantId: 'tenant-abc' });
}

describe('WS18a — affirmative-to-close', () => {
  it('"yes book it" closes without ever calling the classifier (DISCARD-BUG REGRESSION)', async () => {
    const ctx = await reachClosing(['gasket']);
    const before = ctx.complete.mock.calls.length; // 2 (classify + confirm)
    const fx = await turn(ctx, 'yes book it');
    // The INTENT CLASSIFIER was NOT consulted for the affirmative → the quote
    // can't be misread as a second intent. Exactly ONE extra gateway call is
    // expected: the WS18d strict confirmIntent yes/no gate (the authoritative
    // D-018 check) — never classifyIntent.
    expect(ctx.complete.mock.calls.length).toBe(before + 1);
    expect(ctx.session.machine.currentState).toBe('closing');
    expect(ctx.session.machine.currentContext.pendingQuote).toBeDefined();
    expect(lastTts(fx)).toContain('send you the full quote');
  });

  it('"yeah lock it in" is also affirmative-dominant', async () => {
    const ctx = await reachClosing(['gasket']);
    const before = ctx.complete.mock.calls.length;
    await turn(ctx, 'yeah lock it in');
    // +1 = the strict confirmIntent gate (WS18d), never the classifier.
    expect(ctx.complete.mock.calls.length).toBe(before + 1);
    expect(ctx.session.machine.currentState).toBe('closing');
    expect(ctx.session.machine.currentContext.pendingQuote).toBeDefined();
  });
});

describe('WS18a — refinements', () => {
  it('"make it two" re-grounds at qty 2 and speaks $9.00', async () => {
    const ctx = await reachClosing(['gasket']);
    const fx = await turn(ctx, 'make it two');
    expect(ctx.session.machine.currentState).toBe('closing');
    expect(lastTts(fx)).toContain('$9.00');
    const pq = ctx.session.machine.currentContext.pendingQuote!;
    expect(pq.refinementCount).toBe(1);
    expect(pq.groundedLines[0]!.quantity).toBe(2);
  });

  it('"actually three" re-grounds at qty 3 and speaks $13.50', async () => {
    const ctx = await reachClosing(['gasket']);
    const fx = await turn(ctx, 'actually three');
    expect(lastTts(fx)).toContain('$13.50');
  });

  it('"also add a gasket" appends a catalog-priced line', async () => {
    const ctx = await reachClosing(['water heater replacement']);
    const fx = await turn(ctx, 'also add a gasket');
    expect(ctx.session.machine.currentState).toBe('closing');
    // Two-line read-back with the grounded total 185000 + 450 = 185450.
    expect(lastTts(fx)).toContain('$1854.50');
    expect(ctx.session.machine.currentContext.pendingQuote!.groundedLines).toHaveLength(2);
  });

  it('"drop the gasket" removes the matching line', async () => {
    const ctx = await reachClosing(['water heater replacement', 'gasket']);
    const fx = await turn(ctx, 'drop the gasket');
    expect(ctx.session.machine.currentState).toBe('closing');
    const pq = ctx.session.machine.currentContext.pendingQuote!;
    expect(pq.groundedLines).toHaveLength(1);
    expect(pq.groundedLines[0]!.description).toBe('Water Heater Replacement');
    expect(lastTts(fx)).toContain('$1850.00');
  });

  it('"yes but make it two" is a REFINEMENT, not a close (rule 1 precedence)', async () => {
    const ctx = await reachClosing(['gasket']);
    const before = ctx.complete.mock.calls.length;
    const fx = await turn(ctx, 'yes but make it two');
    // Refinement handled deterministically — classifier untouched.
    expect(ctx.complete.mock.calls.length).toBe(before);
    expect(lastTts(fx)).toContain('$9.00');
    expect(ctx.session.machine.currentContext.pendingQuote!.groundedLines[0]!.quantity).toBe(2);
  });
});

describe('WS18a — second intent + low confidence', () => {
  it('"yes and my sink is leaking" is a SECOND INTENT (classifier runs, quote cleared)', async () => {
    const ctx = await reachClosing(['gasket']);
    const before = ctx.complete.mock.calls.length;
    await turn(ctx, 'yes and my sink is leaking');
    // Deferred to the classifier → create_appointment → FSM treats as second
    // intent → back to intent_capture, pendingQuote dropped.
    expect(ctx.complete.mock.calls.length).toBe(before + 1);
    expect(ctx.session.machine.currentState).toBe('intent_capture');
    expect(ctx.session.machine.currentContext.pendingQuote).toBeUndefined();
  });

  it('a quiet/empty reply reprompts (not silence)', async () => {
    const ctx = await reachClosing(['gasket']);
    const fx = await turn(ctx, '');
    expect(ctx.session.machine.currentState).toBe('closing');
    expect(lastTts(fx)).toBe(POST_QUOTE_REPROMPT_LINE);
    expect(ctx.session.machine.currentContext.pendingQuote).toBeDefined();
  });
});
