/**
 * #1416 — in-app follow-ups to #1406 D6 (`pinnedRefs`).
 *
 *  - After a customer pick, a job the operator NAMED that does not exist is
 *    said honestly (never a readback that would auto-open a placeholder job)
 *    — the same rule the phone now applies (speechturn-pinned-refs.test.ts).
 *  - The low-confidence `entity_confirm` path ("did you mean QA Matrix
 *    North?" → "yes") re-resolves the references still outstanding, exactly
 *    as a disambiguation pick does.
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
import type { LLMGateway, LLMResponse } from '../../../../src/ai/gateway/gateway';
import type {
  EntityResolver,
  EntityResolverResult,
} from '../../../../src/ai/resolution/entity-resolver';

const TENANT = 'tenant-1416-inapp';
const OPERATOR = 'user-operator-1416';
const CUST_NORTH = '0b6b1f6e-1111-4c1a-9d8e-000000003416';
const CUST_SOUTH = '0b6b1f6e-1111-4c1a-9d8e-000000004416';
const JOB_FURNACE = '0b6b1f6e-2222-4c1a-9d8e-000000003416';
const JOB_HEATER = '0b6b1f6e-2222-4c1a-9d8e-000000004416';

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

function resolverByKind(byKind: Record<string, EntityResolverResult>): EntityResolver {
  return {
    resolve: vi.fn(async (input) => byKind[input.kind] ?? { kind: 'not_found' }),
  } as EntityResolver;
}

const TWO_QA_MATRIX_CUSTOMERS: EntityResolverResult = {
  kind: 'ambiguous',
  candidates: [
    { id: CUST_NORTH, kind: 'customer', label: 'QA Matrix North', score: 0.9 },
    { id: CUST_SOUTH, kind: 'customer', label: 'QA Matrix South', score: 0.89 },
  ],
};

describe('InAppVoiceAdapter — references outstanding after a pick or a confirm (#1416)', () => {
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

  it('a named job that does not exist is said honestly after the customer pick — no readback, nothing drafted', async () => {
    const adapter = makeAdapter(
      resolverByKind({ customer: TWO_QA_MATRIX_CUSTOMERS, job: { kind: 'not_found', reference: 'QA Matrix job' } }),
    );
    const { sessionId } = await adapter.startSession(TENANT, OPERATOR);
    await adapter.handleInput(sessionId, 'Invoice the QA Matrix job, $350 for the furnace repair.');

    const turn2 = await adapter.handleInput(sessionId, 'QA Matrix North');
    expect(turn2.state).not.toBe('intent_confirm');
    expect(turn2.ttsText).toMatch(/couldn't find a matching job for QA Matrix job/i);
    expect(await proposalRepo.findByTenant(TENANT)).toHaveLength(0);
  });

  const PROBABLY_NORTH: EntityResolverResult = {
    kind: 'low_confidence',
    candidate: { id: CUST_NORTH, kind: 'customer', label: 'QA Matrix North', score: 0.7 },
  };

  it('after "yes" to the one-candidate customer confirm, the spoken job is still resolved onto the draft', async () => {
    const adapter = makeAdapter(
      resolverByKind({
        customer: PROBABLY_NORTH,
        job: {
          kind: 'resolved',
          candidate: { id: JOB_FURNACE, kind: 'job', label: 'QA Matrix job', score: 0.95 },
        },
      }),
    );
    const { sessionId } = await adapter.startSession(TENANT, OPERATOR);
    const turn1 = await adapter.handleInput(sessionId, 'Invoice the QA Matrix job, $350 for the furnace repair.');
    expect(turn1.state).toBe('entity_confirm');

    // Not a bare repeated "yes" — a repeat of the same text is de-duplicated.
    const turn2 = await adapter.handleInput(sessionId, 'yeah, that one');
    expect(turn2.state).toBe('intent_confirm');

    await adapter.handleInput(sessionId, 'yes');
    const [proposal] = await proposalRepo.findByTenant(TENANT);
    expect(proposal?.payload.customerId).toBe(CUST_NORTH);
    expect(proposal?.payload.jobId).toBe(JOB_FURNACE);
  });

  it('after the confirm, an ambiguous job is a second question — never a guess', async () => {
    const adapter = makeAdapter(
      resolverByKind({
        customer: PROBABLY_NORTH,
        job: {
          kind: 'ambiguous',
          candidates: [
            { id: JOB_FURNACE, kind: 'job', label: 'QA Matrix furnace', score: 0.9 },
            { id: JOB_HEATER, kind: 'job', label: 'QA Matrix water heater', score: 0.88 },
          ],
        },
      }),
    );
    const { sessionId } = await adapter.startSession(TENANT, OPERATOR);
    await adapter.handleInput(sessionId, 'Invoice the QA Matrix job, $350 for the furnace repair.');

    const turn2 = await adapter.handleInput(sessionId, 'yeah, that one');
    expect(turn2.state).toBe('entity_resolution');
    const question = turn2.sideEffects.find(
      (e) => e.type === 'tts_play' && e.payload.template === 'disambiguate',
    );
    const offered = (question?.payload.candidates as Array<{ id: string }>).map((c) => c.id);
    expect(offered.sort()).toEqual([JOB_FURNACE, JOB_HEATER].sort());

    const turn3 = await adapter.handleInput(sessionId, 'QA Matrix water heater');
    expect(turn3.state).toBe('intent_confirm');
    await adapter.handleInput(sessionId, 'yes');
    const [proposal] = await proposalRepo.findByTenant(TENANT);
    expect(proposal?.payload.customerId).toBe(CUST_NORTH);
    expect(proposal?.payload.jobId).toBe(JOB_HEATER);
  });

  it('"no" to the confirm is still the honest not-found, not a re-resolve', async () => {
    const adapter = makeAdapter(
      resolverByKind({
        customer: PROBABLY_NORTH,
        job: {
          kind: 'resolved',
          candidate: { id: JOB_FURNACE, kind: 'job', label: 'QA Matrix job', score: 0.95 },
        },
      }),
    );
    const { sessionId } = await adapter.startSession(TENANT, OPERATOR);
    await adapter.handleInput(sessionId, 'Invoice the QA Matrix job, $350 for the furnace repair.');

    const turn2 = await adapter.handleInput(sessionId, 'no');
    expect(turn2.state).toBe('intent_capture');
    expect(turn2.ttsText).toMatch(/couldn't find a matching customer for QA Matrix/i);
  });
});
