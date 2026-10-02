/**
 * #1577 — in-app parity: the readback copy is shared (renderTtsText), so a
 * booking with no day or time is asked "What date and time work for you?"
 * in-app as well — and a bare "yes" to that question must not draft a
 * booking with no time.
 *
 * Seam: InAppVoiceAdapter (startSession / handleInput) with a scripted
 * gateway, a resolver fake and in-memory repos (the #1476 harness).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { InAppVoiceAdapter } from '../../../../src/ai/agents/customer-calling/inapp-adapter';
import { VoiceSessionStore } from '../../../../src/ai/agents/customer-calling/voice-session-store';
import { InMemoryProposalRepository } from '../../../../src/proposals/proposal';
import { InMemoryAuditRepository } from '../../../../src/audit/audit';
import { InMemoryOnCallRepository } from '../../../../src/oncall/rotation';
import { InMemoryCustomerRepository, createCustomer } from '../../../../src/customers/customer';
import type { LLMGateway, LLMResponse } from '../../../../src/ai/gateway/gateway';
import type {
  EntityResolver,
  EntityResolverResult,
} from '../../../../src/ai/resolution/entity-resolver';

const TENANT = 'tenant-1577-inapp';
const OPERATOR = 'user-operator-1577';

const BOOKING_NO_TIME = JSON.stringify({
  intentType: 'create_appointment',
  confidence: 0.92,
  extractedEntities: { customerName: 'Dana Whitfield', jobTitle: 'attic fan replacement' },
});
const UNKNOWN = JSON.stringify({ intentType: 'unknown', confidence: 0.3, extractedEntities: {} });

function scriptedGateway(responses: string[]): LLMGateway {
  let i = 0;
  return {
    complete: vi.fn(async () => {
      const content = responses[Math.min(i++, responses.length - 1)];
      return {
        content,
        model: 'mock',
        provider: 'mock',
        tokenUsage: { input: 1, output: 1, total: 2 },
        latencyMs: 1,
      } satisfies LLMResponse;
    }),
  } as unknown as LLMGateway;
}

function resolverFor(customerId: string): EntityResolver {
  const dana: EntityResolverResult = {
    kind: 'resolved',
    candidate: { id: customerId, kind: 'customer', label: 'Dana Whitfield', score: 0.97 },
  };
  return {
    resolve: vi.fn(async (input) => (input.kind === 'customer' ? dana : { kind: 'not_found' })),
  } as EntityResolver;
}

describe('#1577 — in-app: a booking with no day or time asks for one', () => {
  let store: VoiceSessionStore;
  let proposalRepo: InMemoryProposalRepository;
  let customerRepo: InMemoryCustomerRepository;
  let danaId: string;

  beforeEach(async () => {
    store = new VoiceSessionStore({ startInterval: false });
    proposalRepo = new InMemoryProposalRepository();
    customerRepo = new InMemoryCustomerRepository();
    const dana = await createCustomer(
      {
        tenantId: TENANT,
        firstName: 'Dana',
        lastName: 'Whitfield',
        primaryPhone: '+14805550199',
        createdBy: OPERATOR,
      },
      customerRepo,
    );
    danaId = dana.id;
  });
  afterEach(() => store.dispose());

  function adapterWith(responses: string[]) {
    return new InAppVoiceAdapter({
      store,
      gateway: scriptedGateway(responses),
      proposalRepo,
      auditRepo: new InMemoryAuditRepository(),
      onCallRepo: new InMemoryOnCallRepository(new Map()),
      entityResolver: resolverFor(danaId),
      customerRepo,
    });
  }

  it('asks for the date and time, and a bare "yes" drafts nothing', async () => {
    const adapter = adapterWith([BOOKING_NO_TIME, UNKNOWN]);
    const { sessionId } = await adapter.startSession(TENANT, OPERATOR);

    const turn1 = await adapter.handleInput(sessionId, 'Book Dana Whitfield for the attic fan replacement.');
    expect(turn1.state).toBe('intent_confirm');
    expect(turn1.ttsText).toBe('What date and time work for you?');

    const turn2 = await adapter.handleInput(sessionId, 'yes');
    expect(turn2.proposalIds ?? []).toHaveLength(0);
    expect(await proposalRepo.findByTenant(TENANT)).toHaveLength(0);
    expect(turn2.ttsText).toBe('What date and time work for you?');
  });
});
