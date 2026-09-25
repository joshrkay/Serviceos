/**
 * PROVEN (CONTEXT.md): the spoken quote total on the phone surface, against a
 * real Postgres catalog.
 *
 * media-streams is the surface where quote readback is declared reachable
 * (coverage-table.ts: ws18_post_quote_refinement). The processor's default
 * coverageSurface is 'media_streams'. The catalog the quote is grounded
 * against is the REAL PgCatalogItemRepository, so this pins the full path
 * from a stored unitPriceCents to the figure the caller hears — derived by
 * quote-readback.ts from the billing engine, never recomputed (I9′).
 *
 * Independent literal: 185000 + 2 × 450 = 185900 cents → "$1859.00".
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { Pool } from 'pg';
import { getSharedTestDb, createTestTenant, closeSharedTestDb } from './shared';
import { createVoiceTurnProcessor } from '../../src/ai/voice-turn';
import { VoiceSessionStore } from '../../src/ai/agents/customer-calling/voice-session-store';
import { PgCatalogItemRepository } from '../../src/catalog/pg-catalog-item';
import { createCatalogItem } from '../../src/catalog/catalog-item';
import { PgAuditRepository } from '../../src/audit/pg-audit';
import { InMemoryProposalRepository } from '../../src/proposals/proposal';
import type { LLMGateway, LLMResponse } from '../../src/ai/gateway/gateway';
import type { SideEffect } from '../../src/ai/agents/customer-calling/types';

function scriptedGateway(responses: unknown[]): LLMGateway {
  let i = 0;
  return {
    complete: vi.fn(async () => ({
      content: JSON.stringify(responses[Math.min(i++, responses.length - 1)]),
      model: 'mock',
      provider: 'mock',
      tokenUsage: { input: 10, output: 10, total: 20 },
      latencyMs: 1,
    } satisfies LLMResponse)),
  } as unknown as LLMGateway;
}

function ttsTexts(fx: SideEffect[]): string[] {
  return fx.filter((e) => e.type === 'tts_play').map((e) => String(e.payload.text));
}

describe('Integration — PROVEN: spoken quote total from a real catalog (media-streams surface)', () => {
  let pool: Pool;
  let catalogRepo: PgCatalogItemRepository;
  let auditRepo: PgAuditRepository;

  beforeAll(async () => {
    pool = await getSharedTestDb();
    catalogRepo = new PgCatalogItemRepository(pool);
    auditRepo = new PgAuditRepository(pool);
  });

  afterAll(async () => {
    await closeSharedTestDb();
  });

  it('two catalogued lines (quantity 2 on one) → the caller hears $1859.00 and pendingQuote.totalCents is 185900', async () => {
    const seed = await createTestTenant(pool);
    await catalogRepo.create(
      createCatalogItem({ tenantId: seed.tenantId, name: 'Water Heater Replacement', category: 'Parts', unit: 'each', unitPriceCents: 185000 }),
    );
    await catalogRepo.create(
      createCatalogItem({ tenantId: seed.tenantId, name: 'Gasket', category: 'Parts', unit: 'each', unitPriceCents: 450 }),
    );

    const store = new VoiceSessionStore({ startInterval: false });
    const proposalRepo = new InMemoryProposalRepository();
    const session = store.create(seed.tenantId, 'telephony', { callSid: `CA-${seed.tenantId.slice(0, 8)}` });
    session.machine.dispatch({ type: 'incoming_call', callSid: session.callSid!, from: '+15125550100', to: '+15125550999', tenantId: seed.tenantId });
    session.machine.dispatch({ type: 'greeted_ok' });
    session.machine.dispatch({ type: 'caller_known', customerId: 'cust-1' });
    session.customerId = 'cust-1';

    const processor = createVoiceTurnProcessor({
      store,
      gateway: scriptedGateway([
        {
          intentType: 'draft_estimate',
          confidence: 0.95,
          reasoning: 'quote',
          extractedEntities: { customerName: 'Acme', lineItemDescriptions: ['water heater replacement', '2 gaskets'] },
        },
        { answer: 'yes', reasoning: 'confirmed' },
      ]),
      businessName: 'Acme Plumbing',
      systemActorId: seed.userId,
      auditRepo,
      proposalRepo,
      catalogRepo,
    });

    const turn1 = await processor.speechTurn({ session, speechResult: 'I need a quote', callSid: session.callSid!, tenantId: seed.tenantId });
    expect(session.machine.currentState).toBe('intent_confirm');
    const turn2 = await processor.speechTurn({ session, speechResult: 'yes', callSid: session.callSid!, tenantId: seed.tenantId });

    const spoken = [...ttsTexts(turn1), ...ttsTexts(turn2)].join(' ');
    expect(spoken).toContain('$1859.00 all together');

    const pq = session.machine.currentContext.pendingQuote;
    expect(pq).toBeDefined();
    expect(pq!.totalCents).toBe(185900);
    expect(Number.isInteger(pq!.totalCents)).toBe(true);
    expect(pq!.groundedLines.map((l) => l.unitPrice)).toEqual([185000, 450]);
  });
});
