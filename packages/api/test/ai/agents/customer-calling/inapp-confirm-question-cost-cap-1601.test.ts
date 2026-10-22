/**
 * #1601 step 2 — DIVERGENCE PINNED at `InAppVoiceAdapter.handleInput`.
 *
 * The in-app copy of the confirm-step question answer (#1476) decided the
 * cost cap on THIS call's tracker events; the phone processor decides on the
 * tracker's LEVEL (#1204). The difference shows when the cap was crossed by
 * a usage whose events were discarded (the sentiment classifier /
 * vulnerability grader shape): in-app then still ANSWERED the lookup, the
 * processor ends the call. Step 2 moves the answer to the shared helper
 * with the processor's rule, so the in-app surface now escalates too.
 * Harness: the #1476 in-app fixture.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { InAppVoiceAdapter } from '../../../../src/ai/agents/customer-calling/inapp-adapter';
import { VoiceSessionStore } from '../../../../src/ai/agents/customer-calling/voice-session-store';
import { InMemoryProposalRepository } from '../../../../src/proposals/proposal';
import { InMemoryAuditRepository } from '../../../../src/audit/audit';
import { InMemoryOnCallRepository } from '../../../../src/oncall/rotation';
import { InMemoryCustomerRepository, createCustomer } from '../../../../src/customers/customer';
import { estimateCostCents } from '../../../../src/ai/skills/session-cost-tracker';
import type { LLMGateway, LLMResponse } from '../../../../src/ai/gateway/gateway';
import type { EntityResolver, EntityResolverResult } from '../../../../src/ai/resolution/entity-resolver';

const TENANT = 'tenant-1601-cap';
const OPERATOR = 'user-operator-1601';

const INVOICE_FOR_DANA = JSON.stringify({
  intentType: 'create_invoice',
  confidence: 0.92,
  extractedEntities: { customerName: 'Dana Whitfield', amount: 35000, lineItemDescriptions: ['attic fan replacement'] },
});
const LOOKUP_DANA = JSON.stringify({
  intentType: 'lookup_customer',
  confidence: 0.94,
  extractedEntities: { customerName: 'Dana Whitfield' },
});

function scriptedGateway(responses: string[]): LLMGateway {
  let i = 0;
  return {
    complete: vi.fn(async () => ({
      content: responses[Math.min(i++, responses.length - 1)],
      model: 'mock',
      provider: 'mock',
      tokenUsage: { input: 1, output: 1, total: 2 },
      latencyMs: 1,
    }) satisfies LLMResponse),
  } as unknown as LLMGateway;
}

function resolverFor(customerId: string): EntityResolver {
  const dana: EntityResolverResult = {
    kind: 'resolved',
    candidate: { id: customerId, kind: 'customer', label: 'Dana Whitfield', score: 0.97 },
  };
  return { resolve: vi.fn(async (input) => (input.kind === 'customer' ? dana : { kind: 'not_found' })) } as EntityResolver;
}

describe('#1601 — InAppVoiceAdapter: a confirm-step question after the cap was crossed off-turn', () => {
  let store: VoiceSessionStore;
  let customerRepo: InMemoryCustomerRepository;
  let danaId: string;

  beforeEach(async () => {
    store = new VoiceSessionStore({ startInterval: false });
    customerRepo = new InMemoryCustomerRepository();
    const dana = await createCustomer(
      { tenantId: TENANT, firstName: 'Dana', lastName: 'Whitfield', primaryPhone: '+14805550199', createdBy: OPERATOR },
      customerRepo,
    );
    danaId = dana.id;
  });
  afterEach(() => store.dispose());

  it('ends the call for the exceeded cap instead of answering the lookup (the processor rule, #1204)', async () => {
    const adapter = new InAppVoiceAdapter({
      store,
      gateway: scriptedGateway([INVOICE_FOR_DANA, LOOKUP_DANA]),
      proposalRepo: new InMemoryProposalRepository(),
      auditRepo: new InMemoryAuditRepository(),
      onCallRepo: new InMemoryOnCallRepository(new Map()),
      entityResolver: resolverFor(danaId),
      customerRepo,
      lookups: { answers: {}, shared: { customerRepo, proposalRepo: new InMemoryProposalRepository() }, entityResolver: resolverFor(danaId) },
    });
    const { sessionId } = await adapter.startSession(TENANT, OPERATOR);
    const turn1 = await adapter.handleInput(sessionId, 'Invoice Dana Whitfield 350 dollars for the attic fan replacement.');
    expect(turn1.state).toBe('intent_confirm');

    // Between turns, a classifier that records its usage on the same tracker
    // and discards the events crosses every per-session cap (#1204).
    const session = store.get(sessionId)!;
    session.costTracker.recordUsage({ inputTokens: 1_000_000, outputTokens: 1_000_000, costCents: estimateCostCents(1_000_000, 1_000_000) });
    expect(session.costTracker.isExceeded).toBe(true);

    const turn2 = await adapter.handleInput(sessionId, "Who's Dana Whitfield again?");

    expect(turn2.state).not.toBe('intent_confirm');
    expect(turn2.ttsText?.toLowerCase() ?? '').not.toContain('dana whitfield');
  });
});
