/**
 * #1492 P2 — QA VOX-05: "Draft an estimate for the QA Matrix job…". The
 * classifier extracted only `jobReference: "QA Matrix"` (no customerName), so
 * resolution went straight to tenant-wide job matching, which answered
 * not_found, and the operator heard "I couldn't find a matching job for QA
 * Matrix" although the QA Matrix customer has several jobs.
 *
 * A job reference that names no job but does name a customer is a question
 * about THAT customer's jobs — the create_invoice customer-then-job path:
 * the customer (or a which-customer question), then their jobs (one resolves,
 * several are a which-job question). A reference naming neither stays an
 * honest not_found (#1416).
 *
 * Seam: InAppVoiceAdapter (startSession / handleInput) with a scripted
 * gateway and an EntityResolver fake that answers the way PgEntityResolver
 * does: tenant-wide "QA Matrix" job words overflow into not_found, the
 * customer lookup finds the customer, and a customer-anchored job lookup
 * (`customerId`) ranks that customer's jobs.
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

const TENANT = 'tenant-1492';
const OPERATOR = 'user-operator-1492';
const CUST_A = '0b6b1f6e-1111-4c1a-9d8e-00000000a492';
const CUST_B = '0b6b1f6e-1111-4c1a-9d8e-00000000b492';
const JOBS_OF_A = [1, 2, 3].map((n) => `0b6b1f6e-2222-4c1a-9d8e-00000000a${n}92`);
const JOBS_OF_B = [1, 2].map((n) => `0b6b1f6e-2222-4c1a-9d8e-00000000b${n}92`);

function estimateClassifier(jobReference: string): string {
  return JSON.stringify({
    intentType: 'draft_estimate',
    confidence: 0.9,
    extractedEntities: {
      jobReference,
      lineItemDescriptions: ['furnace tune-up'],
    },
  });
}

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
  return ids.map((id, i) => ({ id, kind: 'job', label: `Furnace visit ${i + 1}`, score: 0.95 }));
}

interface World {
  customer: (reference: string) => EntityResolverResult;
}

/** Tenant-wide job words never match a job; anchored lookups rank the customer's jobs. */
function world({ customer }: World): EntityResolver {
  return {
    resolve: vi.fn(async (input): Promise<EntityResolverResult> => {
      if (input.kind === 'customer') return customer(input.reference);
      if (input.kind === 'job') {
        if (input.customerId === CUST_A) return { kind: 'ambiguous', candidates: jobCandidates(JOBS_OF_A) };
        if (input.customerId === CUST_B) return { kind: 'ambiguous', candidates: jobCandidates(JOBS_OF_B) };
        return { kind: 'not_found', reference: input.reference };
      }
      return { kind: 'not_found', reference: input.reference };
    }),
  };
}

function offeredIds(turn: { sideEffects: Array<{ type: string; payload: Record<string, unknown> }> }): string[] {
  const question = turn.sideEffects.find(
    (e) => e.type === 'tts_play' && e.payload.template === 'disambiguate',
  );
  return ((question?.payload.candidates as Array<{ id: string }> | undefined) ?? []).map((c) => c.id).sort();
}

describe('InAppVoiceAdapter — a job reference naming a customer falls back to that customer\'s jobs (#1492)', () => {
  let store: VoiceSessionStore;
  let proposalRepo: InMemoryProposalRepository;

  beforeEach(() => {
    store = new VoiceSessionStore({ startInterval: false });
    proposalRepo = new InMemoryProposalRepository();
  });
  afterEach(() => store.dispose());

  function adapterFor(resolver: EntityResolver, jobReference = 'QA Matrix') {
    return new InAppVoiceAdapter({
      store,
      gateway: scriptedGateway([estimateClassifier(jobReference)]),
      proposalRepo,
      auditRepo: new InMemoryAuditRepository(),
      onCallRepo: new InMemoryOnCallRepository(new Map()),
      entityResolver: resolver,
    });
  }

  it('the reference names one customer with several jobs → a which-job question over that customer\'s jobs, not "couldn\'t find"', async () => {
    const adapter = adapterFor(
      world({
        customer: () => ({
          kind: 'resolved',
          candidate: { id: CUST_A, kind: 'customer', label: 'QA Matrix A', score: 0.95 },
        }),
      }),
    );
    const { sessionId } = await adapter.startSession(TENANT, OPERATOR);
    const turn = await adapter.handleInput(sessionId, 'Draft an estimate for the QA Matrix job for a furnace tune-up.');

    expect(turn.ttsText ?? '').not.toMatch(/couldn't find/i);
    expect(turn.state).toBe('entity_resolution');
    expect(offeredIds(turn)).toEqual([...JOBS_OF_A].sort());
    expect(await proposalRepo.findByTenant(TENANT)).toHaveLength(0);
  });

  it('the reference names several customers → which customer first, then that customer\'s jobs', async () => {
    const adapter = adapterFor(
      world({
        customer: () => ({
          kind: 'ambiguous',
          candidates: [
            { id: CUST_A, kind: 'customer', label: 'QA Matrix A', score: 0.9 },
            { id: CUST_B, kind: 'customer', label: 'QA Matrix B', score: 0.89 },
          ],
        }),
      }),
    );
    const { sessionId } = await adapter.startSession(TENANT, OPERATOR);
    const turn1 = await adapter.handleInput(sessionId, 'Draft an estimate for the QA Matrix job for a furnace tune-up.');
    expect(turn1.ttsText ?? '').not.toMatch(/couldn't find/i);
    expect(turn1.state).toBe('entity_resolution');
    expect(offeredIds(turn1)).toEqual([CUST_A, CUST_B].sort());

    const turn2 = await adapter.handleInput(sessionId, 'QA Matrix B');
    expect(turn2.ttsText ?? '').not.toMatch(/couldn't find/i);
    expect(turn2.state).toBe('entity_resolution');
    expect(offeredIds(turn2)).toEqual([...JOBS_OF_B].sort());
    expect(await proposalRepo.findByTenant(TENANT)).toHaveLength(0);
  });

  it('a reference naming neither a job nor a customer stays an honest "couldn\'t find" (#1416)', async () => {
    const adapter = adapterFor(
      world({ customer: (reference) => ({ kind: 'not_found', reference }) }),
      'Zebulon Warehouse',
    );
    const { sessionId } = await adapter.startSession(TENANT, OPERATOR);
    const turn = await adapter.handleInput(sessionId, 'Draft an estimate for the Zebulon Warehouse job.');

    expect(turn.ttsText).toBe(
      "I couldn't find a matching job for Zebulon Warehouse. Want to try a different name, or create it?",
    );
    expect(offeredIds(turn)).toEqual([]);
    expect(await proposalRepo.findByTenant(TENANT)).toHaveLength(0);
  });
});
