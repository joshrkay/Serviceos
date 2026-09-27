/**
 * #1406 D6 — "Create an invoice for the QA Matrix job …" on in-app voice.
 *
 * Live evidence (QA 2026-09-26, VOX-07 manual probe): the customer name was
 * ambiguous, the operator picked one, and the turn went STRAIGHT to the
 * readback — the job lookup planned after the customer lookup never ran, so
 * the approved draft_invoice had no jobId and the executor opened a new
 * placeholder job ("Draft invoice for QA Matrix") instead of invoicing the
 * job the operator named. That placeholder's created_by was the CRM
 * customer's id, because in-app proposals stamped createdBy from the
 * caller-phone-matched customer instead of the acting operator.
 *
 * Seam: InAppVoiceAdapter (startSession / handleInput) with a mocked
 * gateway + EntityResolver, in-memory repos.
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

const TENANT = 'tenant-d6';
const OPERATOR = 'user-operator-d6';
// Resolver ids are real uuids in production; resolveSchedulingEntities only
// trusts an identity key that is one.
const CUST_NORTH = '0b6b1f6e-1111-4c1a-9d8e-000000000001';
const CUST_SOUTH = '0b6b1f6e-1111-4c1a-9d8e-000000000002';
const JOB_QA_MATRIX = '0b6b1f6e-2222-4c1a-9d8e-000000000003';
const JOB_QA_MATRIX_2 = '0b6b1f6e-2222-4c1a-9d8e-000000000004';

const INVOICE_CLASSIFIER = JSON.stringify({
  intentType: 'create_invoice',
  confidence: 0.9,
  extractedEntities: {
    customerName: 'QA Matrix',
    jobReference: 'QA Matrix job',
    amount: 35000,
    lineItemDescriptions: ['completed furnace repair'],
  },
});

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

const TWO_QA_MATRIX_CUSTOMERS: EntityResolverResult = {
  kind: 'ambiguous',
  candidates: [
    { id: CUST_NORTH, kind: 'customer', label: 'QA Matrix North', score: 0.9 },
    { id: CUST_SOUTH, kind: 'customer', label: 'QA Matrix South', score: 0.89 },
  ],
};

function resolverByKind(byKind: Record<string, EntityResolverResult>): EntityResolver {
  return {
    resolve: vi.fn(async (input) => byKind[input.kind] ?? { kind: 'not_found' }),
  } as EntityResolver;
}

describe('InAppVoiceAdapter — invoice for a spoken job reference (#1406 D6)', () => {
  let store: VoiceSessionStore;
  let proposalRepo: InMemoryProposalRepository;

  beforeEach(() => {
    store = new VoiceSessionStore({ startInterval: false });
    proposalRepo = new InMemoryProposalRepository();
  });

  afterEach(() => store.dispose());

  function makeAdapter(entityResolver: EntityResolver): InAppVoiceAdapter {
    return new InAppVoiceAdapter({
      store,
      gateway: scriptedGateway([INVOICE_CLASSIFIER]),
      proposalRepo,
      auditRepo: new InMemoryAuditRepository(),
      onCallRepo: new InMemoryOnCallRepository(new Map()),
      entityResolver,
    });
  }

  it('after the customer is picked, the spoken job reference is still resolved onto the draft', async () => {
    const adapter = makeAdapter(
      resolverByKind({
        customer: TWO_QA_MATRIX_CUSTOMERS,
        job: {
          kind: 'resolved',
          candidate: { id: JOB_QA_MATRIX, kind: 'job', label: 'QA Matrix job', score: 0.95 },
        },
      }),
    );
    const { sessionId } = await adapter.startSession(TENANT, OPERATOR);

    const turn1 = await adapter.handleInput(
      sessionId,
      'Create an invoice for the QA Matrix job for the completed furnace repair, $350 total.',
    );
    expect(turn1.state).toBe('entity_resolution');

    const turn2 = await adapter.handleInput(sessionId, 'QA Matrix North');
    expect(turn2.state).toBe('intent_confirm');

    const turn3 = await adapter.handleInput(sessionId, 'yes');
    expect(turn3.proposalIds).toHaveLength(1);
    const [proposal] = await proposalRepo.findByTenant(TENANT);
    expect(proposal.proposalType).toBe('draft_invoice');
    expect(proposal.payload.customerId).toBe(CUST_NORTH);
    expect(proposal.payload.jobId).toBe(JOB_QA_MATRIX);
  });

  it('an ambiguous job reference becomes a second clarification, never a guess or a new job', async () => {
    const adapter = makeAdapter(
      resolverByKind({
        customer: TWO_QA_MATRIX_CUSTOMERS,
        job: {
          kind: 'ambiguous',
          candidates: [
            { id: JOB_QA_MATRIX, kind: 'job', label: 'QA Matrix furnace', score: 0.9 },
            { id: JOB_QA_MATRIX_2, kind: 'job', label: 'QA Matrix water heater', score: 0.88 },
          ],
        },
      }),
    );
    const { sessionId } = await adapter.startSession(TENANT, OPERATOR);
    await adapter.handleInput(sessionId, 'Invoice the QA Matrix job, $350 for the furnace repair.');

    const turn2 = await adapter.handleInput(sessionId, 'QA Matrix North');
    expect(turn2.state).toBe('entity_resolution');
    const question = turn2.sideEffects.find(
      (e) => e.type === 'tts_play' && e.payload.template === 'disambiguate',
    );
    const offered = (question?.payload.candidates as Array<{ id: string }>).map((c) => c.id);
    expect(offered.sort()).toEqual([JOB_QA_MATRIX, JOB_QA_MATRIX_2].sort());

    const turn3 = await adapter.handleInput(sessionId, 'QA Matrix water heater');
    expect(turn3.state).toBe('intent_confirm');
    await adapter.handleInput(sessionId, 'yes');
    const [proposal] = await proposalRepo.findByTenant(TENANT);
    expect(proposal.payload.customerId).toBe(CUST_NORTH);
    expect(proposal.payload.jobId).toBe(JOB_QA_MATRIX_2);
  });

  it('the proposal is created by the acting operator, never the phone-matched CRM customer', async () => {
    const customerRepo = new InMemoryCustomerRepository();
    const customer = await createCustomer(
      {
        tenantId: TENANT,
        firstName: 'QA',
        lastName: 'Matrix',
        primaryPhone: '602-555-0123',
        createdBy: OPERATOR,
      },
      customerRepo,
    );
    const adapter = new InAppVoiceAdapter({
      store,
      gateway: scriptedGateway([INVOICE_CLASSIFIER]),
      proposalRepo,
      auditRepo: new InMemoryAuditRepository(),
      onCallRepo: new InMemoryOnCallRepository(new Map()),
      customerRepo,
      entityResolver: resolverByKind({
        customer: {
          kind: 'resolved',
          candidate: { id: customer.id, kind: 'customer', label: 'QA Matrix', score: 0.95 },
        },
        job: {
          kind: 'resolved',
          candidate: { id: JOB_QA_MATRIX, kind: 'job', label: 'QA Matrix job', score: 0.95 },
        },
      }),
    });
    const { sessionId } = await adapter.startSession(
      TENANT,
      OPERATOR,
      undefined,
      'owner',
      '+1 602 555 0123',
    );
    await adapter.handleInput(sessionId, 'Invoice the QA Matrix job, $350 for the furnace repair.');
    await adapter.handleInput(sessionId, 'yes');

    const [proposal] = await proposalRepo.findByTenant(TENANT);
    expect(proposal.payload.customerId).toBe(customer.id);
    expect(proposal.createdBy).toBe(OPERATOR);
  });
});
