/**
 * #1476 P2 — QA VOX-07: "invoice for the QA Matrix job". After the operator
 * picked WHICH QA Matrix customer, the reply was "I couldn't find a matching
 * job for QA Matrix job" although that customer has four jobs matching it.
 * The job lookup ran tenant-wide, where "QA Matrix" matches more jobs than a
 * one-tap picker may offer (the resolver's overflow → not_found). Once the
 * customer is known the job reference is a question about THAT customer's
 * jobs, and several matches are a which-one clarification.
 *
 * Seam: InAppVoiceAdapter (startSession / handleInput) with a scripted
 * gateway and an EntityResolver fake that honours the resolver contract's
 * customer anchor (`customerId`) the way PgEntityResolver does — scoped to
 * that customer's jobs when given, tenant-wide otherwise.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { InAppVoiceAdapter } from '../../../../src/ai/agents/customer-calling/inapp-adapter';
import { VoiceSessionStore } from '../../../../src/ai/agents/customer-calling/voice-session-store';
import { InMemoryProposalRepository } from '../../../../src/proposals/proposal';
import { InMemoryAuditRepository } from '../../../../src/audit/audit';
import { InMemoryOnCallRepository } from '../../../../src/oncall/rotation';
import type { LLMGateway, LLMResponse } from '../../../../src/ai/gateway/gateway';
import type {
  EntityCandidate,
  EntityResolver,
  EntityResolverResult,
} from '../../../../src/ai/resolution/entity-resolver';

const TENANT = 'tenant-1476-p2';
const OPERATOR = 'user-operator-1476-p2';
const CUST_A = '0b6b1f6e-1111-4c1a-9d8e-00000000a476';
const CUST_B = '0b6b1f6e-1111-4c1a-9d8e-00000000b476';
const JOBS_OF_A = [1, 2, 3, 4].map((n) => `0b6b1f6e-2222-4c1a-9d8e-00000000a${n}76`);
const JOBS_OF_B = [1, 2, 3].map((n) => `0b6b1f6e-2222-4c1a-9d8e-00000000b${n}76`);

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

function jobCandidates(ids: string[]): EntityCandidate[] {
  return ids.map((id, i) => ({ id, kind: 'job', label: `QA Matrix job ${i + 1}`, score: 0.95 }));
}

/**
 * Seven confident "QA Matrix" jobs tenant-wide (more than the five a picker
 * may offer → not_found, as PgEntityResolver answers); four of them belong to
 * customer A.
 */
const qaMatrixWorld: EntityResolver = {
  resolve: vi.fn(async (input): Promise<EntityResolverResult> => {
    if (input.kind === 'customer') {
      return {
        kind: 'ambiguous',
        candidates: [
          { id: CUST_A, kind: 'customer', label: 'QA Matrix A', score: 0.9 },
          { id: CUST_B, kind: 'customer', label: 'QA Matrix B', score: 0.89 },
        ],
      };
    }
    if (input.kind === 'job') {
      if (input.customerId === CUST_A) return { kind: 'ambiguous', candidates: jobCandidates(JOBS_OF_A) };
      if (input.customerId === CUST_B) return { kind: 'ambiguous', candidates: jobCandidates(JOBS_OF_B) };
      return { kind: 'not_found', reference: input.reference };
    }
    return { kind: 'not_found', reference: input.reference };
  }),
};

describe('InAppVoiceAdapter — a job reference after the customer pick is scoped to that customer (#1476 P2)', () => {
  let store: VoiceSessionStore;
  let proposalRepo: InMemoryProposalRepository;

  beforeEach(() => {
    store = new VoiceSessionStore({ startInterval: false });
    proposalRepo = new InMemoryProposalRepository();
  });
  afterEach(() => store.dispose());

  it('several of the picked customer\'s jobs match → a which-one question over exactly those jobs, not "couldn\'t find"', async () => {
    const adapter = new InAppVoiceAdapter({
      store,
      gateway: scriptedGateway([INVOICE_CLASSIFIER]),
      proposalRepo,
      auditRepo: new InMemoryAuditRepository(),
      onCallRepo: new InMemoryOnCallRepository(new Map()),
      entityResolver: qaMatrixWorld,
    });
    const { sessionId } = await adapter.startSession(TENANT, OPERATOR);
    await adapter.handleInput(sessionId, 'Create an invoice for the QA Matrix job for the completed furnace repair, $350 total.');

    const turn2 = await adapter.handleInput(sessionId, 'QA Matrix A');
    expect(turn2.ttsText ?? '').not.toMatch(/couldn't find/i);
    expect(turn2.state).toBe('entity_resolution');
    const question = turn2.sideEffects.find(
      (e) => e.type === 'tts_play' && e.payload.template === 'disambiguate',
    );
    const offered = (question?.payload.candidates as Array<{ id: string }>).map((c) => c.id);
    expect(offered.sort()).toEqual([...JOBS_OF_A].sort());
    expect(await proposalRepo.findByTenant(TENANT)).toHaveLength(0);
  });
});
