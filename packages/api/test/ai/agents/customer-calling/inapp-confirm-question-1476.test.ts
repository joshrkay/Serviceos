/**
 * #1476 item 3 — a QUESTION asked while the assistant is waiting on a yes/no
 * readback ("Can you confirm the number you have for me to call back?",
 * "what time was that again?") is answered, the pending request is KEPT and
 * the confirmation is re-asked — instead of "My apologies — let me try
 * again" and losing everything captured so far.
 *
 * Seam: InAppVoiceAdapter (startSession / handleInput) with a scripted
 * gateway + EntityResolver fake and in-memory repos — the #1416/#1485 harness.
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

const TENANT = 'tenant-1476-inapp';
const OPERATOR = 'user-operator-1476';

const INVOICE_FOR_DANA = JSON.stringify({
  intentType: 'create_invoice',
  confidence: 0.92,
  extractedEntities: {
    customerName: 'Dana Whitfield',
    amount: 35000,
    lineItemDescriptions: ['attic fan replacement'],
  },
});

const BOOKING_FOR_DANA = JSON.stringify({
  intentType: 'create_appointment',
  confidence: 0.92,
  extractedEntities: {
    customerName: 'Dana Whitfield',
    jobTitle: 'attic fan replacement',
    dateTimeDescription: 'next Tuesday at 9 AM',
  },
});

// What the classifier makes of a bare question with no request in it.
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

describe('InAppVoiceAdapter — a question during the confirm step (#1476)', () => {
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

  it('the callback-number question is answered from the customer on file and the confirmation is kept', async () => {
    const adapter = adapterWith([INVOICE_FOR_DANA]);
    const { sessionId } = await adapter.startSession(TENANT, OPERATOR);
    const turn1 = await adapter.handleInput(
      sessionId,
      'Invoice Dana Whitfield 350 dollars for the attic fan replacement.',
    );
    expect(turn1.state).toBe('intent_confirm');

    const turn2 = await adapter.handleInput(
      sessionId,
      'Can you confirm the number you have for me to call back?',
    );
    expect(turn2.state).toBe('intent_confirm');
    expect(turn2.ttsText).toMatch(/480-555-0199/);
    expect(turn2.ttsText).toMatch(/Is that right\?$/);
    expect(turn2.ttsText).not.toMatch(/let me try again/i);
    expect(await proposalRepo.findByTenant(TENANT)).toHaveLength(0);

    // The pending request survived the question: a plain "yes" drafts it.
    const turn3 = await adapter.handleInput(sessionId, 'yes');
    const [proposal] = await proposalRepo.findByTenant(TENANT);
    expect(turn3.proposalIds).toHaveLength(1);
    expect(proposal?.proposalType).toBe('draft_invoice');
  });

  it('"what time was that again?" is answered from the pending request and the booking is kept', async () => {
    const adapter = adapterWith([BOOKING_FOR_DANA, UNKNOWN]);
    const { sessionId } = await adapter.startSession(TENANT, OPERATOR);
    const turn1 = await adapter.handleInput(
      sessionId,
      'Book Dana Whitfield for the attic fan replacement next Tuesday at 9 AM.',
    );
    expect(turn1.state).toBe('intent_confirm');

    const turn2 = await adapter.handleInput(sessionId, 'What time was that again?');
    expect(turn2.state).toBe('intent_confirm');
    expect(turn2.ttsText).toMatch(/next Tuesday at 9 AM/);
    expect(turn2.ttsText).toMatch(/Is that right\?$/);

    const turn3 = await adapter.handleInput(sessionId, 'yes');
    expect(turn3.proposalIds).toHaveLength(1);
  });

  it('"how much will it be?" reads back the amount captured for the pending invoice', async () => {
    const adapter = adapterWith([INVOICE_FOR_DANA]);
    const { sessionId } = await adapter.startSession(TENANT, OPERATOR);
    await adapter.handleInput(
      sessionId,
      'Invoice Dana Whitfield 350 dollars for the attic fan replacement.',
    );

    const turn2 = await adapter.handleInput(sessionId, 'How much will it be?');
    expect(turn2.state).toBe('intent_confirm');
    expect(turn2.ttsText).toMatch(/\$350\.00/);
    expect(turn2.ttsText).toMatch(/Is that right\?$/);
  });

  it('any other question goes through the existing read-only lookup path, then re-asks', async () => {
    const adapter = new InAppVoiceAdapter({
      store,
      gateway: scriptedGateway([
        INVOICE_FOR_DANA,
        JSON.stringify({
          intentType: 'lookup_customer',
          confidence: 0.94,
          extractedEntities: { customerName: 'Dana Whitfield' },
        }),
      ]),
      proposalRepo,
      auditRepo: new InMemoryAuditRepository(),
      onCallRepo: new InMemoryOnCallRepository(new Map()),
      entityResolver: resolverFor(danaId),
      customerRepo,
      lookups: {
        answers: {},
        shared: { customerRepo, proposalRepo },
        entityResolver: resolverFor(danaId),
      },
    });
    const { sessionId } = await adapter.startSession(TENANT, OPERATOR);
    await adapter.handleInput(
      sessionId,
      'Invoice Dana Whitfield 350 dollars for the attic fan replacement.',
    );

    const turn2 = await adapter.handleInput(sessionId, "Who's Dana Whitfield again?");
    expect(turn2.state).toBe('intent_confirm');
    expect(turn2.ttsText?.toLowerCase()).toContain('dana whitfield');
    expect(turn2.ttsText).not.toMatch(/don't have that detail/);
    expect(turn2.ttsText).toMatch(/Is that right\?$/);
    expect(await proposalRepo.findByTenant(TENANT)).toHaveLength(0);
  });

  it('a lookup classify that crosses the session cost cap escalates instead of answering', async () => {
    let call = 0;
    const gateway = {
      complete: vi.fn(async () => {
        call += 1;
        return {
          content:
            call === 1
              ? INVOICE_FOR_DANA
              : JSON.stringify({
                  intentType: 'lookup_customer',
                  confidence: 0.94,
                  extractedEntities: { customerName: 'Dana Whitfield' },
                }),
          model: 'mock',
          provider: 'mock',
          // The question's classify blows through every per-session cap.
          tokenUsage:
            call === 1
              ? { input: 1, output: 1, total: 2 }
              : { input: 1_000_000, output: 1_000_000, total: 2_000_000 },
          latencyMs: 1,
        } satisfies LLMResponse;
      }),
    } as unknown as LLMGateway;
    const adapter = new InAppVoiceAdapter({
      store,
      gateway,
      proposalRepo,
      auditRepo: new InMemoryAuditRepository(),
      onCallRepo: new InMemoryOnCallRepository(new Map()),
      entityResolver: resolverFor(danaId),
      customerRepo,
      lookups: {
        answers: {},
        shared: { customerRepo, proposalRepo },
        entityResolver: resolverFor(danaId),
      },
    });
    const { sessionId } = await adapter.startSession(TENANT, OPERATOR);
    await adapter.handleInput(
      sessionId,
      'Invoice Dana Whitfield 350 dollars for the attic fan replacement.',
    );

    const turn2 = await adapter.handleInput(sessionId, "Who's Dana Whitfield again?");
    expect(turn2.state).not.toBe('intent_confirm');
    expect(turn2.ttsText?.toLowerCase() ?? '').not.toContain('dana whitfield');
  });

  it('a change asked AS a question is still more detail for the booking, not a question to answer', async () => {
    const adapter = adapterWith([
      BOOKING_FOR_DANA,
      JSON.stringify({
        intentType: 'create_appointment',
        confidence: 0.9,
        extractedEntities: { dateTimeDescription: 'Wednesday at 9 AM' },
      }),
    ]);
    const { sessionId } = await adapter.startSession(TENANT, OPERATOR);
    await adapter.handleInput(
      sessionId,
      'Book Dana Whitfield for the attic fan replacement next Tuesday at 9 AM.',
    );

    const turn2 = await adapter.handleInput(sessionId, 'Can you make it Wednesday at 9 AM instead?');
    // Merged as a slot and re-resolved (D01), not answered as a question.
    expect(turn2.trace.stage).not.toBe('answered');
    expect(turn2.trace.resolution).toBe('resolved');
    expect(turn2.state).toBe('intent_confirm');
  });

  it('a suggestion phrased with a question word ("what if we do Wednesday?") is also more detail', async () => {
    const adapter = adapterWith([
      BOOKING_FOR_DANA,
      JSON.stringify({
        intentType: 'create_appointment',
        confidence: 0.9,
        extractedEntities: { dateTimeDescription: 'Wednesday at 9 AM' },
      }),
    ]);
    const { sessionId } = await adapter.startSession(TENANT, OPERATOR);
    await adapter.handleInput(
      sessionId,
      'Book Dana Whitfield for the attic fan replacement next Tuesday at 9 AM.',
    );

    const turn2 = await adapter.handleInput(sessionId, 'What if we do Wednesday at 9 AM?');
    expect(turn2.trace.stage).not.toBe('answered');
    expect(turn2.trace.resolution).toBe('resolved');
  });
});
